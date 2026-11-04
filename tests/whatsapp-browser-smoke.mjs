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
const { browserOptions } = require('../scripts/whatsapp-test/browser.cjs');
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(20); }
  throw new Error('Browser fixture condition timed out');
}
const args = process.platform === 'linux' && process.env.CHROME_NO_SANDBOX === 'true' ? ['--no-sandbox'] : [];

test('installed Client uses native browser identity in a hidden browser without contacting WhatsApp', { timeout: 30000 }, async t => {
  const { Client } = require('whatsapp-web.js');
  const stopped = new Error('offline boundary reached');
  const auth = {
    setup(client) { this.client = client; },
    async beforeBrowserInitialized() {},
    // initialize calls this after launching/configuring Chrome, before navigation.
    async afterBrowserInitialized() { throw stopped; },
    async destroy() {},
  };
  const { ReliableClient } = reliableWhatsAppClasses(Client, class {});
  const client = new ReliableClient({ ...browserOptions(undefined, process.env), authStrategy: auth });
  t.after(() => client.destroy());
  await assert.rejects(client.initialize(), error => error === stopped);
  assert.equal(client.pupPage.url(), 'about:blank');
  assert.equal(client.options.puppeteer.headless, true);
  assert.equal(await client.pupPage.evaluate(() => navigator.userAgent), client.options.userAgent);
  assert.ok(!((await client.pupPage.evaluate(() => navigator.userAgent)).includes('HeadlessChrome')));
});

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

test('installed Client ignores false/undefined sync transitions and coalesces concurrent genuine ready callbacks', { timeout: 30000 }, async t => {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const { exposeFunctionIfAbsent } = require('whatsapp-web.js/src/util/Puppeteer.js');
  const { ReliableClient } = reliableWhatsAppClasses(Client, LocalAuth);
  const browser = await puppeteer.launch({ headless: true, args });
  const page = await browser.newPage();
  const client = new ReliableClient({ authTimeoutMs: 3000 });
  client.pupBrowser = browser;
  client.pupPage = page;
  t.after(() => client.destroy());
  await page.evaluate(() => {
    window.Debug = { VERSION: '2.3000.1050000000' };
    window.WWebJS = {}; // Skip chat-store loading; test the real sync binding.
    window.fixtureSocket = { state: 'CONNECTED', hasSynced: false, listeners: {},
      on(event, callback) { (this.listeners[event] ??= []).push(callback); },
    };
    window.require = () => ({ Socket: window.fixtureSocket, Cmd: { on() {} }, Conn: {}, OfflineMessageHandler: {} });
  });
  let ready = 0, authenticated = 0;
  const errors = [];
  client.on('ready', () => ready++);
  client.on('authenticated', () => authenticated++);
  client.on('lifecycle_error', error => errors.push(error));
  await client.inject();
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.onAppStateHasSyncedEvent());
  assert.equal(ready, 0);
  await page.evaluate(async () => {
    window.fixtureSocket.hasSynced = true;
    await Promise.all([window.onAppStateHasSyncedEvent(), window.onAppStateHasSyncedEvent()]);
  });
  assert.equal(ready, 1);
  assert.equal(authenticated, 1);
  await page.evaluate(async () => {
    window.fixtureSocket.hasSynced = undefined;
    // Reproduce the installed library's actual change:hasSynced listener.
    for (const callback of window.fixtureSocket.listeners['change:hasSynced']) callback(window.fixtureSocket, undefined);
    await window.onAppStateHasSyncedEvent();
  });
  assert.equal(ready, 1);
  assert.equal(authenticated, 1);
  // Concurrent registrations through the upstream helper must not throw a
  // duplicate exposed-binding error on Puppeteer 25.
  await Promise.all([
    exposeFunctionIfAbsent(page, 'fixtureConcurrent', () => 'first'),
    exposeFunctionIfAbsent(page, 'fixtureConcurrent', () => 'second'),
  ]);
  assert.ok(['first', 'second'].includes(await page.evaluate(() => window.fixtureConcurrent())));
  client.lastLoggedOut = true;
  await page.evaluate(async () => { window.fixtureSocket.hasSynced = true; await window.onAppStateHasSyncedEvent(); });
  client.emit('ready');
  assert.equal(ready, 1);
  assert.deepEqual(errors, []);
  assert.equal(page.url(), 'about:blank');
});

test('account restriction reads use the narrow cached key and preserve unknown when modules disappear', { timeout: 30000 }, async t => {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const { ReliableClient } = reliableWhatsAppClasses(Client, LocalAuth);
  const browser = await puppeteer.launch({ headless: true, args });
  const client = new ReliableClient();
  client.pupBrowser = browser;
  client.pupPage = await browser.newPage();
  t.after(() => client.destroy());
  await client.pupPage.evaluate(() => {
    window.fixtureRestriction = { state: 'HIDDEN', time_enforcement_ends: 1793800800000, enforcement_type: 'DEFAULT' };
    window.fixtureRefreshes = 0;
    window.require = name => {
      if (name === 'WAWebGetReachoutTimelockJob') return { fetchReachoutTimelock: async () => { window.fixtureRefreshes++; } };
      if (name === 'WAWebUserPrefsIndexedDBStorage') return { userPrefsIdb: { get: key => {
        if (key !== 'WAReachoutTimelockState') throw new Error('unexpected store access');
        return window.fixtureRestriction;
      } } };
      throw new Error('module unavailable');
    };
  });
  const active = await client.fetchAccountRestriction(true);
  assert.equal(active.active, true);
  assert.equal(active.source, 'server');
  assert.equal(active.endsAt, '2026-11-04T14:00:00.000Z');
  await client.fetchAccountRestriction(false);
  assert.equal(await client.pupPage.evaluate(() => window.fixtureRefreshes), 1);
  await client.pupPage.evaluate(() => { window.fixtureRestriction = null; });
  assert.equal((await client.fetchAccountRestriction(false)).active, null);
  assert.equal((await client.fetchAccountRestriction(true)).active, false);
  await client.pupPage.evaluate(() => { window.require = () => { throw new Error('lazy module unavailable'); }; });
  assert.equal((await client.fetchAccountRestriction(true)).source, 'unavailable');
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
