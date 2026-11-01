import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const { createPilotClient } = require("../../scripts/whatsapp-test/groups.cjs");
const { addOne, inspectTarget } = require("../../scripts/whatsapp-test/operations.cjs");

function resolveChromeExecutable(): string | undefined {
  if (process.env.WHATSAPP_CHROME_PATH && existsSync(process.env.WHATSAPP_CHROME_PATH)) {
    return process.env.WHATSAPP_CHROME_PATH;
  }
  const root = resolve(process.env.EMOJI_APP_ROOT ?? process.cwd());
  const bundledDir = join(root, "runtime", "chromium");
  if (existsSync(bundledDir)) {
    const isWin = process.platform === "win32";
    const binary = isWin ? "chrome.exe" : "chrome";
    const direct = join(bundledDir, binary);
    if (existsSync(direct)) return direct;
    const stack = [bundledDir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      try {
        for (const entry of readdirSync(cur)) {
          const full = join(cur, entry);
          const st = statSync(full);
          if (st.isDirectory()) stack.push(full);
          else if (entry.toLowerCase() === binary.toLowerCase()) return full;
        }
      } catch {}
    }
  }
  return undefined;
}

let client: any = null;
let pilot: any = null;
let companyId: string | null = null;
let state: any = { companyId: null, status: "disconnected" };

const publish = (extra: any) => {
  state = { ...state, ...extra, companyId };
  process.send?.({ type: "state", state });
};

async function killBrowserProcess() {
  try {
    if (client?.pupBrowser?.process) {
      const proc = client.pupBrowser.process();
      if (proc && proc.pid) {
        if (process.platform === "win32") {
          try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" }); } catch {}
        } else {
          try { proc.kill("SIGKILL"); } catch {}
        }
      }
    }
  } catch {}
}

