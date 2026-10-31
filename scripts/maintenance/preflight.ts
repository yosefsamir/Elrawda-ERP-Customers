import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// 1. Verify better-sqlite3 loading and read/write operations
try {
  const db = new Database(":memory:");
  db.prepare("CREATE TABLE _preflight_test (id INTEGER PRIMARY KEY, val TEXT)").run();
  db.prepare("INSERT INTO _preflight_test (id, val) VALUES (1, 'ok')").run();
  const row = db.prepare("SELECT val FROM _preflight_test WHERE id = 1").get() as { val: string } | undefined;
  if (!row || row.val !== "ok") {
    throw new Error("better-sqlite3 read/write query returned unexpected result");
  }
  db.close();
} catch (err: any) {
  throw new Error(`better-sqlite3 verification failed: ${err.message}`);
}

// 2. Resolve Chromium executable path
const puppeteer = require(require.resolve("puppeteer", { paths: [require.resolve("whatsapp-web.js")] }));

function findChromiumInDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const isWin = process.platform === "win32";
  const binaryName = isWin ? "chrome.exe" : "chrome";

  const direct = join(dir, binaryName);
  if (existsSync(direct)) return direct;

  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    try {
      const entries = readdirSync(current);
      for (const entry of entries) {
        const full = join(current, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            stack.push(full);
          } else if (entry.toLowerCase() === binaryName.toLowerCase()) {
            return full;
          }
        } catch {}
      }
    } catch {}
  }
  return null;
}

let chromePath = process.env.WHATSAPP_CHROME_PATH;
if (!chromePath || !existsSync(chromePath)) {
  // Check runtime/chromium relative to current app root
  const root = resolve(process.env.EMOJI_APP_ROOT ?? process.cwd());
  const bundled = findChromiumInDir(join(root, "runtime", "chromium"));
  if (bundled && existsSync(bundled)) {
    chromePath = bundled;
  }
}

if (!chromePath || !existsSync(chromePath)) {
  try {
    const defaultPath = await puppeteer.executablePath();
    if (defaultPath && existsSync(defaultPath)) {
      chromePath = defaultPath;
    }
  } catch {}
}

if (!chromePath || !existsSync(chromePath)) {
  throw new Error(
    "Chromium is missing or could not be located in packaged runtime. Ensure WHATSAPP_CHROME_PATH or runtime/chromium is configured."
  );
}

// 3. Verify Chromium can actually launch in headless mode
let chromeVersion = "unknown";
try {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--disable-accelerated-2d-canvas",
    ],
  });
  chromeVersion = await browser.version();
  await browser.close();
} catch (err: any) {
  throw new Error(`Failed to launch Chromium at ${chromePath}: ${err.message}`);
}

console.log(
  JSON.stringify({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    chromium: chromeVersion,
    chromePath,
  })
);
