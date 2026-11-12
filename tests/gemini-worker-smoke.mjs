import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { openDatabase } from '../dist/runtime/packages/storage/database.js';
import { registerGeminiWorkerBridge } from '../dist/runtime/apps/server/image-processing/bridge.js';
import { saveProductImageBlob } from '../dist/runtime/apps/server/image-processing/storage.js';
import { ImageProcessingWorker, enqueueImageProcessingJob, readExternalWorkerStatus } from '../dist/runtime/apps/server/image-processing/worker.js';

// Exercise the shipped entry point in its own process against an offline Gemini
// fixture, including real Chromium, downloads, bridge auth and backend stamping.
const dir = mkdtempSync(join(tmpdir(), 'Gemini worker smoke '));
const dataDir = join(dir, 'server-data');
const profileRoot = join(dir, 'worker profile');
mkdirSync(dataDir);
const db = openDatabase(join(dataDir, 'app.sqlite'));
const worker = new ImageProcessingWorker(db, { dataDir, root: resolve('.'), workerMode: 'external', log() {} });
const bridge = Fastify();
const tokenFile = join(dir, 'bridge.json');
registerGeminiWorkerBridge(bridge, { db, worker, dataDir, root: resolve('.'), bridgeTokenFile: tokenFile });
const image = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#dab579' } }).png().toBuffer();
let submissions = 0;
const fixture = createServer((req, res) => {
  if (req.url === '/result.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(image);
  } else if (req.url === '/submit') {
    submissions++;
    req.resume();
    res.end('ok');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body>
      <button aria-label="Upload & tools" onclick="document.getElementById('menu').hidden=false">Tools</button>
      <button id="menu" role="menuitem" hidden onclick="document.getElementById('file').click()">Upload files</button>
      <input id="file" type="file" onchange="document.getElementById('preview').innerHTML='<uploader-file-preview>uploaded</uploader-file-preview>'">
      <div id="preview"></div><div role="textbox" contenteditable="true" aria-label="Enter a prompt"></div>
      <button aria-label="Send message" onclick="submitJob()">Send</button>
      <script>async function submitJob() {
        await fetch('/submit', {method:'POST'});
        const turn = document.createElement('model-response');
        turn.innerHTML = '<img src="/result.png" width="512" height="512"><a href="/result.png" download="result.png" aria-label="Download image">Download</a>';
        document.body.appendChild(turn);
      }</script></body></html>`);
  }
});
let child;
let childExit;
let logs = '';
async function waitUntil(check, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (child && child.exitCode !== null) throw new Error(`Worker exited ${child.exitCode}: ${logs}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}: ${logs}`);
    await new Promise(r => setTimeout(r, 100));
  }
}
try {
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  await bridge.listen({ port: 0, host: '127.0.0.1' });
  const bridgeUrl = `http://127.0.0.1:${bridge.server.address().port}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO companies(id,name,settings,created_at) VALUES('c','Smoke','{}',?)").run(now);
  db.prepare("INSERT INTO photo_users(id,company_id,username,password_hash,enabled,created_at) VALUES('u','c','smoke','unused',1,?)").run(now);
  const source = await saveProductImageBlob(dataDir, image);
  const enqueue = id => {
    db.prepare("INSERT INTO product_images(id,company_id,source_identity,product_id,unit_id,created_by,created_at) VALUES(?,'c','s','p','unit','u',?)").run(id, now);
    return enqueueImageProcessingJob(db, { companyId: 'c', sourceIdentity: 's', productId: 'p', unitId: 'unit', productImageId: id, userId: 'u', originalImageId: source.id, prompt: 'Preserve this exact product', productCode: 'SMOKE-1' });
  };
  const firstJob = enqueue('first');
  const env = {
    ...process.env, EMOJI_APP_ROOT: resolve('.'),
    EMOJI_GEMINI_BRIDGE_URL: bridgeUrl, EMOJI_GEMINI_BRIDGE_TOKEN_FILE: tokenFile,
    GEMINI_WEB_URL: `http://127.0.0.1:${fixture.address().port}/app`,
    GEMINI_WORKER_POLL_MS: '100', GEMINI_JOB_COOLDOWN_MS: '0',
    GEMINI_TEMP_CHAT: '0', GEMINI_KEEP_CHATS: '1',
    GEMINI_NAV_TIMEOUT_MS: '5000', GEMINI_UPLOAD_TIMEOUT_MS: '5000',
    GEMINI_GENERATION_TIMEOUT_MS: '10000', GEMINI_DOWNLOAD_TIMEOUT_MS: '5000',
  };
  // CLI profile-root must work without environment flags, including paths with spaces.
  delete env.GEMINI_PROFILE_DIR;
  delete env.GEMINI_DIRECT_PROFILE;
  delete env.EMOJI_SUPERVISOR_PID;
  child = spawn(process.execPath, [resolve('dist/runtime/apps/server/image-processing/worker-runner.js'), '--profile-root', profileRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { logs += b; });
  child.stderr.on('data', b => { logs += b; });
  childExit = once(child, 'exit');
  const completed = id => db.prepare('SELECT status FROM image_processing_jobs WHERE id=?').get(id)?.status === 'completed';
  await waitUntil(() => completed(firstJob), 'first result');
  const secondJob = enqueue('second');
  await waitUntil(() => completed(secondJob), 'second result with reused browser');
  assert.equal(submissions, 2);
  assert.ok(existsSync(join(profileRoot, 'profile', 'Default')), 'direct persistent profile must use the requested root');
  assert.equal(existsSync(join(profileRoot, 'gemini-auth')), false, 'must not silently nest a different profile');
  assert.equal(existsSync(join(profileRoot, 'app.sqlite')), false, 'worker must not open server database');
  assert.equal(existsSync(join(profileRoot, 'secret.key')), false, 'direct profile needs no shared cookie encryption key');
  assert.ok(readExternalWorkerStatus(dataDir)?.workerId.startsWith('ext-'));
  for (const id of [firstJob, secondJob]) {
    const row = db.prepare('SELECT result_image_id FROM image_processing_jobs WHERE id=?').get(id);
    assert.ok(existsSync(join(dataDir, 'product-images', `${row.result_image_id}.webp`)));
  }
  console.log('PASS: compiled external Gemini worker completed two jobs through real Chromium and localhost bridge, with persistent profile, downloads and stored results.');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    await childExit;
    clearTimeout(killTimer);
  }
  await worker.stop();
  await bridge.close();
  fixture.closeAllConnections();
  await new Promise(r => fixture.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
