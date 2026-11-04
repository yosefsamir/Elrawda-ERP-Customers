import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WhatsAppRecovery, checkNetworkReachability } from "../../packages/runtime/whatsapp-recovery.js";
import { whatsappLog } from "../../packages/runtime/whatsapp-log.js";
import type { AccountRestriction } from "../../packages/runtime/whatsapp-restriction.js";

export class WhatsAppBridge {
  private child?: ChildProcess;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private targetCompanyId: string | null = null;
  private recoveryTimer?: NodeJS.Timeout;
  private networkWatcherTimer?: NodeJS.Timeout;
  private recovery = new WhatsAppRecovery();
  private connectInFlight?: Promise<any>;
  private stopping = false;
  private checkNetworkFn: () => Promise<boolean>;

  state: {
    companyId: string | null;
    status: string;
    qr?: string;
    error?: string;
    phone?: string;
    pushname?: string;
    platform?: string;
    workerPid?: number;
    reason?: string;
    requiresReauth?: boolean;
    recoveryBlocked?: boolean;
    processingBlocked?: boolean;
    restriction?: AccountRestriction | null;
    retryAttempt?: number;
  } = { companyId: null, status: "disconnected" };

  constructor(
    private dataDir: string,
    private forkWorker: typeof fork = fork,
    networkChecker?: () => Promise<boolean>,
    recoveryOptions?: { maxAttempts?: number; backgroundIntervalMs?: number | null },
    private onState?: (state: WhatsAppBridge["state"]) => void,
  ) {
    this.checkNetworkFn = networkChecker ?? checkNetworkReachability;
    if (recoveryOptions) {
      this.recovery = new WhatsAppRecovery(
        recoveryOptions.maxAttempts ?? 8,
        recoveryOptions.backgroundIntervalMs !== undefined ? recoveryOptions.backgroundIntervalMs : 60000,
      );
    }
  }

