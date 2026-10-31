const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { inspectTarget, runManualAddition } = require('./operations.cjs');
const { createPilotClient } = require('./groups.cjs');

const port = Number(process.env.WHATSAPP_TEST_PORT || 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid WHATSAPP_TEST_PORT');
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const token = crypto.randomBytes(24).toString('hex');
const root = path.resolve(__dirname, '../..');
const dataDir = path.join(root, 'data', 'whatsapp-test');
let client;
let pilot;
let busy = false;
let starting = false;
let closing = false;
let qrGeneration = 0;
const attempts = new Map();
const state = { status: 'starting', qr: null, error: null, account: null, version: null, updatedAt: Date.now() };
// Reload only the disposable lab runner during capability experiments. Its
// state is persisted before every write, so a code update does not reconnect WA.
async function runLabAction(action, input) {
  delete require.cache[require.resolve('./lab.cjs')];
  return require('./lab.cjs').createLab({ getClient: () => client, getPilot: () => pilot, dataDir }).run(action, input);
}

function update(patch) {
  Object.assign(state, patch, { updatedAt: Date.now() });
  if (patch.status) console.log(`[whatsapp-test] ${patch.status}`);
}

async function startClient() {
  if (starting || closing) return;
  starting = true;
  try {
    qrGeneration++;
    if (client) await client.destroy().catch(() => {});
    update({ status: 'starting', qr: null, error: null, account: null });
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    client = new Client({
      authStrategy: new LocalAuth({ clientId: 'manual-pilot', dataPath: path.join(dataDir, 'auth') }),
      webVersionCache: { type: 'local', path: path.join(dataDir, 'web-cache') },
      puppeteer: {
        headless: true,
        ...(process.env.WHATSAPP_CHROME_PATH ? { executablePath: process.env.WHATSAPP_CHROME_PATH } : {}),
        args: process.env.WHATSAPP_TEST_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
      },
    });
    pilot = createPilotClient(client);
    const current = client;
    current.on('qr', async value => {
      const generation = ++qrGeneration;
      try {
        const qr = await QRCode.toDataURL(value, { width: 340, margin: 3, errorCorrectionLevel: 'M' });
        if (client === current && generation === qrGeneration) update({ status: 'qr', qr, error: null });
      } catch { update({ status: 'error', error: 'تعذر عرض QR.' }); }
    });
    current.on('authenticated', () => { qrGeneration++; update({ status: 'authenticated', qr: null }); });
    current.on('loading_screen', percent => update({ status: 'loading', progress: percent }));
    current.on('ready', async () => {
      update({ status: 'ready', qr: null, error: null,
        account: { name: current.info?.pushname || '', phone: current.info?.wid?.user || '' } });
      try { update({ version: await current.getWWebVersion() }); } catch { /* Optional diagnostic. */ }
    });
    current.on('auth_failure', () => { qrGeneration++; update({ status: 'auth_failure', qr: null, error: 'فشل ربط الحساب. أعد المحاولة أو راجع الأجهزة المرتبطة في الموبايل.' }); });
    current.on('disconnected', reason => { qrGeneration++; update({ status: 'disconnected', qr: null, account: null, error: String(reason) }); });
    await current.initialize();
  } catch (error) {
    update({ status: 'error', qr: null, error: error.message });
  } finally { starting = false; }
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 4096) throw new Error('الطلب أكبر من المسموح.');
  }
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('طلب غير صحيح.');
  return value;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { error: 'Local access only.' });
  try {
    if (req.method === 'GET' && req.url === '/') {
      const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html.replace('__LOCAL_TEST_TOKEN__', token));
    }
    if (req.method === 'GET' && ['/app.js', '/style.css'].includes(req.url)) {
      res.writeHead(200, { 'Content-Type': req.url.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
      return res.end(await fs.readFile(path.join(__dirname, req.url.slice(1))));
    }
    if (req.headers['x-local-test-token'] !== token) return json(res, 403, { error: 'افتح صفحة الاختبار المحلية أولًا.' });
    if (req.method === 'GET' && req.url === '/api/status') return json(res, 200, { ...state, busy });
    if (req.method === 'POST' && req.url === '/api/restart') {
      if (starting || busy) return json(res, 409, { error: 'هناك عملية جارية؛ انتظر اكتمالها.' });
      void startClient();
      return json(res, 202, { status: 'starting' });
    }
    if (state.status !== 'ready') return json(res, 409, { error: 'اربط واتساب وانتظر ظهور حالة متصل.' });
    if (busy) return json(res, 409, { error: 'انتظر اكتمال العملية الجارية.' });
    if (req.method === 'POST' && req.url.startsWith('/api/lab/')) {
      const input = await body(req);
      if (busy || starting || state.status !== 'ready') return json(res, 409, { error: 'هناك عملية أخرى أو الاتصال غير جاهز.' });
      busy = true;
      try { return json(res, 200, await runLabAction(req.url.slice('/api/lab/'.length), input)); }
      finally { busy = false; }
    }
    if (req.method === 'GET' && req.url === '/api/groups') {
      busy = true;
      try {
        const groups = await pilot.getGroups();
        return json(res, 200, { groups });
      } finally { busy = false; }
    }
    if (req.method === 'POST' && ['/api/check', '/api/add'].includes(req.url)) {
      const input = await body(req);
      // Recheck after the asynchronous body read, before claiming the single worker.
      if (busy || starting || state.status !== 'ready') return json(res, 409, { error: 'حالة الاتصال تغيرت أو هناك عملية أخرى جارية.' });
      busy = true;
      try {
        if (req.url === '/api/check') return json(res, 200, await inspectTarget(pilot, input.phone, input.groupId));
        if (input.confirmed !== true) return json(res, 400, { error: 'أكد موافقة صاحب الرقم على تجربة الإضافة.' });
        return json(res, 200, await runManualAddition(pilot, input.phone, input.groupId, input.confirmed, attempts));
      } finally { busy = false; }
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, 400, { error: error.message }); }
});

server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`WhatsApp manual test: ${origin}`);
  console.log('No ERP connection. No automatic additions, messages, or private invitations.');
  void startClient();
});

async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  const forced = setTimeout(() => process.exit(0), 8000);
  forced.unref();
  if (client) await client.destroy().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
