import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import type { AppDatabase } from "../../../packages/storage/database.js";

const require = createRequire(import.meta.url);

export const DEFAULT_IMAGE_PROMPT =
  "Create a professional e-commerce studio catalog photo of the exact product shown: completely unfold, smooth out, and stage the full item upright in a centered front-facing flat-lay view showing the complete garment silhouette, collar, torso, hem, and both sleeves fully extended and clearly visible (if sleeved). Keep exact product colors, fabric/material texture, stitching, logos, and design unchanged, isolated on a clean neutral studio background with balanced natural lighting and crisp focus, outputting only the edited high-resolution image.";

export interface ImageProcessingConfig {
  prompt: string;
  geminiUrl: string;
  profileRoot: string;
  profileDir: string;
  headless: boolean;
  navigationTimeoutMs: number;
  uploadTimeoutMs: number;
  generationTimeoutMs: number;
  downloadTimeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  rateLimitBackoffMs: number;
  pollIntervalMs: number;
  jobCooldownMs: number;
  tempChatEnabled: boolean;
  keepChats: boolean;
  workerEnabled: boolean;
}

interface FileConfig {
  prompt?: string;
  geminiUrl?: string;
  navigationTimeoutMs?: number;
  uploadTimeoutMs?: number;
  generationTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  rateLimitBackoffMs?: number;
  pollIntervalMs?: number;
  jobCooldownMs?: number;
  tempChatEnabled?: boolean;
  keepChats?: boolean;
}

function readJsonConfig(dataDir: string, root: string): FileConfig {
  const candidates = [
    process.env.GEMINI_CONFIG_FILE ? resolve(process.env.GEMINI_CONFIG_FILE) : "",
    resolve(dataDir, "image-processing.json"),
    resolve(root, "config", "image-processing.json"),
  ].filter(Boolean);

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") return parsed as FileConfig;
    } catch {}
  }
  return {};
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Returns whether automatic Gemini image processing is enabled in portal_settings.
 */
export function isImageProcessingEnabled(db?: AppDatabase): boolean {
  if (!db) return true;
  try {
    const row = db.prepare("SELECT image_processing_enabled FROM portal_settings WHERE id=1").get() as
      | { image_processing_enabled?: number | null }
      | undefined;
    if (row && row.image_processing_enabled !== undefined && row.image_processing_enabled !== null) {
      return Boolean(row.image_processing_enabled);
    }
  } catch {}
  return true;
}

export interface ProductPromptContext {
  kind?: string | null;
  category?: string | null;
  description?: string | null;
}

const IGNORED_DESC_PREFIXES = new Set([
  "ايموجي",
  "emoji",
  "قديم",
  "جديد",
  "الموسم",
  "شتوي",
  "صيفي",
]);

const COMPOUND_LEAD_PREFIXES = new Set([
  "نص",
  "نصف",
  "دابل",
  "دبل",
  "هاف",
  "اندر",
  "تي",
  "سويت",
  "بوي",
]);

const GENERIC_KINDS = new Set(["عام", "all", "تام"]);
const GENERIC_CATEGORIES = new Set(["خاص", "عام", "all", "مستورد"]);
const SIZE_CODE_REGEX = /^(?:x{0,3}s|m|l|x{1,4}l|[0-9]+xl)$/i;

function normalizeArabicToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, "");
}

function isNoiseDescToken(token: string): boolean {
  const norm = normalizeArabicToken(token);
  if (!norm || norm.length <= 1) return true;
  if (/^\d+$/.test(norm) || SIZE_CODE_REGEX.test(token)) return true;
  return IGNORED_DESC_PREFIXES.has(norm);
}

function extractDescriptionLeadWord(description?: string | null): string {
  if (!description) return "";
  // Strip bracketed status prefixes like "( قديم )" and split on punctuation/whitespace.
  const cleaned = description
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  const tokens = cleaned.split(" ").filter((t) => !isNoiseDescToken(t));
  if (tokens.length === 0) return "";

  const first = tokens[0]!;
  const firstNorm = normalizeArabicToken(first);
  if (COMPOUND_LEAD_PREFIXES.has(firstNorm) && tokens.length > 1) {
    return `${first} ${tokens[1]!}`;
  }
  return first;
}

