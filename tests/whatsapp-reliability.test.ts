import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { fork, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WhatsAppProfile, retryProfileIO, windowsProfileArgument } from "../packages/runtime/whatsapp-profile.js";
import { WhatsAppRecovery } from "../packages/runtime/whatsapp-recovery.js";
import { WhatsAppSession } from "../apps/whatsapp-worker/session.js";
import { reliableWhatsAppClasses } from "../apps/whatsapp-worker/reliable-client.js";
import { WhatsAppBridge } from "../apps/server/whatsapp-bridge.js";
import { safeFailure } from "../packages/runtime/whatsapp-log.js";

const require = createRequire(import.meta.url);
const { LocalAuth } = require("whatsapp-web.js");
async function until(predicate: () => boolean) {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await delay(5); }
  throw new Error("Condition did not become true");
}
const cleanupCallbacks = new WeakMap<object, Array<() => unknown>>();
function cleanup(t: any, callback: () => unknown) {
  let callbacks = cleanupCallbacks.get(t);
  if (!callbacks) {
    callbacks = []; cleanupCallbacks.set(t, callbacks);
    t.after(async () => { for (const dispose of callbacks!.reverse()) await dispose(); });
  }
  callbacks.push(callback);
}
function temp(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "whatsapp-reliability-"));
  cleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
class FakeClient extends EventEmitter {
  options: any;
  authStrategy: any;
  init = async () => {};
  destroys = 0;
  info = { wid: { user: "test-phone" } };
  constructor(options: any = {}) { super(); this.options = options; }
  initialize() { return this.init(); }
  async destroy() { this.destroys++; }
  async getState() { return "CONNECTED"; }
}
function fixture(t: any, extra: any = {}) {
  const dir = temp(t), clients: FakeClient[] = [], fatals: unknown[] = [];
  const session = new WhatsAppSession({ dataDir: dir, createClient: () => {
    const c = new FakeClient(); clients.push(c); return c;
  }, qr: async value => value, publish: () => {}, fatal: error => fatals.push(error), closeMs: 100, ...extra });
  cleanup(t, () => session.stop());
  return { dir, clients, session, fatals };
}

 test("profile lease prevents simultaneous owners and survives a process crash without deleting auth", async t => {
  const dir = temp(t);
  const profile = join(dir, "whatsapp-auth", "session-company");
  mkdirSync(profile, { recursive: true }); writeFileSync(join(profile, "credentials"), "sentinel");
  const child = fork(resolve("tests/fixtures/whatsapp-profile-owner.ts"), [dir], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  cleanup(t, () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child, "message");
  assert.throws(() => new WhatsAppProfile(dir, "company"), /locked/);
  const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
  const next = new WhatsAppProfile(dir, "company");
  await next.prepare(false); next.release();
  assert.equal(readFileSync(join(profile, "credentials"), "utf8"), "sentinel");
});

test("profiles reuse exactly the same auth path across restart/update and reject traversal", async t => {
  const dir = temp(t);
  const first = new WhatsAppProfile(dir, "company"); await first.prepare(false);
  mkdirSync(first.directory, { recursive: true }); writeFileSync(join(first.directory, "lockfile"), "do-not-delete");
  first.release();
  const next = new WhatsAppProfile(dir, "company"); await next.prepare(false);
  assert.equal(next.directory, first.directory);
  assert.equal(readFileSync(join(next.directory, "lockfile"), "utf8"), "do-not-delete");
  next.release(); assert.throws(() => new WhatsAppProfile(dir, "../foreign"), /Invalid/);
});

test("an existing legacy worker is not mistaken for a stale profile lock", t => {
  const dir = temp(t); const path = join(dir, "whatsapp-auth", "session-company"); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "session.lock"), JSON.stringify({ pid: process.ppid }));
  assert.throws(() => new WhatsAppProfile(dir, "company"), /legacy/);
});

test("Windows ownership requires an exact user-data-dir argument", () => {
  assert.equal(windowsProfileArgument('"C:\\chrome.exe" --user-data-dir="C:\\Program Data\\session-a" --headless'), "C:\\Program Data\\session-a");
  assert.equal(windowsProfileArgument('chrome.exe --user-data-dir=C:\\session-a --headless'), "C:\\session-a");
  assert.equal(windowsProfileArgument('chrome.exe --other-user-data-dir=C:\\session-a'), undefined);
  assert.equal(windowsProfileArgument('chrome.exe "--user-data-dir=C:\\Program Data\\session-a" --headless'), "C:\\Program Data\\session-a");
});

