import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProductReader } from "../../../packages/erp/products.js";
import type { AppDatabase } from "../../../packages/storage/database.js";
import { auditPortal } from "../portal-admin.js";
import {
  getConfiguredImagePrompt,
  getImageProcessingConfig,
  isImageProcessingEnabled,
  type GeminiWorkerMode,
  type ImageProcessingConfig,
} from "./config.js";
import {
  GeminiAutomationError,
  GeminiBrowserClient,
  type ImageProcessor,
} from "./gemini-client.js";
import { getGeminiProfileStatus, markGeminiAuthenticated, markGeminiReauthRequired } from "./profile.js";
import { applyStudioCatalogStamp, saveProductImageBlob } from "./storage.js";

export interface ImageProcessingJobRow {
  id: string;
  company_id: string;
  source_identity: string;
  product_id: string;
  unit_id: string;
  product_image_id: string;
  user_id: string;
  original_image_id: string;
  result_image_id: string | null;
  product_code: string | null;
  prompt: string;
  status: "pending" | "processing" | "completed" | "failed";
  retry_count: number;
  max_retries: number;
  next_attempt_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export function enqueueImageProcessingJob(
  db: AppDatabase,
  input: {
    companyId: string;
    sourceIdentity: string;
    productId: string;
    unitId: string;
    productImageId: string;
    userId: string;
    originalImageId: string;
    productCode?: string | null;
    prompt: string;
    maxRetries?: number;
    now?: string;
  },
): string {
  const jobId = randomUUID();
  const now = input.now ?? new Date().toISOString();
  const normalizedCode = input.productCode?.trim() || null;
  db.prepare(
    `INSERT INTO image_processing_jobs(
      id, company_id, source_identity, product_id, unit_id,
      product_image_id, user_id, original_image_id, result_image_id,
      product_code, prompt, status, retry_count, max_retries, next_attempt_at,
      locked_by, locked_at, error_code, error_message,
      created_at, updated_at, started_at, completed_at
    ) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,'pending',0,?,NULL,NULL,NULL,NULL,NULL,?,?,NULL,NULL)`,
  ).run(
    jobId,
    input.companyId,
    input.sourceIdentity,
    input.productId,
    input.unitId,
    input.productImageId,
    input.userId,
    input.originalImageId,
    normalizedCode,
    input.prompt,
    input.maxRetries ?? 3,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO product_image_state(product_image_id, original_image_id, processed_image_id, active_job_id)
     VALUES(?,?,NULL,?)
     ON CONFLICT(product_image_id) DO UPDATE SET
       original_image_id=excluded.original_image_id,
       processed_image_id=NULL,
       active_job_id=excluded.active_job_id`,
  ).run(input.productImageId, input.originalImageId, jobId);
  return jobId;
}

export function recordUnprocessedImageState(
  db: AppDatabase,
  productImageId: string,
  originalImageId: string,
): void {
  db.prepare(
    `INSERT INTO product_image_state (product_image_id, original_image_id, processed_image_id, active_job_id)
     VALUES (?, ?, NULL, NULL)
     ON CONFLICT(product_image_id) DO UPDATE SET
       original_image_id = excluded.original_image_id,
       processed_image_id = NULL,
       active_job_id = NULL`,
  ).run(productImageId, originalImageId);
}

export const EXTERNAL_WORKER_STALE_MS = 90_000;
export const EXTERNAL_JOB_ABANDONED_MS = 6 * 60_000;

export interface ExternalWorkerStatus {
  workerId: string;
  pid: number | null;
  windowsUser: string | null;
  sessionId: number | null;
  profileExists: boolean;
  requiresReauth: boolean;
  reauthReason: string | null;
  authenticatedAt: string | null;
  chromeAvailable: boolean;
  currentJobId: string | null;
  state: "starting" | "idle" | "processing" | "paused_reauth" | "stopped";
  lastHeartbeatAt: string;
  clearLocalReauthPending?: boolean;
}

function getExternalWorkerStatusFile(dataDir: string): string {
  return resolve(dataDir, "gemini-worker-status.json");
}

/**
 * Reads the persisted heartbeat and authentication snapshot of the dedicated Gemini worker.
 */
export function readExternalWorkerStatus(dataDir: string): ExternalWorkerStatus | null {
  const file = getExternalWorkerStatusFile(dataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ExternalWorkerStatus>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.lastHeartbeatAt !== "string") {
      return null;
    }
    return {
      workerId: typeof parsed.workerId === "string" ? parsed.workerId : "",
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      windowsUser: typeof parsed.windowsUser === "string" ? parsed.windowsUser : null,
      sessionId: typeof parsed.sessionId === "number" ? parsed.sessionId : null,
      profileExists: Boolean(parsed.profileExists),
      requiresReauth: Boolean(parsed.requiresReauth),
      reauthReason: typeof parsed.reauthReason === "string" ? parsed.reauthReason : null,
      authenticatedAt: typeof parsed.authenticatedAt === "string" ? parsed.authenticatedAt : null,
      chromeAvailable: parsed.chromeAvailable !== false,
      currentJobId: typeof parsed.currentJobId === "string" ? parsed.currentJobId : null,
      state:
        parsed.state === "starting" ||
        parsed.state === "idle" ||
        parsed.state === "processing" ||
        parsed.state === "paused_reauth" ||
        parsed.state === "stopped"
          ? parsed.state
          : "idle",
      lastHeartbeatAt: parsed.lastHeartbeatAt,
      clearLocalReauthPending: Boolean(parsed.clearLocalReauthPending),
    };
  } catch {
    return null;
  }
}

/**
 * Atomically persists external Gemini worker diagnostics inside dataDir.
 */
export function writeExternalWorkerStatus(dataDir: string, status: ExternalWorkerStatus): void {
  const file = getExternalWorkerStatusFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
  renameSync(tmp, file);
}

/**
 * Returns true if the external worker reported a non-stopped heartbeat within EXTERNAL_WORKER_STALE_MS.
 */
export function isExternalWorkerConnected(status: ExternalWorkerStatus | null, nowMs = Date.now()): boolean {
  if (!status || status.state === "stopped") return false;
  const ts = Date.parse(status.lastHeartbeatAt);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= EXTERNAL_WORKER_STALE_MS;
}

/**
 * Updates external worker heartbeat state and synchronizes reauth pause state with portal_settings.
 */
export function updateExternalWorkerHeartbeat(
  db: AppDatabase,
  dataDir: string,
  payload: {
    workerId: string;
    pid?: number | null;
    windowsUser?: string | null;
    sessionId?: number | null;
    profileExists?: boolean;
    requiresReauth?: boolean;
    reauthReason?: string | null;
    authenticatedAt?: string | null;
    chromeAvailable?: boolean;
    currentJobId?: string | null;
    state?: ExternalWorkerStatus["state"];
  },
  nowMs = Date.now(),
): { clearLocalReauth: boolean; status: ExternalWorkerStatus } {
  const existing = readExternalWorkerStatus(dataDir);
  const nowIso = new Date(nowMs).toISOString();
  const clearLocalReauth = Boolean(existing?.clearLocalReauthPending);
  const reportedRequiresReauth = clearLocalReauth ? false : Boolean(payload.requiresReauth);
  const reportedReason = clearLocalReauth ? null : payload.reauthReason ?? null;

  if (reportedRequiresReauth) {
    db.prepare(
      "UPDATE portal_settings SET gemini_paused=1, gemini_requires_reauth=1, gemini_pause_reason=? WHERE id=1",
    ).run(reportedReason ?? "REAUTH_REQUIRED");
  }

  const next: ExternalWorkerStatus = {
    workerId: payload.workerId,
    pid: payload.pid ?? null,
    windowsUser: payload.windowsUser ?? existing?.windowsUser ?? null,
    sessionId: payload.sessionId ?? null,
    profileExists: Boolean(payload.profileExists ?? existing?.profileExists),
    requiresReauth: reportedRequiresReauth,
    reauthReason: reportedReason,
    authenticatedAt: payload.authenticatedAt ?? existing?.authenticatedAt ?? null,
    chromeAvailable: payload.chromeAvailable !== false,
    currentJobId: payload.currentJobId ?? null,
    state: payload.state ?? (reportedRequiresReauth ? "paused_reauth" : "idle"),
    lastHeartbeatAt: nowIso,
    clearLocalReauthPending: clearLocalReauth && Boolean(payload.requiresReauth),
  };
  writeExternalWorkerStatus(dataDir, next);
  return { clearLocalReauth, status: next };
}

/**
 * Records completion of interactive Gemini login in external-worker mode and clears any pause state.
 */
export function markExternalWorkerAuthCompleted(
  db: AppDatabase,
  dataDir: string,
  payload?: { windowsUser?: string | null; authenticatedAt?: string | null; nowMs?: number },
): ExternalWorkerStatus {
  const nowIso = new Date(payload?.nowMs ?? Date.now()).toISOString();
  const existing = readExternalWorkerStatus(dataDir);
  db.prepare(
    "UPDATE portal_settings SET gemini_paused=0, gemini_requires_reauth=0, gemini_pause_reason=NULL WHERE id=1",
  ).run();
  const next: ExternalWorkerStatus = {
    workerId: existing?.workerId ?? "",
    pid: existing?.pid ?? null,
    windowsUser: payload?.windowsUser ?? existing?.windowsUser ?? null,
    sessionId: existing?.sessionId ?? null,
    profileExists: true,
    requiresReauth: false,
    reauthReason: null,
    authenticatedAt: payload?.authenticatedAt ?? nowIso,
    chromeAvailable: existing?.chromeAvailable ?? true,
    currentJobId: existing?.currentJobId ?? null,
    state: existing?.state === "paused_reauth" ? "idle" : existing?.state ?? "idle",
    lastHeartbeatAt: existing?.lastHeartbeatAt ?? nowIso,
    clearLocalReauthPending: false,
  };
  writeExternalWorkerStatus(dataDir, next);
  return next;
}

/**
 * Marks any stale external local reauth flag to be cleared on the next worker heartbeat.
 */
export function clearExternalWorkerReauth(dataDir: string, nowMs = Date.now()): void {
  const existing = readExternalWorkerStatus(dataDir);
  if (!existing) return;
  writeExternalWorkerStatus(dataDir, {
    ...existing,
    requiresReauth: false,
    reauthReason: null,
    clearLocalReauthPending: true,
    lastHeartbeatAt: existing.lastHeartbeatAt || new Date(nowMs).toISOString(),
  });
}

export function getImageProcessingStatusSummary(
  db: AppDatabase,
  profileRoot: string,
  companyId?: string,
  options?: { dataDir?: string; workerMode?: GeminiWorkerMode; nowMs?: number },
) {
  const settings = db
    .prepare(
      "SELECT gemini_paused, gemini_pause_reason, gemini_requires_reauth, image_processing_enabled FROM portal_settings WHERE id=1",
    )
    .get() as
    | {
        gemini_paused?: number;
        gemini_pause_reason?: string | null;
        gemini_requires_reauth?: number;
        image_processing_enabled?: number;
      }
    | undefined;
  const workerMode: GeminiWorkerMode = options?.workerMode ?? "in-process";
  const ext = workerMode === "external" && options?.dataDir ? readExternalWorkerStatus(options.dataDir) : null;
  const profile =
    workerMode === "external"
      ? {
          profileExists: Boolean(ext?.profileExists),
          requiresReauth: Boolean(ext?.requiresReauth && !ext?.clearLocalReauthPending),
          reauthReason: ext?.requiresReauth && !ext?.clearLocalReauthPending ? ext.reauthReason : null,
          authenticatedAt: ext?.authenticatedAt ?? null,
        }
      : getGeminiProfileStatus(profileRoot);

  const where = companyId ? "WHERE company_id=?" : "";
  const countsRows = (
    companyId
      ? db.prepare(`SELECT status, COUNT(*) count FROM image_processing_jobs ${where} GROUP BY status`).all(companyId)
      : db.prepare(`SELECT status, COUNT(*) count FROM image_processing_jobs GROUP BY status`).all()
  ) as Array<{ status: string; count: number }>;

  const counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of countsRows) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row.count;
    }
  }

  return {
    enabled: Boolean(settings?.image_processing_enabled ?? 1),
    paused: Boolean(settings?.gemini_paused) || profile.requiresReauth,
    requiresReauth: Boolean(settings?.gemini_requires_reauth) || profile.requiresReauth,
    pauseReason: settings?.gemini_pause_reason ?? profile.reauthReason ?? null,
    profileExists: profile.profileExists,
    authenticatedAt: profile.authenticatedAt,
    workerMode,
    worker:
      workerMode === "external"
        ? {
            connected: isExternalWorkerConnected(ext, options?.nowMs),
            workerId: ext?.workerId ?? null,
            pid: ext?.pid ?? null,
            windowsUser: ext?.windowsUser ?? null,
            sessionId: ext?.sessionId ?? null,
            chromeAvailable: ext?.chromeAvailable ?? null,
            currentJobId: ext?.currentJobId ?? null,
            state: ext?.state ?? "offline",
            lastHeartbeatAt: ext?.lastHeartbeatAt ?? null,
          }
        : null,
    counts,
  };
}

export class ImageProcessingWorker {
  private readonly workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopping = false;
  private loginInProgress = false;
  private nextCooldownAt = 0;
  private activePollMs?: number;
  private readonly cooldownMs: number;
  private processor: ImageProcessor;
  private config: ImageProcessingConfig;

  constructor(
    private readonly db: AppDatabase,
    private readonly options: {
      dataDir: string;
      root: string;
      reader?: ProductReader;
      processor?: ImageProcessor;
      workerMode?: GeminiWorkerMode;
      cooldownMs?: number;
      now?: () => number;
      log?: (event: string, fields?: Record<string, unknown>) => void;
    },
  ) {
    const baseCfg = getImageProcessingConfig({ db, dataDir: options.dataDir, root: options.root });
    this.config = options.workerMode ? { ...baseCfg, workerMode: options.workerMode } : baseCfg;
    this.cooldownMs = options.cooldownMs ?? (options.processor ? 0 : this.config.jobCooldownMs);
    this.processor =
      options.processor ??
      new GeminiBrowserClient(this.config, options.root, (event, fields) => this.logEvent(event, fields));
    this.recoverStaleJobs();
  }

  getWorkerMode(): GeminiWorkerMode {
    return this.config.workerMode;
  }

  isEnabled(): boolean {
    return this.config.workerEnabled && isImageProcessingEnabled(this.db);
  }

  private nowMs(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private logEvent(event: string, fields: Record<string, unknown> = {}) {
    if (this.options.log) {
      this.options.log(event, fields);
      return;
    }
    const safeFields = { ...fields };
    for (const sensitive of ["cookie", "cookies", "password", "token", "auth"]) {
      delete safeFields[sensitive];
    }
    console.log(JSON.stringify({ ts: new Date().toISOString(), component: "image-worker", event, ...safeFields }));
  }

  private recoverProcessingJobRow(job: ImageProcessingJobRow, nowIso: string): "recovered" | "failed_final" | "stale_removed" {
    const img = this.db
      .prepare(
        `SELECT pi.id, pi.deleted_at, s.active_job_id
         FROM product_images pi
         LEFT JOIN product_image_state s ON s.product_image_id = pi.id
         WHERE pi.id=?`,
      )
      .get(job.product_image_id) as { id: string; deleted_at: string | null; active_job_id: string | null } | undefined;

    if (!img || img.deleted_at !== null || img.active_job_id !== job.id) {
      this.db
        .prepare(
          `UPDATE image_processing_jobs
           SET status='failed', error_code='STALE_JOB', error_message='تم إلغاء المهمة لأن الصورة حُذفت أو استُبدلت',
               locked_by=NULL, locked_at=NULL, updated_at=?
           WHERE id=? AND status='processing'`,
        )
        .run(nowIso, job.id);
      return "stale_removed";
    }

    if (job.retry_count < job.max_retries) {
      this.db
        .prepare(
          `UPDATE image_processing_jobs
           SET status='pending', retry_count=retry_count+1, next_attempt_at=?,
               locked_by=NULL, locked_at=NULL, error_code='CRASH_RECOVERED',
               error_message='تمت استعادة المهمة بعد توقف التشغيل', updated_at=?
           WHERE id=? AND status='processing'`,
        )
        .run(nowIso, nowIso, job.id);
      return "recovered";
    }

    this.db
      .prepare(
        `UPDATE image_processing_jobs
         SET status='failed', error_code='CRASH_RECOVERY_EXCEEDED',
             error_message='تجاوزت المهمة الحد الأقصى لمحاولات الاستعادة بعد توقف التشغيل',
             locked_by=NULL, locked_at=NULL, updated_at=?
         WHERE id=? AND status='processing'`,
      )
      .run(nowIso, job.id);
    return "failed_final";
  }

  /**
   * Recovers any jobs left in `processing` after a server crash or abrupt restart.
   */
  recoverStaleJobs(): number {
    const nowIso = new Date(this.nowMs()).toISOString();
    const stale = this.db
      .prepare("SELECT * FROM image_processing_jobs WHERE status='processing'")
      .all() as ImageProcessingJobRow[];
    if (!stale.length) return 0;

    let recovered = 0;
    this.db.transaction(() => {
      for (const job of stale) {
        if (this.recoverProcessingJobRow(job, nowIso) === "recovered") {
          recovered++;
        }
      }
    })();

    this.logEvent("stale_jobs_recovered", { total: stale.length, requeued: recovered });
    return stale.length;
  }

  /**
   * Recovers processing jobs abandoned by a crashed or stale external worker.
   */
  recoverAbandonedExternalJobs(): number {
    if (this.config.workerMode !== "external") return 0;
    const processing = this.db
      .prepare("SELECT * FROM image_processing_jobs WHERE status='processing'")
      .all() as ImageProcessingJobRow[];
    if (!processing.length) return 0;

    const now = this.nowMs();
    const nowIso = new Date(now).toISOString();
    const ext = readExternalWorkerStatus(this.options.dataDir);
    const workerAlive = isExternalWorkerConnected(ext, now);

    const abandoned = processing.filter((job) => {
      if (ext?.workerId && job.locked_by && job.locked_by !== ext.workerId) {
        return true;
      }
      const lockedAtMs = job.locked_at ? Date.parse(job.locked_at) : 0;
      const ageMs = lockedAtMs ? now - lockedAtMs : EXTERNAL_JOB_ABANDONED_MS + 1;
      if (!workerAlive && ageMs > EXTERNAL_WORKER_STALE_MS) {
        return true;
      }
      return ageMs > EXTERNAL_JOB_ABANDONED_MS;
    });

    if (!abandoned.length) return 0;
    let recovered = 0;
    this.db.transaction(() => {
      for (const job of abandoned) {
        if (this.recoverProcessingJobRow(job, nowIso) === "recovered") {
          recovered++;
        }
      }
    })();

    this.logEvent("abandoned_external_jobs_recovered", { total: abandoned.length, requeued: recovered });
    return abandoned.length;
  }

  start(intervalMs?: number) {
    const pollMs = intervalMs ?? this.activePollMs ?? this.config.pollIntervalMs;
    this.activePollMs = pollMs;
    if (!this.isEnabled()) return;
    if (this.timer) return;
    this.stopping = false;
    if (this.config.workerMode === "external") {
      // In external mode, never claim jobs or launch local Chromium; only sweep abandoned locks.
      this.timer = setInterval(() => {
        try {
          this.recoverAbandonedExternalJobs();
        } catch (err: any) {
          this.logEvent("external_recovery_error", { error: err?.message ?? String(err) });
        }
      }, Math.max(pollMs, 15_000));
      this.timer.unref();
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logEvent("worker_tick_error", { error: err?.message ?? String(err) });
      });
    }, pollMs);
    this.timer.unref();
    // Trigger an immediate tick on startup in case recovered/pending jobs are waiting.
    this.notify();
  }

  notify() {
    if (this.config.workerMode === "external") return;
    if (this.stopping || this.loginInProgress || !this.isEnabled()) return;
    setImmediate(() => {
      void this.tick().catch((err) => {
        this.logEvent("worker_notify_error", { error: err?.message ?? String(err) });
      });
    });
  }

  async stop() {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
    if (this.config.workerMode !== "external") {
      await this.processor.close?.().catch(() => {});
    }
  }

  async setProcessingEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.stop();
      this.logEvent("worker_disabled");
      return;
    }
    this.stopping = false;
    if (!this.isEnabled()) return;
    this.start(this.activePollMs ?? this.config.pollIntervalMs);
    this.logEvent("worker_enabled");
  }

  async beginInteractiveLogin(): Promise<void> {
    this.loginInProgress = true;
    await this.inFlight;
    if (this.config.workerMode !== "external") {
      await this.processor.close?.().catch(() => {});
    }
    this.logEvent("worker_paused_for_login");
  }

  endInteractiveLogin(authenticated: boolean): void {
    this.loginInProgress = false;
    if (authenticated) {
      this.resumeAfterAuth();
      return;
    }
    if (!this.stopping && this.isEnabled()) {
      this.notify();
    }
  }

  tick(): Promise<void> {
    if (this.config.workerMode === "external") {
      this.recoverAbandonedExternalJobs();
      return Promise.resolve();
    }
    if (this.stopping || this.loginInProgress || !this.isEnabled()) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.drainQueue().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  resumeAfterAuth() {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE portal_settings SET gemini_paused=0, gemini_requires_reauth=0, gemini_pause_reason=NULL WHERE id=1")
        .run();
    })();
    if (this.config.workerMode === "external") {
      clearExternalWorkerReauth(this.options.dataDir, this.nowMs());
      this.logEvent("worker_resumed", { workerMode: "external" });
      return;
    }
    markGeminiAuthenticated(this.config.profileRoot);
    this.logEvent("worker_resumed");
    this.notify();
  }

  private isPaused(): boolean {
    const row = this.db
      .prepare("SELECT gemini_paused, gemini_requires_reauth FROM portal_settings WHERE id=1")
      .get() as { gemini_paused?: number; gemini_requires_reauth?: number } | undefined;
    if (row?.gemini_paused || row?.gemini_requires_reauth) return true;
    if (this.config.workerMode === "external") {
      const ext = readExternalWorkerStatus(this.options.dataDir);
      if (ext?.requiresReauth && !ext.clearLocalReauthPending) {
        this.db
          .prepare("UPDATE portal_settings SET gemini_paused=1, gemini_requires_reauth=1, gemini_pause_reason=? WHERE id=1")
          .run(ext.reauthReason ?? "REAUTH_REQUIRED");
        return true;
      }
      return false;
    }
    const profile = getGeminiProfileStatus(this.config.profileRoot);
    if (profile.requiresReauth) {
      this.db
        .prepare("UPDATE portal_settings SET gemini_paused=1, gemini_requires_reauth=1, gemini_pause_reason=? WHERE id=1")
        .run(profile.reauthReason ?? "REAUTH_REQUIRED");
      return true;
    }
    return false;
  }

  /**
   * Atomically claims the next eligible pending job for either the in-process worker or a verified external worker.
   */
  claimNextJob(claimerId = this.workerId): ImageProcessingJobRow | null {
    if (this.stopping || this.loginInProgress || !this.isEnabled() || this.isPaused()) return null;
    const nowIso = new Date(this.nowMs()).toISOString();
    return this.db.transaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT j.id FROM image_processing_jobs j
           JOIN product_images pi ON pi.id = j.product_image_id
           JOIN product_image_state s ON s.product_image_id = pi.id
           WHERE j.status = 'pending'
             AND pi.deleted_at IS NULL
             AND s.active_job_id = j.id
             AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
           ORDER BY j.created_at ASC, j.id ASC
           LIMIT 1`,
        )
        .get(nowIso) as { id: string } | undefined;
      if (!candidate) return null;

      const updated = this.db
        .prepare(
          `UPDATE image_processing_jobs
           SET status='processing',
               locked_by=?,
               locked_at=?,
               started_at=COALESCE(started_at, ?),
               updated_at=?
           WHERE id=? AND status='pending'
           RETURNING *`,
        )
        .get(claimerId, nowIso, nowIso, nowIso, candidate.id) as ImageProcessingJobRow | undefined;

      return updated ?? null;
    })();
  }

  /**
   * Returns a claimed job only if it is still locked by `ownerId` in `processing` state.
   */
  getClaimedJob(jobId: string, ownerId: string): ImageProcessingJobRow | null {
    const row = this.db
      .prepare("SELECT * FROM image_processing_jobs WHERE id=? AND status='processing' AND locked_by=?")
      .get(jobId, ownerId) as ImageProcessingJobRow | undefined;
    return row ?? null;
  }

  private async drainQueue() {
    let processedAny = false;
    try {
      while (!this.stopping && !this.loginInProgress && this.isEnabled()) {
        if (this.cooldownMs > 0 && this.nowMs() < this.nextCooldownAt) {
          break;
        }
        const job = this.claimNextJob(this.workerId);
        if (!job) break;
        processedAny = true;
        await this.processSingleJob(job);
        if (this.cooldownMs > 0) {
          const jitter = Math.round(this.cooldownMs * 0.4 * Math.random());
          this.nextCooldownAt = this.nowMs() + this.cooldownMs + jitter;
          break;
        }
      }
    } finally {
      if (processedAny) {
        // Release browser lock & memory when burst completes so maintenance/login can run cleanly.
        await this.processor.close?.().catch(() => {});
      }
    }
  }

  private async processSingleJob(job: ImageProcessingJobRow) {
    this.logEvent("job_started", {
      jobId: job.id,
      productImageId: job.product_image_id,
      productId: job.product_id,
      retryCount: job.retry_count,
    });

    const sourcePath = resolve(this.options.dataDir, "product-images", `${job.original_image_id}.webp`);
    try {
      const prompt = job.prompt || getConfiguredImagePrompt(this.db, this.options.dataDir, this.options.root);
      const result = await this.processor.process({
        jobId: job.id,
        sourceImagePath: sourcePath,
        prompt,
      });
      await this.completeClaimedJob(job.id, this.workerId, result.buffer);
    } catch (error: any) {
      await this.handleJobFailure(job, error);
    }
  }

  /**
   * Validates job ownership, applies studio watermark/code stamp, saves the processed image blob, and commits DB state.
   */
  async completeClaimedJob(
    jobId: string,
    ownerId: string,
    rawProcessedBuffer: Buffer,
  ): Promise<{ ok: boolean; reason?: "not_found_or_not_owner" | "stale_superseded"; resultImageId?: string }> {
    const job = this.getClaimedJob(jobId, ownerId);
    if (!job) {
      return { ok: false, reason: "not_found_or_not_owner" };
    }

    const stampSettings = this.db
      .prepare("SELECT watermark_logo, watermark_logo_enabled, watermark_code_enabled FROM portal_settings WHERE id=1")
      .get() as
      | {
          watermark_logo: Buffer | Uint8Array | null;
          watermark_logo_enabled?: number | null;
          watermark_code_enabled?: number | null;
        }
      | undefined;
    const logoEnabled = (stampSettings?.watermark_logo_enabled ?? 1) !== 0;
    const codeEnabled = (stampSettings?.watermark_code_enabled ?? 1) !== 0;
    let productCode = "";
    if (codeEnabled) {
      productCode = job.product_code?.trim() || "";
      if (!productCode && this.options.reader) {
        const item = await this.options.reader.get(job.company_id, job.product_id, job.unit_id).catch(() => undefined);
        productCode = item?.code?.trim() || "";
      }
    }
    const logoBuffer =
      logoEnabled && stampSettings?.watermark_logo ? Buffer.from(stampSettings.watermark_logo) : null;
    const finalBuffer = await applyStudioCatalogStamp(rawProcessedBuffer, {
      logoBuffer,
      productCode,
    });

    const saved = await saveProductImageBlob(this.options.dataDir, finalBuffer);
    let committed = false;
    try {
      const nowIso = new Date(this.nowMs()).toISOString();
      committed = this.db.transaction(() => {
        const current = this.getClaimedJob(job.id, ownerId);
        if (!current) {
          return false;
        }
        const img = this.db
          .prepare(
            `SELECT pi.id, pi.deleted_at, pi.company_id, s.active_job_id
             FROM product_images pi
             LEFT JOIN product_image_state s ON s.product_image_id = pi.id
             WHERE pi.id=?`,
          )
          .get(job.product_image_id) as
          | { id: string; deleted_at: string | null; active_job_id: string | null; company_id: string }
          | undefined;

        if (!img || img.deleted_at !== null || img.active_job_id !== job.id) {
          this.db
            .prepare(
              `UPDATE image_processing_jobs
               SET status='failed',
                   error_code='STALE_JOB_SUPERSEDED',
                   error_message='تم تجاهل النتيجة لأن الصورة حُذفت أو استُبدلت أثناء المعالجة',
                   locked_by=NULL, locked_at=NULL, updated_at=?
               WHERE id=?`,
            )
            .run(nowIso, job.id);
          auditPortal(this.db, job.company_id, "product.image.job_discarded_stale", {
            jobId: job.id,
            imageId: job.product_image_id,
          });
          return false;
        }

        this.db
          .prepare("UPDATE product_image_state SET processed_image_id=? WHERE product_image_id=?")
          .run(saved.id, job.product_image_id);
        this.db
          .prepare(
            `UPDATE image_processing_jobs
             SET status='completed',
                 result_image_id=?,
                 completed_at=?,
                 updated_at=?,
                 locked_by=NULL,
                 locked_at=NULL,
                 error_code=NULL,
                 error_message=NULL
             WHERE id=?`,
          )
          .run(saved.id, nowIso, nowIso, job.id);
        auditPortal(this.db, job.company_id, "product.image.processed", {
          jobId: job.id,
          imageId: job.product_image_id,
          resultImageId: saved.id,
        });
        return true;
      })();
    } finally {
      if (!committed) {
        await saved.cleanup();
      }
    }

    this.logEvent(committed ? "job_completed" : "job_discarded_stale", {
      jobId: job.id,
      productImageId: job.product_image_id,
      resultImageId: committed ? saved.id : null,
      ownerId,
    });
    return committed
      ? { ok: true, resultImageId: saved.id }
      : { ok: false, reason: "stale_superseded" };
  }

  /**
   * Records a failure reported by an external or in-process owner while preserving retry/reauth semantics.
   */
  async failClaimedJob(
    jobId: string,
    ownerId: string,
    error: unknown,
  ): Promise<{ ok: boolean; outcome?: "paused_reauth" | "retried" | "failed" | "stale" }> {
    const job = this.getClaimedJob(jobId, ownerId);
    if (!job) {
      return { ok: false };
    }
    const outcome = await this.handleJobFailure(job, error);
    return { ok: true, outcome };
  }

  private async handleJobFailure(
    job: ImageProcessingJobRow,
    error: any,
  ): Promise<"paused_reauth" | "retried" | "failed" | "stale"> {
    const now = this.nowMs();
    const nowIso = new Date(now).toISOString();

    const classified =
      error instanceof GeminiAutomationError
        ? error
        : new GeminiAutomationError(
            typeof error?.code === "string" && error.code ? error.code : "TRANSIENT_FAILURE",
            error?.message || "تعذر إتمام معالجة الصورة",
            error?.retryable !== false,
          );

    if (classified.code === "REAUTH_REQUIRED" || classified.code === "CAPTCHA_OR_CHALLENGE") {
      if (this.config.workerMode === "external") {
        const existing = readExternalWorkerStatus(this.options.dataDir);
        writeExternalWorkerStatus(this.options.dataDir, {
          workerId: existing?.workerId ?? job.locked_by ?? "",
          pid: existing?.pid ?? null,
          windowsUser: existing?.windowsUser ?? null,
          sessionId: existing?.sessionId ?? null,
          profileExists: existing?.profileExists ?? true,
          requiresReauth: true,
          reauthReason: classified.code,
          authenticatedAt: existing?.authenticatedAt ?? null,
          chromeAvailable: existing?.chromeAvailable ?? true,
          currentJobId: null,
          state: "paused_reauth",
          lastHeartbeatAt: existing?.lastHeartbeatAt ?? nowIso,
          clearLocalReauthPending: false,
        });
      } else {
        markGeminiReauthRequired(this.config.profileRoot, classified.code);
      }
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE portal_settings SET gemini_paused=1, gemini_requires_reauth=1, gemini_pause_reason=? WHERE id=1")
          .run(classified.code);
        this.db
          .prepare(
            `UPDATE image_processing_jobs
             SET status='failed',
                 error_code=?,
                 error_message=?,
                 locked_by=NULL,
                 locked_at=NULL,
                 updated_at=?
             WHERE id=?`,
          )
          .run(classified.code, classified.message, nowIso, job.id);
        auditPortal(this.db, job.company_id, "product.image.job_paused_reauth", {
          jobId: job.id,
          imageId: job.product_image_id,
          code: classified.code,
        });
      })();
      if (this.config.workerMode !== "external") {
        await this.processor.close?.().catch(() => {});
      }
      this.logEvent("worker_paused_reauth", { jobId: job.id, code: classified.code });
      return "paused_reauth";
    }

    // Never revive or retry if image was deleted or superseded while running.
    const currentImage = this.db
      .prepare(
        `SELECT pi.deleted_at, s.active_job_id
         FROM product_images pi
         LEFT JOIN product_image_state s ON s.product_image_id = pi.id
         WHERE pi.id=?`,
      )
      .get(job.product_image_id) as { deleted_at: string | null; active_job_id: string | null } | undefined;
    if (!currentImage || currentImage.deleted_at !== null || currentImage.active_job_id !== job.id) {
      this.db
        .prepare(
          `UPDATE image_processing_jobs
           SET status='failed', error_code='STALE_JOB_SUPERSEDED',
               error_message='تم إلغاء المهمة لأن الصورة حُذفت أو استُبدلت',
               locked_by=NULL, locked_at=NULL, updated_at=?
           WHERE id=?`,
        )
        .run(nowIso, job.id);
      this.logEvent("job_aborted_stale", { jobId: job.id });
      return "stale";
    }

    if (classified.retryable && job.retry_count < job.max_retries) {
      const attempt = job.retry_count;
      const base =
        classified.code === "RATE_LIMITED"
          ? this.config.rateLimitBackoffMs * 2 ** attempt
          : Math.min(this.config.baseBackoffMs * 2 ** attempt, this.config.maxBackoffMs);
      const jitter = Math.floor(base * 0.15 * Math.random());
      const nextAttempt = new Date(now + base + jitter).toISOString();

      this.db
        .prepare(
          `UPDATE image_processing_jobs
           SET status='pending',
               retry_count=retry_count+1,
               next_attempt_at=?,
               error_code=?,
               error_message=?,
               locked_by=NULL,
               locked_at=NULL,
               updated_at=?
           WHERE id=?`,
        )
        .run(nextAttempt, classified.code, classified.message, nowIso, job.id);

      this.logEvent("job_retry_scheduled", {
        jobId: job.id,
        retryCount: attempt + 1,
        maxRetries: job.max_retries,
        nextAttempt,
        code: classified.code,
      });
      return "retried";
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE image_processing_jobs
           SET status='failed',
               error_code=?,
               error_message=?,
               locked_by=NULL,
               locked_at=NULL,
               updated_at=?
           WHERE id=?`,
        )
        .run(classified.code, classified.message, nowIso, job.id);
      auditPortal(this.db, job.company_id, "product.image.job_failed", {
        jobId: job.id,
        imageId: job.product_image_id,
        code: classified.code,
      });
    })();

    this.logEvent("job_failed", {
      jobId: job.id,
      productImageId: job.product_image_id,
      code: classified.code,
      retries: job.retry_count,
    });
    return "failed";
  }
}
