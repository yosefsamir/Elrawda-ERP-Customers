import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import sharp from "sharp";
import { openDatabase } from "../packages/storage/database.js";
import type { Product, ProductReader } from "../packages/erp/products.js";
import { createBackup, restoreBackup, verifyBackup } from "../packages/storage/backup.js";
import { createPortal } from "../apps/server/portal.js";
import { registerPortalAdmin } from "../apps/server/portal-admin.js";
import { hashPassword, localSecretStore } from "../apps/server/security.js";
import {
  applyStudioCatalogStamp,
  normalizeWatermarkLogo,
} from "../apps/server/image-processing/storage.js";
import {
  buildImagePromptForProduct,
  DEFAULT_IMAGE_PROMPT,
  extractProductTypeHint,
  getConfiguredImagePrompt,
  getImageProcessingConfig,
  resolveChromiumExecutable,
} from "../apps/server/image-processing/config.js";
import {
  GeminiAutomationError,
  GeminiBrowserClient,
  isInteractiveGeminiSessionAuthenticated,
  type ImageProcessor,
} from "../apps/server/image-processing/gemini-client.js";
import { chromium } from "playwright";
import { ImageProcessingWorker, enqueueImageProcessingJob } from "../apps/server/image-processing/worker.js";

function restoreEnvVar(name: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

async function makeSolidPng(width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: rgb },
  })
    .png()
    .toBuffer();
}

async function sampleCenterRgb(webpBuffer: Buffer): Promise<{ r: number; g: number; b: number; width: number; height: number }> {
  const { data, info } = await sharp(webpBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cx = Math.floor(info.width / 2);
  const cy = Math.floor(info.height / 2);
  const offset = (cy * info.width + cx) * 3;
  return {
    r: data[offset]!,
    g: data[offset + 1]!,
    b: data[offset + 2]!,
    width: info.width,
    height: info.height,
  };
}

function createTestReader(): ProductReader {
  const demo: Product = {
    id: "1",
    unitId: "10",
    code: "M-100",
    name: "تيشيرت قطن",
    category: "رجالي",
    description: "تيشيرت صيفي سادة",
    unit: "قطعة",
    price: 250,
  };
  return {
    async search() {
      return [demo];
    },
    async suggest() {
      return [demo];
    },
    async get(_companyId, id, unitId) {
      return id === demo.id && unitId === demo.unitId ? demo : undefined;
    },
    async close() {},
  };
}

function setupPortalFixtures(root: string) {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "app.sqlite"));
  const secrets = localSecretStore(dataDir);
  const companyId = "comp-1";
  const userId = "user-1";
  const sourceIdentity = "sql-src-1";
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO companies(id,name,logo_type,logo,settings,paused,pause_until,created_at,run_mode) VALUES(?,?,NULL,NULL,'{}',0,NULL,?,'live')",
  ).run(companyId, "شركة الروضة", now);
  db.prepare(
    "INSERT INTO sources(company_id,kind,identity,label,config,baseline_complete) VALUES(?,?,?,?,?,1)",
  ).run(companyId, "sql", sourceIdentity, "Main SQL", secrets.encrypt("{}"));
  db.prepare("UPDATE portal_settings SET company_id=?, enabled=1, origin='' WHERE id=1").run(companyId);
  db.prepare("INSERT INTO photo_users(id,company_id,username,password_hash,enabled,created_at) VALUES(?,?,?,?,1,?)").run(
    userId,
    companyId,
    "photographer1",
    hashPassword("StrongPass#123"),
    now,
  );

  return { dataDir, db, companyId, userId, sourceIdentity };
}

async function loginPortalUser(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emoji-Request": "1",
      Origin: baseUrl,
    },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  const cookieHeader = res.headers.get("set-cookie");
  assert.ok(cookieHeader, "expected session cookie on login");
  return cookieHeader.split(";")[0]!;
}