test("EBUSY retries back off, recover, and never swallow an exhausted or unrelated error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const recovered = retryProfileIO(() => { if (++attempts < 3) throw Object.assign(new Error("locked"), { code: "EBUSY" }); return "ok"; }, "test_busy", 2);
  await Promise.resolve(); t.mock.timers.tick(250); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(500); assert.equal(await recovered, "ok"); assert.equal(attempts, 3);
  const locked = Object.assign(new Error("locked"), { code: "EBUSY" });
  await assert.rejects(retryProfileIO(() => { throw locked; }, "test_busy", 0), error => error === locked);
  await assert.rejects(retryProfileIO(() => { throw new Error("wrong disk"); }, "test_busy"), /wrong disk/);
});

test("real LocalAuth adapter does not unlink locked live auth files on library logout", async t => {
  const dir = temp(t), { PersistentAuth } = reliableWhatsAppClasses(FakeClient, LocalAuth);
  const auth = new PersistentAuth({ clientId: "company", dataPath: dir });
  const client: any = new FakeClient({ puppeteer: {} }); auth.setup(client);
  let loggedOut = false; client.on("session_logout", () => { loggedOut = true; });
  await auth.beforeBrowserInitialized(); writeFileSync(join(auth.userDataDir, "lockfile"), "auth");
  await auth.logout();
  assert.equal(loggedOut, true); assert.equal(readFileSync(join(auth.userDataDir, "lockfile"), "utf8"), "auth");
  await auth.beforeBrowserInitialized(); assert.equal(existsSync(auth.userDataDir), true);
});

test("inject waits for actual auth modules, coalesces navigation and handles later rejections", async () => {
  let calls = 0, waited = false, release!: () => void;
  class Base extends FakeClient { async inject() { assert.equal(waited, true); calls++; } }
  const { ReliableClient } = reliableWhatsAppClasses(Base, LocalAuth);
  const client: any = new ReliableClient({ authTimeoutMs: 20 });
  client.authStrategy = {};
  client.pupPage = { waitForFunction: async (predicate: string, options: any) => {
    assert.match(predicate, /WAWebSocketModel.*Socket/); assert.equal(options.polling, 200);
    await new Promise<void>(r => { release = r; }); waited = true;
  } };
  const first = client.inject(), second = client.inject(); release(); await Promise.all([first, second]);
  assert.equal(calls, 1);
  let failure: unknown; client.on("lifecycle_error", (error: unknown) => { failure = error; });
  client.pupPage.waitForFunction = async () => { throw new TypeError("Socket unavailable"); };
  await client.inject(); assert.ok(failure instanceof TypeError);
  client.retire(); await client.inject(); assert.equal(calls, 1);
});

test("temporary network disconnect preserves auth, gracefully closes and permits recovery", async t => {
  const f = fixture(t); await f.session.connect("company");
  const path = f.session.current!.profile.directory; mkdirSync(path, { recursive: true }); writeFileSync(join(path, "credentials"), "saved");
  f.clients[0].emit("ready"); f.clients[0].emit("disconnected", "TIMEOUT");
  await until(() => !f.session.current);
  assert.equal(f.session.state.reason, "TIMEOUT"); assert.equal(f.session.state.requiresReauth, false);
  assert.ok(f.clients[0].destroys > 0); assert.equal(readFileSync(join(path, "credentials"), "utf8"), "saved");
  await f.session.connect("company", false); assert.equal(f.clients.length, 2);
  assert.equal(f.session.current!.profile.directory, path); assert.equal(f.fatals.length, 0);
});

test("concurrent connect requests create one client and old callbacks cannot change its replacement", async t => {
  const f = fixture(t);
  await f.session.connect("company"); await f.session.connect("company"); assert.equal(f.clients.length, 1);
  f.clients[0].emit("lifecycle_error", new Error("init")); await until(() => !f.session.current);
  await f.session.connect("company"); f.clients[0].emit("ready"); f.clients[0].emit("qr", "old-secret");
  assert.equal(f.session.state.status, "starting"); assert.equal(f.session.state.qr, null);
  f.clients[1].emit("ready"); assert.equal(f.session.state.status, "ready");
});

test("shutdown during asynchronous initialize waits for launch completion and releases the lease last", async t => {
  let finish!: () => void;
  const c = new FakeClient(); c.init = () => new Promise<void>(r => { finish = r; });
  const f = fixture(t, { createClient: () => c });
  await f.session.connect("company"); await Promise.resolve();
  const stop = f.session.stop();
  assert.throws(() => new WhatsAppProfile(f.dir, "company"), /locked/);
  finish(); await stop;
  const profile = new WhatsAppProfile(f.dir, "company"); profile.release();
  c.emit("ready"); assert.notEqual(f.session.state.status, "ready");
});

