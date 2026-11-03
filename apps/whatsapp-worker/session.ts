import { deadline, safeFailure, whatsappLog } from "../../packages/runtime/whatsapp-log.js";
import { WhatsAppProfile, cleanProfileBrowsers } from "../../packages/runtime/whatsapp-profile.js";

interface Session {
  client: any;
  profile: WhatsAppProfile;
  initialization?: Promise<void>;
  closing?: Promise<void>;
  retired: boolean;
  qrVersion: number;
  recordTimer?: NodeJS.Timeout;
  startupTimer?: NodeJS.Timeout;
  browser?: any;
}

export class WhatsAppSession {
  current?: Session;
  state: any = { companyId: null, status: "disconnected" };
  private healthTimer?: NodeJS.Timeout;
  private unhealthySince?: number;
  private checking = false;

  constructor(private options: {
    dataDir: string;
    createClient: (profile: WhatsAppProfile) => any;
    qr: (value: string) => Promise<string>;
    publish: (state: any) => void;
    fatal: (error: unknown) => void;
    startupMs?: number;
    closeMs?: number;
  }) {}

  private publish(extra: any) {
    this.state = { ...this.state, ...extra };
    this.options.publish(this.state);
  }
  private alive(session: Session) { return this.current === session && !session.retired; }
  get client() { return this.current?.client; }

  async connect(companyId: string, explicit = true) {
    if (this.state.companyId && this.state.companyId !== companyId) throw new Error("جلسة شركة أخرى نشطة؛ افصلها أولًا.");
    if (this.current && !this.current.retired && ["starting", "qr", "ready", "reconnecting"].includes(this.state.status)) return this.state;
    await this.stop();
    const profile = new WhatsAppProfile(this.options.dataDir, companyId);
    try {
      if (profile.requiresReauth && !explicit) {
        this.publish({ companyId, status: "error", requiresReauth: true, recoveryBlocked: true,
          qr: null, error: "انتهى ربط واتساب. اضغط ربط واتساب لمسح كود جديد." });
        profile.release();
        return this.state;
      }
      await profile.prepare(explicit);
      const client = this.options.createClient(profile);
      const session: Session = { client, profile, retired: false, qrVersion: 0 };
      this.current = session;
      this.unhealthySince = undefined;
      this.publish({ companyId, status: "starting", qr: null, error: null, requiresReauth: false,
        recoveryBlocked: false, phone: null, pushname: null, platform: null, reason: null });
      const log = (event: string, fields = {}) => whatsappLog(event, { companyId, workerPid: process.pid, ...fields });
      const fail = (reason: string, reauth = false, blocked = false, error?: unknown) => {
        if (!this.alive(session)) return;
        log("session_failure", { reason, requiresReauth: reauth, failure: error ? safeFailure(error) : undefined });
        if (reauth) {
          try { profile.markReauth(reason); }
          catch (cause) { this.options.fatal(cause); return; }
        }
        this.publish({ status: reauth || blocked ? "error" : "reconnecting", qr: null, reason,
          requiresReauth: reauth, recoveryBlocked: reauth || blocked,
          error: reauth ? "انتهى ربط واتساب. اضغط ربط واتساب لمسح كود جديد." : blocked ? `توقف اتصال واتساب: ${reason}` : "انقطع اتصال واتساب؛ جارٍ الاسترداد." });
        // Invalidate callbacks synchronously; cleanup uses only this captured generation.
        const closing = this.stop();
        void closing.then(() => this.publish({ status: reauth || blocked ? "error" : "disconnected", qr: null,
          reason, requiresReauth: reauth, recoveryBlocked: reauth || blocked,
          error: reauth ? "انتهى ربط واتساب. اضغط ربط واتساب لمسح كود جديد." : blocked ? `توقف اتصال واتساب: ${reason}` : "انقطع اتصال واتساب؛ جارٍ الاسترداد." }), this.options.fatal);
      };
      client.on("qr", (value: string) => {
        if (!this.alive(session)) return;
        clearTimeout(session.startupTimer);
        log("qr_generated");
        const qrVersion = ++session.qrVersion;
        void this.options.qr(value).then(qr => {
          if (this.alive(session) && session.qrVersion === qrVersion && this.state.status !== "ready") this.publish({ status: "qr", qr });
        }, error => fail("QR_ENCODING_FAILED", false, false, error));
      });
      client.on("authenticated", () => {
        if (!this.alive(session)) return;
        log("authenticated");
        session.qrVersion++;
        clearTimeout(session.startupTimer);
        if (this.state.status !== "ready") {
          this.publish({ status: "starting", qr: null });
          session.startupTimer = setTimeout(() => fail("POST_AUTH_TIMEOUT"), this.options.startupMs ?? 120000);
          session.startupTimer.unref();
        }
      });
      client.on("ready", () => {
        if (!this.alive(session)) return;
        try { profile.authenticated(); } catch (error) { fail("AUTH_MARKER_IO", false, true, error); return; }
        clearTimeout(session.startupTimer);
        session.qrVersion++;
        const info = client.info;
        log("ready");
        this.publish({ status: "ready", qr: null, error: null, reason: null, requiresReauth: false, recoveryBlocked: false,
          phone: info?.wid?.user || null, pushname: info?.pushname || null, platform: info?.platform || null });
        this.startHealth(session, fail);
      });
      client.on("auth_failure", (reason: unknown) => {
        // LocalAuth does not normally emit auth_failure; preserve the classification without auth payloads.
        log("auth_failure", { reason: safeFailure(reason).message });
        fail("AUTH_FAILURE", true);
      });
      client.on("change_state", (reason: string) => { if (this.alive(session)) log("connection_state", { reason }); });
      client.on("disconnected", (reason: string) => {
        log("disconnected", { reason, bridgeLogout: Boolean(client.lastLoggedOut),
          postLogoutNavigation: Boolean(client.pupPage?.url?.().includes("post_logout=1")) });
        fail(reason, ["LOGOUT", "UNPAIRED", "UNPAIRED_IDLE"].includes(reason),
          ["CONFLICT", "TOS_BLOCK", "SMB_TOS_BLOCK", "DEPRECATED_VERSION", "PROXYBLOCK"].includes(reason));
      });
      client.on("session_logout", () => fail("LOGOUT", true));
      client.on("lifecycle_error", (error: unknown) => fail("INJECTION_FAILED", false, false, error));
      const observeBrowser = () => {
        const browser = client.pupBrowser;
        if (!browser || session.browser) return;
        session.browser = browser;
        clearInterval(session.recordTimer);
        const browserProcess = browser.process?.();
        log("chromium_started", { browserPid: browserProcess?.pid });
        browserProcess?.once("exit", (code: number | null, signal: string | null) =>
          log("chromium_exit", { browserPid: browserProcess.pid, code, signal }));
        browser.on("disconnected", () => { log("chromium_disconnected", { browserPid: browser.process?.()?.pid }); fail("CHROMIUM_DISCONNECTED"); });
        client.pupPage?.on("error", () => fail("CHROMIUM_PAGE_CRASH"));
      };
      session.recordTimer = setInterval(observeBrowser, 100);
      session.recordTimer.unref();
      session.startupTimer = setTimeout(() => fail("INITIALIZATION_TIMEOUT"), this.options.startupMs ?? 120000);
      session.startupTimer.unref();
      session.initialization = Promise.resolve().then(() => { if (this.alive(session)) return client.initialize(); }).then(observeBrowser,
        error => fail("INITIALIZATION_FAILED", false, false, error));
      log("initialization_started");
      return this.state;
    } catch (error) { profile.release(); throw error; }
  }

