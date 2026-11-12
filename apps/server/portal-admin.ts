import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { ProductReader } from "../../packages/erp/products.js";
import type { AppDatabase } from "../../packages/storage/database.js";
import { hashPassword } from "./security.js";
import {
  buildImagePromptForProduct,
  DEFAULT_IMAGE_PROMPT,
  getConfiguredImagePrompt,
  getImageProcessingConfig,
  isImageProcessingEnabled,
} from "./image-processing/config.js";
import { canLaunchInteractiveBrowser, runInteractiveGeminiLogin } from "./image-processing/gemini-client.js";
import { markGeminiAuthenticated } from "./image-processing/profile.js";
import { normalizeWatermarkLogo } from "./image-processing/storage.js";
import {
  clearExternalWorkerReauth,
  enqueueImageProcessingJob,
  getImageProcessingStatusSummary,
} from "./image-processing/worker.js";
export const photoCredentials = z.object({ username: z.string().trim().min(3).max(80), password: z.string().min(10).max(200) });
export function auditPortal(db: AppDatabase, companyId: string, event: string, details: object) {
  db.prepare("INSERT INTO audit_events(company_id,event,details,created_at) VALUES(?,?,?,?)")
    .run(companyId,event,JSON.stringify(details),new Date().toISOString());
}
export function registerPortalAdmin(
  app: FastifyInstance,
  db: AppDatabase,
  options?: {
    dataDir?: string;
    root?: string;
    reader?: ProductReader;
    onResumeWorker?: () => void;
    onJobQueued?: () => void;
    onToggleProcessing?: (enabled: boolean) => Promise<void> | void;
    onBeforeLogin?: () => Promise<void> | void;
    onAfterLogin?: (authenticated: boolean) => Promise<void> | void;
    canLaunchInteractive?: () => { supported: boolean; reason?: string };
    interactiveLoginRunner?: typeof runInteractiveGeminiLogin;
  },
) {
  const root = resolve(options?.root ?? process.cwd());
  const dataDir = resolve(options?.dataDir ?? resolve(root, "data/application"));
  if (!app.hasContentTypeParser("multipart/form-data")) {
    void app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 } });
  }
  function company(request: any): string {
    if (request.companyId) return request.companyId;
    const single = db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string } | undefined;
    if (single) return single.id;
    throw Object.assign(new Error("أضف شركة أولًا"),{statusCode:400});
  }
  const statusSummary = (companyId?: string) => {
    const imageCfg = getImageProcessingConfig({ db, dataDir, root });
    return getImageProcessingStatusSummary(db, imageCfg.profileRoot, companyId, {
      dataDir,
      workerMode: imageCfg.workerMode,
    });
  };
  const checkInteractive =
    options?.canLaunchInteractive ??
    (() => {
      const imageCfg = getImageProcessingConfig({ db, dataDir, root });
      if (imageCfg.workerMode === "external") {
        return {
          supported: false,
          reason:
            "يعمل Gemini تحت حساب Windows المخصّص؛ افتح «Gemini Web Login» من قائمة ابدأ على جهاز الخادم أو شغّل gemini-login.bat لتسجيل الدخول.",
        };
      }
      return canLaunchInteractiveBrowser();
    });
  const loginRunner = options?.interactiveLoginRunner ?? runInteractiveGeminiLogin;
  let loginAbort: AbortController | null = null;
  let loginPromise: Promise<void> | null = null;
  let loginState: {
    status: "idle" | "launching" | "waiting_for_login" | "confirming" | "succeeded" | "failed" | "cancelled";
    stage: "launching" | "waiting_for_login" | "confirming" | null;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  } = {
    status: "idle",
    stage: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  const getLoginStatusPayload = () => {
    const capability = checkInteractive();
    return {
      ...loginState,
      active: Boolean(loginPromise),
      interactiveSupported: capability.supported,
      unsupportedReason: capability.reason ?? null,
    };
  };
  app.addHook("onClose", async () => {
    loginAbort?.abort();
    await loginPromise?.catch(() => {});
  });
  app.get("/api/portal/settings", async request => {
    const id=company(request);
    const settings=db.prepare("SELECT company_id,enabled,origin,image_prompt,image_processing_enabled,watermark_logo IS NOT NULL AS has_watermark_logo,watermark_logo_enabled,watermark_code_enabled FROM portal_settings WHERE id=1").get() as any;
    return { enabled: Boolean(settings?.enabled), origin:settings?.origin || "",
      selected: true,
      imageProcessingEnabled: Boolean(settings?.image_processing_enabled ?? 1),
      hasWatermarkLogo: Boolean(settings?.has_watermark_logo),
      watermarkLogoEnabled: Boolean(settings?.watermark_logo_enabled ?? 1),
      watermarkCodeEnabled: Boolean(settings?.watermark_code_enabled ?? 1),
      imagePrompt: getConfiguredImagePrompt(db, dataDir, root),
      customImagePrompt: settings?.image_prompt || "",
      defaultImagePrompt: DEFAULT_IMAGE_PROMPT,
      geminiStatus: statusSummary(id),
      interactiveLogin: getLoginStatusPayload(),
      users:db.prepare("SELECT id,username,enabled,created_at FROM photo_users WHERE company_id=? ORDER BY created_at").all(id) };
  });
  app.put("/api/portal/settings", async request => {
    const id=company(request);
    const {enabled,origin,imagePrompt}=z.object({
      enabled:z.boolean(),
      origin:z.union([z.literal(""),z.url().refine(v=> {
        const url=new URL(v);return url.protocol==="https:" && url.origin===v && !url.username && !url.password;
      },"استخدم أصل HTTPS بدون مسار أو شرطة في النهاية")]),
      imagePrompt:z.string().max(4000).optional(),
    }).parse(request.body);
    if(enabled && !(db.prepare("SELECT 1 FROM sources WHERE company_id=? AND kind='sql' AND config IS NOT NULL").get(id)))
      throw Object.assign(new Error("اربط الشركة بقاعدة SQL أولًا"),{statusCode:400});
    db.transaction(()=>{
      if (imagePrompt !== undefined) {
        const cleaned = imagePrompt.trim() || null;
        db.prepare("UPDATE portal_settings SET company_id=?,enabled=?,origin=?,image_prompt=? WHERE id=1").run(id,Number(enabled),origin,cleaned);
      } else {
        db.prepare("UPDATE portal_settings SET company_id=?,enabled=?,origin=? WHERE id=1").run(id,Number(enabled),origin);
      }
      db.prepare("DELETE FROM photo_sessions").run();
      auditPortal(db,id,"portal.settings",{operatorId:request.operatorId,enabled,origin,promptUpdated:imagePrompt!==undefined});
    })();
    return {ok:true};
  });
  app.get("/api/portal/image-processing", async request => {
    const id = company(request);
    const watermarkRow = db
      .prepare("SELECT watermark_logo IS NOT NULL AS has_watermark_logo, watermark_logo_enabled, watermark_code_enabled FROM portal_settings WHERE id=1")
      .get() as
      | { has_watermark_logo: number; watermark_logo_enabled?: number | null; watermark_code_enabled?: number | null }
      | undefined;
    const jobs = db.prepare(
      `SELECT id, product_id, unit_id, product_image_id, status, retry_count, max_retries,
              error_code, error_message, created_at, updated_at, completed_at
       FROM image_processing_jobs
       WHERE company_id=?
       ORDER BY created_at DESC
       LIMIT 30`,
    ).all(id);
    return {
      imageProcessingEnabled: isImageProcessingEnabled(db),
      hasWatermarkLogo: Boolean(watermarkRow?.has_watermark_logo),
      watermarkLogoEnabled: Boolean(watermarkRow?.watermark_logo_enabled ?? 1),
      watermarkCodeEnabled: Boolean(watermarkRow?.watermark_code_enabled ?? 1),
      imagePrompt: getConfiguredImagePrompt(db, dataDir, root),
      defaultImagePrompt: DEFAULT_IMAGE_PROMPT,
      geminiStatus: statusSummary(id),
      interactiveLogin: getLoginStatusPayload(),
      jobs,
    };
  });
  app.post("/api/portal/image-processing/watermark-logo", async (request, reply) => {
    const id = company(request);
    let buffer: Buffer;
    try {
      const file = await (request as any).file();
      if (!file) {
        return reply.code(400).send({ error: "اختر صورة PNG أو JPEG أو WebP" });
      }
      buffer = await file.toBuffer();
      if (file.file?.truncated) {
        return reply.code(413).send({ error: "حجم صورة اللوجو كبير جدًا؛ الحد الأقصى 2 ميجابايت" });
      }
    } catch (err: any) {
      if (err?.code === "FST_REQ_FILE_TOO_LARGE" || err?.statusCode === 413) {
        return reply.code(413).send({ error: "حجم صورة اللوجو كبير جدًا؛ الحد الأقصى 2 ميجابايت" });
      }
      return reply.code(400).send({ error: "تعذر قراءة ملف اللوجو؛ اختر صورة PNG أو JPEG أو WebP" });
    }
    let normalized: Awaited<ReturnType<typeof normalizeWatermarkLogo>>;
    try {
      normalized = await normalizeWatermarkLogo(buffer);
    } catch {
      return reply.code(400).send({ error: "نوع الصورة غير مدعوم؛ استخدم صورة PNG أو JPEG أو WebP صالحة." });
    }
    db.transaction(() => {
      db.prepare("UPDATE portal_settings SET watermark_logo=?, watermark_logo_type=? WHERE id=1").run(
        normalized.buffer,
        normalized.mime,
      );
      auditPortal(db, id, "portal.image_processing.watermark_logo_updated", {
        operatorId: request.operatorId,
        width: normalized.width,
        height: normalized.height,
      });
    })();
    return { ok: true, hasWatermarkLogo: true, width: normalized.width, height: normalized.height };
  });
  app.get("/api/portal/image-processing/watermark-logo", async (request, reply) => {
    company(request);
    const row = db
      .prepare("SELECT watermark_logo, watermark_logo_type FROM portal_settings WHERE id=1")
      .get() as { watermark_logo: Buffer | null; watermark_logo_type: string | null } | undefined;
    if (!row?.watermark_logo) return reply.code(404).send();
    return reply
      .header("Cache-Control", "private, no-store")
      .type(row.watermark_logo_type || "image/png")
      .send(row.watermark_logo);
  });
  app.delete("/api/portal/image-processing/watermark-logo", async request => {
    const id = company(request);
    db.transaction(() => {
      db.prepare("UPDATE portal_settings SET watermark_logo=NULL, watermark_logo_type=NULL WHERE id=1").run();
      auditPortal(db, id, "portal.image_processing.watermark_logo_deleted", {
        operatorId: request.operatorId,
      });
    })();
    return { ok: true, hasWatermarkLogo: false };
  });
  app.put("/api/portal/image-processing/stamp-options", async request => {
    const id = company(request);
    const body = z
      .object({
        watermarkLogoEnabled: z.boolean().optional(),
        watermarkCodeEnabled: z.boolean().optional(),
      })
      .parse(request.body);
    const current = db
      .prepare("SELECT watermark_logo_enabled, watermark_code_enabled FROM portal_settings WHERE id=1")
      .get() as { watermark_logo_enabled?: number | null; watermark_code_enabled?: number | null } | undefined;
    const watermarkLogoEnabled = body.watermarkLogoEnabled ?? Boolean(current?.watermark_logo_enabled ?? 1);
    const watermarkCodeEnabled = body.watermarkCodeEnabled ?? Boolean(current?.watermark_code_enabled ?? 1);
    db.transaction(() => {
      db.prepare("UPDATE portal_settings SET watermark_logo_enabled=?, watermark_code_enabled=? WHERE id=1").run(
        Number(watermarkLogoEnabled),
        Number(watermarkCodeEnabled),
      );
      auditPortal(db, id, "portal.image_processing.stamp_options_updated", {
        operatorId: request.operatorId,
        watermarkLogoEnabled,
        watermarkCodeEnabled,
      });
    })();
    return { ok: true, watermarkLogoEnabled, watermarkCodeEnabled };
  });
  app.put("/api/portal/image-processing/prompt", async request => {
    const id = company(request);
    const { imagePrompt } = z.object({ imagePrompt: z.string().max(4000) }).parse(request.body);
    const cleaned = imagePrompt.trim() || null;
    db.transaction(() => {
      db.prepare("UPDATE portal_settings SET image_prompt=? WHERE id=1").run(cleaned);
      auditPortal(db, id, "portal.image_processing.prompt_updated", { operatorId: request.operatorId, custom: Boolean(cleaned) });
    })();
    return {
      ok: true,
      imagePrompt: getConfiguredImagePrompt(db, dataDir, root),
      customImagePrompt: cleaned || "",
      defaultImagePrompt: DEFAULT_IMAGE_PROMPT,
    };
  });
  app.put("/api/portal/image-processing/enabled", async request => {
    const id = company(request);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    db.transaction(() => {
      db.prepare("UPDATE portal_settings SET image_processing_enabled=? WHERE id=1").run(Number(enabled));
      auditPortal(db, id, "portal.image_processing.toggled", { operatorId: request.operatorId, enabled });
    })();
    await options?.onToggleProcessing?.(enabled);
    return {
      ok: true,
      enabled,
      geminiStatus: statusSummary(id),
    };
  });
  app.post("/api/portal/image-processing/login", async (request, reply) => {
    const id = company(request);
    const capability = checkInteractive();
    if (!capability.supported) {
      return reply.code(409).send({
        ok: false,
        error: capability.reason ?? "بيئة التشغيل الحالية لا تدعم فتح متصفح تفاعلي",
        interactiveLogin: getLoginStatusPayload(),
      });
    }
    if (loginPromise) {
      return {
        ok: true,
        alreadyRunning: true,
        interactiveLogin: getLoginStatusPayload(),
      };
    }
    const abortController = new AbortController();
    loginAbort = abortController;
    loginState = {
      status: "launching",
      stage: "launching",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    auditPortal(db, id, "portal.image_processing.login_started", { operatorId: request.operatorId });
    const imageCfg = getImageProcessingConfig({ db, dataDir, root });
    let runTask: Promise<void>;
    runTask = (async () => {
      let authenticated = false;
      try {
        await options?.onBeforeLogin?.();
        if (abortController.signal.aborted) {
          throw new Error("تم إلغاء تسجيل الدخول");
        }
        await loginRunner({
          config: imageCfg,
          root,
          signal: abortController.signal,
          onStage: stage => {
            loginState = {
              ...loginState,
              status: stage,
              stage,
            };
          },
        });
        authenticated = true;
        db.transaction(() => {
          db.prepare("UPDATE portal_settings SET gemini_paused=0, gemini_requires_reauth=0, gemini_pause_reason=NULL WHERE id=1").run();
          auditPortal(db, id, "portal.image_processing.login_succeeded", { operatorId: request.operatorId });
        })();
        markGeminiAuthenticated(imageCfg.profileRoot);
        loginState = {
          ...loginState,
          status: "succeeded",
          stage: null,
          finishedAt: new Date().toISOString(),
          error: null,
        };
      } catch (err: any) {
        const cancelled = abortController.signal.aborted;
        const msg = cancelled
          ? "تم إلغاء تسجيل الدخول"
          : (err?.message ?? "تعذر إتمام تسجيل الدخول عبر المتصفح");
        loginState = {
          ...loginState,
          status: cancelled ? "cancelled" : "failed",
          stage: null,
          finishedAt: new Date().toISOString(),
          error: msg,
        };
        auditPortal(db, id, cancelled ? "portal.image_processing.login_cancelled" : "portal.image_processing.login_failed", {
          operatorId: request.operatorId,
          error: msg,
        });
      } finally {
        if (loginAbort === abortController) {
          loginAbort = null;
          loginPromise = null;
        }
        await options?.onAfterLogin?.(authenticated);
      }
    })();
    loginPromise = runTask;
    return {
      ok: true,
      interactiveLogin: getLoginStatusPayload(),
    };
  });
  app.get("/api/portal/image-processing/login/status", async request => {
    const id = company(request);
    return {
      ok: true,
      interactiveLogin: getLoginStatusPayload(),
      geminiStatus: statusSummary(id),
    };
  });
  app.post("/api/portal/image-processing/login/cancel", async request => {
    const id = company(request);
    if (loginAbort) {
      loginAbort.abort();
      loginState = {
        ...loginState,
        status: "cancelled",
        stage: null,
        finishedAt: new Date().toISOString(),
        error: "تم إلغاء تسجيل الدخول",
      };
      auditPortal(db, id, "portal.image_processing.login_cancel_requested", { operatorId: request.operatorId });
    }
    return {
      ok: true,
      interactiveLogin: getLoginStatusPayload(),
    };
  });
  app.post("/api/portal/image-processing/resume", async request => {
    const id = company(request);
    const imageCfg = getImageProcessingConfig({ db, dataDir, root });
    db.transaction(() => {
      db.prepare("UPDATE portal_settings SET gemini_paused=0, gemini_requires_reauth=0, gemini_pause_reason=NULL WHERE id=1").run();
      auditPortal(db, id, "portal.image_processing.resumed", { operatorId: request.operatorId });
    })();
    if (imageCfg.workerMode === "external") {
      clearExternalWorkerReauth(dataDir);
    } else {
      markGeminiAuthenticated(imageCfg.profileRoot);
    }
    options?.onResumeWorker?.();
    return { ok: true };
  });
  app.post("/api/portal/image-processing/jobs/:jobId/retry", async request => {
    const id = company(request);
    const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
    if (!isImageProcessingEnabled(db)) {
      throw Object.assign(new Error("معالجة الصور التلقائية متوقفة حاليًا من إعدادات الإدارة"), { statusCode: 409 });
    }
    const existingMeta = db.prepare(
      `SELECT j.company_id, j.product_id, j.unit_id, pi.deleted_at
       FROM image_processing_jobs j
       JOIN product_images pi ON pi.id = j.product_image_id
       WHERE j.id=? AND j.company_id=?`,
    ).get(jobId, id) as { company_id: string; product_id: string; unit_id: string; deleted_at: string | null } | undefined;
    if (!existingMeta || existingMeta.deleted_at !== null) {
      throw Object.assign(new Error("المهمة غير موجودة"), { statusCode: 404 });
    }
    const item = options?.reader
      ? await options.reader.get(existingMeta.company_id, existingMeta.product_id, existingMeta.unit_id).catch(() => undefined)
      : undefined;
    const imageCfg = getImageProcessingConfig({ db, dataDir, root });
    const prompt = buildImagePromptForProduct(getConfiguredImagePrompt(db, dataDir, root), item);
    let newJobId = "";
    db.transaction(() => {
      const job = db.prepare(
        `SELECT j.*, pi.deleted_at
         FROM image_processing_jobs j
         JOIN product_images pi ON pi.id = j.product_image_id
         WHERE j.id=? AND j.company_id=?`,
      ).get(jobId, id) as any;
      if (!job || job.deleted_at !== null) throw Object.assign(new Error("المهمة غير موجودة"), { statusCode: 404 });
      if (job.status === "pending" || job.status === "processing") {
        throw Object.assign(new Error("المهمة قيد التنفيذ بالفعل"), { statusCode: 409 });
      }
      newJobId = enqueueImageProcessingJob(db, {
        companyId: job.company_id,
        sourceIdentity: job.source_identity,
        productId: job.product_id,
        unitId: job.unit_id,
        productImageId: job.product_image_id,
        userId: job.user_id,
        originalImageId: job.original_image_id,
        productCode: item?.code ?? job.product_code,
        prompt,
        maxRetries: imageCfg.maxRetries,
      });
      auditPortal(db, id, "portal.image_processing.job_retried", { oldJobId: jobId, newJobId, operatorId: request.operatorId });
    })();
    options?.onJobQueued?.();
    return { ok: true, jobId: newJobId };
  });
  app.post("/api/portal/users",async request=>{
    const id=company(request),input=photoCredentials.parse(request.body),userId=randomUUID();
    if(db.prepare("SELECT 1 FROM photo_users WHERE username=?").get(input.username))
      throw Object.assign(new Error("اسم المستخدم مستخدم بالفعل"),{statusCode:409});
    db.transaction(()=>{
      db.prepare("INSERT INTO photo_users VALUES(?,?,?,?,1,?)").run(userId,id,input.username,hashPassword(input.password),new Date().toISOString());
      auditPortal(db,id,"portal.user.created",{userId,operatorId:request.operatorId});
    })();
    return {ok:true};
  });
  app.put("/api/portal/users/:id",async request=>{
    const id=company(request),{id:userId}=z.object({id:z.uuid()}).parse(request.params);
    const input=z.object({enabled:z.boolean(),password:z.string().min(10).max(200).optional()}).parse(request.body);
    if(!db.prepare("SELECT 1 FROM photo_users WHERE id=? AND company_id=?").get(userId,id))
      throw Object.assign(new Error("الحساب غير موجود"),{statusCode:404});
    const hash=input.password?hashPassword(input.password):null;
    db.transaction(()=>{
      db.prepare("UPDATE photo_users SET enabled=?,password_hash=COALESCE(?,password_hash) WHERE id=? AND company_id=?").run(Number(input.enabled),hash,userId,id);
      db.prepare("DELETE FROM photo_sessions WHERE user_id=?").run(userId);
      auditPortal(db,id,"portal.user.updated",{userId,enabled:input.enabled,passwordChanged:Boolean(hash),operatorId:request.operatorId});
    })();
    return {ok:true};
  });
}