let commandQueue = Promise.resolve();
process.on("message", (message: any) => {
  commandQueue = commandQueue.then(() => handleMessage(message));
});
async function handleMessage(message: any) {
  try {
    const { id, action, payload } = message;
    if (companyId && companyId !== message.companyId) {
      throw new Error("Another company WhatsApp session is currently active");
    }

    let result: any = {};

    if (action === "shutdown") {
      await shutdown();
      return;
    }
    if (action === "connect") {
      if (client && ["starting", "qr"].includes(state.status)) {
        process.send?.({ id, result: state });
        return;
      }
      if (client && state.status === "ready") {
        const info = (client as any)?.info;
        if (info) {
          state.phone = info.wid?.user || state.phone;
          state.pushname = info.pushname || state.pushname;
          state.platform = info.platform || state.platform;
        }
        process.send?.({ id, result: state });
        return;
      }

      if (client) {
        await killBrowserProcess();
        try {
          await client.destroy();
        } catch {
          // Ignore destroy errors
        }
        client = null;
        pilot = null;
      }

      companyId = message.companyId;
      publish({ status: "starting", qr: null, error: null });

      const authDataPath = resolve(process.env.EMOJI_DATA_DIR!, "whatsapp-auth");
      const sessionDir = resolve(authDataPath, `session-${companyId}`);
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }

      // WhatsApp Session Lock & Stale Lock Cleanup (L8)
      const lockPath = resolve(sessionDir, "session.lock");
      if (existsSync(lockPath)) {
        let isStale = false;
        try {
          const lockContent = readFileSync(lockPath, "utf8");
          const lockData = JSON.parse(lockContent);
          if (lockData.pid && lockData.pid !== process.pid) {
            try {
              process.kill(lockData.pid, 0); // Check if PID is actively running
              throw new Error(`جلسة واتساب لهذه الشركة قيد الاستخدام بواسطة عملية أخرى (PID ${lockData.pid})`);
            } catch (e: any) {
              if (e.message && e.message.includes("قيد الاستخدام")) throw e;
              isStale = true;
            }
          } else {
            isStale = true;
          }
        } catch (e: any) {
          if (e.message && e.message.includes("قيد الاستخدام")) throw e;
          isStale = true;
        }

        if (isStale) {
          try { rmSync(lockPath, { force: true }); } catch {}
          // Also clean up any stale Chromium SingletonLock from crashed browser (M7)
          for (const targetDir of [sessionDir, join(sessionDir, "Default")]) {
            if (existsSync(targetDir)) {
              for (const item of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
                try { rmSync(join(targetDir, item), { force: true }); } catch {}
              }
            }
          }
        }
      }

      try {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, companyId, createdAt: new Date().toISOString() }));
      } catch {}

      // Dedicated persistent web version cache path (L9)
      const cacheDir = process.env.PUPPETEER_CACHE_DIR || resolve(process.env.EMOJI_DATA_DIR!, "..", "cache");
      const webCacheDir = resolve(cacheDir, "wwebjs_cache");
      if (!existsSync(webCacheDir)) {
        mkdirSync(webCacheDir, { recursive: true });
      }

      const chromeExec = resolveChromeExecutable();
      const puppeteerArgs = [
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-gpu",
      ];
      // Only for Linux hosts without user namespaces. Windows always runs with the sandbox on.
      if (process.env.CHROME_NO_SANDBOX === "true") puppeteerArgs.unshift("--no-sandbox");

      client = new Client({
        authStrategy: new LocalAuth({
          clientId: companyId,
          dataPath: authDataPath,
        }),
        webVersionCache: {
          type: "local",
          path: webCacheDir,
        },
        puppeteer: {
          headless: true,
          protocolTimeout: 30000,
          args: puppeteerArgs,
          ...(chromeExec ? { executablePath: chromeExec } : {}),
        },
      });

      pilot = createPilotClient(client);

      client.on("qr", async (qr: string) =>
        publish({ status: "qr", qr: await QRCode.toDataURL(qr) }),
      );
      client.on("ready", () => {
        const info = (client as any)?.info;
        publish({
          status: "ready",
          qr: null,
          error: null,
          phone: info?.wid?.user || null,
          pushname: info?.pushname || null,
          platform: info?.platform || null,
        });
      });
      client.on("auth_failure", () =>
        publish({
          status: "error",
          qr: null,
          error: "WhatsApp session authentication failed",
        }),
      );
      client.on("disconnected", () =>
        publish({ status: "disconnected", qr: null }),
      );

      // A killed worker leaves its browser running, so the server needs the PID on disk (M7)
      const recordBrowser = setInterval(() => {
        const browserPid = client?.pupBrowser?.process?.()?.pid;
        if (!browserPid) return;
        clearInterval(recordBrowser);
        try {
          writeFileSync(lockPath, JSON.stringify({ pid: process.pid, browserPid, companyId, createdAt: new Date().toISOString() }));
        } catch {}
      }, 250);
      recordBrowser.unref();

      void client
        .initialize()
        .catch(async (err: any) => {
          console.error("WhatsApp client initialization failed:", err);
          // A browser left running keeps the profile locked, and every retry then fails forever
          clearInterval(recordBrowser);
          await killBrowserProcess();
          try {
            await client?.destroy();
          } catch {
            // Ignore destroy errors
          }
          client = null;
          pilot = null;
    
          publish({
            status: "error",
            error: err?.message || "Failed to initialize browser or WhatsApp session",
          });
        });

      result = state;
    } else if (action === "disconnect") {
      await killBrowserProcess();
      if (client) {
        try {
          await client.destroy();
        } catch {
          // Ignore destroy errors
        }
      }
      if (companyId) {
        const authDataPath = resolve(process.env.EMOJI_DATA_DIR!, "whatsapp-auth");
        const sessionDir = resolve(authDataPath, `session-${companyId}`);
        const lockPath = resolve(sessionDir, "session.lock");
        if (existsSync(lockPath)) {
          try { rmSync(lockPath, { force: true }); } catch {}
        }
      }
      client = null;
      pilot = null;
      companyId = null;
      publish({ status: "disconnected", qr: null, error: null, phone: null, pushname: null });
    } else {
      if (state.status !== "ready") {
        throw new Error("WhatsApp client is not ready. Please connect first.");
      }

      if (action === "lookup") {
        const number = await client.getNumberId(payload.phone);
        result = {
          registered: Boolean(number),
          numberId: number?._serialized,
        };
      } else if (action === "groups") {
        result = await pilot.getGroups();
      } else if (action === "get_group_info") {
        const group = await pilot.getChatById(payload.groupId);
        result = {
          id: payload.groupId,
          name: group.formattedTitle || group.name,
          participantCount: group.groupMetadata?.participants?.length ?? 0,
        };
      } else if (action === "add_participant") {
        result = await addOne(pilot, payload.phone, payload.groupId, true);
      } else if (action === "get_membership") {
        result = await inspectTarget(pilot, payload.phone, payload.groupId);
      } else if (action === "get_invite_link") {
        const group = await pilot.getChatById(payload.groupId);
        const code = await group.getInviteCode();
        result = {
          code,
          link: `https://chat.whatsapp.com/${code}`,
        };
      } else if (action === "send_message") {
        const { phone, text } = payload;
        const number = await client.getNumberId(phone);

        if (!number) {
          result = { status: "not_on_whatsapp", phone };
        } else {
          const targetId = number._serialized.replace(
            /@s\.whatsapp\.net$/,
            "@c.us",
          );
          const sent = await client.sendMessage(targetId, text);
          result = {
            status: "sent",
            messageId: sent?.id?._serialized,
          };
        }
      } else if (action === "create_group") {
        const { title } = payload;
        const res = await client.createGroup(title, [], {
          autoSendInviteV4: false,
          memberAddMode: true,
          isRestrict: true,
        });
        const gid =
          res?.gid?._serialized ||
          res?.gid ||
          null;
        if (typeof gid !== "string" || !/^[\w-]+@g\.us$/.test(gid)) throw new Error("Group creation result is uncertain");
        result = { groupId: gid };
      } else {
        throw new Error(`Unsupported WhatsApp worker action: ${action}`);
      }
    }

    process.send?.({ id, result });
  } catch (error) {
    process.send?.({
      id: message.id,
      error:
        error instanceof Error ? error.message : "Operation execution failed",
    });
  }
}

async function shutdown() {
  try {
    await killBrowserProcess();
    if (client) {
      await client.destroy();
    }
    if (companyId) {
      const authDataPath = resolve(process.env.EMOJI_DATA_DIR!, "whatsapp-auth");
      const sessionDir = resolve(authDataPath, `session-${companyId}`);
      const lockPath = resolve(sessionDir, "session.lock");
      if (existsSync(lockPath)) {
        try { rmSync(lockPath, { force: true }); } catch {}
      }
    }
  } catch {
    // Ignore errors during shutdown
  } finally {
    process.exit(0);
  }
}

process.on("uncaughtException", async (err) => {
  console.error("[WhatsApp Worker] Uncaught exception:", err);
  await shutdown();
});
process.on("unhandledRejection", async (reason) => {
  console.error("[WhatsApp Worker] Unhandled rejection:", reason);
  await shutdown();
});

process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
