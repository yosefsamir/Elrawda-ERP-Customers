import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";

export interface LockMetadata {
  pid: number;
  owner: string;
  createdAt: number;
  systemBootTime: number;
}

function isPidReusedOrStale(prior: Partial<LockMetadata>): boolean {
  if (!prior.pid || typeof prior.pid !== "number" || prior.pid <= 0) {
    return true;
  }

  // 1. If lock was created in a previous OS boot session, it is definitely stale
  const currentBootTime = Date.now() - (os.uptime() * 1000);
  if (prior.createdAt && prior.createdAt < (currentBootTime - 5000)) {
    return true;
  }

  // 2. Probe PID existence with signal 0
  let isAlive = false;
  let permError = false;
  try {
    process.kill(prior.pid, 0);
    isAlive = true;
  } catch (probe: any) {
    if (probe.code === "ESRCH") {
      return true; // Process definitely dead
    }
    if (probe.code === "EPERM") {
      permError = true;
    }
  }

  // 3. If EPERM on Windows or Linux, the PID belongs to an elevated system process
  // unrelated to our user space Node server
  if (permError) {
    return true; // Reused PID by system process
  }

  if (!isAlive) {
    return true;
  }

  // 4. If alive, verify if it is actually a Node.js process
  try {
    if (process.platform === "linux") {
      const cmdline = readFileSync(`/proc/${prior.pid}/cmdline`, "utf8");
      if (!cmdline.includes("node") && !cmdline.includes("whatsapp-erp")) {
        return true; // Reused by unrelated process
      }
    } else if (process.platform === "win32") {
      const out = execFileSync("tasklist.exe", ["/FI", `PID eq ${prior.pid}`, "/NH", "/FO", "CSV"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000,
      });
      if (!out.toLowerCase().includes("node.exe")) {
        return true; // Reused by unrelated process
      }
    }
  } catch {
    // If querying process details fails (e.g. process exited in the meantime), consider stale
    return true;
  }

  // Process is genuinely alive and is a Node.js process from current boot
  return false;
}

export function acquireLock(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const owner = randomUUID();
  const currentBootTime = Math.floor(Date.now() - os.uptime() * 1000);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const payload: LockMetadata = {
        pid: process.pid,
        owner,
        createdAt: Date.now(),
        systemBootTime: currentBootTime,
      };
      writeFileSync(file, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (JSON.parse(readFileSync(file, "utf8")).owner === owner) {
            unlinkSync(file);
          }
        } catch {}
      };
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      let prior: Partial<LockMetadata>;
      try {
        prior = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // Corrupt lock file: clear and retry
        try { unlinkSync(file); } catch {}
        continue;
      }

      if (isPidReusedOrStale(prior)) {
        try { unlinkSync(file); } catch {}
        continue;
      }

      throw new Error("Another server or maintenance process is using this data directory.");
    }
  }
  throw new Error("Could not acquire the data directory lock.");
}
