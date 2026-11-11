import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ZodError } from "zod";
import { openDatabase } from "../../packages/storage/database.js";
import { CompanyRepository } from "../../packages/storage/company-repository.js";
import { isLocalOrLanHost, localSecretStore, tokenHash } from "./security.js";
import { WhatsAppBridge } from "./whatsapp-bridge.js";
import { ExecutionEngine } from "./execution-engine.js";
import { SyncService } from "./sync-service.js";
import { registerAuth } from "./auth-routes.js";
import { registerCompanyRoutes } from "./company-routes.js";
import { registerPortalAdmin } from "./portal-admin.js";
import { createPortal } from "./portal.js";
import { createProductReader } from "../../packages/erp/products.js";
import { getImageProcessingConfig } from "./image-processing/config.js";
import { ImageProcessingWorker } from "./image-processing/worker.js";
export async function createApp(options: {
  dataDir: string;
  root: string;
  logger?: boolean;
}) {
  const db = openDatabase(resolve(options.dataDir, "app.sqlite"));
  const repo = new CompanyRepository(db),
    secrets = localSecretStore(options.dataDir),
    wa = new WhatsAppBridge(options.dataDir, undefined, undefined, undefined, state => {
      if (state.companyId && (state.requiresReauth || state.recoveryBlocked || state.processingBlocked)) {
        repo.pauseForWhatsApp(state.companyId, state.reason || "WHATSAPP_RECOVERY_BLOCKED");
      }
    });
  const sync = new SyncService(db,repo,secrets,options.root);
  const engine = new ExecutionEngine(db, repo, wa);
  const productReader = createProductReader(db, secrets);
  const imageCfg = getImageProcessingConfig({ db, dataDir: options.dataDir, root: options.root });
  const imageWorker = new ImageProcessingWorker(db, {
    dataDir: options.dataDir,
    root: options.root,
    reader: productReader,
  });

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 3 * 1024 * 1024,
    disableRequestLogging: true,
  });
  app.addHook("onListen", async () => {
    engine.start(3500);
    if (imageWorker.isEnabled()) {
      imageWorker.start(imageCfg.pollIntervalMs);
    }
    // Automatically connect WhatsApp on boot if a saved session exists
    try {
      const companies = db
        .prepare("SELECT id, name FROM companies")
        .all() as Array<{ id: string; name: string }>;
      for (const c of companies) {
        const sessionDir = resolve(
          options.dataDir,
          "whatsapp-auth",
          `session-${c.id}`,
        );
        if (existsSync(sessionDir)) {
          console.log(
            `[WhatsApp] Found saved session for company ${c.name} (${c.id}). Auto-connecting on startup...`,
          );
          wa.autoConnect(c.id);
          break;
        }
      }
    } catch (err: any) {
      console.error("[WhatsApp] Startup auto-connect check failed:", err.message);
    }
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 },
  });
  app.decorateRequest("operatorId", "");
  app.decorateRequest("companyId", null);
  app.decorateRequest("sessionHash", "");
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (!request.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const hostname = request.hostname;
    if (!isLocalOrLanHost(hostname))
      return reply.code(403).send({ error: "الوصول متاح محليًا فقط" });
    if (!["GET", "HEAD"].includes(request.method)) {
      if (request.headers["x-emoji-request"] !== "1")
        return reply.code(403).send({ error: "طلب غير صالح" });
      if (
        request.headers.origin &&
        request.headers.origin !==
          `${request.protocol}://${request.headers.host}`
      )
        return reply.code(403).send({ error: "مصدر الطلب غير مسموح" });
    }
    const token = request.cookies.emoji_session;
    if (token) {
      const hash = tokenHash(token);
      const session: any = db
        .prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?")
        .get(hash, new Date().toISOString());
      if (session) {
        request.operatorId = session.operator_id;
        request.sessionHash = hash;
        const singleCompany = db
          .prepare("SELECT id FROM companies LIMIT 1")
          .get() as { id: string } | undefined;
        request.companyId = singleCompany?.id ?? session.company_id ?? null;
      }
    }
    const publicRoute =
      request.url === "/api/session" || request.url.startsWith("/api/auth/");
    if (!publicRoute && !request.operatorId)
      return reply.code(401).send({ error: "سجّل الدخول أولًا" });
    if (request.companyId && request.operatorId) {
      db.prepare("INSERT OR IGNORE INTO company_access VALUES(?,?)").run(
        request.operatorId,
        request.companyId,
      );
    }
  });
  app.setErrorHandler((caught, request, reply) => {
    const error = caught as Error & { statusCode?: number; code?: string };
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({
          error: "راجع البيانات المدخلة",
          fields: error.issues.map((issue) => issue.path.join(".")),
        });
    if ((error as any).code === "FST_REQ_FILE_TOO_LARGE")
      return reply.code(413).send({ error: "الصورة أكبر من 2 ميجابايت" });
    const code = (error as any).code;
    if (
      [
        "ELOGIN",
        "ESOCKET",
        "ETIMEOUT",
        "EINSTLOOKUP",
        "ECONNCLOSED",
        "EREQUEST",
      ].includes(code)
    )
      return reply
        .code(400)
        .send({
          error: `تعذر الاتصال أو قراءة مخطط SQL (${code}). راجع السيرفر والقاعدة والصلاحيات والشهادة.`,
        });
    const status = (error as any).statusCode ?? 500;
    if (
      status >= 500 &&
      !error.message.startsWith("اربط") &&
      !error.message.includes("واتساب") &&
      !error.message.includes("مصدر") &&
      !error.message.includes("المصدر")
    )
      request.log.error({ code }, "Operation failed");
    const message =
      status < 500 ||
      /واتساب|المصدر|مصدر|مهلة|ملف|ENOENT|شركة أخرى/.test(error.message)
        ? error.message
        : "تعذر إتمام العملية. راجع الإعدادات وحالة الاتصال.";
    return reply
      .code(status)
      .send({
        error: message.includes("ENOENT")
          ? "النسخة المحلية غير متاحة. شغّل فحص قاعدة البيانات أو استخدم اتصال SQL."
          : message,
      });
  });
  registerAuth(app, { db, repo, secrets, wa, sync, root: options.root });
  registerCompanyRoutes(app, { db, repo, secrets, wa, sync, root: options.root });
  registerPortalAdmin(app, db, {
    dataDir: options.dataDir,
    root: options.root,
    reader: productReader,
    onResumeWorker: () => imageWorker.resumeAfterAuth(),
    onJobQueued: () => imageWorker.notify(),
    onToggleProcessing: (enabled) => imageWorker.setProcessingEnabled(enabled),
    onBeforeLogin: () => imageWorker.beginInteractiveLogin(),
    onAfterLogin: (authenticated) => imageWorker.endInteractiveLogin(authenticated),
  });
  const portal = await createPortal({
    db,
    dataDir: options.dataDir,
    root: options.root,
    reader: productReader,
    logger: options.logger,
    onJobQueued: () => imageWorker.notify(),
  });
  const dist = resolve(options.root, "dist/web");
  if (existsSync(dist)) {
    await app.register(staticFiles, { root: dist });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "مسار غير موجود" })
        : reply.sendFile("index.html"),
    );
  }
  const version = JSON.parse(readFileSync(resolve(options.root,"package.json"),"utf8")).version;
  app.get("/healthz", async () => ({
    ok: true,
    schemaVersion: 4,
    version,
    whatsapp: {
      status: wa.state.status,
      companyId: wa.state.companyId,
      error: wa.state.error ?? null,
      workerPid: wa.state.workerPid ?? null,
      reason: wa.state.reason ?? null,
      requiresReauth: wa.state.requiresReauth ?? false,
      recoveryBlocked: wa.state.recoveryBlocked ?? false,
      processingBlocked: wa.state.processingBlocked ?? false,
      restriction: wa.state.restriction ?? null,
      retryAttempt: wa.state.retryAttempt ?? 0,
    },
  }));
  const syncTimer = setInterval(() => {
    const sources = db.prepare("SELECT company_id FROM sources WHERE kind='sql'").all() as Array<{company_id:string}>;
    for (const source of sources) void sync.run(source.company_id).catch(() => {});
  },30000);
  syncTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(syncTimer);
    try {
      await portal.close();
      await Promise.allSettled([sync.stop(), engine.stop(), imageWorker.stop()]);
      await wa.stop();
    } finally { db.close(); }
  });
  return { app, portal, db, repo, wa, engine, sync, imageWorker };
}
