import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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
  private watchdogTimer?: NodeJS.Timeout;
  private stopping = false;

  state: {
    companyId: string | null;
    status: string;
    qr?: string;
    error?: string;
    phone?: string;
    pushname?: string;
    platform?: string;
  } = { companyId: null, status: "disconnected" };

  constructor(private dataDir: string) {
    this.startWatchdog();
  }

  autoConnect(companyId: string) {
    this.targetCompanyId = companyId;
    this.call(companyId, "connect").catch((err) => {
      console.error(`[WhatsAppBridge] Auto-connect attempt failed:`, err.message);
    });
  }

  private startWatchdog() {
    this.watchdogTimer = setInterval(() => {
      if (
        this.targetCompanyId &&
        this.state.status !== "ready" &&
        this.state.status !== "starting" &&
        this.state.status !== "qr"
      ) {
        console.log(
          `[WhatsApp Watchdog] Status is '${this.state.status}'. Auto-reconnecting company ${this.targetCompanyId}...`,
        );
        this.call(this.targetCompanyId, "connect").catch((err) => {
          console.error("[WhatsApp Watchdog] Auto-reconnect failed:", err.message);
        });
      }
    }, 15000);
    this.watchdogTimer.unref();
  }

  async call(companyId: string, action: string, payload: unknown = {}) {
    if (this.stopping) throw new Error("جارٍ إغلاق عامل واتساب");
    if (this.state.companyId && this.state.companyId !== companyId) throw new Error("جلسة شركة أخرى نشطة؛ افصلها أولًا.");
    if (action === "connect") {
      this.targetCompanyId = companyId;
    } else if (action === "disconnect") {
      this.targetCompanyId = null;
    }

    if (!this.child) {
      this.child = fork(
        fileURLToPath(new URL(`../whatsapp-worker/index.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url)),
        [],
        {
          env: { ...process.env, EMOJI_DATA_DIR: this.dataDir },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      this.child.on("message", (message: any) => {
        if (message.type === "state") this.state = message.state;
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
        this.state = { ...this.state, status: "error", error: error.message };
      });
      this.child.on("exit", () => {
        this.child = undefined;
        this.state = {
          companyId: null,
          status: "disconnected",
          error: "توقف عامل واتساب؛ أعد الربط من الشاشة.",
        };
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error("عامل واتساب غير متاح"));
        }
        this.pending.clear();
      });
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
          reject(new Error("انتهت مهلة العملية؛ لم نكرر الطلب."));
        },
        action === "connect" ? 15000 : 25000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child!.send({ id, companyId, action, payload }, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  async stop() {
    this.stopping = true;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    this.targetCompanyId = null;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 35000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      // IPC is graceful on Windows too; SIGTERM there would terminate immediately.
      if (child.connected) child.send({action:"shutdown"}, error => { if (error) child.kill(); });
      else child.kill();
    });
  }
}
