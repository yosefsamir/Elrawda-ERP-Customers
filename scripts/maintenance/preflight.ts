import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require=createRequire(import.meta.url);
const Database=require("better-sqlite3");
new Database(":memory:").close();
const puppeteer=require(require.resolve("puppeteer",{paths:[require.resolve("whatsapp-web.js")]}));
if (!existsSync(process.env.WHATSAPP_CHROME_PATH || await puppeteer.executablePath())) throw new Error("Chromium is missing. Re-run dependency installation with the shared PUPPETEER_CACHE_DIR.");
console.log(JSON.stringify({ok:true,platform:process.platform,arch:process.arch,node:process.versions.node}));
