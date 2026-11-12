import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import sharp from "sharp";
import { openDatabase } from "../packages/storage/database.js";
import { registerGeminiWorkerBridge } from "../apps/server/image-processing/bridge.js";
import { saveProductImageBlob } from "../apps/server/image-processing/storage.js";
import {
  enqueueImageProcessingJob,
  getImageProcessingStatusSummary,
  ImageProcessingWorker,
} from "../apps/server/image-processing/worker.js";

async function makeTestImage(width = 256, height = 256, rgb = { r: 210, g: 110, b: 60 }): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: rgb },
  })
    .png()
    .toBuffer();
}

function seedProductImageJob(db: ReturnType<typeof openDatabase>, originalImageId: string, productImageId = "img-1") {
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO companies(id, name, settings, created_at) VALUES(?, ?, '{}', ?)").run(
    "comp-1",
    "Test Co",
    now,
  );
  db.prepare(
    "INSERT OR IGNORE INTO photo_users(id, company_id, username, password_hash, enabled, created_at) VALUES(?,?,?,?,1,?)",
  ).run("user-1", "comp-1", "photo-admin", "hash", now);
  db.prepare(
    "INSERT INTO product_images(id, company_id, source_identity, product_id, unit_id, created_by, created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(productImageId, "comp-1", "src-1", "prod-1", "unit-1", "user-1", now);
  return enqueueImageProcessingJob(db, {
    companyId: "comp-1",
    sourceIdentity: "src-1",
    productId: "prod-1",
    unitId: "unit-1",
    productImageId,
    userId: "user-1",
    originalImageId,
    productCode: "SKU-77",
    prompt: "Studio product photo",
    maxRetries: 3,
    now,
  });
}