test("initialization timeout is bounded and requests recovery without deleting the profile", async t => {
  const f = fixture(t, { startupMs: 10 }); await f.session.connect("company");
  await until(() => f.session.state.reason === "INITIALIZATION_TIMEOUT");
  assert.equal(f.session.state.requiresReauth, false); assert.equal(f.fatals.length, 0);
});

test("actual logout persists a relink requirement, blocks automatic retry and archives only on explicit connect", async t => {
  const f = fixture(t); await f.session.connect("company");
  const path = f.session.current!.profile.directory; mkdirSync(path, { recursive: true }); writeFileSync(join(path, "credentials"), "revoked");
  f.clients[0].emit("disconnected", "LOGOUT"); await until(() => !f.session.current);
  assert.equal(f.session.state.requiresReauth, true); assert.equal(existsSync(path), true);
  await f.session.connect("company", false); assert.equal(f.clients.length, 1);
  await f.session.connect("company", true); assert.equal(f.clients.length, 2);
  const archive = readdirSync(join(f.dir, "whatsapp-auth")).find(name => name.startsWith(".revoked-"))!;
  assert.equal(readFileSync(join(f.dir, "whatsapp-auth", archive, "credentials"), "utf8"), "revoked");
  f.clients[1].emit("qr", "qr-secret"); await until(() => f.session.state.status === "qr");
  f.clients[1].emit("ready"); assert.equal(f.session.current!.profile.requiresReauth, false);
});

test("unpaired and conflict reasons require attention without takeover or auth deletion", async t => {
  for (const reason of ["UNPAIRED", "UNPAIRED_IDLE", "CONFLICT"]) {
    const f = fixture(t); await f.session.connect("company"); f.clients[0].emit("disconnected", reason);
    await until(() => !f.session.current);
    assert.equal(f.session.state.recoveryBlocked, true); assert.equal(f.session.state.requiresReauth, reason !== "CONFLICT");
  }
});