  private startHealth(session: Session, fail: (reason: string) => void) {
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      if (!this.alive(session) || this.checking) return;
      this.checking = true;
      void deadline(Promise.resolve().then(() => session.client.getState()), 5000, "Health timeout").then(reason => {
        if (!this.alive(session)) return;
        if (reason === "CONNECTED") {
          this.unhealthySince = undefined;
          if (this.state.status === "reconnecting") this.publish({ status: "ready", error: null });
        } else {
          whatsappLog("health_degraded", { companyId: this.state.companyId, reason });
          this.unhealthySince ??= Date.now();
          this.publish({ status: "reconnecting", qr: null });
          if (Date.now() - this.unhealthySince >= 60000) fail("SOCKET_UNAVAILABLE");
        }
      }, () => {
        if (!this.alive(session)) return;
        this.unhealthySince ??= Date.now();
        this.publish({ status: "reconnecting", qr: null });
        if (Date.now() - this.unhealthySince >= 60000) fail("HEALTH_TIMEOUT");
      }).finally(() => { this.checking = false; });
    }, 15000);
    this.healthTimer.unref();
  }

  async stop() {
    const session = this.current;
    if (!session) return;
    if (session.closing) return session.closing;
    session.retired = true;
    session.client.retire?.();
    clearInterval(session.recordTimer);
    clearTimeout(session.startupTimer);
    clearInterval(this.healthTimer);
    session.closing = (async () => {
      const closeMs = this.options.closeMs ?? 10000;
      whatsappLog("chromium_graceful_close", { companyId: session.profile.companyId });
      try { await deadline(Promise.resolve().then(() => session.client.destroy()), closeMs, "Chromium close timeout"); }
      catch (error) { whatsappLog("chromium_close_failed", { failure: safeFailure(error) }); }
      // Launch may still be in flight when stop arrives. Never release the lease or start
      // a new generation until initialize has settled and every owned browser is gone.
      await cleanProfileBrowsers(session.profile.directory);
      if (session.initialization) await deadline(session.initialization, closeMs, "Initialization did not settle during shutdown");
      try { await deadline(Promise.resolve().then(() => session.client.destroy()), closeMs, "Final Chromium close timeout"); }
      catch (error) { whatsappLog("chromium_final_close_failed", { failure: safeFailure(error) }); }
      await cleanProfileBrowsers(session.profile.directory);
      session.profile.release();
      if (this.current === session) this.current = undefined;
      whatsappLog("profile_released", { companyId: session.profile.companyId });
    })();
    return session.closing;
  }

  async disconnect() {
    await this.stop();
    this.publish({ companyId: null, status: "disconnected", qr: null, error: null,
      requiresReauth: false, recoveryBlocked: false, phone: null, pushname: null, platform: null });
    return this.state;
  }
}
