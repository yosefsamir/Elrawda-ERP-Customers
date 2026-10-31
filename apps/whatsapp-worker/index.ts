import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

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


      const chromeExec = resolveChromeExecutable();
      const enableSandbox = process.env.CHROME_SANDBOX === "true";
      const puppeteerArgs = [
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-gpu",
      ];
      if (!enableSandbox) {
        // Under Windows SYSTEM (Session 0) service account, Chromium cannot create a sandboxed token
        // without WinLocalSystemSid privilege failure. Setting CHROME_SANDBOX=true enables sandbox
        // when running under an interactive user or dedicated unprivileged account.
        puppeteerArgs.unshift("--no-sandbox");
      }

      client = new Client({
        authStrategy: new LocalAuth({
          clientId: companyId,
          dataPath: authDataPath,
        }),
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

      void client
        .initialize()
        .catch(async (err: any) => {
          console.error("WhatsApp client initialization failed:", err);
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
    if (client) {
      await client.destroy();
    }
    if (companyId) {
      const authDataPath = resolve(process.env.EMOJI_DATA_DIR!, "whatsapp-auth");
      const sessionDir = resolve(authDataPath, `session-${companyId}`);

    }
  } catch {
    // Ignore errors during shutdown
  } finally {
    process.exit(0);
  }
}

process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