test("recovery is exponentially backed off, capped, bounded, and only resets after stable ready", () => {
  const recovery = new WhatsAppRecovery(8, null);
  assert.deepEqual(Array.from({ length: 8 }, () => recovery.nextDelay()), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(recovery.nextDelay(), null);
  recovery.readySince = 0; assert.equal(recovery.nextDelay(59999), null);
  recovery.readySince = 0; assert.equal(recovery.nextDelay(60000), 2000);
});

test("recovery transitions to background interval when backgroundIntervalMs is configured", () => {
  const recovery = new WhatsAppRecovery(8, 60000);
  assert.deepEqual(Array.from({ length: 8 }, () => recovery.nextDelay()), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(recovery.isBackgroundPolling(), true);
  assert.equal(recovery.nextDelay(), 60000);
  assert.equal(recovery.nextDelay(), 60000);
});

class Worker extends EventEmitter {
  pid = 12345;
  connected = true;
  exitCode: number | null = null;
  signalCode: string | null = null;
  requests: any[] = [];
  send(message: any, callback?: (error: any) => void) {
    this.requests.push(message);
    if (message.action === "shutdown") { this.exitCode = 0; this.emit("exit", 0, null); }
    else queueMicrotask(() => this.emit("message", { id: message.id, result: {} }));
    callback?.(null);
  }
  kill() { this.exitCode = 1; this.emit("exit", 1, null); }
}
function bridgeFixture(t: any, networkChecker?: () => Promise<boolean>, recoveryOptions?: any) {
  const workers: Worker[] = [];
  const bridge = new WhatsAppBridge(
    temp(t),
    (() => { const c = new Worker(); workers.push(c); return c; }) as any,
    networkChecker ?? (async () => true),
    recoveryOptions ?? { maxAttempts: 8, backgroundIntervalMs: null },
  );
  cleanup(t, () => bridge.stop()); return { bridge, workers };
}

test("bridge deduplicates simultaneous connections and fences other companies before the first state", async t => {
  const { bridge, workers } = bridgeFixture(t);
  const first = bridge.call("company", "connect"), second = bridge.call("company", "connect");
  assert.equal(first, second); await first;
  await assert.rejects(bridge.call("other", "connect"), /شركة/);
  assert.equal(workers.length, 1); assert.equal(workers[0].requests.length, 1);
});

test("bridge automatically recovers worker crashes with a finite budget and cancels on stop", async t => {
  const { bridge, workers } = bridgeFixture(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await bridge.call("company", "connect");
  for (const ms of [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]) {
    workers.at(-1)!.kill(); t.mock.timers.tick(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  assert.equal(workers.length, 9);
  workers.at(-1)!.kill(); t.mock.timers.tick(120000);
  assert.equal(workers.length, 9); assert.equal(bridge.state.recoveryBlocked, true);
  await bridge.stop(); t.mock.timers.tick(120000); assert.equal(workers.length, 9);
});

test("bridge never auto-retries a revoked session even when the worker subsequently exits", async t => {
  const { bridge, workers } = bridgeFixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  await bridge.call("company", "connect");
  workers[0].emit("message", { type: "state", state: { companyId: "company", status: "error", reason: "LOGOUT", recoveryBlocked: true, requiresReauth: true } });
  workers[0].kill(); t.mock.timers.tick(120000);
  assert.equal(workers.length, 1); assert.equal(bridge.state.requiresReauth, true);
});

test("failure logging strips URL credentials and long authentication tokens", () => {
  const error = new Error(`Cannot read Socket https://web.whatsapp.com/?token=${"a".repeat(80)} ${"b".repeat(80)}`);
  const logged = JSON.stringify(safeFailure(error));
  assert.doesNotMatch(logged, /token=|a{80}|b{80}/); assert.match(logged, /Socket/);
});


test("Windows locked profile archive retries after the file owner releases its handle", { skip: process.platform !== "win32" }, async t => {
  const dir = temp(t), profile = new WhatsAppProfile(dir, "company");
  cleanup(t, () => profile.release());
  mkdirSync(profile.directory, { recursive: true });
  const file = join(profile.directory, "lockfile"); writeFileSync(file, "revoked-sentinel");
  profile.markReauth("LOGOUT");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$stream = [IO.File]::Open($env:WHATSAPP_TEST_LOCKFILE, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); [Console]::WriteLine('READY'); [Console]::In.ReadLine() | Out-Null; $stream.Dispose()"],
    { env: { ...process.env, WHATSAPP_TEST_LOCKFILE: file }, windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
  cleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit"); child.stdin!.end("release\n"); await exit;
    }
  });
  const [ready] = await once(child.stdout!, "data"); assert.match(String(ready), /READY/);
  let retried = false;
  const originalLog = console.log;
  t.mock.method(console, "log", (...args: any[]) => {
    if (String(args[0]).includes('"event":"revoked_profile_archive_retry"')) retried = true;
    originalLog(...args);
  });
  const preparing = profile.prepare(true);
  assert.equal(existsSync(file), true);
  await until(() => retried);
  child.stdin!.end("release\n");
  await preparing;
  const archive = readdirSync(profile.root).find(name => name.startsWith(".revoked-"))!;
  assert.equal(readFileSync(join(profile.root, archive, "lockfile"), "utf8"), "revoked-sentinel");
});


test("a short ready interval followed by a long outage does not reset the recovery budget", () => {
  const recovery = new WhatsAppRecovery(2, null);
  assert.equal(recovery.nextDelay(0), 2000);
  recovery.observe("ready", 0); recovery.observe("reconnecting", 5000);
  assert.equal(recovery.nextDelay(70000), 4000);
  assert.equal(recovery.nextDelay(80000), null);
});


test("legacy lock from a previous OS boot does not block recovery when its PID is reused", async t => {
  const { uptime } = await import("node:os");
  const dir = temp(t), path = join(dir, "whatsapp-auth", "session-company"); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "session.lock"), JSON.stringify({ pid: process.ppid,
    createdAt: new Date(Date.now() - uptime() * 1000 - 60000).toISOString() }));
  const profile = new WhatsAppProfile(dir, "company"); cleanup(t, () => profile.release());
  await profile.prepare(false);
  assert.equal(existsSync(join(path, "session.lock")), false);
});

test("health watchdog recovers a stalled socket without a disconnected event or auth deletion", async t => {
  const f = fixture(t); await f.session.connect("company");
  const directory = f.session.current!.profile.directory; mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "credentials"), "network-sentinel");
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  f.clients[0].getState = async () => "OPENING";
  f.clients[0].emit("ready");
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(15000);
    for (let j = 0; j < 15; j++) await Promise.resolve();
    if (i === 0) assert.equal(f.session.state.status, "reconnecting");
  }
  await until(() => !f.session.current);
  assert.equal(f.session.state.reason, "SOCKET_UNAVAILABLE");
  assert.equal(f.session.state.requiresReauth, false);
  assert.equal(readFileSync(join(directory, "credentials"), "utf8"), "network-sentinel");
});