/**
 * Extracts a concise AI-friendly product type hint from ERP hierarchy fields
 * (kind + category + cleaned first word(s) from description), ignoring section (`name`).
 */
export function extractProductTypeHint(product?: ProductPromptContext | null): string {
  if (!product) return "";
  const rawKind = (product.kind ?? "").trim().replace(/\s+/g, " ");
  const rawCategory = (product.category ?? "").trim().replace(/\s+/g, " ");
  const descLead = extractDescriptionLeadWord(product.description);

  const kind = rawKind && !GENERIC_KINDS.has(normalizeArabicToken(rawKind)) ? rawKind : "";
  const category =
    rawCategory && !GENERIC_CATEGORIES.has(normalizeArabicToken(rawCategory)) ? rawCategory : "";

  const chosen: string[] = [];
  const chosenNorm: string[] = [];
  const pushUnique = (value: string) => {
    if (!value) return;
    const norm = normalizeArabicToken(value);
    if (!norm) return;
    if (chosenNorm.some((existing) => existing === norm || existing.includes(norm))) return;
    chosen.push(value);
    chosenNorm.push(norm);
  };

  pushUnique(kind);
  pushUnique(category);
  pushUnique(descLead);

  // Fall back to raw category only if nothing else produced a concrete hint.
  if (chosen.length === 0 && rawCategory && !GENERIC_KINDS.has(normalizeArabicToken(rawCategory))) {
    pushUnique(rawCategory);
  }

  return chosen.join(" — ");
}

/**
 * Injects catalog product type context into the configured image-editing prompt.
 */
export function buildImagePromptForProduct(
  basePrompt: string,
  product?: ProductPromptContext | null,
): string {
  const hint = extractProductTypeHint(product);
  if (!hint) {
    return basePrompt.replace(/\{\{\s*product\s*\}\}|\{\s*product\s*\}/gi, "").trim();
  }
  if (/\{\{\s*product\s*\}\}|\{\s*product\s*\}/i.test(basePrompt)) {
    return basePrompt.replace(/\{\{\s*product\s*\}\}|\{\s*product\s*\}/gi, hint).trim();
  }
  return (
    `${basePrompt}\n\n` +
    `Catalog item type context: "${hint}" (use this only as background context to recognize what kind of product is visibly shown in the uploaded image; prioritize strict visual fidelity to the photographed item — never replace an unrelated object or invent unseen extra pieces like pants if only a top is pictured, and do not add mismatched parts such as sleeves on pants, vests, footwear, caps, bags, or belts).`
  );
}

/**
 * Resolves the active image-editing prompt from DB settings, env var, config file, or default.
 */
export function getConfiguredImagePrompt(db?: AppDatabase, dataDir?: string, root?: string): string {
  if (db) {
    try {
      const row = db.prepare("SELECT image_prompt FROM portal_settings WHERE id=1").get() as
        | { image_prompt?: string | null }
        | undefined;
      if (row?.image_prompt && row.image_prompt.trim()) {
        return row.image_prompt.trim();
      }
    } catch {}
  }
  if (process.env.GEMINI_IMAGE_PROMPT && process.env.GEMINI_IMAGE_PROMPT.trim()) {
    return process.env.GEMINI_IMAGE_PROMPT.trim();
  }
  if (dataDir && root) {
    const fileCfg = readJsonConfig(dataDir, root);
    if (typeof fileCfg.prompt === "string" && fileCfg.prompt.trim()) {
      return fileCfg.prompt.trim();
    }
  }
  return DEFAULT_IMAGE_PROMPT;
}

