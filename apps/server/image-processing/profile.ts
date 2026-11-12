import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext } from "playwright";
import { localSecretStore } from "../security.js";

const exec = promisify(execFile);

function windowsProfileArgument(commandLine: string): string | undefined {
  return /(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|([^\s"]+)))(?=\s|$)/i
    .exec(commandLine)
    ?.slice(1)
    .find(Boolean);
}

export async function ownedGeminiBrowsers(profileDir: string): Promise<number[]> {
  const normalized = resolve(profileDir);
  if (process.platform === "win32") {
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'chrome-headless-shell.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const rows = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, "")) : [];
    return (Array.isArray(rows) ? rows : [rows])
      .filter((row) => {
        const arg = windowsProfileArgument(row.CommandLine ?? "");
        return arg && resolve(arg).toLowerCase() === normalized.toLowerCase();
      })
      .map((row) => Number(row.ProcessId));
  }
  if (process.platform !== "linux") return [];
  const pids: number[] = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!["chrome", "chrome-headless-shell"].includes(basename(readlinkSync(`/proc/${pid}/exe`)))) continue;
      const flattened = args.join(" ");
      if (args.includes(`--user-data-dir=${normalized}`) || flattened.includes(` --user-data-dir=${normalized} --`)) {
        pids.push(Number(pid));
      }
    } catch (error: any) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return pids;
}

export async function cleanGeminiProfileBrowsers(profileDir: string) {
  for (const pid of await ownedGeminiBrowsers(profileDir)) {
    if (!(await ownedGeminiBrowsers(profileDir)).includes(pid)) continue;
    if (process.platform === "win32") {
      await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
    } else {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error: any) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await ownedGeminiBrowsers(profileDir)).length) return;
    await delay(250);
  }
  throw new Error("Chromium still owns the Gemini profile; refusing to launch a second browser");
}

/**
 * Manages an exclusive OS-level lease and non-secret session state markers for the Gemini browser profile.
 */
export interface GeminiProfileLockOptions {
  profileDir?: string;
  lockName?: string;
}

export type GeminiStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface GeminiCdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority?: "Low" | "Medium" | "High";
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
  partitionKey?: {
    topLevelSite: string;
    hasCrossSiteAncestor?: boolean;
  };
}

export interface GeminiEncryptedAuthSnapshot {
  version: 1;
  savedAt: string;
  userAgent: string;
  storageState: GeminiStorageState;
  cdpCookies?: GeminiCdpCookie[];
}

export function getEncryptedStorageStatePath(profileRoot: string): string {
  return join(resolve(profileRoot), ".locks", "storage-state.enc");
}

export function getSyncedStorageStatePath(profileRoot: string): string {
  return join(resolve(profileRoot), ".locks", "service-synced.json");
}

export function saveEncryptedGeminiStorageState(options: {
  profileRoot: string;
  dataDir: string;
  storageState: GeminiStorageState;
  userAgent: string;
  cdpCookies?: GeminiCdpCookie[];
  savedAt?: string;
}): GeminiEncryptedAuthSnapshot {
  const locks = join(resolve(options.profileRoot), ".locks");
  const resolvedDataDir = resolve(options.dataDir);
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  mkdirSync(resolvedDataDir, { recursive: true, mode: 0o700 });

  const snapshot: GeminiEncryptedAuthSnapshot = {
    version: 1,
    savedAt: options.savedAt ?? new Date().toISOString(),
    userAgent: options.userAgent,
    storageState: options.storageState,
    ...(options.cdpCookies?.length ? { cdpCookies: options.cdpCookies } : {}),
  };
  const encrypted = localSecretStore(resolvedDataDir).encrypt(snapshot);
  const target = getEncryptedStorageStatePath(options.profileRoot);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, encrypted, { encoding: "utf8", mode: 0o600, flush: true });
  try {
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return snapshot;
}

