/** One bounded recovery budget shared by worker exits, initialization errors and watchdogs. */
export class WhatsAppRecovery {
  attempts = 0;
  readySince?: number;
  constructor(readonly maxAttempts = 8) {}
  reset() { this.attempts = 0; this.readySince = undefined; }
  observe(status: string, now = Date.now()) {
    if (status === "ready") { this.readySince ??= now; return; }
    if (this.readySince !== undefined && now - this.readySince >= 60000) this.attempts = 0;
    this.readySince = undefined;
  }
  nextDelay(now = Date.now()): number | null {
    this.observe("disconnected", now);
    if (this.attempts >= this.maxAttempts) return null;
    return Math.min(2000 * 2 ** this.attempts++, 60000);
  }
}