export function getImageProcessingConfig(options: {
  db?: AppDatabase;
  dataDir: string;
  root: string;
}): ImageProcessingConfig {
  const fileCfg = readJsonConfig(options.dataDir, options.root);
  const profileRoot = resolve(
    process.env.GEMINI_PROFILE_DIR ?? resolve(options.dataDir, "gemini-auth"),
  );
  return {
    prompt: getConfiguredImagePrompt(options.db, options.dataDir, options.root),
    geminiUrl: process.env.GEMINI_WEB_URL || fileCfg.geminiUrl || "https://gemini.google.com/app",
    profileRoot,
    profileDir: join(profileRoot, "profile"),
    headless: true,
    navigationTimeoutMs: positiveInt(process.env.GEMINI_NAV_TIMEOUT_MS, fileCfg.navigationTimeoutMs ?? 30_000),
    uploadTimeoutMs: positiveInt(process.env.GEMINI_UPLOAD_TIMEOUT_MS, fileCfg.uploadTimeoutMs ?? 30_000),
    generationTimeoutMs: positiveInt(process.env.GEMINI_GENERATION_TIMEOUT_MS, fileCfg.generationTimeoutMs ?? 150_000),
    downloadTimeoutMs: positiveInt(process.env.GEMINI_DOWNLOAD_TIMEOUT_MS, fileCfg.downloadTimeoutMs ?? 45_000),
    maxRetries: positiveInt(process.env.GEMINI_MAX_RETRIES, fileCfg.maxRetries ?? 5),
    baseBackoffMs: positiveInt(process.env.GEMINI_BASE_BACKOFF_MS, fileCfg.baseBackoffMs ?? 20_000),
    maxBackoffMs: positiveInt(process.env.GEMINI_MAX_BACKOFF_MS, fileCfg.maxBackoffMs ?? 300_000),
    rateLimitBackoffMs: positiveInt(process.env.GEMINI_RATE_LIMIT_BACKOFF_MS, fileCfg.rateLimitBackoffMs ?? 600_000),
    pollIntervalMs: positiveInt(process.env.GEMINI_WORKER_POLL_MS, fileCfg.pollIntervalMs ?? 2500),
    jobCooldownMs: nonNegativeInt(process.env.GEMINI_JOB_COOLDOWN_MS, fileCfg.jobCooldownMs ?? 35_000),
    tempChatEnabled: process.env.GEMINI_TEMP_CHAT !== "0" && (fileCfg.tempChatEnabled ?? true),
    keepChats: process.env.GEMINI_KEEP_CHATS === "1" || (fileCfg.keepChats ?? false),
    workerEnabled: process.env.GEMINI_WORKER_DISABLED !== "1",
  };
}

function findBinaryInDir(dir: string, binaryName: string): string | null {
  if (!existsSync(dir)) return null;
  const direct = join(dir, binaryName);
  if (existsSync(direct)) return direct;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    try {
      for (const entry of readdirSync(current)) {
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

/**
 * Resolves a Chromium/Chrome executable across Playwright cache, packaged runtime, Puppeteer cache, or OS install.
 */
export function resolveChromiumExecutable(root = process.cwd()): string | undefined {
  for (const envPath of [process.env.GEMINI_CHROME_PATH, process.env.WHATSAPP_CHROME_PATH]) {
    if (envPath && existsSync(envPath)) return envPath;
  }

  try {
    const pwDefault = chromium.executablePath();
    if (pwDefault && existsSync(pwDefault)) return pwDefault;
  } catch {}

  const binaryName = process.platform === "win32" ? "chrome.exe" : "chrome";

  // Check packaged Windows runtime
  const bundled = findBinaryInDir(join(resolve(root), "runtime", "chromium"), binaryName);
  if (bundled && existsSync(bundled)) return bundled;

  // Check Playwright browser cache for any installed chromium-* revision (excluding headless-shell for interactive login)
  const pwCacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  if (existsSync(pwCacheRoot)) {
    try {
      const dirs = readdirSync(pwCacheRoot)
        .filter((name) => name.startsWith("chromium-"))
        .sort()
        .reverse();
      for (const dir of dirs) {
        const candidate = findBinaryInDir(join(pwCacheRoot, dir), binaryName);
        if (candidate && existsSync(candidate)) return candidate;
      }
    } catch {}
  }

  // Fallback to Puppeteer cache (already present in repo dependencies)
  try {
    const puppeteer = require("puppeteer");
    const puppPath = puppeteer.executablePath?.();
    if (puppPath && existsSync(puppPath)) return puppPath;
  } catch {}

  const osCandidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  for (const candidate of osCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}