export function loadEncryptedGeminiStorageState(
  profileRoot: string,
  dataDir: string,
): GeminiEncryptedAuthSnapshot | null {
  const target = getEncryptedStorageStatePath(profileRoot);
  const resolvedDataDir = resolve(dataDir);
  if (!existsSync(target) || !existsSync(join(resolvedDataDir, "secret.key"))) {
    return null;
  }
  try {
    const raw = readFileSync(target, "utf8");
    const parsed = localSecretStore(resolvedDataDir).decrypt(raw) as Partial<GeminiEncryptedAuthSnapshot> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      typeof parsed.savedAt !== "string" ||
      typeof parsed.userAgent !== "string" ||
      !parsed.storageState ||
      !Array.isArray(parsed.storageState.cookies) ||
      !Array.isArray(parsed.storageState.origins)
    ) {
      return null;
    }
    const cdpCookies = Array.isArray(parsed.cdpCookies)
      ? parsed.cdpCookies.filter(
          (cookie): cookie is GeminiCdpCookie =>
            Boolean(cookie) &&
            typeof cookie === "object" &&
            typeof cookie.name === "string" &&
            cookie.name.length > 0 &&
            typeof cookie.value === "string" &&
            typeof cookie.domain === "string" &&
            cookie.domain.length > 0 &&
            typeof cookie.path === "string",
        )
      : undefined;
    return {
      version: 1,
      savedAt: parsed.savedAt,
      userAgent: parsed.userAgent,
      storageState: parsed.storageState,
      ...(cdpCookies?.length ? { cdpCookies } : {}),
    };
  } catch {
    return null;
  }
}

export function getSyncedStorageStateTimestamp(profileRoot: string): string | null {
  const target = getSyncedStorageStatePath(profileRoot);
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as { savedAt?: unknown };
    return typeof parsed.savedAt === "string" ? parsed.savedAt : null;
  } catch {
    return null;
  }
}

export function markStorageStateSynced(profileRoot: string, savedAt: string) {
  const locks = join(resolve(profileRoot), ".locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  writeFileSync(
    getSyncedStorageStatePath(profileRoot),
    JSON.stringify({ savedAt, syncedAt: new Date().toISOString() }),
    { mode: 0o600, flush: true },
  );
}

export class GeminiProfileLock {
  readonly root: string;
  readonly profileDir: string;
  readonly reauthMarker: string;
  readonly authStateFile: string;
  private lease: Database.Database;
  private closed = false;

  constructor(profileRoot: string, options: GeminiProfileLockOptions = {}) {
    this.root = resolve(profileRoot);
    this.profileDir = options.profileDir ? resolve(options.profileDir) : join(this.root, "profile");
    const lockName = options.lockName ?? "gemini.sqlite";
    const locks = join(this.root, ".locks");
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    this.reauthMarker = join(locks, "reauth.json");
    this.authStateFile = join(locks, "auth-state.json");
    this.lease = new Database(join(locks, lockName), { timeout: 0 });
    try {
      this.lease.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY)");
    } catch (error) {
      this.lease.close();
      throw error;
    }
  }

  async prepare() {
    await cleanGeminiProfileBrowsers(this.profileDir);
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      rmSync(join(this.profileDir, name), { force: true });
    }
  }

  release() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.lease.close();
    } catch {}
  }
}

export function getGeminiProfileStatus(profileRoot: string): {
  profileExists: boolean;
  requiresReauth: boolean;
  reauthReason: string | null;
  authenticatedAt: string | null;
} {
  const root = resolve(profileRoot);
  const profileDir = join(root, "profile");
  const reauthMarker = join(root, ".locks", "reauth.json");
  const authStateFile = join(root, ".locks", "auth-state.json");
  const storageStateFile = getEncryptedStorageStatePath(root);

  let requiresReauth = false;
  let reauthReason: string | null = null;
  if (existsSync(reauthMarker)) {
    requiresReauth = true;
    try {
      const parsed = JSON.parse(readFileSync(reauthMarker, "utf8"));
      reauthReason = typeof parsed.reason === "string" ? parsed.reason : "REAUTH_REQUIRED";
    } catch {
      reauthReason = "REAUTH_REQUIRED";
    }
  }

  let authenticatedAt: string | null = null;
  if (existsSync(authStateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(authStateFile, "utf8"));
      authenticatedAt = typeof parsed.authenticatedAt === "string" ? parsed.authenticatedAt : null;
    } catch {}
  }

  return {
    profileExists: Boolean(authenticatedAt) || existsSync(storageStateFile) || existsSync(join(profileDir, "Default")),
    requiresReauth,
    reauthReason,
    authenticatedAt,
  };
}

export function markGeminiReauthRequired(profileRoot: string, reason: string) {
  const locks = join(resolve(profileRoot), ".locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(locks, "reauth.json"),
    JSON.stringify({ reason, at: new Date().toISOString() }),
    { mode: 0o600, flush: true },
  );
}

export function markGeminiAuthenticated(profileRoot: string) {
  const locks = join(resolve(profileRoot), ".locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  rmSync(join(locks, "reauth.json"), { force: true });
  writeFileSync(
    join(locks, "auth-state.json"),
    JSON.stringify({ authenticatedAt: new Date().toISOString() }),
    { mode: 0o600, flush: true },
  );
}
