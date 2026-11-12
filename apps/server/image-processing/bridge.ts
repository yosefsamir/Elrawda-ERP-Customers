import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDatabase } from "../../../packages/storage/database.js";
import { getConfiguredImagePrompt } from "./config.js";
import { validateAndNormalizeImage } from "./storage.js";
import {
  ImageProcessingWorker,
  markExternalWorkerAuthCompleted,
  readExternalWorkerStatus,
  updateExternalWorkerHeartbeat,
  writeExternalWorkerStatus,
  type ExternalWorkerStatus,
} from "./worker.js";

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Loads an existing localhost bridge token from disk or creates a new 256-bit random token.
 */
export function loadOrCreateBridgeToken(filePath: string): string {
  const target = resolve(filePath);
  if (existsSync(target)) {
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as { token?: unknown };
      if (typeof parsed.token === "string" && parsed.token.trim().length >= 32) {
        return parsed.token.trim();
      }
    } catch {}
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), "utf8");
  renameSync(tmp, target);
  return token;
}

/**
 * Reads an already provisioned bridge token without creating one (used by external worker and CLI).
 */
export function readBridgeToken(filePath: string): string | null {
  const target = resolve(filePath);
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.trim().length >= 16 ? parsed.token.trim() : null;
  } catch {
    return null;
  }
}

function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return LOOPBACK_ADDRS.has(ip.trim().toLowerCase());
}

function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractBearerToken(req: FastifyRequest): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return undefined;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function clearExternalCurrentJob(dataDir: string, workerId: string, jobId: string, state: ExternalWorkerStatus["state"] = "idle"): void {
  const ext = readExternalWorkerStatus(dataDir);
  if (!ext || (ext.workerId && ext.workerId !== workerId) || ext.currentJobId !== jobId) return;
  writeExternalWorkerStatus(dataDir, {
    ...ext,
    currentJobId: null,
    state: ext.requiresReauth ? "paused_reauth" : state,
    lastHeartbeatAt: new Date().toISOString(),
  });
}

export interface GeminiWorkerBridgeOptions {
  db: AppDatabase;
  worker: ImageProcessingWorker;
  dataDir: string;
  root: string;
  bridgeTokenFile: string;
  bridgeToken?: string;
  now?: () => number;
}

/**
 * Registers the loopback-only, bearer-token-authenticated HTTP bridge for the dedicated Gemini worker.
 */
