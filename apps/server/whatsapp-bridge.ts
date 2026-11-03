import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WhatsAppRecovery } from "../../packages/runtime/whatsapp-recovery.js";
import { whatsappLog } from "../../packages/runtime/whatsapp-log.js";

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
  private recovery = new WhatsAppRecovery();
  private connectInFlight?: Promise<any>;
  private stopping = false;

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
    retryAttempt?: number;
  } = { companyId: null, status: "disconnected" };

  constructor(private dataDir: string, private forkWorker: typeof fork = fork) {}

  private scheduleRecovery() {
    if (this.stopping || !this.targetCompanyId || this.recoveryTimer || this.state.recoveryBlocked ||
      ["ready", "starting", "qr", "reconnecting"].includes(this.state.status)) return;
    const delayMs = this.recovery.nextDelay();
    if (delayMs === null) {
      this.state = { ...this.state, status: "error", recoveryBlocked: true,
        error: "تعذر استرداد واتساب بعد 8 محاولات. راجع السجل ثم اضغط ربط واتساب للمحاولة مجددًا." };
      whatsappLog("recovery_exhausted", { companyId: this.targetCompanyId, attempts: this.recovery.attempts });
      return;
    }
    this.state.retryAttempt = this.recovery.attempts;
    whatsappLog("recovery_scheduled", { companyId: this.targetCompanyId, attempt: this.recovery.attempts, delayMs });
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      const companyId = this.targetCompanyId;
      if (companyId && !this.stopping) void this.call(companyId, "connect", { automatic: true }).catch(() => this.scheduleRecovery());
    }, delayMs);
    this.recoveryTimer.unref();
  }

  getWorkerPid(): number | undefined {
    return this.child?.pid;
  }

  autoConnect(companyId: string) {
    void this.call(companyId, "connect", { automatic: true }).catch(() => this.scheduleRecovery());
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
        this.recovery.reset();
      }
      this.targetCompanyId = companyId;
      const request = this.request(companyId, action, payload).catch(error => {
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
          this.recovery.observe(this.state.status);
          if (["ready", "qr"].includes(this.state.status) || this.state.recoveryBlocked) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = undefined;
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
        this.state = { ...this.state, status: this.state.recoveryBlocked ? "error" : "disconnected",
          qr: undefined, workerPid: undefined,
          error: this.state.recoveryBlocked ? this.state.error : "توقف عامل واتساب؛ جارٍ استعادة الاتصال تلقائيًا..." };
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error("عامل واتساب غير متاح"));
        }
        this.pending.clear();
        // The next worker obtains the OS-backed profile lease and verifies browser command
        // line ownership before cleaning orphans. Never kill a stale recorded PID by name.
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
    this.targetCompanyId = null;
    await this.retireUnresponsiveWorker();
  }
}