async function uploadMultipartImage(
  baseUrl: string,
  path: string,
  method: "POST" | "PUT",
  cookie: string,
  pngBytes: Buffer,
  filename = "model.png",
  mimeType = "image/png",
) {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(pngBytes)], { type: mimeType }), filename);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      "X-Emoji-Request": "1",
      Origin: baseUrl,
    },
    body: form,
  });
  return { status: res.status, json: await res.json() as any };
}

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withMockGeminiServer(
  mode: { kind: "ok"; generatedPng: Buffer; priorPng: Buffer } | { kind: "signin" },
  fn: (ctx: {
    url: string;
    requests: { submittedPrompt: string; uploadedSize: number; downloadCount: number };
  }) => Promise<void>,
) {
  const state = { submittedPrompt: "", uploadedSize: 0, downloadCount: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = req.url || "/";
    if (reqUrl.startsWith("/prior.png")) {
      const buf = mode.kind === "ok" ? mode.priorPng : Buffer.alloc(0);
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(buf);
      return;
    }
    if (reqUrl.startsWith("/generated-preview.png")) {
      const buf = mode.kind === "ok" ? mode.generatedPng : Buffer.alloc(0);
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(buf);
      return;
    }
    if (reqUrl.startsWith("/generated-fullres.png")) {
      state.downloadCount++;
      const buf = mode.kind === "ok" ? mode.generatedPng : Buffer.alloc(0);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition": 'attachment; filename="gemini-generated-fullres.png"',
      });
      res.end(buf);
      return;
    }
    if (reqUrl.startsWith("/submit") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          state.submittedPrompt = parsed.prompt || "";
          state.uploadedSize = parsed.uploadedSize || 0;
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }

    if (mode.kind === "signin") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html><body>
          <main>
            <button type="button" aria-label="Upload & tools">Upload &amp; tools</button>
            <a href="/signin">Sign in</a>
            <div role="textbox" aria-label="Enter a prompt for Gemini" contenteditable="true"></div>
          </main>
        </body></html>`);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html><body>
        <main id="chat">
          <model-response data-turn="0">
            <img src="/prior.png" width="300" height="300" alt="Prior output" />
            <a href="/prior.png" download="prior.png" aria-label="Download image">Download</a>
          </model-response>

          <button type="button" id="toolsBtn" aria-label="Upload & tools">Upload &amp; tools</button>
          <div id="toolsMenu" role="menu" style="display:none">
            <button type="button" id="uploadMenuItem" role="menuitem">Upload files</button>
          </div>
          <input id="fileInput" type="file" accept="image/*" style="display:none" />
          <div id="previewMount"></div>

          <div id="promptBox" role="textbox" aria-label="Enter a prompt for Gemini" contenteditable="true"></div>
          <button type="button" id="sendBtn" aria-label="Send message">Send</button>
        </main>
        <script>
          const toolsBtn = document.getElementById('toolsBtn');
          const toolsMenu = document.getElementById('toolsMenu');
          const uploadMenuItem = document.getElementById('uploadMenuItem');
          const fileInput = document.getElementById('fileInput');
          const previewMount = document.getElementById('previewMount');
          const promptBox = document.getElementById('promptBox');
          const sendBtn = document.getElementById('sendBtn');
          const chat = document.getElementById('chat');
          let uploadedSize = 0;

          toolsBtn.addEventListener('click', () => {
            toolsMenu.style.display = 'block';
          });
          uploadMenuItem.addEventListener('click', () => {
            toolsMenu.style.display = 'none';
            fileInput.click();
          });
          fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            uploadedSize = file.size;
            const preview = document.createElement('uploader-file-preview');
            preview.textContent = file.name;
            previewMount.appendChild(preview);
          });
          sendBtn.addEventListener('click', async () => {
            const promptText = (promptBox.innerText || promptBox.textContent || '').trim();
            await fetch('/submit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt: promptText, uploadedSize })
            });

            const turn = document.createElement('model-response');
            turn.setAttribute('aria-busy', 'true');
            const stopBtn = document.createElement('button');
            stopBtn.setAttribute('aria-label', 'Stop response');
            stopBtn.textContent = 'Stop';
            turn.appendChild(stopBtn);
            chat.appendChild(turn);

            setTimeout(() => {
              stopBtn.remove();
              turn.removeAttribute('aria-busy');
              const img = document.createElement('img');
              img.src = '/generated-preview.png?ts=' + Date.now();
              img.alt = 'Generated product image';
              const dl = document.createElement('a');
              dl.href = '/generated-fullres.png?ts=' + Date.now();
              dl.setAttribute('download', 'gemini-generated-fullres.png');
              dl.setAttribute('aria-label', 'Download full size image');
              dl.textContent = 'Download full size';
              turn.appendChild(img);
              turn.appendChild(dl);
            }, 350);
          });
        </script>
      </body></html>`);
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/app`;
  try {
    await fn({ url, requests: state });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

test("Happy path: Playwright headless Chromium + persistent profile processes uploaded product image and preserves original", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-e2e-"));
  const prevEnv = {
    url: process.env.GEMINI_WEB_URL,
    profile: process.env.GEMINI_PROFILE_DIR,
    prompt: process.env.GEMINI_IMAGE_PROMPT,
  };
  const cleanups: Array<() => unknown> = [];

  try {
    const originalPng = await makeSolidPng(400, 400, { r: 220, g: 30, b: 30 });
    const priorPng = await makeSolidPng(300, 300, { r: 10, g: 10, b: 220 });
    const generatedFullResPng = await makeSolidPng(640, 640, { r: 20, g: 200, b: 60 });

    await withMockGeminiServer({ kind: "ok", generatedPng: generatedFullResPng, priorPng }, async ({ url, requests }) => {
      const fixture = setupPortalFixtures(root);
      const db = fixture.db;
      cleanups.push(() => db.close());
      const versionRow = db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number };
      assert.equal(versionRow.v, 4);

      const profileRoot = join(root, "gemini-profile");
      process.env.GEMINI_WEB_URL = url;
      process.env.GEMINI_PROFILE_DIR = profileRoot;
      process.env.GEMINI_IMAGE_PROMPT = "Enhance studio lighting evenly for catalog.";

      const worker = new ImageProcessingWorker(db, { dataDir: fixture.dataDir, root });
      cleanups.push(() => worker.stop());
      const portal = await createPortal({
        db,
        dataDir: fixture.dataDir,
        root,
        reader: createTestReader(),
        onJobQueued: () => worker.notify(),
      });
      cleanups.push(() => portal.close());
      await portal.listen({ port: 0, host: "127.0.0.1" });
      const addr = portal.server.address();
      assert.ok(addr && typeof addr === "object");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const cookie = await loginPortalUser(baseUrl, "photographer1", "StrongPass#123");

      // 1. Upload returns immediately with pending job and original image visible.
      const uploadRes = await uploadMultipartImage(baseUrl, "/api/products/1/10/images", "POST", cookie, originalPng);
      assert.equal(uploadRes.status, 200);
      assert.equal(uploadRes.json.ok, true);
      assert.ok(uploadRes.json.jobId);
      assert.equal(uploadRes.json.images.length, 1);
      assert.equal(uploadRes.json.images[0].status, "pending");
      const imageId = uploadRes.json.images[0].id as string;
      const jobId = uploadRes.json.jobId as string;
      assert.equal(uploadRes.json.images[0].url, `/api/images/${imageId}`);

      const initialBlobRes = await fetch(`${baseUrl}${uploadRes.json.images[0].url}`);
      assert.equal(initialBlobRes.status, 200);
      const initialSample = await sampleCenterRgb(Buffer.from(await initialBlobRes.arrayBuffer()));
      assert.ok(initialSample.r > 180 && initialSample.g < 70, "original red image should be served while pending");
      assert.equal(initialSample.width, 400);

      // 2. Background worker processes via real Chromium headless persistent context.
      await worker.tick();

      assert.ok(requests.submittedPrompt.startsWith("Enhance studio lighting evenly for catalog."));
      assert.match(requests.submittedPrompt, /Catalog item type context: "رجالي — تيشيرت"/);
      assert.ok(requests.uploadedSize > 100);
      assert.equal(requests.downloadCount, 1, "should download actual generated asset via download event");

      // 3. Job completed + DB state + cache-busted replacement URL + preserved original on disk.
      const jobStatusRes = await fetch(`${baseUrl}/api/image-jobs/${jobId}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(jobStatusRes.status, 200);
      const jobJson = (await jobStatusRes.json()) as any;
      assert.equal(jobJson.status, "completed");
      assert.match(jobJson.resultImageUrl, new RegExp(`^/api/images/${imageId}\\?v=`));

      const publicProductRes = await fetch(`${baseUrl}/api/products/1/10`);
      assert.equal(publicProductRes.status, 200);
      const publicJson = (await publicProductRes.json()) as any;
      const publicPhoto = publicJson.products[0].images[0];
      assert.equal(publicPhoto.status, "completed");
      assert.equal(publicPhoto.url, jobJson.resultImageUrl);
      assert.equal(publicPhoto.jobId, undefined, "public route must not expose internal jobId");
      assert.equal(publicPhoto.error, undefined, "public route must not expose internal error");

      const processedRes = await fetch(`${baseUrl}${publicPhoto.url}`);
      assert.equal(processedRes.status, 200);
      const processedSample = await sampleCenterRgb(Buffer.from(await processedRes.arrayBuffer()));
      assert.ok(processedSample.g > 160 && processedSample.r < 60, "processed green image should now be served");
      assert.equal(processedSample.width, 640);

      // Verify original file on disk is still preserved and untouched.
      const originalDiskPath = resolve(fixture.dataDir, "product-images", `${imageId}.webp`);
      assert.ok(existsSync(originalDiskPath));
      const originalDiskSample = await sampleCenterRgb(readFileSync(originalDiskPath));
      assert.ok(originalDiskSample.r > 180 && originalDiskSample.width === 400);

      // Verify SQLite backup integrity includes both original and processed blobs under schema v4.
      const backupDir = join(root, "backup-out");
      await createBackup(fixture.dataDir, backupDir, true);
      const verifiedVersion = verifyBackup(backupDir);
      assert.equal(verifiedVersion, 4);
    });
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    restoreEnvVar("GEMINI_WEB_URL", prevEnv.url);
    restoreEnvVar("GEMINI_PROFILE_DIR", prevEnv.profile);
    restoreEnvVar("GEMINI_IMAGE_PROMPT", prevEnv.prompt);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Configurable prompt priority + admin prompt update preserves photo sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-cfg-"));
  const prevPrompt = process.env.GEMINI_IMAGE_PROMPT;
  const prevConfigFile = process.env.GEMINI_CONFIG_FILE;

  try {
    const fixture = setupPortalFixtures(root);
    const adminApp = Fastify();
    registerPortalAdmin(adminApp, fixture.db, { dataDir: fixture.dataDir, root });
    const portal = await createPortal({ db: fixture.db, dataDir: fixture.dataDir, root, reader: createTestReader() });

    await portal.listen({ port: 0, host: "127.0.0.1" });
    const addr = portal.server.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const cookie = await loginPortalUser(baseUrl, "photographer1", "StrongPass#123");

    // 1. Default prompt fallback
    delete process.env.GEMINI_IMAGE_PROMPT;
    delete process.env.GEMINI_CONFIG_FILE;
    assert.equal(getConfiguredImagePrompt(fixture.db, fixture.dataDir, root), DEFAULT_IMAGE_PROMPT);

    // 2. Config JSON fallback
    const jsonPath = join(fixture.dataDir, "image-processing.json");
    writeFileSync(jsonPath, JSON.stringify({ prompt: "JSON file prompt" }));
    assert.equal(getConfiguredImagePrompt(fixture.db, fixture.dataDir, root), "JSON file prompt");

    // 3. Environment variable overrides JSON
    process.env.GEMINI_IMAGE_PROMPT = "Env prompt";
    assert.equal(getConfiguredImagePrompt(fixture.db, fixture.dataDir, root), "Env prompt");

    // 4. DB portal_settings prompt overrides Env and keeps active photographer sessions intact
    const putPromptRes = await adminApp.inject({
      method: "PUT",
      url: "/api/portal/image-processing/prompt",
      payload: { imagePrompt: "DB Admin Studio Prompt" },
    });
    assert.equal(putPromptRes.statusCode, 200);
    assert.equal(getConfiguredImagePrompt(fixture.db, fixture.dataDir, root), "DB Admin Studio Prompt");

    const sessionRes = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: cookie } });
    const sessionJson = (await sessionRes.json()) as { authenticated: boolean };
    assert.equal(sessionJson.authenticated, true, "updating prompt must not invalidate active photo sessions");

    // Clearing DB custom prompt reverts gracefully to env/config/default
    await adminApp.inject({
      method: "PUT",
      url: "/api/portal/image-processing/prompt",
      payload: { imagePrompt: "" },
    });
    assert.equal(getConfiguredImagePrompt(fixture.db, fixture.dataDir, root), "Env prompt");

    await portal.close();
    await adminApp.close();
    fixture.db.close();
  } finally {
    restoreEnvVar("GEMINI_IMAGE_PROMPT", prevPrompt);
    restoreEnvVar("GEMINI_CONFIG_FILE", prevConfigFile);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bounded exponential backoff retries, terminal failure fallback, and manual retry recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-retry-"));
  const prevMaxRetries = process.env.GEMINI_MAX_RETRIES;
  const prevBaseBackoff = process.env.GEMINI_BASE_BACKOFF_MS;
  const cleanups: Array<() => unknown> = [];
  try {
    process.env.GEMINI_MAX_RETRIES = "2";
    process.env.GEMINI_BASE_BACKOFF_MS = "1000";

    const fixture = setupPortalFixtures(root);
    cleanups.push(() => fixture.db.close());
    const originalPng = await makeSolidPng(320, 320, { r: 210, g: 50, b: 50 });
    const enhancedWebp = await sharp(await makeSolidPng(480, 480, { r: 40, g: 180, b: 220 })).webp().toBuffer();

    let mode: "fail-transient" | "always-fail" | "succeed" = "fail-transient";
    let calls = 0;
    let fakeNow = Date.parse("2026-06-01T12:00:00.000Z");

    const processor: ImageProcessor = {
      async process() {
        calls++;
        if (mode === "fail-transient" && calls < 3) {
          throw new GeminiAutomationError("TIMEOUT", "Temporary Gemini timeout", true);
        }
        if (mode === "always-fail") {
          throw new GeminiAutomationError("TRANSIENT_FAILURE", "Persistent temporary failure", true);
        }
        return { buffer: enhancedWebp, width: 480, height: 480, format: "webp" };
      },
    };

    const worker = new ImageProcessingWorker(fixture.db, {
      dataDir: fixture.dataDir,
      root,
      processor,
      now: () => fakeNow,
      log: () => {},
    });
    cleanups.push(() => worker.stop());

    const portal = await createPortal({ db: fixture.db, dataDir: fixture.dataDir, root, reader: createTestReader() });
    cleanups.push(() => portal.close());
    await portal.listen({ port: 0, host: "127.0.0.1" });
    const addr = portal.server.address() as any;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const cookie = await loginPortalUser(baseUrl, "photographer1", "StrongPass#123");

    // Job 1: fails twice, succeeds on 3rd attempt (attempt 2 after 2 retries)
    const upload1 = await uploadMultipartImage(baseUrl, "/api/products/1/10/images", "POST", cookie, originalPng);
    const job1Id = upload1.json.jobId as string;

    await worker.tick(); // Attempt 0 -> schedules retry 1 (>= 1000ms)
    let job1 = await (await fetch(`${baseUrl}/api/image-jobs/${job1Id}`, { headers: { Cookie: cookie } })).json() as any;
    assert.equal(job1.status, "pending");
    assert.equal(job1.retryCount, 1);

    await worker.tick(); // Before backoff elapsed -> must NOT run yet
    assert.equal(calls, 1);

    fakeNow += 2000;
    await worker.tick(); // Attempt 1 -> schedules retry 2 (>= 2000ms)
    job1 = await (await fetch(`${baseUrl}/api/image-jobs/${job1Id}`, { headers: { Cookie: cookie } })).json() as any;
    assert.equal(job1.status, "pending");
    assert.equal(job1.retryCount, 2);

    fakeNow += 4000;
    await worker.tick(); // Attempt 2 -> succeeds
    job1 = await (await fetch(`${baseUrl}/api/image-jobs/${job1Id}`, { headers: { Cookie: cookie } })).json() as any;
    assert.equal(job1.status, "completed");

    // Job 2: exhausts max_retries=2 -> enters terminal failed state keeping original image visible
    mode = "always-fail";
    calls = 0;
    const upload2 = await uploadMultipartImage(baseUrl, "/api/products/1/10/images", "POST", cookie, originalPng);
    const img2Id = upload2.json.images[1].id as string;
    const job2Id = upload2.json.jobId as string;

    await worker.tick(); // attempt 0 -> retry 1
    fakeNow += 5000;
    await worker.tick(); // attempt 1 -> retry 2
    fakeNow += 10000;
    await worker.tick(); // attempt 2 -> exhausted -> failed

    const job2 = await (await fetch(`${baseUrl}/api/image-jobs/${job2Id}`, { headers: { Cookie: cookie } })).json() as any;
    assert.equal(job2.status, "failed");
    assert.equal(job2.retryCount, 2);
    assert.equal(calls, 3);

    // Extra ticks must NOT trigger an infinite retry loop
    fakeNow += 60000;
    await worker.tick();
    assert.equal(calls, 3);

    // Original image still visible on portal while failed
    const failedImgRes = await fetch(`${baseUrl}/api/images/${img2Id}`);
    assert.equal(failedImgRes.status, 200);
    const failedSample = await sampleCenterRgb(Buffer.from(await failedImgRes.arrayBuffer()));
    assert.ok(failedSample.r > 180 && failedSample.g < 70);

    // Manual retry succeeds once Gemini recovers
    mode = "succeed";
    const retryRes = await fetch(`${baseUrl}/api/images/${img2Id}/retry`, {
      method: "POST",
      headers: { Cookie: cookie, "X-Emoji-Request": "1", Origin: baseUrl },
    });
    assert.equal(retryRes.status, 200);
    await worker.tick();

    const recoveredImgRes = await fetch(`${baseUrl}/api/images/${img2Id}`);
    const recoveredSample = await sampleCenterRgb(Buffer.from(await recoveredImgRes.arrayBuffer()));
    assert.ok(recoveredSample.b > 170 && recoveredSample.g > 150);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    restoreEnvVar("GEMINI_MAX_RETRIES", prevMaxRetries);
    restoreEnvVar("GEMINI_BASE_BACKOFF_MS", prevBaseBackoff);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reauth required pauses worker cleanly without retry loop until admin resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-reauth-"));
  const prevUrl = process.env.GEMINI_WEB_URL;
  const prevProfile = process.env.GEMINI_PROFILE_DIR;
  const cleanups: Array<() => unknown> = [];

  try {
    const fixture = setupPortalFixtures(root);
    cleanups.push(() => fixture.db.close());
    const adminApp = Fastify();
    cleanups.push(() => adminApp.close());
    registerPortalAdmin(adminApp, fixture.db, { dataDir: fixture.dataDir, root });
    const portal = await createPortal({ db: fixture.db, dataDir: fixture.dataDir, root, reader: createTestReader() });
    cleanups.push(() => portal.close());
    await portal.listen({ port: 0, host: "127.0.0.1" });
    const addr = portal.server.address() as any;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const cookie = await loginPortalUser(baseUrl, "photographer1", "StrongPass#123");

    const originalPng = await makeSolidPng(320, 320, { r: 200, g: 120, b: 20 });
    const uploadA = await uploadMultipartImage(baseUrl, "/api/products/1/10/images", "POST", cookie, originalPng);
    const uploadB = await uploadMultipartImage(baseUrl, "/api/products/1/10/images", "POST", cookie, originalPng);
    const jobAId = uploadA.json.jobId as string;
    const jobBId = uploadB.json.jobId as string;

    const profileRoot = join(root, "gemini-profile");
    process.env.GEMINI_PROFILE_DIR = profileRoot;

    // 1. Real Chromium hits mock sign-in Gemini page -> REAUTH_REQUIRED
    await withMockGeminiServer({ kind: "signin" }, async ({ url }) => {
      process.env.GEMINI_WEB_URL = url;
      const worker = new ImageProcessingWorker(fixture.db, {
        dataDir: fixture.dataDir,
        root,
        log: () => {},
      });
      cleanups.push(() => worker.stop());

      await worker.tick();

      const statusRes = await fetch(`${baseUrl}/api/image-jobs/status`, { headers: { Cookie: cookie } });
      const statusJson = (await statusRes.json()) as any;
      assert.equal(statusJson.paused, true);
      assert.equal(statusJson.requiresReauth, true);

      const jobA = await (await fetch(`${baseUrl}/api/image-jobs/${jobAId}`, { headers: { Cookie: cookie } })).json() as any;
      const jobB = await (await fetch(`${baseUrl}/api/image-jobs/${jobBId}`, { headers: { Cookie: cookie } })).json() as any;
      assert.equal(jobA.status, "failed");
      assert.equal(jobA.errorCode, "REAUTH_REQUIRED");
      assert.equal(jobB.status, "pending", "queued jobB should pause rather than burning through retries");

      // Another tick while paused must not touch jobB
      await worker.tick();
      const jobBAfterTick = await (await fetch(`${baseUrl}/api/image-jobs/${jobBId}`, { headers: { Cookie: cookie } })).json() as any;
      assert.equal(jobBAfterTick.status, "pending");
      assert.equal(jobBAfterTick.retryCount, 0);

      await worker.stop();
    });

    // 2. Admin resumes queue after reauth -> jobB processes and completes
    const generatedPng = await makeSolidPng(512, 512, { r: 30, g: 180, b: 90 });
    const priorPng = await makeSolidPng(300, 300, { r: 20, g: 20, b: 20 });
    await withMockGeminiServer({ kind: "ok", generatedPng, priorPng }, async ({ url }) => {
      process.env.GEMINI_WEB_URL = url;
      const resumeRes = await adminApp.inject({ method: "POST", url: "/api/portal/image-processing/resume" });
      assert.equal(resumeRes.statusCode, 200);

      const worker2 = new ImageProcessingWorker(fixture.db, { dataDir: fixture.dataDir, root, log: () => {} });
      cleanups.push(() => worker2.stop());
      await worker2.tick();

      const jobBAfterResume = await (await fetch(`${baseUrl}/api/image-jobs/${jobBId}`, { headers: { Cookie: cookie } })).json() as any;
      assert.equal(jobBAfterResume.status, "completed");

      const statusRes = await fetch(`${baseUrl}/api/image-jobs/status`, { headers: { Cookie: cookie } });
      const statusJson = (await statusRes.json()) as any;
      assert.equal(statusJson.paused, false);
      assert.equal(statusJson.requiresReauth, false);

      await worker2.stop();
    });
  } finally {
    for (const fn of cleanups.reverse()) {
      await fn();
    }
    restoreEnvVar("GEMINI_WEB_URL", prevUrl);
    restoreEnvVar("GEMINI_PROFILE_DIR", prevProfile);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Crash recovery and stale-job protection on delete or replace during in-flight processing", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-stale-"));
  const cleanups: Array<() => unknown> = [];
  try {
    const fixture = setupPortalFixtures(root);
    cleanups.push(() => fixture.db.close());
    const orangePng = await makeSolidPng(320, 320, { r: 230, g: 130, b: 20 });
    const purplePng = await makeSolidPng(320, 320, { r: 150, g: 40, b: 220 });
    const staleResultWebp = await sharp(await makeSolidPng(400, 400, { r: 0, g: 255, b: 0 })).webp().toBuffer();
    const freshResultWebp = await sharp(await makeSolidPng(400, 400, { r: 20, g: 200, b: 240 })).webp().toBuffer();

    const portal = await createPortal({ db: fixture.db, dataDir: fixture.dataDir, root, reader: createTestReader() });
    cleanups.push(() => portal.close());
    await portal.listen({ port: 0, host: "127.0.0.1" });
    const addr = portal.server.address() as any;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const cookie = await loginPortalUser(baseUrl, "photographer1", "StrongPass#123");

    // 1. Crash recovery check: job stuck in `processing` gets recovered on worker startup
    const upCrash = await uploadMultipartImage(baseUrl, "/api/products/1/10/images", "POST", cookie, orangePng);
    const crashJobId = upCrash.json.jobId as string;
    fixture.db.prepare("UPDATE image_processing_jobs SET status='processing', locked_by='crashed-pid' WHERE id=?").run(crashJobId);

    const job1Gate = deferred<void>();
    const job1Started = deferred<void>();
    let nextResult = freshResultWebp;
    const controlledProcessor: ImageProcessor = {
      async process({ jobId }) {
        if (jobId === staleTargetJobId) {
          job1Started.resolve();
          await job1Gate.promise;
          return { buffer: staleResultWebp, width: 400, height: 400, format: "webp" };
        }
        return { buffer: nextResult, width: 400, height: 400, format: "webp" };
      },
    };
    let staleTargetJobId = "";

    const crashWorker = new ImageProcessingWorker(fixture.db, {
      dataDir: fixture.dataDir,
      root,
      processor: controlledProcessor,
      log: () => {},
    });
    cleanups.push(() => crashWorker.stop());
    const recoveredRow = fixture.db.prepare("SELECT status, retry_count, error_code FROM image_processing_jobs WHERE id=?").get(crashJobId) as any;
    assert.equal(recoveredRow.status, "pending");
    assert.equal(recoveredRow.retry_count, 1);
    assert.equal(recoveredRow.error_code, "CRASH_RECOVERED");
    await crashWorker.tick();
    const crashAfter = fixture.db.prepare("SELECT status FROM image_processing_jobs WHERE id=?").get(crashJobId) as any;
    assert.equal(crashAfter.status, "completed");

    // 2. Stale-job protection when image is DELETED while processing
    const upDel = await uploadMultipartImage(baseUrl, "/api/products/1/10/images", "POST", cookie, orangePng);
    const delImgId = upDel.json.images[upDel.json.images.length - 1].id as string;
    staleTargetJobId = upDel.json.jobId as string;

    const delTick = crashWorker.tick();
    await job1Started.promise;

    const delRes = await fetch(`${baseUrl}/api/images/${delImgId}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "X-Emoji-Request": "1", Origin: baseUrl },
    });
    assert.equal(delRes.status, 200);
    job1Gate.resolve();
    await delTick;

    assert.equal((await fetch(`${baseUrl}/api/images/${delImgId}`)).status, 404, "deleted image must stay deleted");
    const delJobRow = fixture.db.prepare("SELECT status, result_image_id FROM image_processing_jobs WHERE id=?").get(upDel.json.jobId) as any;
    assert.equal(delJobRow.status, "failed");
    assert.equal(delJobRow.result_image_id, null);

    // 3. Stale-job protection when image is REPLACED (PUT /api/images/:id) while old job runs
    const upRep = await uploadMultipartImage(baseUrl, "/api/products/1/10/images", "POST", cookie, orangePng);
    const repImgId = upRep.json.images[upRep.json.images.length - 1].id as string;
    const oldJobId = upRep.json.jobId as string;

    const repGate = deferred<void>();
    const repStarted = deferred<void>();
    const replaceWorker = new ImageProcessingWorker(fixture.db, {
      dataDir: fixture.dataDir,
      root,
      processor: {
        async process({ jobId }) {
          if (jobId === oldJobId) {
            repStarted.resolve();
            await repGate.promise;
            return { buffer: staleResultWebp, width: 400, height: 400, format: "webp" };
          }
          return { buffer: freshResultWebp, width: 400, height: 400, format: "webp" };
        },
      },
      log: () => {},
    });
    cleanups.push(() => replaceWorker.stop());

    const repTick1 = replaceWorker.tick();
    await repStarted.promise;

    // Replace image while old job is in flight
    const replaceRes = await uploadMultipartImage(baseUrl, `/api/images/${repImgId}`, "PUT", cookie, purplePng, "replacement.png");
    assert.equal(replaceRes.status, 200);
    const newJobId = replaceRes.json.jobId as string;
    assert.notEqual(newJobId, oldJobId);

    // While new job is pending, portal must show purple replacement (not stale green or old orange)
    const duringReplaceSample = await sampleCenterRgb(Buffer.from(await (await fetch(`${baseUrl}/api/images/${repImgId}`)).arrayBuffer()));
    assert.ok(duringReplaceSample.b > 170 && duringReplaceSample.g < 80, "replacement image must be visible immediately");

    // Let old stale job finish -> worker drains old stale discard + runs new job
    repGate.resolve();
    await repTick1;

    // Verify stale green image was NEVER applied; final image is fresh cyan from newJobId
    const oldJobRow = fixture.db.prepare("SELECT status, error_code FROM image_processing_jobs WHERE id=?").get(oldJobId) as any;
    const newJobRow = fixture.db.prepare("SELECT status FROM image_processing_jobs WHERE id=?").get(newJobId) as any;
    assert.equal(oldJobRow.status, "failed");
    assert.match(String(oldJobRow.error_code), /^STALE_/);
    assert.equal(newJobRow.status, "completed");

    const finalSample = await sampleCenterRgb(Buffer.from(await (await fetch(`${baseUrl}/api/images/${repImgId}`)).arrayBuffer()));
    assert.ok(finalSample.b > 180 && finalSample.g > 160 && finalSample.r < 60, "newest replacement job result must win");
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Security and permission boundaries for image jobs, uploads, and cross-company isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-sec-"));
  try {
    const fixture = setupPortalFixtures(root);
    const portal = await createPortal({ db: fixture.db, dataDir: fixture.dataDir, root, reader: createTestReader() });
    await portal.listen({ port: 0, host: "127.0.0.1" });
    const addr = portal.server.address() as any;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const cookie = await loginPortalUser(baseUrl, "photographer1", "StrongPass#123");

    const validPng = await makeSolidPng(280, 280, { r: 10, g: 120, b: 210 });
    const up = await uploadMultipartImage(baseUrl, "/api/products/1/10/images", "POST", cookie, validPng);
    const imgId = up.json.images[0].id as string;
    const jobId = up.json.jobId as string;

    // 1. Unauthenticated requests rejected
    assert.equal((await fetch(`${baseUrl}/api/image-jobs/status`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/image-jobs/${jobId}`)).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/images/${imgId}/retry`, {
          method: "POST",
          headers: { "X-Emoji-Request": "1", Origin: baseUrl },
        })
      ).status,
      401,
    );

    // 2. Corrupted/invalid image payload rejected cleanly with 400 and no orphan job
    const beforeJobs = (fixture.db.prepare("SELECT COUNT(*) c FROM image_processing_jobs").get() as { c: number }).c;
    const badRes = await uploadMultipartImage(
      baseUrl,
      "/api/products/1/10/images",
      "POST",
      cookie,
      Buffer.from("not-a-valid-image-payload"),
      "bad.png",
      "image/png",
    );
    assert.equal(badRes.status, 400);
    const afterJobs = (fixture.db.prepare("SELECT COUNT(*) c FROM image_processing_jobs").get() as { c: number }).c;
    assert.equal(afterJobs, beforeJobs);

    // 3. Cross-company / cross-source job is unreachable via authenticated user of comp-1
    const now = new Date().toISOString();
    fixture.db.prepare(
      "INSERT INTO companies(id,name,logo_type,logo,settings,paused,pause_until,created_at,run_mode) VALUES(?,?,NULL,NULL,'{}',0,NULL,?,'live')",
    ).run("comp-2", "شركة ثانية", now);
    fixture.db.prepare(
      "INSERT INTO photo_users(id,company_id,username,password_hash,enabled,created_at) VALUES(?,?,?,?,1,?)",
    ).run("user-2", "comp-2", "otheruser", hashPassword("OtherPass#123"), now);
    fixture.db.prepare("INSERT INTO product_images VALUES(?,?,?,?,?,?,?,NULL)").run(
      "11111111-1111-4111-8111-111111111111",
      "comp-2",
      "other-src",
      "1",
      "10",
      "user-2",
      now,
    );
    const otherJobId = enqueueImageProcessingJob(fixture.db, {
      companyId: "comp-2",
      sourceIdentity: "other-src",
      productId: "1",
      unitId: "10",
      productImageId: "11111111-1111-4111-8111-111111111111",
      userId: "user-2",
      originalImageId: "11111111-1111-4111-8111-111111111111",
      prompt: "secret other company prompt",
    });
    const crossCompanyRes = await fetch(`${baseUrl}/api/image-jobs/${otherJobId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(crossCompanyRes.status, 404);

    await portal.close();
    fixture.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive login check does not falsely pass when first Sign in link is hidden", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-hidden-signin-"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html><body>
        <main>
          <a href="https://accounts.google.com/ServiceLogin" style="display:none">Sign in</a>
          <button type="button">Sign in</button>
          <button type="button" aria-label="Upload & tools">Upload &amp; tools</button>
          <div role="textbox" aria-label="Enter a prompt for Gemini" contenteditable="true"></div>
        </main>
      </body></html>`);
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const mockUrl = `http://127.0.0.1:${addr.port}`;

  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "app.sqlite"));
  const samplePath = join(root, "sample.png");
  writeFileSync(samplePath, await makeSolidPng(300, 300, { r: 80, g: 120, b: 160 }));

  const prevUrl = process.env.GEMINI_WEB_URL;
  const prevProfile = process.env.GEMINI_PROFILE_DIR;
  process.env.GEMINI_WEB_URL = mockUrl;
  process.env.GEMINI_PROFILE_DIR = join(root, "gemini-profile");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;

  try {
    const config = getImageProcessingConfig({ db, dataDir, root });
    const executablePath = resolveChromiumExecutable(root);
    context = await chromium.launchPersistentContext(join(root, "check-profile"), {
      ...(executablePath ? { executablePath } : {}),
      headless: true,
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(mockUrl, { waitUntil: "domcontentloaded" });

    assert.equal(await isInteractiveGeminiSessionAuthenticated(context, mockUrl), false);
    await context.close();
    context = null;

    const client = new GeminiBrowserClient(config, root);
    await assert.rejects(
      () => client.process({ jobId: "hidden-signin-test", sourceImagePath: samplePath, prompt: "test" }),
      (err: unknown) => err instanceof GeminiAutomationError && err.code === "REAUTH_REQUIRED",
    );
    await client.close();
  } finally {
    if (context) await context.close().catch(() => {});
    restoreEnvVar("GEMINI_WEB_URL", prevUrl);
    restoreEnvVar("GEMINI_PROFILE_DIR", prevProfile);
    db.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("master toggle disables worker and keeps uploaded images as-is without queuing", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-toggle-"));
  const fixture = setupPortalFixtures(root);
  const samplePng = await makeSolidPng(120, 120, { r: 210, g: 50, b: 50 });
  const replacementPng = await makeSolidPng(120, 120, { r: 50, g: 90, b: 220 });
  const processedPng = await makeSolidPng(160, 160, { r: 245, g: 245, b: 245 });
  let processCalls = 0;

  const mockProcessor: ImageProcessor = {
    async process() {
      processCalls++;
      return {
        buffer: processedPng,
        mimeType: "image/png",
        format: "png",
        width: 160,
        height: 160,
      };
    },
    async close() {},
  };

  const worker = new ImageProcessingWorker(fixture.db, {
    dataDir: fixture.dataDir,
    root,
    processor: mockProcessor,
    log: () => {},
  });
  worker.start(50);

  let portal: Awaited<ReturnType<typeof createPortal>> | null = null;
  const admin = Fastify();
  try {
    portal = await createPortal({
      db: fixture.db,
      dataDir: fixture.dataDir,
      root,
      reader: createTestReader(),
      onJobQueued: () => worker.notify(),
    });
    registerPortalAdmin(admin, fixture.db, {
      dataDir: fixture.dataDir,
      root,
      onResumeWorker: () => worker.resumeAfterAuth(),
      onJobQueued: () => worker.notify(),
      onToggleProcessing: (enabled) => worker.setProcessingEnabled(enabled),
    });

    await portal.listen({ port: 0, host: "127.0.0.1" });
    await admin.listen({ port: 0, host: "127.0.0.1" });
    const portalAddr = portal.server.address();
    const adminAddr = admin.server.address();
    assert.ok(portalAddr && typeof portalAddr === "object");
    assert.ok(adminAddr && typeof adminAddr === "object");
    const portalUrl = `http://127.0.0.1:${portalAddr.port}`;
    const adminUrl = `http://127.0.0.1:${adminAddr.port}`;

    const cookie = await loginPortalUser(portalUrl, "photographer1", "StrongPass#123");

    // Disable master processing toggle
    const disableRes = await fetch(`${adminUrl}/api/portal/image-processing/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableRes.status, 200);
    const disableBody = (await disableRes.json()) as any;
    assert.equal(disableBody.enabled, false);
    assert.equal(disableBody.geminiStatus.enabled, false);
    assert.equal(worker.isEnabled(), false);

    // Portal status reflects disabled state
    const statusRes = await fetch(`${portalUrl}/api/image-jobs/status`, { headers: { Cookie: cookie } });
    assert.equal(statusRes.status, 200);
    assert.equal(((await statusRes.json()) as any).enabled, false);

    // Upload image while disabled -> immediate original, ZERO jobs queued
    const uploaded = await uploadMultipartImage(portalUrl, "/api/products/1/10/images", "POST", cookie, samplePng);
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.json.jobId, null);
    assert.equal(uploaded.json.processingEnabled, false);
    assert.equal(uploaded.json.images.length, 1);
    assert.equal(uploaded.json.images[0].status, "completed");

    const jobCountDisabled = fixture.db.prepare("SELECT COUNT(*) AS c FROM image_processing_jobs").get() as { c: number };
    assert.equal(jobCountDisabled.c, 0);
    assert.equal(processCalls, 0);

    // Replace image while disabled -> updates original directly without queuing
    const imgId = uploaded.json.images[0].id as string;
    const replaced = await uploadMultipartImage(portalUrl, `/api/images/${imgId}`, "PUT", cookie, replacementPng);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.json.jobId, null);
    assert.equal(replaced.json.images[0].status, "completed");
    const jobCountAfterReplace = fixture.db.prepare("SELECT COUNT(*) AS c FROM image_processing_jobs").get() as { c: number };
    assert.equal(jobCountAfterReplace.c, 0);

    // Verify served image bytes come from the replacement original (blue)
    const imgFetch = await fetch(`${portalUrl}${replaced.json.images[0].url}`);
    assert.equal(imgFetch.status, 200);
    const pixel = await sampleCenterRgb(Buffer.from(await imgFetch.arrayBuffer()));
    assert.ok(pixel.b > 180 && pixel.r < 90, `expected replacement blue pixels, got ${JSON.stringify(pixel)}`);

    // Retry while disabled is blocked with 409
    const retryRes = await fetch(`${portalUrl}/api/images/${imgId}/retry`, {
      method: "POST",
      headers: { Cookie: cookie, "X-Emoji-Request": "1", Origin: portalUrl },
    });
    assert.equal(retryRes.status, 409);

    // Re-enable toggle -> new upload queues & processes normally
    const enableRes = await fetch(`${adminUrl}/api/portal/image-processing/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enableRes.status, 200);
    assert.equal(worker.isEnabled(), true);

    const enabledUpload = await uploadMultipartImage(portalUrl, "/api/products/1/10/images", "POST", cookie, samplePng);
    assert.equal(enabledUpload.status, 200);
    assert.ok(enabledUpload.json.jobId, "expected jobId once processing re-enabled");

    const job = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = fixture.db
          .prepare("SELECT status FROM image_processing_jobs WHERE id=?")
          .get(enabledUpload.json.jobId) as { status: string } | undefined;
        if (row?.status === "completed") return row;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("timed out waiting for job after re-enabling");
    })();
    assert.equal(job.status, "completed");
    assert.equal(processCalls, 1);
  } finally {
    await worker.stop();
    if (portal) await portal.close();
    await admin.close();
    fixture.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker enforces cooldown pacing and releases browser between jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-cooldown-"));
  const fixture = setupPortalFixtures(root);
  const nowIso = new Date().toISOString();
  const samplePng = await makeSolidPng(80, 80, { r: 100, g: 150, b: 200 });

  let clock = 10_000;
  let processCalls = 0;
  let closeCalls = 0;

  try {
    for (const [imgId, offset] of [
      ["img-cd-1", 0],
      ["img-cd-2", 1],
    ] as const) {
      const imgDir = join(fixture.dataDir, "application", "product-images");
      mkdirSync(imgDir, { recursive: true });
      writeFileSync(join(imgDir, `${imgId}.webp`), await sharp(samplePng).webp().toBuffer());
      const createdAt = new Date(Date.now() + offset).toISOString();
      fixture.db
        .prepare("INSERT INTO product_images VALUES(?,?,?,?,?,?,?,NULL)")
        .run(imgId, fixture.companyId, fixture.sourceIdentity, "1", "10", fixture.userId, createdAt);
      enqueueImageProcessingJob(fixture.db, {
        companyId: fixture.companyId,
        sourceIdentity: fixture.sourceIdentity,
        productId: "1",
        unitId: "10",
        productImageId: imgId,
        userId: fixture.userId,
        originalImageId: imgId,
        prompt: "prompt",
        now: createdAt,
      });
    }

    const worker = new ImageProcessingWorker(fixture.db, {
      dataDir: fixture.dataDir,
      root,
      cooldownMs: 30_000,
      now: () => clock,
      processor: {
        async process() {
          processCalls++;
          return { buffer: samplePng, mimeType: "image/png", format: "png", width: 80, height: 80 };
        },
        async close() {
          closeCalls++;
        },
      },
      log: () => {},
    });

    // First tick processes ONLY 1 job and closes Chrome immediately
    await worker.tick();
    assert.equal(processCalls, 1);
    assert.equal(closeCalls, 1);

    // Within cooldown (< 30s): second tick is skipped
    clock += 15_000;
    await worker.tick();
    assert.equal(processCalls, 1);

    // Past max jittered cooldown (30s * 1.4 = 42s): second job runs
    clock += 45_000;
    await worker.tick();
    assert.equal(processCalls, 2);
    assert.equal(closeCalls, 2);

    const remainingPending = fixture.db
      .prepare("SELECT COUNT(*) AS c FROM image_processing_jobs WHERE status='pending'")
      .get() as { c: number };
    assert.equal(remainingPending.c, 0);
    await worker.stop();
  } finally {
    fixture.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("admin interactive login routes handle Session-0, stage progression, worker pause/resume, and cancel", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-admin-login-"));
  const fixture = setupPortalFixtures(root);
  let beforeCount = 0;
  let afterResults: boolean[] = [];
  let interactiveSupported = false;

  let resolveLogin: (() => void) | undefined;
  let capturedSignal: AbortSignal | undefined;

  const admin = Fastify();
  try {
    fixture.db
      .prepare("UPDATE portal_settings SET gemini_paused=1, gemini_requires_reauth=1, gemini_pause_reason='NEED_AUTH' WHERE id=1")
      .run();

    registerPortalAdmin(admin, fixture.db, {
      dataDir: fixture.dataDir,
      root,
      canLaunchInteractive: () =>
        interactiveSupported
          ? { supported: true }
          : { supported: false, reason: "Windows Session 0 unsupported" },
      onBeforeLogin: async () => {
        beforeCount++;
      },
      onAfterLogin: (authenticated) => {
        afterResults.push(authenticated);
      },
      interactiveLoginRunner: async (opts) => {
        capturedSignal = opts.signal;
        opts.onStage?.("waiting_for_login");
        await new Promise<void>((resolve, reject) => {
          resolveLogin = () => resolve();
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });

    await admin.listen({ port: 0, host: "127.0.0.1" });
    const addr = admin.server.address();
    assert.ok(addr && typeof addr === "object");
    const adminUrl = `http://127.0.0.1:${addr.port}`;

    // 1. Session 0 returns 409 cleanly without starting browser
    const unsupportedRes = await fetch(`${adminUrl}/api/portal/image-processing/login`, { method: "POST" });
    assert.equal(unsupportedRes.status, 409);
    const unsupportedBody = (await unsupportedRes.json()) as any;
    assert.equal(unsupportedBody.ok, false);
    assert.equal(unsupportedBody.interactiveLogin.interactiveSupported, false);
    assert.equal(beforeCount, 0);

    // 2. Enable interactive mode -> start login -> cancel halfway
    interactiveSupported = true;
    const startRes = await fetch(`${adminUrl}/api/portal/image-processing/login`, { method: "POST" });
    assert.equal(startRes.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(beforeCount, 1);

    const statusMidRes = await fetch(`${adminUrl}/api/portal/image-processing/login/status`);
    const statusMid = (await statusMidRes.json()) as any;
    assert.equal(statusMid.interactiveLogin.active, true);
    assert.equal(statusMid.interactiveLogin.stage, "waiting_for_login");

    const cancelRes = await fetch(`${adminUrl}/api/portal/image-processing/login/cancel`, { method: "POST" });
    assert.equal(cancelRes.status, 200);
    assert.equal(capturedSignal?.aborted, true);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(afterResults, [false]);

    // 3. Start login again -> complete successfully -> reauth cleared & worker resumed
    const secondStartRes = await fetch(`${adminUrl}/api/portal/image-processing/login`, { method: "POST" });
    assert.equal(secondStartRes.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(resolveLogin);
    resolveLogin();
    await new Promise((r) => setTimeout(r, 30));

    const finalStatusRes = await fetch(`${adminUrl}/api/portal/image-processing/login/status`);
    const finalStatus = (await finalStatusRes.json()) as any;
    assert.equal(finalStatus.interactiveLogin.active, false);
    assert.equal(finalStatus.interactiveLogin.status, "succeeded");
    assert.equal(finalStatus.geminiStatus.requiresReauth, false);
    assert.equal(finalStatus.geminiStatus.paused, false);
    assert.deepEqual(afterResults, [false, true]);
  } finally {
    await admin.close();
    fixture.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("GeminiBrowserClient dismisses unknown overlay dialogs and enables temporary chat when present", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-overlay-tempchat-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "app.sqlite"));
  const generatedPng = await makeSolidPng(256, 256, { r: 30, g: 200, b: 90 });
  const samplePath = join(root, "source.png");
  writeFileSync(samplePath, await makeSolidPng(256, 256, { r: 220, g: 40, b: 40 }));

  let tempChatEnabled = false;
  let overlayDismissed = false;

  const server = createServer((req, res) => {
    const reqUrl = req.url || "/";
    if (reqUrl === "/temp-chat" && req.method === "POST") {
      tempChatEnabled = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (reqUrl === "/overlay-dismissed" && req.method === "POST") {
      overlayDismissed = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (reqUrl.startsWith("/generated-fullres.png")) {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition": 'attachment; filename="gemini-generated-fullres.png"',
      });
      res.end(generatedPng);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html><body>
        <div class="cdk-overlay-container" id="promoOverlay" style="position:fixed;inset:0;z-index:9999;">
          <div class="cdk-overlay-backdrop cdk-overlay-backdrop-showing" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);"></div>
          <div class="cdk-overlay-pane" style="position:fixed;inset:20px;background:#fff;">
            <div role="dialog">
              <h2>New Feature Announcement</h2>
              <button type="button" id="gotItBtn">Got it</button>
            </div>
          </div>
        </div>

        <main id="chat">
          <div data-test-id="temp-chat-button-container">
            <button type="button" id="tempChatBtn" aria-label="Turn on temporary chat" aria-pressed="false">Temp Chat</button>
          </div>
          <button type="button" id="toolsBtn" aria-label="Upload & tools">Upload &amp; tools</button>
          <div id="toolsMenu" role="menu" style="display:none">
            <button type="button" id="uploadMenuItem" role="menuitem">Upload files</button>
          </div>
          <input id="fileInput" type="file" accept="image/*" style="display:none" />
          <div id="previewMount"></div>
          <div id="promptBox" role="textbox" aria-label="Enter a prompt for Gemini" contenteditable="true"></div>
          <button type="button" id="sendBtn" aria-label="Send message">Send</button>
        </main>

        <script>
          const promoOverlay = document.getElementById('promoOverlay');
          document.getElementById('gotItBtn').addEventListener('click', () => {
            promoOverlay.remove();
            fetch('/overlay-dismissed', { method: 'POST' });
          });
          document.getElementById('tempChatBtn').addEventListener('click', (e) => {
            e.currentTarget.setAttribute('aria-pressed', 'true');
            fetch('/temp-chat', { method: 'POST' });
          });
          const toolsBtn = document.getElementById('toolsBtn');
          const toolsMenu = document.getElementById('toolsMenu');
          const fileInput = document.getElementById('fileInput');
          toolsBtn.addEventListener('click', () => { toolsMenu.style.display = 'block'; });
          document.getElementById('uploadMenuItem').addEventListener('click', () => {
            toolsMenu.style.display = 'none';
            fileInput.click();
          });
          fileInput.addEventListener('change', () => {
            const f = fileInput.files && fileInput.files[0];
            if (!f) return;
            const p = document.createElement('uploader-file-preview');
            p.textContent = f.name;
            document.getElementById('previewMount').appendChild(p);
          });
          document.getElementById('sendBtn').addEventListener('click', () => {
            const turn = document.createElement('model-response');
            document.getElementById('chat').appendChild(turn);
            setTimeout(() => {
              const img = document.createElement('img');
              img.src = '/generated-fullres.png';
              img.width = 256;
              img.height = 256;
              turn.appendChild(img);
              const dl = document.createElement('a');
              dl.href = '/generated-fullres.png';
              dl.download = 'out.png';
              dl.setAttribute('aria-label', 'Download full size');
              dl.textContent = 'Download';
              turn.appendChild(dl);
            }, 60);
          });
        </script>
      </body></html>`);
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const mockUrl = `http://127.0.0.1:${addr.port}`;

  const prevUrl = process.env.GEMINI_WEB_URL;
  const prevProfile = process.env.GEMINI_PROFILE_DIR;
  process.env.GEMINI_WEB_URL = mockUrl;
  process.env.GEMINI_PROFILE_DIR = join(root, "gemini-profile");

  try {
    const cfg = getImageProcessingConfig({ db, dataDir, root });
    const client = new GeminiBrowserClient(cfg, root);
    const out = await client.process({
      jobId: "overlay-tempchat-test",
      sourceImagePath: samplePath,
      prompt: "Create studio product image",
    });
    assert.ok(out.buffer.length > 0);
    assert.equal(overlayDismissed, true);
    assert.equal(tempChatEnabled, true);
    await client.close();
  } finally {
    restoreEnvVar("GEMINI_WEB_URL", prevUrl);
    restoreEnvVar("GEMINI_PROFILE_DIR", prevProfile);
    db.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("GeminiBrowserClient waits for delayed temp-chat hydration and cleans up fallback persistent chats despite overlapping anchor", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-delayed-cleanup-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "app.sqlite"));
  const generatedPng = await makeSolidPng(256, 256, { r: 20, g: 140, b: 220 });
  const samplePath = join(root, "source.png");
  writeFileSync(samplePath, await makeSolidPng(256, 256, { r: 200, g: 80, b: 80 }));

  let delayedTempActivated = false;
  let chatDeleted = false;

  const server = createServer((req, res) => {
    const reqUrl = req.url || "/";
    if (reqUrl === "/temp-chat" && req.method === "POST") {
      delayedTempActivated = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (reqUrl === "/chat-deleted" && req.method === "POST") {
      chatDeleted = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (reqUrl.startsWith("/generated-fullres.png")) {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition": 'attachment; filename="gemini-generated-fullres.png"',
      });
      res.end(generatedPng);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html><body>
        <aside id="sidebar" style="position:relative;width:260px;">
          <gem-nav-list-item data-test-id="conversation" id="convItem" style="display:none;position:relative;height:36px;">
            <a id="convLink" href="/app/abc123456" style="position:absolute;inset:0;z-index:2;display:block;">Test Chat</a>
            <button type="button" id="moreBtn" data-test-id="actions-menu-button" style="position:relative;z-index:1;">More</button>
          </gem-nav-list-item>
        </aside>

        <div id="menuOverlay" class="cdk-overlay-pane" style="display:none;">
          <button type="button" role="menuitem" data-test-id="delete-button">Delete</button>
        </div>
        <div id="dialogOverlay" class="cdk-overlay-pane" style="display:none;">
          <message-dialog>
            <h2>Delete chat?</h2>
            <button type="button" id="confirmDeleteBtn">Delete</button>
          </message-dialog>
        </div>

        <main id="chat">
          <div data-test-id="temp-chat-button-container" id="tempWrap" style="display:none;">
            <button type="button" id="tempChatBtn" aria-label="Turn on temporary chat">Temp</button>
          </div>
          <button type="button" id="toolsBtn" aria-label="Upload & tools">Upload &amp; tools</button>
          <input id="fileInput" type="file" accept="image/*" style="display:none" />
          <div id="previewMount"></div>
          <div id="promptBox" role="textbox" aria-label="Enter a prompt for Gemini" contenteditable="true"></div>
          <button type="button" id="sendBtn" aria-label="Send message">Send</button>
        </main>

        <script>
          setTimeout(() => {
            document.getElementById('tempWrap').style.display = 'block';
          }, 350);

          document.getElementById('tempChatBtn').addEventListener('click', (e) => {
            e.currentTarget.setAttribute('aria-label', 'Turn off temporary chat');
            document.getElementById('tempWrap').classList.add('temp-chat-on');
            fetch('/temp-chat', { method: 'POST' });
          });
          document.getElementById('toolsBtn').addEventListener('click', () => document.getElementById('fileInput').click());
          document.getElementById('fileInput').addEventListener('change', () => {
            const p = document.createElement('uploader-file-preview');
            p.textContent = 'img';
            document.getElementById('previewMount').appendChild(p);
          });
          document.getElementById('sendBtn').addEventListener('click', () => {
            history.pushState({}, '', '/app/abc123456');
            setTimeout(() => {
              document.getElementById('convItem').style.display = 'block';
              const turn = document.createElement('model-response');
              const img = document.createElement('img');
              img.src = '/generated-fullres.png';
              img.width = 256; img.height = 256;
              turn.appendChild(img);
              const dl = document.createElement('a');
              dl.href = '/generated-fullres.png'; dl.download = 'out.png';
              dl.setAttribute('aria-label', 'Download full size');
              dl.textContent = 'Download';
              turn.appendChild(dl);
              document.getElementById('chat').appendChild(turn);
            }, 60);
          });
          document.getElementById('moreBtn').addEventListener('click', () => {
            document.getElementById('menuOverlay').style.display = 'block';
          });
          document.querySelector('[data-test-id="delete-button"]').addEventListener('click', () => {
            document.getElementById('menuOverlay').style.display = 'none';
            document.getElementById('dialogOverlay').style.display = 'block';
          });
          document.getElementById('confirmDeleteBtn').addEventListener('click', () => {
            document.getElementById('dialogOverlay').style.display = 'none';
            document.getElementById('convItem').remove();
            fetch('/chat-deleted', { method: 'POST' });
          });
        </script>
      </body></html>`);
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const mockUrl = `http://127.0.0.1:${addr.port}`;

  const prevUrl = process.env.GEMINI_WEB_URL;
  const prevProfile = process.env.GEMINI_PROFILE_DIR;
  process.env.GEMINI_WEB_URL = mockUrl;
  process.env.GEMINI_PROFILE_DIR = join(root, "gemini-profile");

  try {
    const cfg = getImageProcessingConfig({ db, dataDir, root });
    const client = new GeminiBrowserClient(cfg, root);
    const out = await client.process({
      jobId: "delayed-cleanup-test",
      sourceImagePath: samplePath,
      prompt: "Studio photo",
    });
    assert.ok(out.buffer.length > 0);
    assert.equal(delayedTempActivated, true);
    assert.equal(chatDeleted, true);
    await client.close();
  } finally {
    restoreEnvVar("GEMINI_WEB_URL", prevUrl);
    restoreEnvVar("GEMINI_PROFILE_DIR", prevProfile);
    db.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractProductTypeHint + buildImagePromptForProduct ignore section name and inject clean ERP type hints", () => {
  assert.equal(
    extractProductTypeHint({ kind: "ملابس", category: "هودي", description: "هودي china" }),
    "ملابس — هودي",
  );
  assert.equal(
    extractProductTypeHint({ kind: "ملابس", category: "جبردين", description: "بنطلون جبردين مستورد" }),
    "ملابس — جبردين — بنطلون",
  );
  assert.equal(
    extractProductTypeHint({ kind: "ملابس", category: "تريكو", description: "نص سوسته قطيفه" }),
    "ملابس — تريكو — نص سوسته",
  );
  assert.equal(
    extractProductTypeHint({ kind: "ملابس", category: "جينز", description: "( قديم ) بنطلون رجالي جينز ليكرا الوان" }),
    "ملابس — جينز — بنطلون",
  );
  assert.equal(
    extractProductTypeHint({ kind: "ملابس", category: "شورت", description: "ايموجي شورت رجالي قصات 450" }),
    "ملابس — شورت",
  );
  assert.equal(
    extractProductTypeHint({ kind: "كوتشي", category: "خاص", description: "ك ر رانينج خاص 550" }),
    "كوتشي — رانينج",
  );
  assert.equal(
    extractProductTypeHint({ kind: "اكسسوار", category: "شنطه cross", description: "شنطه مستورد cross" }),
    "اكسسوار — شنطه cross",
  );

  const injected = buildImagePromptForProduct("BASE_PROMPT", {
    kind: "ملابس",
    category: "ترنج",
    description: "ترنج قصات",
  });
  assert.ok(injected.startsWith("BASE_PROMPT\n\n"));
  assert.match(injected, /Catalog item type context: "ملابس — ترنج"/);

  const placeholderReplaced = buildImagePromptForProduct("Photo of {{product}} cleanly.", {
    kind: "كوتشي",
    category: "سكتشر",
    description: "ك ر سكتشر مستورد 900",
  });
  assert.equal(placeholderReplaced, "Photo of كوتشي — سكتشر cleanly.");
});

test("normalizeWatermarkLogo & applyStudioCatalogStamp overlay top-right logo & bottom-left code cleanly", async () => {
  await assert.rejects(() => normalizeWatermarkLogo(Buffer.from("not-an-image")));

  // 900x450 logo with outer transparent margin + colored inner rect -> normalized <= 512px PNG
  const rawLogo = await sharp({
    create: { width: 900, height: 450, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 420, height: 180, channels: 4, background: { r: 20, g: 90, b: 220, alpha: 1 } },
        })
          .png()
          .toBuffer(),
        left: 240,
        top: 135,
      },
    ])
    .png()
    .toBuffer();

  const normalizedLogo = await normalizeWatermarkLogo(rawLogo);
  assert.equal(normalizedLogo.mime, "image/png");
  assert.equal(normalizedLogo.width, 512);
  assert.equal(normalizedLogo.height, 256);

  const productPhoto = await makeSolidPng(900, 1200, { r: 240, g: 240, b: 235 });

  // No logo & no code -> returns identical bytes without re-encoding
  const unchanged = await applyStudioCatalogStamp(productPhoto, {});
  assert.equal(Buffer.compare(unchanged, productPhoto), 0);

  // Code + transparent logo -> same 900x1200 dimensions, blue logo at top-right, dark text at bottom-left
  const stamped = await applyStudioCatalogStamp(productPhoto, {
    logoBuffer: normalizedLogo.buffer,
    productCode: "S32033 & <A>",
  });
  const stampedRaw = await sharp(stamped).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(stampedRaw.info.width, 900);
  assert.equal(stampedRaw.info.height, 1200);

  const regionHasContrast = (x0: number, y0: number, x1: number, y1: number, pred: (rgb: { r: number; g: number; b: number }) => boolean) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * stampedRaw.info.width + x) * 3;
        if (pred({ r: stampedRaw.data[idx]!, g: stampedRaw.data[idx + 1]!, b: stampedRaw.data[idx + 2]! })) {
          return true;
        }
      }
    }
    return false;
  };

  // Top-right has blue trimmed logo pixels
  assert.ok(
    regionHasContrast(700, 35, 870, 230, (c) => c.b > 170 && c.r < 60),
    "expected blue logo overlay in top-right corner",
  );
  // Top-left remains untouched studio background for portal zoom button
  assert.ok(
    !regionHasContrast(20, 20, 150, 150, (c) => c.r < 220 || c.b < 215),
    "expected top-left corner to remain untouched",
  );
  // Bottom-left contains dark text pixels drawn directly on photo (no dark pill box)
  assert.ok(
    regionHasContrast(35, 1110, 290, 1165, (c) => c.r < 60 && c.g < 60 && c.b < 60),
    "expected dark text glyphs in bottom-left corner",
  );
  // Most of bottom-left box remains original light studio background (no filled rectangle behind text)
  let lightPixels = 0;
  for (let y = 1115; y < 1160; y++) {
    for (let x = 40; x < 240; x++) {
      const idx = (y * 900 + x) * 3;
      if (stampedRaw.data[idx]! > 220) lightPixels++;
    }
  }
  assert.ok(lightPixels > 45 * 200 * 0.55, "expected open studio background around text with no rectangle box");

  // White-background opaque JPEG/PNG logo knocks out outer white seamlessly
  const opaqueWhiteLogo = await sharp({
    create: { width: 160, height: 160, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 10, g: 120, b: 60 } } })
          .png()
          .toBuffer(),
        left: 40,
        top: 40,
      },
    ])
    .png()
    .toBuffer();
  const stampedOpaqueLogo = await applyStudioCatalogStamp(productPhoto, { logoBuffer: opaqueWhiteLogo });
  const opaqueMeta = await sharp(stampedOpaqueLogo).metadata();
  assert.equal(opaqueMeta.width, 900);
  assert.equal(opaqueMeta.height, 1200);

  // Dark background automatically switches code ink to bright white for readability
  const darkPhoto = await makeSolidPng(900, 1200, { r: 20, g: 20, b: 22 });
  const darkStamped = await sharp(await applyStudioCatalogStamp(darkPhoto, { productCode: "V 6302" }))
    .removeAlpha()
    .raw()
    .toBuffer();
  let whiteGlyphPixels = 0;
  for (let y = 1110; y < 1165; y++) {
    for (let x = 35; x < 250; x++) {
      const idx = (y * 900 + x) * 3;
      if (darkStamped[idx]! > 210 && darkStamped[idx + 1]! > 210 && darkStamped[idx + 2]! > 210) whiteGlyphPixels++;
    }
  }
  assert.ok(whiteGlyphPixels > 30, "expected bright white text contrast on dark photo background");
});

test("Admin watermark logo API, worker end-to-end stamping with reader fallback, and backup restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgproc-watermark-e2e-"));
  const fixture = setupPortalFixtures(root);
  const samplePng = await makeSolidPng(400, 400, { r: 220, g: 40, b: 40 });
  const processedPng = await makeSolidPng(800, 900, { r: 30, g: 185, b: 120 });
  const brandLogoPng = await makeSolidPng(320, 140, { r: 15, g: 70, b: 190 });
  const reader = createTestReader();

  const processor: ImageProcessor = {
    async process() {
      return { buffer: processedPng, width: 800, height: 900, format: "png" };
    },
  };
  const worker = new ImageProcessingWorker(fixture.db, {
    dataDir: fixture.dataDir,
    root,
    reader,
    processor,
  });

  const admin = Fastify();
  const portal = await createPortal({
    db: fixture.db,
    dataDir: fixture.dataDir,
    root,
    reader,
    onJobQueued: () => worker.notify(),
  });
  registerPortalAdmin(admin, fixture.db, {
    dataDir: fixture.dataDir,
    root,
    reader,
    onResumeWorker: () => worker.resumeAfterAuth(),
    onJobQueued: () => worker.notify(),
    onToggleProcessing: (enabled) => worker.setProcessingEnabled(enabled),
  });

  try {
    await portal.listen({ port: 0, host: "127.0.0.1" });
    await admin.listen({ port: 0, host: "127.0.0.1" });
    const portalAddr = portal.server.address() as any;
    const adminAddr = admin.server.address() as any;
    const portalUrl = `http://127.0.0.1:${portalAddr.port}`;
    const adminUrl = `http://127.0.0.1:${adminAddr.port}`;

    // 1. Initially no watermark logo
    const initSettings = (await (await fetch(`${adminUrl}/api/portal/settings`)).json()) as any;
    assert.equal(initSettings.hasWatermarkLogo, false);
    const initProc = (await (await fetch(`${adminUrl}/api/portal/image-processing`)).json()) as any;
    assert.equal(initProc.hasWatermarkLogo, false);
    assert.equal((await fetch(`${adminUrl}/api/portal/image-processing/watermark-logo`)).status, 404);

    // 2. Reject invalid upload
    const badForm = new FormData();
    badForm.append("logo", new Blob([Buffer.from("invalid-bytes")], { type: "image/png" }), "bad.png");
    const badUploadRes = await fetch(`${adminUrl}/api/portal/image-processing/watermark-logo`, {
      method: "POST",
      body: badForm,
    });
    assert.equal(badUploadRes.status, 400);

    // 3. Upload valid logo & verify GET settings + image payload
    const uploadRes = await uploadMultipartImage(
      adminUrl,
      "/api/portal/image-processing/watermark-logo",
      "POST",
      "",
      brandLogoPng,
      "logo.png",
    );
    // Note helper uses field name "file" whereas @fastify/multipart request.file() accepts any single file field.
    assert.equal(uploadRes.status, 200);
    assert.equal(uploadRes.json.ok, true);
    assert.equal(uploadRes.json.hasWatermarkLogo, true);

    const logoRes = await fetch(`${adminUrl}/api/portal/image-processing/watermark-logo`);
    assert.equal(logoRes.status, 200);
    assert.equal(logoRes.headers.get("content-type"), "image/png");
    assert.equal(logoRes.headers.get("cache-control"), "private, no-store");
    const logoMeta = await sharp(Buffer.from(await logoRes.arrayBuffer())).metadata();
    assert.equal(logoMeta.format, "png");
    assert.equal(logoMeta.width, 320);

    // 4. Upload product image & process -> stores product_code & stamps footer onto final WebP
    const cookie = await loginPortalUser(portalUrl, "photographer1", "StrongPass#123");
    const productUp = await uploadMultipartImage(portalUrl, "/api/products/1/10/images", "POST", cookie, samplePng);
    assert.equal(productUp.status, 200);
    const jobId = productUp.json.jobId as string;
    const jobRow = fixture.db
      .prepare("SELECT product_code FROM image_processing_jobs WHERE id=?")
      .get(jobId) as { product_code: string | null };
    assert.equal(jobRow.product_code, "M-100");

    await worker.tick();
    const imgId = productUp.json.images[0].id as string;
    const stampedRes = await fetch(`${portalUrl}/api/images/${imgId}`);
    assert.equal(stampedRes.status, 200);
    const stampedBuf = Buffer.from(await stampedRes.arrayBuffer());
    const stampedRaw = await sharp(stampedBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(stampedRaw.info.width, 800);
    assert.equal(stampedRaw.info.height, 900);
    // Verify top-right has blue brand logo pixels stamped over the processed green background
    let blueLogoPixels = 0;
    for (let y = 30; y < 170; y++) {
      for (let x = 620; x < 770; x++) {
        const idx = (y * 800 + x) * 3;
        if (stampedRaw.data[idx + 2]! > 150 && stampedRaw.data[idx]! < 50) blueLogoPixels++;
      }
    }
    assert.ok(blueLogoPixels > 100, "expected top-right logo overlay on processed WebP");
    // Verify bottom-left contains dark code glyphs stamped directly without white/black bar
    let darkCodePixels = 0;
    for (let y = 820; y < 880; y++) {
      for (let x = 30; x < 230; x++) {
        const idx = (y * 800 + x) * 3;
        if (stampedRaw.data[idx]! < 50 && stampedRaw.data[idx + 1]! < 50 && stampedRaw.data[idx + 2]! < 50) {
          darkCodePixels++;
        }
      }
    }
    assert.ok(darkCodePixels > 30, "expected bottom-left code text overlay on processed WebP");

    // 5. Legacy job without product_code falls back to worker reader.get()
    const legacyRow = fixture.db
      .prepare("SELECT original_image_id FROM product_image_state WHERE product_image_id=?")
      .get(imgId) as { original_image_id: string };
    const fallbackJobId = enqueueImageProcessingJob(fixture.db, {
      companyId: fixture.companyId,
      sourceIdentity: fixture.sourceIdentity,
      productId: "1",
      unitId: "10",
      productImageId: imgId,
      userId: fixture.userId,
      originalImageId: legacyRow.original_image_id,
      prompt: "Studio photo",
    });
    await worker.tick();
    const fallbackDone = fixture.db
      .prepare("SELECT status, result_image_id FROM image_processing_jobs WHERE id=?")
      .get(fallbackJobId) as { status: string; result_image_id: string | null };
    assert.equal(fallbackDone.status, "completed");
    const fallbackBlob = readFileSync(resolve(fixture.dataDir, "product-images", `${fallbackDone.result_image_id}.webp`));
    const fallbackRaw = await sharp(fallbackBlob).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(fallbackRaw.info.width, 800);
    assert.equal(fallbackRaw.info.height, 900);
    let fallbackCodePixels = 0;
    for (let y = 820; y < 880; y++) {
      for (let x = 30; x < 230; x++) {
        const idx = (y * 800 + x) * 3;
        if (fallbackRaw.data[idx]! < 50 && fallbackRaw.data[idx + 1]! < 50 && fallbackRaw.data[idx + 2]! < 50) {
          fallbackCodePixels++;
        }
      }
    }
    assert.ok(fallbackCodePixels > 30, "expected reader fallback to stamp product code on bottom-left");

    // 6. Backup preserves watermark_logo across deletion & restore
    const backupDir = join(root, "backup-dir");
    await createBackup(fixture.dataDir, backupDir, true);
    assert.equal(verifyBackup(backupDir), 4);

    const delRes = await fetch(`${adminUrl}/api/portal/image-processing/watermark-logo`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    assert.equal(((await delRes.json()) as any).hasWatermarkLogo, false);
    assert.equal((await fetch(`${adminUrl}/api/portal/image-processing/watermark-logo`)).status, 404);

    fixture.db.close();
    await restoreBackup(fixture.dataDir, backupDir);
    const reopenedDb = openDatabase(join(fixture.dataDir, "app.sqlite"));
    const restoredRow = reopenedDb
      .prepare("SELECT watermark_logo, watermark_logo_type FROM portal_settings WHERE id=1")
      .get() as { watermark_logo: Buffer | null; watermark_logo_type: string | null };
    reopenedDb.close();
    assert.ok(restoredRow.watermark_logo && restoredRow.watermark_logo.length > 0);
    assert.equal(restoredRow.watermark_logo_type, "image/png");
  } finally {
    await portal.close().catch(() => {});
    await admin.close().catch(() => {});
    try {
      fixture.db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
