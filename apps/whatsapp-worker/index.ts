import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { WhatsAppSession } from "./session.js";
import { reliableWhatsAppClasses } from "./reliable-client.js";
import { errorCode, whatsappLog } from "../../packages/runtime/whatsapp-log.js";

const require = createRequire(import.meta.url);
const { Client, LocalAuth } = require("whatsapp-web.js");
const version = require("whatsapp-web.js/package.json").version;
if (version !== "1.34.7") throw new Error("Review the WhatsApp lifecycle adapter before changing whatsapp-web.js");
const { ReliableClient, PersistentAuth } = reliableWhatsAppClasses(Client, LocalAuth);
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


let stopping = false;
let shutdownPromise: Promise<void> | undefined;
const session = new WhatsAppSession({
  dataDir: process.env.EMOJI_DATA_DIR!,
  createClient: profile => {
    const chromeExec = resolveChromeExecutable();
    const args = ["--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-accelerated-2d-canvas", "--no-first-run", "--disable-gpu"];
    if (process.env.CHROME_NO_SANDBOX === "true") args.unshift("--no-sandbox");
    return new ReliableClient({
      authStrategy: new PersistentAuth({ clientId: profile.companyId, dataPath: profile.root }),
      webVersionCache: { type: "local", path: resolve(process.env.PUPPETEER_CACHE_DIR || resolve(process.env.EMOJI_DATA_DIR!, "..", "cache"), "wwebjs_cache") },
      authTimeoutMs: 30000,
      puppeteer: { headless: true, protocolTimeout: 30000, args, ...(chromeExec ? { executablePath: chromeExec } : {}) },
    });
  },
  qr: value => QRCode.toDataURL(value),
  publish: state => { if (process.connected) process.send?.({ type: "state", state }); },
  fatal: error => { whatsappLog("fatal_cleanup", { errorCode: errorCode(error) }); void shutdown(1); },
});

let commandQueue = Promise.resolve();
process.on("message", (message: any) => {
  // Shutdown bypasses long-running business commands and invalidates pending init immediately.
  if (message.action === "shutdown") { void shutdown(); return; }
  commandQueue = commandQueue.then(() => handleMessage(message)).catch(error => {
    whatsappLog("command_queue_failure", { errorCode: errorCode(error) });
    void shutdown(1);
  });
});
async function handleMessage(message: any) {
  try {
    if (stopping) throw new Error("WhatsApp worker is stopping");
    const { id, action, payload } = message;
    let result: any;
    if (action === "connect") result = await session.connect(message.companyId, !payload?.automatic);
    else if (action === "disconnect") result = await session.disconnect();
    else {
      if (session.state.companyId !== message.companyId || session.state.status !== "ready") throw new Error("WhatsApp client is not ready. Please connect first.");
      const client = session.client;
      const pilot = createPilotClient(client);
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
    if (process.connected) process.send?.({ id, result });
  } catch (error) {
    whatsappLog("command_failed", { action: message.action, errorCode: errorCode(error) });
    if (process.connected) process.send?.({ id: message.id, error: error instanceof Error ? error.message : "Operation execution failed" });
  }
}

function shutdown(code = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    whatsappLog("worker_shutdown", { workerPid: process.pid, code });
    const timeout = setTimeout(() => process.exit(1), 35000);
    try { await session.stop(); }
    catch (error) { code = 1; whatsappLog("shutdown_incomplete", { errorCode: errorCode(error) }); }
    finally { clearTimeout(timeout); process.exit(code); }
  })();
  return shutdownPromise;
}
process.on("uncaughtException", error => { whatsappLog("uncaught_exception", { errorCode: errorCode(error) }); void shutdown(1); });
process.on("unhandledRejection", error => { whatsappLog("unhandled_rejection", { errorCode: errorCode(error) }); void shutdown(1); });
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
