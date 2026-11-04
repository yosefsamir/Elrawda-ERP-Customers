import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { uptime } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode, whatsappLog } from "./whatsapp-log.js";

const exec = promisify(execFile);
const retryable = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "SQLITE_BUSY"]);
export async function retryProfileIO<T>(operation: () => T | Promise<T>, event: string, retries = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!retryable.has((error as any).code) || attempt >= retries) throw error;
      const delayMs = Math.min(250 * 2 ** attempt, 4000);
      whatsappLog(event, { attempt: attempt + 1, delayMs, errorCode: errorCode(error) });
      await delay(delayMs);
    }
  }
}

// Windows paths may contain spaces. Match the entire user-data-dir argument, never a PID/name alone.
export function windowsProfileArgument(commandLine: string): string | undefined {
  return /(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|([^\s"]+)))(?=\s|$)/i.exec(commandLine)?.slice(1).find(Boolean);
}

export async function ownedProfileBrowsers(profile: string): Promise<number[]> {
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'chrome-headless-shell.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    const rows = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, "")) : [];
    return (Array.isArray(rows) ? rows : [rows]).filter(row => {
      const argument = windowsProfileArgument(row.CommandLine ?? "");
      return argument && resolve(argument).toLowerCase() === resolve(profile).toLowerCase();
    }).map(row => Number(row.ProcessId));
  }
  if (process.platform !== "linux") throw new Error("Unsupported profile process inspection platform");
  const pids: number[] = [];
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!["chrome", "chrome-headless-shell"].includes(basename(readlinkSync(`/proc/${pid}/exe`)))) continue;
      // Chromium can rewrite argv into a single process-title string on Linux.
      // Match the whole known profile followed by the next switch in that case.
      const flattened = args.join(" ");
      if (args.includes(`--user-data-dir=${profile}`) || flattened.includes(` --user-data-dir=${profile} --`)) pids.push(Number(pid));
    } catch (error: any) { if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error; }
  }
  return pids;
}

// Called only while holding this profile's OS-backed lease. Recheck ownership immediately before killing.
export async function cleanProfileBrowsers(profile: string) {
  for (const pid of await ownedProfileBrowsers(profile)) {
    if (!(await ownedProfileBrowsers(profile)).includes(pid)) continue;
    whatsappLog("chromium_force_stop", { browserPid: pid });
    if (process.platform === "win32") {
      await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 });
    } else {
      try { process.kill(pid, "SIGKILL"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await ownedProfileBrowsers(profile)).length) return;
    await delay(250);
  }
  throw new Error("Chromium still owns the WhatsApp profile; refusing a second browser");
}

export class WhatsAppProfile {
  readonly root: string;
  readonly directory: string;
  readonly marker: string;
  readonly recoveryMarker: string;
  private lease: Database.Database;
  private closed = false;

  constructor(dataDir: string, readonly companyId: string) {
    if (!/^[-_\w]+$/.test(companyId)) throw new Error("Invalid WhatsApp company ID");
    this.root = resolve(dataDir, "whatsapp-auth");
    this.directory = join(this.root, `session-${companyId}`);
    const locks = join(this.root, ".locks");
    mkdirSync(locks, { recursive: true });
    this.marker = join(locks, `${companyId}.reauth.json`);
    this.recoveryMarker = join(locks, `${companyId}.blocked.json`);
    // SQLite's exclusive OS lock is atomic across processes, is released on a crash/reboot,
    // and avoids racing stale-PID lock-file deletion. Never unlink this database.
    this.lease = new Database(join(locks, `${companyId}.sqlite`), { timeout: 0 });
    try {
      this.lease.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY)");
      const legacyLock = join(this.directory, "session.lock");
      if (existsSync(legacyLock)) {
        const prior = JSON.parse(readFileSync(legacyLock, "utf8"));
        const createdAt = typeof prior.createdAt === "number" ? prior.createdAt : Date.parse(prior.createdAt);
        const previousBoot = Number.isFinite(createdAt) && createdAt < Date.now() - uptime() * 1000 - 5000;
        if (!previousBoot && Number.isInteger(prior.pid) && prior.pid > 0 && prior.pid !== process.pid) {
          try { process.kill(prior.pid, 0); }
          catch (error: any) { if (error.code === "ESRCH") return; throw error; }
          throw new Error("A legacy WhatsApp worker still owns this profile");
        }
      }
    } catch (error) { this.lease.close(); throw error; }
  }

  get requiresReauth() { return existsSync(this.marker); }
  markReauth(reason: string) {
    writeFileSync(this.marker, JSON.stringify({ reason, at: new Date().toISOString() }), { mode: 0o600, flush: true });
  }
  authenticated() { rmSync(this.marker, { force: true }); }
  get recoveryBlockReason(): string | undefined {
    if (!existsSync(this.recoveryMarker)) return undefined;
    let data;
    try { data = JSON.parse(readFileSync(this.recoveryMarker, "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) return "RECOVERY_MARKER_INVALID";
      throw error;
    }
    return typeof data.reason === "string" ? data.reason : "RECOVERY_BLOCKED";
  }
  markRecoveryBlocked(reason: string) {
    writeFileSync(this.recoveryMarker, JSON.stringify({ reason, at: new Date().toISOString() }), { mode: 0o600, flush: true });
  }
  clearRecoveryBlock() { rmSync(this.recoveryMarker, { force: true }); }

  async prepare(explicit: boolean) {
    await cleanProfileBrowsers(this.directory);
    if (this.requiresReauth) {
      if (!explicit) throw new Error("WhatsApp requires explicit relinking");
      if (existsSync(this.directory)) {
        const archive = join(this.root, `.revoked-${this.companyId}-${Date.now()}`);
        await retryProfileIO(() => renameSync(this.directory, archive), "revoked_profile_archive_retry");
        whatsappLog("revoked_profile_archived", { companyId: this.companyId });
      }
    }
    // Only Chromium singleton metadata, after ownership is proven absent. Never touch Default/lockfile or auth DBs.
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "session.lock"]) {
      await retryProfileIO(() => rmSync(join(this.directory, name), { force: true }), "profile_lock_retry");
    }
  }

  release() {
    if (this.closed) return;
    this.closed = true;
    this.lease.close();
  }
}
