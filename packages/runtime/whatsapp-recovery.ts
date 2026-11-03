import { createConnection } from "node:net";

export function checkNetworkReachability(
  host = "web.whatsapp.com",
  port = 443,
  timeoutMs = 3000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const socket = createConnection({ host, port, timeout: timeoutMs }, () => {
        socket.destroy();
        finish(true);
      });
      socket.on("error", () => {
        socket.destroy();
        finish(false);
      });
      socket.on("timeout", () => {
        socket.destroy();
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

export function isNetworkError(reason?: string | null, error?: unknown): boolean {
  if (
    reason &&
    [
      "NETWORK_UNAVAILABLE",
      "WAITING_FOR_NETWORK",
      "SOCKET_UNAVAILABLE",
      "HEALTH_TIMEOUT",
      "INJECTION_FAILED",
      "INITIALIZATION_TIMEOUT",
    ].includes(reason)
  ) {
    return true;
  }
  if (!error) return false;
  const msg = String((error as any).message ?? error).toLowerCase();
  return (
    msg.includes("err_name_not_resolved") ||
    msg.includes("err_connection_refused") ||
    msg.includes("err_internet_disconnected") ||
    msg.includes("err_network_changed") ||
    msg.includes("err_timed_out") ||
    msg.includes("err_address_unreachable") ||
    msg.includes("err_connection_reset") ||
    msg.includes("err_connection_closed") ||
    msg.includes("navigation timeout") ||
    msg.includes("waiting failed") ||
    msg.includes("auth timeout") ||
    msg.includes("timeouterror") ||
    msg.includes("timed out") ||
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach") ||
    msg.includes("net::err_")
  );
}

/** One bounded recovery budget that transitions to low-frequency background polling rather than dying. */
export class WhatsAppRecovery {
  attempts = 0;
  readySince?: number;

  constructor(
    readonly maxAttempts = 8,
    readonly backgroundIntervalMs: number | null = 60000,
  ) {}

  reset() {
    this.attempts = 0;
    this.readySince = undefined;
  }

  observe(status: string, now = Date.now()) {
    if (status === "ready") {
      this.readySince ??= now;
      return;
    }
    if (this.readySince !== undefined && now - this.readySince >= 60000) {
      this.attempts = 0;
    }
    this.readySince = undefined;
  }

  isBackgroundPolling(): boolean {
    return this.attempts >= this.maxAttempts;
  }

  nextDelay(now = Date.now()): number | null {
    this.observe("disconnected", now);
    if (this.attempts < this.maxAttempts) {
      return Math.min(2000 * 2 ** this.attempts++, 60000);
    }
    if (this.backgroundIntervalMs === null) return null;
    this.attempts++;
    return this.backgroundIntervalMs;
  }
}