export function registerGeminiWorkerBridge(app: FastifyInstance, options: GeminiWorkerBridgeOptions): { token: string } {
  const token = options.bridgeToken ?? loadOrCreateBridgeToken(options.bridgeTokenFile);
  const nowMs = options.now ?? (() => Date.now());

  app.register(
    async (bridge) => {
      bridge.addContentTypeParser(
        "application/octet-stream",
        { parseAs: "buffer" },
        (_req: FastifyRequest, body: Buffer, done) => {
          done(null, body);
        },
      );

      bridge.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
        if (!isLoopbackIp(req.ip)) {
          return reply.code(403).send({ ok: false, error: "Forbidden: localhost only" });
        }
        const provided = extractBearerToken(req);
        if (!tokensMatch(token, provided)) {
          return reply.code(401).send({ ok: false, error: "Unauthorized bridge token" });
        }
      });

      bridge.post("/heartbeat", async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
        if (!workerId) {
          return reply.code(400).send({ ok: false, error: "workerId is required" });
        }
        const stateRaw = typeof body.state === "string" ? body.state : undefined;
        const state: ExternalWorkerStatus["state"] | undefined =
          stateRaw === "starting" ||
          stateRaw === "idle" ||
          stateRaw === "processing" ||
          stateRaw === "paused_reauth" ||
          stateRaw === "stopped"
            ? stateRaw
            : undefined;

        const result = updateExternalWorkerHeartbeat(
          options.db,
          options.dataDir,
          {
            workerId,
            pid: typeof body.pid === "number" ? body.pid : null,
            windowsUser: typeof body.windowsUser === "string" ? body.windowsUser : null,
            sessionId: typeof body.sessionId === "number" ? body.sessionId : null,
            profileExists: Boolean(body.profileExists),
            requiresReauth: Boolean(body.requiresReauth),
            reauthReason: typeof body.reauthReason === "string" ? body.reauthReason : null,
            authenticatedAt: typeof body.authenticatedAt === "string" ? body.authenticatedAt : null,
            chromeAvailable: body.chromeAvailable !== false,
            currentJobId: typeof body.currentJobId === "string" ? body.currentJobId : null,
            state,
          },
          nowMs(),
        );
        options.worker.recoverAbandonedExternalJobs();

        const settings = options.db
          .prepare("SELECT gemini_paused, gemini_requires_reauth FROM portal_settings WHERE id=1")
          .get() as { gemini_paused?: number; gemini_requires_reauth?: number } | undefined;

        return {
          ok: true,
          clearLocalReauth: result.clearLocalReauth,
          enabled: options.worker.isEnabled(),
          paused: Boolean(settings?.gemini_paused || settings?.gemini_requires_reauth),
        };
      });

      bridge.post("/claim", async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
        if (!workerId) {
          return reply.code(400).send({ ok: false, error: "workerId is required" });
        }
        options.worker.recoverAbandonedExternalJobs();
        const job = options.worker.claimNextJob(workerId);
        if (!job) {
          const settings = options.db
            .prepare("SELECT gemini_paused, gemini_requires_reauth FROM portal_settings WHERE id=1")
            .get() as { gemini_paused?: number; gemini_requires_reauth?: number } | undefined;
          return {
            ok: true,
            job: null,
            enabled: options.worker.isEnabled(),
            paused: Boolean(settings?.gemini_paused || settings?.gemini_requires_reauth),
          };
        }

        const ext = readExternalWorkerStatus(options.dataDir);
        if (ext) {
          writeExternalWorkerStatus(options.dataDir, {
            ...ext,
            workerId,
            currentJobId: job.id,
            state: "processing",
            lastHeartbeatAt: new Date(nowMs()).toISOString(),
          });
        }

        const prompt = job.prompt || getConfiguredImagePrompt(options.db, options.dataDir, options.root);
        return {
          ok: true,
          job: {
            id: job.id,
            prompt,
            retryCount: job.retry_count,
            maxRetries: job.max_retries,
          },
        };
      });

      bridge.get("/jobs/:jobId/source", async (req, reply) => {
        const { jobId } = req.params as { jobId: string };
        const query = (req.query ?? {}) as { workerId?: string };
        const headerWorkerId = typeof req.headers["x-worker-id"] === "string" ? req.headers["x-worker-id"] : "";
        const workerId = (query.workerId || headerWorkerId || "").trim();
        if (!workerId) {
          return reply.code(400).send({ ok: false, error: "workerId is required" });
        }

        const job = options.worker.getClaimedJob(jobId, workerId);
        if (!job) {
          return reply.code(404).send({ ok: false, error: "Job is not claimed by this worker" });
        }

        const sourcePath = resolve(options.dataDir, "product-images", `${job.original_image_id}.webp`);
        if (!existsSync(sourcePath)) {
          return reply.code(404).send({ ok: false, error: "Source image file missing" });
        }

        return reply.type("image/webp").send(readFileSync(sourcePath));
      });

      bridge.post(
        "/jobs/:jobId/complete",
        { bodyLimit: 12 * 1024 * 1024 },
        async (req, reply) => {
          const { jobId } = req.params as { jobId: string };
          const query = (req.query ?? {}) as { workerId?: string };
          const headerWorkerId = typeof req.headers["x-worker-id"] === "string" ? req.headers["x-worker-id"] : "";
          const workerId = (query.workerId || headerWorkerId || "").trim();
          if (!workerId) {
            return reply.code(400).send({ ok: false, error: "workerId is required" });
          }

          if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return reply.code(400).send({ ok: false, error: "Processed image binary payload required" });
          }

          try {
            await validateAndNormalizeImage(req.body, { minWidth: 128, minHeight: 128 });
          } catch (err: any) {
            return reply.code(400).send({
              ok: false,
              error: err?.message || "Invalid processed image payload",
            });
          }

          const result = await options.worker.completeClaimedJob(jobId, workerId, req.body);
          clearExternalCurrentJob(options.dataDir, workerId, jobId, "idle");
          if (!result.ok && result.reason === "not_found_or_not_owner") {
            return reply.code(409).send(result);
          }
          return result;
        },
      );

      bridge.post("/jobs/:jobId/fail", async (req, reply) => {
        const { jobId } = req.params as { jobId: string };
        const body = (req.body ?? {}) as Record<string, unknown>;
        const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
        if (!workerId) {
          return reply.code(400).send({ ok: false, error: "workerId is required" });
        }

        const result = await options.worker.failClaimedJob(jobId, workerId, {
          code: typeof body.code === "string" ? body.code : "TRANSIENT_FAILURE",
          message: typeof body.message === "string" ? body.message : "تعذر إتمام معالجة الصورة",
          retryable: body.retryable !== false,
        });
        clearExternalCurrentJob(
          options.dataDir,
          workerId,
          jobId,
          result.outcome === "paused_reauth" ? "paused_reauth" : "idle",
        );
        if (!result.ok) {
          return reply.code(409).send(result);
        }
        return result;
      });

      bridge.post("/auth-completed", async (req) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const status = markExternalWorkerAuthCompleted(options.db, options.dataDir, {
          windowsUser: typeof body.windowsUser === "string" ? body.windowsUser : null,
          authenticatedAt: typeof body.authenticatedAt === "string" ? body.authenticatedAt : null,
          nowMs: nowMs(),
        });
        options.worker.resumeAfterAuth();
        return { ok: true, status };
      });
    },
    { prefix: "/internal/gemini-worker" },
  );

  return { token };
}
