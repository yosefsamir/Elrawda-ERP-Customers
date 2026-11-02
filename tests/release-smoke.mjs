import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, symlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const defaultReleaseDir = resolve('release', `whatsapp-erp-windows-${pkg.version}`);
const packagedDir = process.env.ELRAWDA_RELEASE_DIR || (existsSync(defaultReleaseDir) ? defaultReleaseDir : null);

const temp = mkdtempSync(join(tmpdir(), 'Elrawda-release-smoke-'));
const appRoot = join(temp, 'release-1');
const data = join(temp, 'customer-data');
const ready = join(temp, 'ready.json');

if (packagedDir && existsSync(packagedDir)) {
  cpSync(packagedDir, appRoot, { recursive: true });
} else {
  cpSync(resolve('dist'), join(appRoot, 'dist'), { recursive: true });
  cpSync('package.json', join(appRoot, 'package.json'));
}

if (!existsSync(join(appRoot, 'node_modules'))) {
  symlinkSync(resolve(process.env.ELRAWDA_SMOKE_MODULES || 'node_modules'), join(appRoot, 'node_modules'), 'dir');
}

const nodeExec =
  process.platform === 'win32' && existsSync(join(appRoot, 'runtime', 'node.exe'))
    ? join(appRoot, 'runtime', 'node.exe')
    : process.execPath;

const env = {
  ...process.env,
  EMOJI_APP_ROOT: appRoot,
  EMOJI_DATA_DIR: data,
  EMOJI_READY_FILE: ready,
  PORT: '0',
  NODE_PATH: join(appRoot, 'node_modules'),
};

let child;
let logs = '';

async function run(args) {
  return new Promise((yes, no) => {
    const c = spawn(nodeExec, args, { cwd: appRoot, env });
    let text = '';
    c.stdout.on('data', (b) => (text += b));
    c.stderr.on('data', (b) => (text += b));
    c.on('exit', (code) => (code === 0 ? yes(text) : no(new Error(text))));
    c.on('error', no);
  });
}

async function start() {
  if (existsSync(ready)) rmSync(ready);
  child = spawn(nodeExec, ['dist/runtime/apps/server/index.js'], { cwd: appRoot, env });
  child.stdout.on('data', (b) => (logs += b));
  child.stderr.on('data', (b) => (logs += b));
  const deadline = Date.now() + 20000;
  while (!existsSync(ready)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(logs);
    await new Promise((r) => setTimeout(r, 100));
  }
  return JSON.parse(readFileSync(ready, 'utf8')).port;
}

async function stop() {
  const exited = new Promise((r) => child.once('exit', r));
  await run(['dist/runtime/scripts/maintenance/admin.js', 'stop']);
  assert.equal(await exited, 0);
}

try {
  let port = await start();
  let base = `http://127.0.0.1:${port}`;
  const health = await (await fetch(base + '/healthz')).json();
  assert.equal(health.ok, true);
  assert.equal(health.schemaVersion, 2);

  const auth = await fetch(base + '/api/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-emoji-request': '1' },
    body: JSON.stringify({ username: 'releaseqa', password: 'OnlyForIsolatedTests!' }),
  });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get('set-cookie').split(';')[0];

  const created = await fetch(base + '/api/companies', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-emoji-request': '1', cookie },
    body: JSON.stringify({ name: 'Persistent customer company' }),
  });
  assert.equal(created.status, 200);

  // A company must be usable before any data source or WhatsApp session is connected
  for (const path of ['/api/company', '/api/overview', '/api/branches', '/api/customers?scope=all&state=all&page=1']) {
    const response = await fetch(base + path, { headers: { cookie } });
    assert.equal(response.status, 200, `${path} must work without a data source`);
  }

  const web = await fetch(base + '/');
  assert.equal(web.status, 200);
  assert.match(await web.text(), /assets\/index/);

  const backup = join(temp, 'online-backup');
  await run(['dist/runtime/scripts/maintenance/admin.js', 'backup', '--output', backup]);
  await run(['dist/runtime/scripts/maintenance/admin.js', 'verify-backup', '--input', backup]);

  await stop();

  await run(['dist/runtime/scripts/maintenance/admin.js', 'restore', '--input', backup]);
  await run(['dist/runtime/scripts/maintenance/probe.js', data, '--readonly']);

  port = await start();
  base = `http://127.0.0.1:${port}`;
  const restored = await (await fetch(base + '/api/company', { headers: { cookie } })).json();
  assert.equal(restored.name, 'Persistent customer company');
  assert.equal(restored.runMode, 'preview');
  assert.equal(restored.paused, 1);
  await stop();

  console.log(
    'PASS: isolated packaged runtime execution, HTTP/UI, online WAL backup, verification, offline restore, schema probe, restart, persistent credentials and company data, graceful shutdown.'
  );
} finally {
  if (child?.exitCode === null) child.kill('SIGKILL');
  rmSync(temp, { recursive: true, force: true });
}
