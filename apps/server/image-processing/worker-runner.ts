import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { watchSupervisor } from "../../../packages/runtime/supervisor.js";
import { readBridgeToken } from "./bridge.js";
import { getImageProcessingConfig, resolveChromiumExecutable } from "./config.js";
import { GeminiAutomationError, GeminiBrowserClient } from "./gemini-client.js";
import { getGeminiProfileStatus, markGeminiAuthenticated, markGeminiReauthRequired } from "./profile.js";

function logWorkerEvent(event: string, fields: Record<string, unknown> = {}) {
  const safe = { ...fields };
  for (const key of ["cookie", "cookies", "password", "token", "auth"]) {
    delete safe[key];
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "gemini-worker-runner", event, ...safe }));
}

function getArgValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function runExternalGeminiWorker(options?: {
  root?: string;
  dataDir?: string;
  bridgeUrl?: string;
  bridgeTokenFile?: string;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const root = resolve(options?.root ?? getArgValue("--root") ?? process.env.EMOJI_APP_ROOT ?? process.cwd());
  const profileDirArg = options?.dataDir ?? getArgValue("--profile-root") ?? process.env.GEMINI_PROFILE_DIR ?? resolve(root, "gemini-worker");
  const dataDir = resolve(profileDirArg);
  const baseCfg = getImageProcessingConfig({ dataDir, root });
  const cfg = {
    ...baseCfg,
    directProfile: true,
    profileRoot: dataDir,
    profileDir: join(dataDir, "profile"),
    loginProfileDir: join(dataDir, "login-profile"),
    bridgeUrl: (options?.bridgeUrl ?? baseCfg.bridgeUrl).replace(/\/+$/, ""),
    bridgeTokenFile: resolve(options?.bridgeTokenFile ?? baseCfg.bridgeTokenFile),
  };

  const workerId = `ext-${process.pid}-${randomUUID().slice(0, 8)}`;
  const windowsUser = process.env.EMOJI_WORKER_WINDOWS_USER || process.env.USERNAME || null;
  const parsedSessionId = process.env.EMOJI_WORKER_SESSION_ID ? Number(process.env.EMOJI_WORKER_SESSION_ID) : null;
  const sessionId = parsedSessionId !== null && Number.isFinite(parsedSessionId) ? parsedSessionId : null;
  const chromeExecutable = resolveChromiumExecutable(root);
  const client = new GeminiBrowserClient(cfg, root, logWorkerEvent);

  let stopping = false;
  let currentJobId: string | null = null;
  let currentState: "starting" | "idle" | "processing" | "paused_reauth" | "stopped" = "starting";
  let nextCooldownAt = 0;

  const getToken = () => readBridgeToken(cfg.bridgeTokenFile);

  const authHeaders = (extra: Record<string, string> = {}): Record<string, string> | null => {
    const token = getToken();
    if (!token) return null;
    return {
      Authorization: `Bearer ${token}`,
      "x-worker-id": workerId,
      ...extra,
    };
  };

  const sendHeartbeat = async (stateOverride?: typeof currentState) => {
    const headers = authHeaders({ "Content-Type": "application/json" });
    if (!headers) return;
    const status = getGeminiProfileStatus(cfg.profileRoot);
    const state = stateOverride ?? (status.requiresReauth ? "paused_reauth" : currentState);
    try {
      const res = await fetchWithTimeout(
        `${cfg.bridgeUrl}/internal/gemini-worker/heartbeat`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            workerId,
            pid: process.pid,
            windowsUser,
            sessionId,
            profileExists: status.profileExists,
            requiresReauth: status.requiresReauth,
            reauthReason: status.reauthReason,
            authenticatedAt: status.authenticatedAt,
            chromeAvailable: Boolean(chromeExecutable),
            currentJobId,
            state,
          }),
        },
        10_000,
      );
      if (res.ok) {
        const body = (await res.json()) as { clearLocalReauth?: boolean };
        if (body?.clearLocalReauth) {
          markGeminiAuthenticated(cfg.profileRoot);
          if (currentState === "paused_reauth") {
            currentState = "idle";
          }
          logWorkerEvent("local_reauth_cleared_by_portal");
        }
      }
    } catch {}
  };

  const uploadCompletionWithRetry = async (jobId: string, buffer: Buffer): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = authHeaders({ "Content-Type": "application/octet-stream" });
      if (!headers) {
        throw new Error("Bridge token file unavailable");
      }
      try {
        const res = await fetchWithTimeout(
          `${cfg.bridgeUrl}/internal/gemini-worker/jobs/${encodeURIComponent(jobId)}/complete?workerId=${encodeURIComponent(workerId)}`,
          {
            method: "POST",
            headers,
            body: new Uint8Array(buffer),
          },
          30_000,
        );
        if (res.ok) return;
        const text = await res.text().catch(() => "");
        if (res.status === 409) {
          logWorkerEvent("completion_rejected_not_owner", { jobId, status: res.status, body: text.slice(0, 200) });
          return;
        }
        lastError = new Error(`Bridge completion failed (${res.status}): ${text.slice(0, 200)}`);
      } catch (err) {
        lastError = err;
      }
      await sleep(1000 * (attempt + 1));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  const reportFailure = async (jobId: string, error: unknown): Promise<void> => {
    const classified =
      error instanceof GeminiAutomationError
        ? error
        : new GeminiAutomationError(
            "TRANSIENT_FAILURE",
            error instanceof Error ? error.message : String(error || "تعذر إتمام معالجة الصورة"),
            true,
          );
    if (classified.code === "REAUTH_REQUIRED" || classified.code === "CAPTCHA_OR_CHALLENGE") {
      markGeminiReauthRequired(cfg.profileRoot, classified.code);
      currentState = "paused_reauth";
      await client.close().catch(() => {});
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = authHeaders({ "Content-Type": "application/json" });
      if (!headers) return;
      try {
        const res = await fetchWithTimeout(
          `${cfg.bridgeUrl}/internal/gemini-worker/jobs/${encodeURIComponent(jobId)}/fail`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              workerId,
              code: classified.code,
              message: classified.message,
              retryable: classified.retryable,
            }),
          },
          15_000,
        );
        if (res.ok || res.status === 409) return;
      } catch {}
      await sleep(1000 * (attempt + 1));
    }
  };

  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    currentState = "stopped";
    logWorkerEvent("worker_stopping", { reason });
    await sendHeartbeat("stopped");
    await client.close().catch(() => {});
  };

  const supervisorPid = process.env.EMOJI_SUPERVISOR_PID ? Number(process.env.EMOJI_SUPERVISOR_PID) : undefined;
  const unwatchSupervisor = supervisorPid
    ? watchSupervisor(supervisorPid, () => {
        void shutdown("supervisor_exit").finally(() => process.exit(0));
      })
    : undefined;

  const onSigInt = () => void shutdown("SIGINT").finally(() => process.exit(0));
  const onSigTerm = () => void shutdown("SIGTERM").finally(() => process.exit(0));
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  const heartbeatMs = options?.heartbeatIntervalMs ?? 15_000;
  const pollMs = options?.pollIntervalMs ?? cfg.pollIntervalMs;
  const hbTimer = setInterval(() => {
    if (!stopping) {
      void sendHeartbeat();
    }
  }, heartbeatMs);
  hbTimer.unref();

  logWorkerEvent("worker_started", {
    workerId,
    windowsUser,
    sessionId,
    profileRoot: cfg.profileRoot,
    bridgeUrl: cfg.bridgeUrl,
    chromeAvailable: Boolean(chromeExecutable),
  });

  currentState = getGeminiProfileStatus(cfg.profileRoot).requiresReauth ? "paused_reauth" : "idle";
  await sendHeartbeat();

  let browserBusy = false;
  try {
    while (!stopping) {
      try {
        const headers = authHeaders({ "Content-Type": "application/json" });
        if (!headers) {
          await sleep(2000);
          continue;
        }

        if (cfg.jobCooldownMs > 0 && Date.now() < nextCooldownAt) {
          if (browserBusy) {
            await client.close().catch(() => {});
            browserBusy = false;
          }
          await sleep(Math.min(pollMs, Math.max(500, nextCooldownAt - Date.now())));
          continue;
        }

        const profileStatus = getGeminiProfileStatus(cfg.profileRoot);
        if (profileStatus.requiresReauth) {
          currentState = "paused_reauth";
          if (browserBusy) {
            await client.close().catch(() => {});
            browserBusy = false;
          }
          await sleep(pollMs);
          continue;
        }

        const claimRes = await fetchWithTimeout(
          `${cfg.bridgeUrl}/internal/gemini-worker/claim`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ workerId }),
          },
          15_000,
        );
        if (!claimRes.ok) {
          if (browserBusy) {
            await client.close().catch(() => {});
            browserBusy = false;
          }
          await sleep(pollMs);
          continue;
        }

        const claimData = (await claimRes.json()) as {
          ok?: boolean;
          paused?: boolean;
          enabled?: boolean;
          job?: { id: string; prompt: string; retryCount: number; maxRetries: number } | null;
        };

        if (!claimData.job) {
          currentState = claimData.paused ? "paused_reauth" : "idle";
          if (browserBusy) {
            await client.close().catch(() => {});
            browserBusy = false;
          }
          await sleep(pollMs);
          continue;
        }

        const job = claimData.job;
        currentJobId = job.id;
        currentState = "processing";
        await sendHeartbeat("processing");

        const jobTmpDir = mkdtempSync(join(tmpdir(), "gemini-worker-job-"));
        try {
          const sourceRes = await fetchWithTimeout(
            `${cfg.bridgeUrl}/internal/gemini-worker/jobs/${encodeURIComponent(job.id)}/source?workerId=${encodeURIComponent(workerId)}`,
            {
              method: "GET",
              headers: authHeaders() ?? {},
            },
            30_000,
          );
          if (!sourceRes.ok) {
            throw new GeminiAutomationError(
              sourceRes.status >= 500 ? "TRANSIENT_FAILURE" : "INVALID_SOURCE_IMAGE",
              `تعذر تنزيل الصورة الأصلية من الخادم (${sourceRes.status})`,
              sourceRes.status >= 500,
            );
          }

          const sourceBuffer = Buffer.from(await sourceRes.arrayBuffer());
          if (!existsSync(jobTmpDir)) mkdirSync(jobTmpDir, { recursive: true });
          const sourceImagePath = join(jobTmpDir, `${job.id}.webp`);
          writeFileSync(sourceImagePath, sourceBuffer);

          browserBusy = true;
          const result = await client.process({
            jobId: job.id,
            sourceImagePath,
            prompt: job.prompt,
          });
          await uploadCompletionWithRetry(job.id, result.buffer);
          logWorkerEvent("job_completed", { jobId: job.id, bytes: result.buffer.length });
        } catch (err) {
          logWorkerEvent("job_failed", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
          await reportFailure(job.id, err);
        } finally {
          currentJobId = null;
          currentState = getGeminiProfileStatus(cfg.profileRoot).requiresReauth ? "paused_reauth" : "idle";
          rmSync(jobTmpDir, { recursive: true, force: true });
        }

        if (cfg.jobCooldownMs > 0) {
          const jitter = Math.round(cfg.jobCooldownMs * 0.4 * Math.random());
          nextCooldownAt = Date.now() + cfg.jobCooldownMs + jitter;
          await client.close().catch(() => {});
          browserBusy = false;
        }
      } catch (loopErr: any) {
        logWorkerEvent("worker_loop_error", { error: loopErr?.message ?? String(loopErr) });
        await sleep(pollMs);
      }
    }
  } finally {
    clearInterval(hbTimer);
    unwatchSupervisor?.();
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    await client.close().catch(() => {});
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  await runExternalGeminiWorker();
}