test("gemini localhost bridge enforces loopback + bearer auth and completes job in external mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gemini-bridge-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "app.sqlite"));

  try {
    const sourcePng = await makeTestImage(240, 240, { r: 40, g: 130, b: 190 });
    const stored = await saveProductImageBlob(dataDir, sourcePng);
    const jobId = seedProductImageJob(db, stored.id);

    let localCalled = false;
    const worker = new ImageProcessingWorker(db, {
      dataDir,
      root: resolve("."),
      workerMode: "external",
      processor: {
        async process() {
          localCalled = true;
          throw new Error("In-process processor must never run in external mode");
        },
      },
    });

    const app = Fastify();
    const tokenFile = join(dir, "gemini-bridge.json");
    const { token } = registerGeminiWorkerBridge(app, {
      db,
      worker,
      dataDir,
      root: resolve("."),
      bridgeTokenFile: tokenFile,
    });
    assert.ok(token.length >= 64, "generated bridge token should be at least 32 bytes hex");
    assert.ok(existsSync(tokenFile), "bridge token file must be persisted");

    // In-process tick/start must NOT claim pending jobs or run local Chrome when workerMode=external
    worker.start(50);
    worker.notify();
    await worker.tick();
    assert.equal(localCalled, false);
    const beforeClaim = db.prepare("SELECT status FROM image_processing_jobs WHERE id=?").get(jobId) as { status: string };
    assert.equal(beforeClaim.status, "pending");

    // Auth checks
    const unauth = await app.inject({ method: "POST", url: "/internal/gemini-worker/claim", payload: { workerId: "w1" } });
    assert.equal(unauth.statusCode, 401);

    const wrongToken = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/claim",
      headers: { authorization: "Bearer wrong-token" },
      payload: { workerId: "w1" },
    });
    assert.equal(wrongToken.statusCode, 401);

    const nonLoopback = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/claim",
      remoteAddress: "192.168.1.50",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "w1" },
    });
    assert.equal(nonLoopback.statusCode, 403);

    // Heartbeat reports dedicated worker metadata without needing LOCAL SERVICE profile access
    const hb = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/heartbeat",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workerId: "ext-w1",
        pid: 4321,
        windowsUser: "PC\\WhatsAppERPGemini",
        sessionId: 0,
        profileExists: true,
        requiresReauth: false,
        authenticatedAt: "2026-11-12T10:00:00.000Z",
        chromeAvailable: true,
        state: "idle",
      },
    });
    assert.equal(hb.statusCode, 200);
    const summary = getImageProcessingStatusSummary(db, join(dir, "unused-profile"), "comp-1", {
      dataDir,
      workerMode: "external",
    });
    assert.equal(summary.workerMode, "external");
    assert.equal(summary.profileExists, true);
    assert.equal(summary.worker?.connected, true);
    assert.equal(summary.worker?.windowsUser, "PC\\WhatsAppERPGemini");
    assert.equal(summary.worker?.sessionId, 0);

    // Claim job
    const claim1 = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "ext-w1" },
    });
    assert.equal(claim1.statusCode, 200);
    const claimBody = claim1.json();
    assert.equal(claimBody.job.id, jobId);
    assert.equal(claimBody.job.prompt, "Studio product photo");

    // Second concurrent claim returns null
    const claim2 = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "ext-w2" },
    });
    assert.equal(claim2.statusCode, 200);
    assert.equal(claim2.json().job, null);

    // Download source bytes (only owning worker allowed)
    const wrongOwnerSource = await app.inject({
      method: "GET",
      url: `/internal/gemini-worker/jobs/${jobId}/source?workerId=ext-w2`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(wrongOwnerSource.statusCode, 404);

    const sourceRes = await app.inject({
      method: "GET",
      url: `/internal/gemini-worker/jobs/${jobId}/source?workerId=ext-w1`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(sourceRes.statusCode, 200);
    assert.equal(sourceRes.headers["content-type"], "image/webp");
    assert.deepEqual(sourceRes.rawPayload, readFileSync(join(dataDir, "product-images", `${stored.id}.webp`)));

    // Upload processed output -> Backend stamps and persists result image
    const resultPng = await makeTestImage(512, 512, { r: 230, g: 230, b: 230 });
    const completeRes = await app.inject({
      method: "POST",
      url: `/internal/gemini-worker/jobs/${jobId}/complete`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-worker-id": "ext-w1",
      },
      payload: resultPng,
    });
    assert.equal(completeRes.statusCode, 200);
    const completed = completeRes.json();
    assert.equal(completed.ok, true);
    assert.ok(completed.resultImageId);
    assert.ok(existsSync(join(dataDir, "product-images", `${completed.resultImageId}.webp`)));

    const row = db
      .prepare("SELECT status, result_image_id FROM image_processing_jobs WHERE id=?")
      .get(jobId) as { status: string; result_image_id: string };
    assert.equal(row.status, "completed");
    assert.equal(row.result_image_id, completed.resultImageId);

    const stateRow = db
      .prepare("SELECT processed_image_id FROM product_image_state WHERE product_image_id=?")
      .get("img-1") as { processed_image_id: string };
    assert.equal(stateRow.processed_image_id, completed.resultImageId);

    await worker.stop();
    await app.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gemini bridge handles REAUTH_REQUIRED pause, resume clearLocalReauth, and crash recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gemini-bridge-reauth-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "app.sqlite"));

  let fakeNow = Date.parse("2026-11-12T12:00:00.000Z");
  try {
    const sourcePng = await makeTestImage(240, 240);
    const stored = await saveProductImageBlob(dataDir, sourcePng);
    const job1 = seedProductImageJob(db, stored.id, "img-reauth-1");

    const worker = new ImageProcessingWorker(db, {
      dataDir,
      root: resolve("."),
      workerMode: "external",
      now: () => fakeNow,
    });
    const app = Fastify();
    const { token } = registerGeminiWorkerBridge(app, {
      db,
      worker,
      dataDir,
      root: resolve("."),
      bridgeTokenFile: join(dir, "gemini-bridge.json"),
      now: () => fakeNow,
    });

    // Claim job1 then fail with REAUTH_REQUIRED
    const c1 = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "ext-w1" },
    });
    assert.equal(c1.json().job.id, job1);

    const failRes = await app.inject({
      method: "POST",
      url: `/internal/gemini-worker/jobs/${job1}/fail`,
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "ext-w1", code: "REAUTH_REQUIRED", message: "Sign in needed", retryable: false },
    });
    assert.equal(failRes.statusCode, 200);
    assert.equal(failRes.json().outcome, "paused_reauth");

    const job2 = enqueueImageProcessingJob(db, {
      companyId: "comp-1",
      sourceIdentity: "src-2",
      productId: "prod-1",
      unitId: "unit-1",
      productImageId: "img-reauth-1",
      userId: "user-1",
      originalImageId: stored.id,
      prompt: "Retry after auth",
      maxRetries: 3,
    });

    // Claims stay paused while REAUTH_REQUIRED is active
    const pausedClaim = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "ext-w1" },
    });
    assert.equal(pausedClaim.json().job, null);
    assert.equal(pausedClaim.json().paused, true);

    // Operator resumes from portal -> worker receives clearLocalReauth=true on next heartbeat
    worker.resumeAfterAuth();
    const hbAfterResume = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/heartbeat",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "ext-w1", profileExists: true, requiresReauth: true },
    });
    assert.equal(hbAfterResume.statusCode, 200);
    assert.equal(hbAfterResume.json().clearLocalReauth, true);

    // Worker reports auth-completed and claims job2, then simulates crash -> new worker-2 claims recovered job2
    await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/auth-completed",
      headers: { authorization: `Bearer ${token}` },
      payload: { windowsUser: "PC\\WhatsAppERPGemini" },
    });

    const claimed2 = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "ext-w1" },
    });
    assert.equal(claimed2.json().job.id, job2);

    // Advance clock past stale heartbeat window and restart with ext-w2
    fakeNow += 120_000;
    await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/heartbeat",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "ext-w2", profileExists: true, requiresReauth: false, state: "idle" },
    });

    const recoveredClaim = await app.inject({
      method: "POST",
      url: "/internal/gemini-worker/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId: "ext-w2" },
    });
    assert.equal(recoveredClaim.json().job.id, job2);
    assert.equal(recoveredClaim.json().job.retryCount, 1);

    await worker.stop();
    await app.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
