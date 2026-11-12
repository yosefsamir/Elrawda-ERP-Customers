import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../dist/runtime/apps/server/image-processing/config.js';

const root = resolve('dist/portal');
const browser = await chromium.launch({ executablePath: resolveChromiumExecutable(), headless: true });
let paused = true;
let statusRequests = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://portal.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = value => route.fulfill({ json: value });
    if (path === '/api/session') return json({ authenticated: true, username: 'photos' });
    if (path === '/api/image-jobs/status') {
      statusRequests++;
      return json({ enabled: true, paused, requiresReauth: paused, pauseReason: 'Gemini worker REAUTH_REQUIRED at C:\\profile' });
    }
    if (path === '/api/products' || path.startsWith('/api/products/')) {
      return json({ products: [{ id: '1', unitId: '1', code: 'TEST', name: 'صنف تجريبي', category: '', description: 'صنف تجريبي', unit: 'قطعة', price: 100,
        images: [{ id: 'image', url: '/emoji-logo.png', status: 'failed', error: 'Gemini Chromium timeout at C:\\worker\\profile' }],
      }] });
    }
    if (path.startsWith('/api/')) return json({ products: [] });
    const file = path === '/manage' ? 'index.html' : path.slice(1);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(file)] ?? 'application/octet-stream';
    return route.fulfill({ body: await readFile(resolve(root, file)), contentType: mime });
  });
  await page.goto('http://portal.test/manage');
  await page.getByLabel('كود الموديل أو رقم الصنف', { exact: true }).fill('TEST');
  await page.locator('button[type="submit"]').first().click();
  const warning = page.locator('.notice.warning');
  await warning.waitFor({ state: 'visible' });
  assert.match(await warning.innerText(), /معالجة الصور متوقفة/);
  assert.doesNotMatch(await page.locator('body').innerText(), /Gemini|Chromium|REAUTH_REQUIRED|C:\\|worker/i);
  assert.match(await page.locator('.image-job-error').innerText(), /تعذرت معالجة الصورة/);

  // There are no pending images. The warning must still follow service recovery
  // and subsequent stoppage without reload, another search, or another upload.
  paused = false;
  await warning.waitFor({ state: 'hidden', timeout: 8_000 });
  paused = true;
  await warning.waitFor({ state: 'visible', timeout: 8_000 });
  assert.ok(statusRequests >= 3);
  assert.deepEqual(errors, []);
  console.log('PASS: built photo portal refreshes processing availability while idle and shows only simple image-processing messages.');
} finally {
  await browser.close();
}