test("a delayed QR encoder cannot override authenticated or ready state", async t => {
  let encode!: (qr: string) => void;
  const f = fixture(t, { qr: () => new Promise<string>(resolve => { encode = resolve; }) });
  await f.session.connect("company");
  f.clients[0].emit("qr", "secret"); f.clients[0].emit("authenticated");
  encode("old-qr"); await Promise.resolve();
  assert.equal(f.session.state.status, "starting"); assert.equal(f.session.state.qr, null);
  f.clients[0].emit("ready"); assert.equal(f.session.state.status, "ready");
});

test("simulated 5-minute, 1-hour, and 24-hour network outages preserve credentials and resume automatically on restoration", async t => {
  let isOnline = false;
  const dataDir = temp(t);
  const credentialsPath = join(dataDir, "whatsapp-auth", "session-company", "credentials");
  mkdirSync(join(dataDir, "whatsapp-auth", "session-company"), { recursive: true });
  writeFileSync(credentialsPath, "sentinel-auth-data");

  const workers: Worker[] = [];
  const bridge = new WhatsAppBridge(
    dataDir,
    (() => { const c = new Worker(); workers.push(c); return c; }) as any,
    async () => isOnline,
    { maxAttempts: 8, backgroundIntervalMs: 60000 },
  );
  cleanup(t, () => bridge.stop());

  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  await bridge.call("company", "connect");

  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(bridge.state.status, "waiting_for_network");
  assert.equal(Boolean(bridge.state.requiresReauth), false);
  assert.equal(Boolean(bridge.state.recoveryBlocked), false);
  const initialWorkerCount = workers.length;

  // 5-minute outage
  t.mock.timers.tick(300000);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(bridge.state.status, "waiting_for_network");
  assert.equal(workers.length, initialWorkerCount);
  assert.equal(readFileSync(credentialsPath, "utf8"), "sentinel-auth-data");

  // 1-hour outage
  t.mock.timers.tick(3600000);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(bridge.state.status, "waiting_for_network");
  assert.equal(workers.length, initialWorkerCount);
  assert.equal(readFileSync(credentialsPath, "utf8"), "sentinel-auth-data");

  // 24-hour outage
  t.mock.timers.tick(86400000);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(bridge.state.status, "waiting_for_network");
  assert.equal(workers.length, initialWorkerCount);
  assert.equal(readFileSync(credentialsPath, "utf8"), "sentinel-auth-data");

  // Network returns
  isOnline = true;
  t.mock.timers.tick(5000);
  for (let i = 0; i < 15; i++) await Promise.resolve();

  assert.ok(workers.length > initialWorkerCount);
  assert.equal(readFileSync(credentialsPath, "utf8"), "sentinel-auth-data");
});

test("recovery continues with background retries after 8 fast attempts and recovers when network returns", async t => {
  let isOnline = true;
  const { bridge, workers } = bridgeFixture(t, async () => isOnline, { maxAttempts: 8, backgroundIntervalMs: 60000 });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  await bridge.call("company", "connect");

  for (const ms of [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]) {
    workers.at(-1)!.kill();
    t.mock.timers.tick(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  assert.equal(workers.length, 9);

  // Attempt 9 uses backgroundIntervalMs (60000ms) rather than blocking permanently
  workers.at(-1)!.kill();
  t.mock.timers.tick(60000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(workers.length, 10);
  assert.equal(Boolean(bridge.state.recoveryBlocked), false);

  // Worker reports ready
  workers.at(-1)!.emit("message", { type: "state", state: { companyId: "company", status: "ready" } });
  assert.equal(bridge.state.status, "ready");
});

test("simulated Windows restart during an outage preserves saved LocalAuth credentials", async t => {
  const dir = temp(t);
  const profileDir = join(dir, "whatsapp-auth", "session-company");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "saved-credentials"), "session-tokens-intact");

  const workers: Worker[] = [];
  const bridge = new WhatsAppBridge(
    dir,
    (() => { const c = new Worker(); workers.push(c); return c; }) as any,
    async () => false,
  );
  cleanup(t, () => bridge.stop());
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

  bridge.autoConnect("company");
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(bridge.state.status, "waiting_for_network");
  assert.equal(readFileSync(join(profileDir, "saved-credentials"), "utf8"), "session-tokens-intact");
});
