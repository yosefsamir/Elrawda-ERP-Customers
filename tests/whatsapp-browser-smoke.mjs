// Offline fixture: real Chromium/profile lifecycle, no WhatsApp account or auth secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WhatsAppSession } from '../dist/runtime/apps/whatsapp-worker/session.js';
import { reliableWhatsAppClasses } from '../dist/runtime/apps/whatsapp-worker/reliable-client.js';
import { cleanProfileBrowsers } from '../dist/runtime/packages/runtime/whatsapp-profile.js';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const { ExposeAuthStore } = require('whatsapp-web.js/src/util/Injected/AuthStore/AuthStore.js');
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(20); }
  throw new Error('Browser fixture condition timed out');
}
const args = process.platform === 'linux' && process.env.CHROME_NO_SANDBOX === 'true' ? ['--no-sandbox'] : [];

test('real Chromium preserves profile across restart, temporary transport failure and browser crash', { timeout: 120000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-chromium-'));
  const server = createServer((_, response) => response.end('<!doctype html><title>Local lifecycle fixture</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  class BrowserClient extends EventEmitter {
    constructor(profile) { super(); this.profile = profile; }
    async initialize() {
      this.pupBrowser = await puppeteer.launch({ headless: true, args, userDataDir: this.profile.directory });
      this.pupPage = await this.pupBrowser.newPage(); await this.pupPage.goto(url); this.emit('ready');
    }
    async destroy() { if (this.pupBrowser?.connected) await this.pupBrowser.close(); }
    async getState() { return 'CONNECTED'; }
  }
  const fatals = [];
  const session = new WhatsAppSession({ dataDir: dir, createClient: profile => new BrowserClient(profile),
    qr: async () => '', publish: () => {}, fatal: error => fatals.push(error) });
  const profilePath = join(dir, 'whatsapp-auth', 'session-company');
  t.after(async () => { await session.stop(); await cleanProfileBrowsers(profilePath); server.close(); rmSync(dir, { recursive: true, force: true }); });
  await session.connect('company'); await until(() => session.state.status === 'ready');
  await session.client.pupPage.evaluate(() => localStorage.setItem('fixture-persistent', 'keep-across-restarts'));
  await session.stop();
  await session.connect('company'); await until(() => session.state.status === 'ready');
  assert.equal(await session.client.pupPage.evaluate(() => localStorage.getItem('fixture-persistent')), 'keep-across-restarts');
  await session.client.pupPage.setOfflineMode(true);
  session.client.emit('disconnected', 'TIMEOUT'); await until(() => !session.current);
  assert.equal(session.state.requiresReauth, false);
  await session.connect('company', false); await until(() => session.state.status === 'ready');
  assert.equal(await session.client.pupPage.evaluate(() => localStorage.getItem('fixture-persistent')), 'keep-across-restarts');
  await until(() => Boolean(session.current.browser));
  process.kill(session.client.pupBrowser.process().pid, 'SIGKILL');
  await until(() => !session.current);
  assert.equal(session.state.reason, 'CHROMIUM_DISCONNECTED');
  await session.connect('company', false); await until(() => session.state.status === 'ready');
  assert.equal(await session.client.pupPage.evaluate(() => localStorage.getItem('fixture-persistent')), 'keep-across-restarts');
  assert.deepEqual(fatals, []);
});

test('real browser reproduces null Socket and adapter waits for module readiness before injection', { timeout: 30000 }, async t => {
  const browser = await puppeteer.launch({ headless: true, args });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.evaluate(() => {
    window.Debug = { VERSION: 'fixture' };
    window.fixtureReady = false;
    window.require = name => {
      if (!window.fixtureReady && name === 'WAWebSocketModel') return null;
      return { Socket: { state: 'CONNECTED' }, Cmd: {}, Conn: {}, OfflineMessageHandler: {} };
    };
  });
  await assert.rejects(page.evaluate(ExposeAuthStore), /Socket/);
  class FixtureClient extends EventEmitter {
    constructor(options) { super(); this.options = options; this.pupPage = page; this.authStrategy = {}; }
    async inject() { await this.pupPage.evaluate(ExposeAuthStore); }
  }
  const { ReliableClient } = reliableWhatsAppClasses(FixtureClient, class {});
  const client = new ReliableClient({ authTimeoutMs: 3000 });
  const failures = []; client.on('lifecycle_error', error => failures.push(error));
  await page.evaluate(() => { setTimeout(() => { window.fixtureReady = true; }, 400); });
  const start = Date.now(); await Promise.all([client.inject(), client.inject()]);
  assert.ok(Date.now() - start >= 300); assert.deepEqual(failures, []);
  assert.equal(await page.evaluate(() => window.AuthStore.AppState.state), 'CONNECTED');
});

test('installed library destroy skips Puppeteer 25 browser; adapter actually closes it', { timeout: 30000 }, async t => {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const browser = await puppeteer.launch({ headless: true, args });
  t.after(() => browser.close());
  assert.equal(typeof browser.isConnected, 'undefined');
  const upstream = new Client(); upstream.pupBrowser = browser;
  await upstream.destroy(); assert.equal(browser.connected, true);
  const { ReliableClient, PersistentAuth } = reliableWhatsAppClasses(Client, LocalAuth);
  const adapted = new ReliableClient({ authStrategy: new PersistentAuth({}) }); adapted.pupBrowser = browser;
  await adapted.destroy(); assert.equal(browser.connected, false);
});

test('failed graceful close cleans owned Chromium and leaves another browser untouched', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-owned-browser-'));
  const unrelated = await puppeteer.launch({ headless: true, args });
  let owned;
  class BrokenCloseClient extends EventEmitter {
    constructor(profile) { super(); this.profile = profile; }
    async initialize() {
      owned = this.pupBrowser = await puppeteer.launch({ headless: true, args, userDataDir: this.profile.directory });
      this.emit('ready');
    }
    async destroy() { throw Object.assign(new Error('fixture close failed'), { code: 'EBUSY' }); }
    async getState() { return 'CONNECTED'; }
  }
  const session = new WhatsAppSession({ dataDir: dir, createClient: profile => new BrokenCloseClient(profile),
    qr: async () => '', publish: () => {}, fatal: error => { throw error; } });
  t.after(async () => { await session.stop(); await unrelated.close(); rmSync(dir, { recursive: true, force: true }); });
  await session.connect('company'); await until(() => session.state.status === 'ready');
  await session.stop();
  await until(() => !owned.connected);
  assert.equal(unrelated.connected, true);
});