  private scheduleRecovery() {
    if (this.stopping || !this.targetCompanyId || this.recoveryTimer || this.state.recoveryBlocked ||
      ["ready", "starting", "qr"].includes(this.state.status)) return;

    if (this.state.status === "waiting_for_network") {
      this.ensureNetworkWatcher();
      return;
    }

    const delayMs = this.recovery.nextDelay();
    if (delayMs === null) {
      this.state = {
        ...this.state,
        status: "error",
        recoveryBlocked: true,
        error: "تعذر استرداد واتساب بعد 8 محاولات. راجع السجل ثم اضغط ربط واتساب للمحاولة مجددًا.",
      };
      whatsappLog("recovery_exhausted", { companyId: this.targetCompanyId, attempts: this.recovery.attempts });
      return;
    }
    const isBackground = this.recovery.isBackgroundPolling();
    this.state.retryAttempt = this.recovery.attempts;
    whatsappLog(isBackground ? "recovery_background_scheduled" : "recovery_scheduled", {
      companyId: this.targetCompanyId,
      attempt: this.recovery.attempts,
      delayMs,
      isBackground,
    });

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      const companyId = this.targetCompanyId;
      if (!companyId || this.stopping) return;

      void this.checkNetworkFn().then((online) => {
        if (this.stopping || this.targetCompanyId !== companyId) return;
        if (!online) {
          this.state = {
            ...this.state,
            status: "waiting_for_network",
            reason: "NETWORK_UNAVAILABLE",
            error: "في انتظار اتصال الإنترنت؛ سيتم استعادة الاتصال تلقائيًا فور توفر الشبكة.",
          };
          whatsappLog("waiting_for_network", { companyId, attempt: this.recovery.attempts });
          this.ensureNetworkWatcher();
          return;
        }
        void this.call(companyId, "connect", { automatic: true }).catch(() => this.scheduleRecovery());
      }).catch(() => {
        if (this.stopping || this.targetCompanyId !== companyId) return;
        this.state = {
          ...this.state,
          status: "waiting_for_network",
          reason: "NETWORK_UNAVAILABLE",
          error: "في انتظار اتصال الإنترنت؛ سيتم استعادة الاتصال تلقائيًا فور توفر الشبكة.",
        };
        this.ensureNetworkWatcher();
      });
    }, delayMs);
    this.recoveryTimer.unref();
  }

  private ensureNetworkWatcher(intervalMs = 5000) {
    if (this.networkWatcherTimer || this.stopping) return;
    this.networkWatcherTimer = setInterval(() => {
      if (this.stopping || !this.targetCompanyId) {
        this.clearNetworkWatcher();
        return;
      }
      void this.checkNetworkFn().then((online) => {
        if (online && !this.stopping && this.targetCompanyId) {
          this.clearNetworkWatcher();
          whatsappLog("network_restored", { companyId: this.targetCompanyId });
          this.state = {
            ...this.state,
            status: "reconnecting",
            error: "تم استعادة الاتصال بالإنترنت؛ جارٍ إعادة تشغيل واتساب...",
          };
          void this.call(this.targetCompanyId, "connect", { automatic: true }).catch(() => this.scheduleRecovery());
        }
      }).catch(() => {});
    }, intervalMs);
    this.networkWatcherTimer.unref();
  }

  private clearNetworkWatcher() {
    if (this.networkWatcherTimer) {
      clearInterval(this.networkWatcherTimer);
      this.networkWatcherTimer = undefined;
    }
  }

  getWorkerPid(): number | undefined {
    return this.child?.pid;
  }

  autoConnect(companyId: string) {
    this.targetCompanyId = companyId;
    void this.checkNetworkFn().then((online) => {
      if (!online) {
        this.state = {
          ...this.state,
          companyId,
          status: "waiting_for_network",
          reason: "NETWORK_UNAVAILABLE",
          error: "في انتظار اتصال الإنترنت؛ سيتم استعادة الاتصال تلقائيًا فور توفر الشبكة.",
        };
        whatsappLog("waiting_for_network", { companyId, startup: true });
        this.ensureNetworkWatcher();
        return;
      }
      void this.call(companyId, "connect", { automatic: true }).catch(() => this.scheduleRecovery());
    }).catch(() => {
      this.state = {
        ...this.state,
        companyId,
        status: "waiting_for_network",
        reason: "NETWORK_UNAVAILABLE",
        error: "في انتظار اتصال الإنترنت؛ سيتم استعادة الاتصال تلقائيًا فور توفر الشبكة.",
      };
      this.ensureNetworkWatcher();
    });
  }

  call(companyId: string, action: string, payload: any = {}): Promise<any> {
    if (this.stopping) return Promise.reject(new Error("جارٍ إغلاق عامل واتساب"));
    if ((this.targetCompanyId && this.targetCompanyId !== companyId) ||
        (this.state.companyId && this.state.companyId !== companyId)) return Promise.reject(new Error("جلسة شركة أخرى نشطة؛ افصلها أولًا."));
    if (action === "connect") {
      if (this.connectInFlight) return this.connectInFlight;
      if (!payload.automatic) {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
        this.clearNetworkWatcher();
        this.recovery.reset();
      }
      this.targetCompanyId = companyId;
      const request = this.checkNetworkFn().then(online => {
        if (!online) {
          this.state = {
            ...this.state,
            companyId,
            status: "waiting_for_network",
            reason: "NETWORK_UNAVAILABLE",
            error: "في انتظار اتصال الإنترنت؛ سيتم استعادة الاتصال تلقائيًا فور توفر الشبكة.",
          };
          whatsappLog("waiting_for_network", { companyId });
          this.ensureNetworkWatcher();
          return this.state;
        }
        return this.request(companyId, action, payload);
      }).catch(error => {
        this.state = { ...this.state, status: "error", error: "تعذر تشغيل جلسة واتساب؛ راجع سجل الخدمة." };
        this.scheduleRecovery();
        throw error;
      });
      this.connectInFlight = request;
      void request.finally(() => { if (this.connectInFlight === request) this.connectInFlight = undefined; }).catch(() => {});
      return request;
    }
    if (action === "disconnect") {
      this.targetCompanyId = null;
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
      this.clearNetworkWatcher();
    }
    return this.request(companyId, action, payload);
  }

  private async request(companyId: string, action: string, payload: unknown) {
    if (!this.child) {
      this.child = this.forkWorker(
        fileURLToPath(new URL(`../whatsapp-worker/index.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url)),
        [],
        {
          env: { ...process.env, EMOJI_DATA_DIR: this.dataDir },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      const child = this.child;
      this.state.workerPid = child.pid;
      whatsappLog("worker_started", { workerPid: child.pid, companyId });

      this.child.on("message", (message: any) => {
        if (this.child !== child) return;
        if (message.type === "state") {
          this.state = { ...message.state, workerPid: child.pid };
          this.onState?.(this.state);
          this.recovery.observe(this.state.status);
          if (["ready", "qr"].includes(this.state.status) || this.state.recoveryBlocked) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = undefined;
            this.clearNetworkWatcher();
          }
          this.scheduleRecovery();
        }
        if (message.id) {
          const item = this.pending.get(message.id);
          if (item) {
            clearTimeout(item.timer);
            this.pending.delete(message.id);
            message.error
              ? item.reject(new Error(message.error))
              : item.resolve(message.result);
          }
        }
      });
      this.child.on("error", (error) => {
        if (this.child !== child) return;
        whatsappLog("worker_error", { workerPid: child.pid, errorCode: (error as any).code });
        this.state = { ...this.state, status: "error", error: error.message };
        this.scheduleRecovery();
      });
      const workerExited = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.child !== child) return;
        this.child = undefined;
        whatsappLog("worker_exit", { workerPid: child.pid, companyId: this.targetCompanyId, code, signal });
        const isNetworkWaiting = this.state.status === "waiting_for_network";
        this.state = { ...this.state,
          status: this.state.recoveryBlocked ? "error" : isNetworkWaiting ? "waiting_for_network" : "disconnected",
          qr: undefined, workerPid: undefined,
          error: this.state.recoveryBlocked ? this.state.error : isNetworkWaiting ? this.state.error : "توقف عامل واتساب؛ جارٍ استعادة الاتصال تلقائيًا..." };
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error("عامل واتساب غير متاح"));
        }
        this.pending.clear();
        this.scheduleRecovery();
      };
      child.on("exit", workerExited);
      child.on("close", workerExited);
    }
    if (this.state.companyId && this.state.companyId !== companyId)
      throw new Error(
        "جلسة شركة أخرى نشطة. افصلها أولًا قبل ربط حساب شركة ثانية.",
      );
    const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          if (action === "connect") {
            this.state = { ...this.state, status: "error" };
            void this.retireUnresponsiveWorker().catch(() => {});
          }
          reject(new Error("انتهت مهلة العملية؛ لم نكرر الطلب."));
        },
        action === "connect" ? 45000 : 25000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child!.send({ id, companyId, action, payload }, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  private async retireUnresponsiveWorker() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const force = () => {
        whatsappLog("worker_force_stop", { workerPid: child.pid });
        if (process.platform === "win32" && child.pid) {
          try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 }); }
          catch (error) { reject(error); }
        } else child.kill("SIGKILL");
      };
      const timeout = setTimeout(force, 40000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      if (child.connected) child.send({ action: "shutdown" }, error => { if (error) force(); });
      else child.kill("SIGTERM");
    }).catch(error => { whatsappLog("worker_stop_failed", { workerPid: child.pid }); throw error; });
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.clearNetworkWatcher();
    this.targetCompanyId = null;
    await this.retireUnresponsiveWorker();
  }
}
