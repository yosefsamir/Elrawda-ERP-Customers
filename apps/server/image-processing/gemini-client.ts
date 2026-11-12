import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type FileChooser, type Locator, type Page } from "playwright";
import sharp from "sharp";
import { resolveChromiumExecutable, type ImageProcessingConfig } from "./config.js";
import {
  GeminiProfileLock,
  type GeminiEncryptedAuthSnapshot,
  getSyncedStorageStateTimestamp,
  loadEncryptedGeminiStorageState,
  markGeminiAuthenticated,
  markGeminiReauthRequired,
  markStorageStateSynced,
  saveEncryptedGeminiStorageState,
} from "./profile.js";
import { validateAndNormalizeImage } from "./storage.js";

export type GeminiErrorCode =
  | "REAUTH_REQUIRED"
  | "CAPTCHA_OR_CHALLENGE"
  | "RATE_LIMITED"
  | "POLICY_REJECTED"
  | "INVALID_SOURCE_IMAGE"
  | "TIMEOUT"
  | "INVALID_OUTPUT"
  | "TRANSIENT_FAILURE";

export class GeminiAutomationError extends Error {
  constructor(
    public readonly code: GeminiErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GeminiAutomationError";
  }
}

export interface ProcessImageRequest {
  jobId: string;
  sourceImagePath: string;
  prompt: string;
}

export interface ProcessImageResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
}

export interface ImageProcessor {
  process(request: ProcessImageRequest): Promise<ProcessImageResult>;
  close?(): Promise<void>;
}

const UPLOAD_TRIGGER_SELECTOR = [
  'button[aria-label="Upload & tools"]',
  'button[aria-label*="Upload" i]',
  'button[aria-label*="Add files" i]',
  'button[aria-label*="التحميل"]',
  'button[aria-label*="إضافة ملف"]',
].join(", ");

const PROMPT_INPUT_SELECTOR = [
  'div[role="textbox"][aria-label*="prompt" i]',
  'div[role="textbox"][contenteditable="true"]',
  'rich-textarea [contenteditable="true"]',
  'div[role="textbox"]',
  "textarea",
].join(", ");

const SEND_BUTTON_SELECTOR = [
  'button[aria-label*="Send" i]',
  'button[aria-label*="Submit" i]',
  'button[aria-label*="إرسال"]',
  'button.send-button',
].join(", ");

const STOP_BUTTON_SELECTOR = [
  'button[aria-label*="Stop" i]',
  'button[aria-label*="إيقاف"]',
].join(", ");

const RESPONSE_CONTAINER_SELECTOR = [
  "model-response",
  '[data-message-author-role="model"]',
  '[data-test-id="model-response"]',
  ".model-response",
].join(", ");

const DOWNLOAD_BUTTON_SELECTOR = [
  'button[aria-label*="Download" i]',
  'a[aria-label*="Download" i]',
  'button[mattooltip*="Download" i]',
  'button[aria-label*="تنزيل"]',
  'button[aria-label*="تحميل"]',
  "a[download]",
].join(", ");

const SIGN_IN_TEXT_PATTERN = /^(Sign in|تسجيل الدخول)$/i;

const SIGN_IN_ATTR_SELECTOR = [
  'a[data-test-id="sidenav-error-action-link"]',
  'a[href*="accounts.google.com/ServiceLogin"]',
  'a[href*="accounts.google.com/signin"]',
  'a[aria-label="Sign in" i]',
  'a[aria-label="تسجيل الدخول"]',
  'button[aria-label="Sign in" i]',
  'button[aria-label="تسجيل الدخول"]',
].join(", ");

const GOOGLE_AUTH_COOKIE_NAMES = new Set([
  "SID",
  "HSID",
  "SSID",
  "SAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
]);

function isGoogleOriginUrl(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    return hostname === "google.com" || hostname.endsWith(".google.com");
  } catch {
    return false;
  }
}

async function hasGoogleAuthCookies(context: BrowserContext, targetUrl: string): Promise<boolean> {
  const cookies = await context
    .cookies(["https://google.com", "https://gemini.google.com", targetUrl])
    .catch(() => []);
  const nowSec = Date.now() / 1000;
  return cookies.some(
    (cookie) =>
      GOOGLE_AUTH_COOKIE_NAMES.has(cookie.name) &&
      Boolean(cookie.value) &&
      (cookie.expires === -1 || cookie.expires > nowSec),
  );
}

function isAuthOrChallengeUrl(url: string): "reauth" | "captcha" | null {
  const lower = url.toLowerCase();
  if (lower.includes("/sorry/") || lower.includes("recaptcha") || lower.includes("captcha")) {
    return "captcha";
  }
  if (
    lower.includes("accounts.google.com") ||
    lower.includes("servicelogin") ||
    lower.includes("/signin") ||
    lower.includes("/challenge/")
  ) {
    return "reauth";
  }
  return null;
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function findVisibleSignInControl(page: Page): Promise<Locator | null> {
  return (
    (await firstVisible(page.locator("a, button").filter({ hasText: SIGN_IN_TEXT_PATTERN }))) ??
    (await firstVisible(page.locator(SIGN_IN_ATTR_SELECTOR)))
  );
}

/**
 * Checks whether the current OS process runs in an interactive desktop session capable of showing Chrome UI.
 */
export function canLaunchInteractiveBrowser(): { supported: boolean; reason?: string } {
  if (process.platform === "win32") {
    const session = (process.env.SESSIONNAME ?? "").trim().toLowerCase();
    const user = (process.env.USERNAME ?? "").trim().toUpperCase();
    if (
      session === "services" ||
      (!session && (user === "LOCAL SERVICE" || user === "NETWORK SERVICE" || user === "SYSTEM" || user.endsWith("$")))
    ) {
      return {
        supported: false,
        reason:
          "الخادم يعمل حاليًا كخدمة نظام معزولة في Windows (Session 0 / LOCAL SERVICE) لا تسمح بعرض نافذة متصفح على الشاشة منه. افتح «Gemini Web Login» من قائمة ابدأ (Start Menu) أو شغّل gemini-login.bat كمسؤول على سطح المكتب، وسيتم حفظ الجلسة ومزامنتها تلقائيًا مع الخدمة.",
      };
    }
    return { supported: true };
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return {
      supported: false,
      reason: "لا توجد بيئة عرض رسومية (DISPLAY / WAYLAND_DISPLAY) متاحة على هذا الخادم لفتح نافذة المتصفح.",
    };
  }
  return { supported: true };
}

const DIALOG_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  "mat-dialog-container",
  ".lumi-dialog",
  ".cdk-overlay-pane",
].join(", ");

const CONSENT_ACCEPT_PATTERN =
  /^(Agree|I agree|Accept|Accept all|Got it|Continue|OK|Okay|Done|Understood|Understand|Allow|Turn on|Enable|Confirm|Start|Next|موافق|أوافق|قبول|حسنًا|حسناً|متابعة|فهمت|تم|التالي|تشغيل|تفعيل)$/i;

const CONSENT_DISMISS_PATTERN =
  /^(Dismiss|Not now|No thanks|No, thanks|Maybe later|Later|Skip|Skip for now|Close|Cancel|Decline|Reject|No|تجاهل|ليس الآن|لاحقًا|لاحقا|إغلاق|تخطي|لا شكرًا|لا شكرا|إلغاء|رفض)$/i;

const DANGEROUS_BUTTON_PATTERN =
  /upgrade|subscribe|get .* plus|try .* pro|learn more|terms|privacy|sign in|log in|ترقية|اشتراك|تسجيل الدخول/i;

function normalizeDesktopUserAgent(userAgent?: string | null): string | undefined {
  if (!userAgent) return undefined;
  const normalized = userAgent.replace(/\bHeadlessChrome\//g, "Chrome/").trim();
  return normalized || undefined;
}

async function applyEncryptedStorageStateToContext(
  context: BrowserContext,
  snapshot: GeminiEncryptedAuthSnapshot,
  log: (event: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  await context.clearCookies();
  const cookies = snapshot.storageState.cookies.filter((cookie) => Boolean(cookie.name && cookie.domain));
  if (cookies.length > 0) {
    try {
      await context.addCookies(cookies);
    } catch (error) {
      log("gemini_cookie_batch_fallback", {
        count: cookies.length,
        message: error instanceof Error ? error.message : String(error),
      });
      for (const cookie of cookies) {
        await context.addCookies([cookie]).catch(() => {});
      }
    }
  }

  const origins = snapshot.storageState.origins.filter(
    (entry) =>
      (entry.origin.startsWith("https://") || entry.origin.startsWith("http://")) &&
      Array.isArray(entry.localStorage) &&
      entry.localStorage.length > 0,
  );
  if (origins.length === 0) return;

  const seedPage = await context.newPage();
  let activeOrigin = "";
  try {
    await seedPage.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      if (activeOrigin && (reqUrl === activeOrigin || reqUrl === `${activeOrigin}/`)) {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body></body></html>",
        });
        return;
      }
      await route.abort();
    });

    for (const entry of origins) {
      activeOrigin = entry.origin.replace(/\/+$/, "");
      try {
        await seedPage.goto(activeOrigin, { waitUntil: "domcontentloaded", timeout: 10_000 });
        await seedPage.evaluate((items) => {
          const storage = (globalThis as any).localStorage;
          storage.clear();
          for (const item of items) {
            storage.setItem(item.name, item.value);
          }
        }, entry.localStorage);
      } catch (error) {
        log("gemini_origin_seed_failed", {
          origin: activeOrigin,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await seedPage.close().catch(() => {});
  }
}

/**
 * Automates Gemini Web via Playwright Chromium using a persistent authenticated profile.
 */
export class GeminiBrowserClient implements ImageProcessor {
  private context: BrowserContext | null = null;
  private lock: GeminiProfileLock | null = null;

  constructor(
    private readonly config: ImageProcessingConfig,
    private readonly root: string,
    private readonly log: (event: string, fields?: Record<string, unknown>) => void = () => {},
  ) {}

  private async ensureContext(tempDownloadDir: string): Promise<BrowserContext> {
    const snapshot = loadEncryptedGeminiStorageState(this.config.profileRoot, this.config.dataDir);
    const syncedAt = getSyncedStorageStateTimestamp(this.config.profileRoot);
    const needsSync = Boolean(snapshot && snapshot.savedAt !== syncedAt);

    if (this.context && !needsSync) return this.context;
    if (this.context && needsSync) {
      await this.close();
    }

    this.lock = new GeminiProfileLock(this.config.profileRoot);
    try {
      await this.lock.prepare();
      const executablePath = resolveChromiumExecutable(this.root);
      const userAgent = normalizeDesktopUserAgent(snapshot?.userAgent);
      this.context = await chromium.launchPersistentContext(this.config.profileDir, {
        ...(executablePath ? { executablePath } : {}),
        headless: true,
        acceptDownloads: true,
        downloadsPath: tempDownloadDir,
        viewport: { width: 1366, height: 900 },
        ...(userAgent ? { userAgent } : {}),
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--disable-blink-features=AutomationControlled",
        ],
      });
      if (snapshot && needsSync) {
        await applyEncryptedStorageStateToContext(this.context, snapshot, this.log);
        markStorageStateSynced(this.config.profileRoot, snapshot.savedAt);
        this.log("gemini_storage_state_synced", {
          savedAt: snapshot.savedAt,
          cookies: snapshot.storageState.cookies.length,
          origins: snapshot.storageState.origins.length,
        });
      }
      return this.context;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    try {
      if (ctx) await ctx.close();
    } finally {
      this.lock?.release();
      this.lock = null;
    }
  }

  private async checkPageAccess(page: Page): Promise<void> {
    const urlKind = isAuthOrChallengeUrl(page.url());
    if (urlKind === "captcha") {
      markGeminiReauthRequired(this.config.profileRoot, "CAPTCHA_OR_CHALLENGE");
      throw new GeminiAutomationError(
        "CAPTCHA_OR_CHALLENGE",
        "توقف التحقق لأن موقع Gemini طلب حل CAPTCHA أو تحدي أمان؛ افتح الجلسة يدويًا عبر أمر تسجيل الدخول.",
        false,
      );
    }
    if (urlKind === "reauth") {
      markGeminiReauthRequired(this.config.profileRoot, "REAUTH_REQUIRED");
      throw new GeminiAutomationError(
        "REAUTH_REQUIRED",
        "انتهت جلسة تسجيل الدخول في Gemini Web؛ شغّل أمر تسجيل الدخول التفاعلي من الخادم.",
        false,
      );
    }

    const challengeFrame = await firstVisible(
      page.locator('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], #captcha-form'),
    );
    if (challengeFrame) {
      markGeminiReauthRequired(this.config.profileRoot, "CAPTCHA_OR_CHALLENGE");
      throw new GeminiAutomationError(
        "CAPTCHA_OR_CHALLENGE",
        "توقف التحقق لأن صفحة Gemini تعرض تحدي تحقق أمني.",
        false,
      );
    }

    const signInButton = await findVisibleSignInControl(page);
    if (signInButton) {
      markGeminiReauthRequired(this.config.profileRoot, "REAUTH_REQUIRED");
      throw new GeminiAutomationError(
        "REAUTH_REQUIRED",
        "جلسة Gemini Web غير مسجلة الدخول؛ شغّل أمر تسجيل الدخول التفاعلي أولًا.",
        false,
      );
    }

    if (isGoogleOriginUrl(page.url()) && !(await hasGoogleAuthCookies(page.context(), page.url()))) {
      markGeminiReauthRequired(this.config.profileRoot, "REAUTH_REQUIRED");
      throw new GeminiAutomationError(
        "REAUTH_REQUIRED",
        "لا توجد جلسة Google نشطة في Gemini Web؛ شغّل أمر تسجيل الدخول التفاعلي أولًا.",
        false,
      );
    }
  }

  private async dismissConsentDialogs(page: Page): Promise<boolean> {
    let dismissedAny = false;
    for (let round = 0; round < 5; round++) {
      let actedInRound = false;
      const overlays = page.locator(DIALOG_OVERLAY_SELECTOR);
      const count = await overlays.count().catch(() => 0);

      for (let i = count - 1; i >= 0; i--) {
        const dialog = overlays.nth(i);
        if (!(await dialog.isVisible().catch(() => false))) continue;

        const hasButtons = (await dialog.locator("button").count().catch(() => 0)) > 0;
        if (!hasButtons) continue;

        const text = (await dialog.innerText().catch(() => "")) || "";
        if (
          /sign in|تسجيل الدخول/i.test(text) &&
          !/creating content from images|prohibited use policy|mmgen/i.test(text)
        ) {
          continue;
        }

        const candidateLocators = [
          dialog.locator("button").filter({ hasText: CONSENT_ACCEPT_PATTERN }),
          dialog.locator("button").filter({ hasText: CONSENT_DISMISS_PATTERN }),
          dialog.locator(
            'button[aria-label^="Agree" i], button[aria-label^="Accept" i], button[aria-label^="Got it" i], button[aria-label^="Dismiss" i], button[aria-label*="close" i], button[aria-label*="skip" i], button[data-test-id*="close" i], button[data-test-id*="dismiss" i], button[aria-label*="موافق"], button[aria-label*="أوافق"], button[aria-label*="إغلاق"], button[aria-label*="تجاهل"]',
          ),
          dialog.locator("button").filter({ hasText: /^(close|clear|×|✕)$/i }),
        ];

        let targetBtn: Locator | null = null;
        for (const group of candidateLocators) {
          const btnCount = await group.count().catch(() => 0);
          for (let b = 0; b < btnCount; b++) {
            const btn = group.nth(b);
            if (!(await btn.isVisible().catch(() => false))) continue;
            if (await btn.isDisabled().catch(() => false)) continue;
            const label = ((await btn.innerText().catch(() => "")) || (await btn.getAttribute("aria-label").catch(() => "")) || "").trim();
            if (label && DANGEROUS_BUTTON_PATTERN.test(label)) continue;
            targetBtn = btn;
            break;
          }
          if (targetBtn) break;
        }

        if (targetBtn) {
          await targetBtn.click({ timeout: 3000 }).catch(() => {});
          dismissedAny = true;
          actedInRound = true;
          await page
            .locator(".cdk-overlay-dark-backdrop.cdk-overlay-backdrop-showing, [role='dialog']")
            .first()
            .waitFor({ state: "hidden", timeout: 3500 })
            .catch(() => {});
          break;
        }
      }

      if (!actedInRound) {
        const hasBlockingOverlay = await page
          .locator('.cdk-overlay-dark-backdrop.cdk-overlay-backdrop-showing, [role="dialog"]:visible, mat-dialog-container:visible')
          .first()
          .isVisible()
          .catch(() => false);
        if (hasBlockingOverlay) {
          const signInVisible = Boolean(await findVisibleSignInControl(page));
          if (!signInVisible) {
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(350);
            const stillVisible = await page
              .locator('.cdk-overlay-dark-backdrop.cdk-overlay-backdrop-showing, [role="dialog"]:visible, mat-dialog-container:visible')
              .first()
              .isVisible()
              .catch(() => false);
            if (!stillVisible) {
              dismissedAny = true;
              continue;
            }
          }
        }
        break;
      }
    }
    return dismissedAny;
  }

  private async clickCleanly(page: Page, locator: Locator, timeoutMs: number): Promise<void> {
    await this.dismissConsentDialogs(page);
    try {
      await locator.click({ timeout: Math.min(timeoutMs, 4500) });
      return;
    } catch (error) {
      const dismissed = await this.dismissConsentDialogs(page);
      if (!dismissed) {
        const hasBackdrop = await page
          .locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing")
          .first()
          .isVisible()
          .catch(() => false);
        if (hasBackdrop && !(await findVisibleSignInControl(page))) {
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(300);
        } else {
          throw error;
        }
      }
      await locator.click({ timeout: timeoutMs });
    }
  }

  private async enableTemporaryChat(page: Page): Promise<boolean> {
    if (!this.config.tempChatEnabled) return false;
    try {
      const tempSelector =
        '[data-test-id="temp-chat-button-container"] button, button[aria-label*="temporary chat" i], button[aria-label*="محادثة مؤقتة"]';
      const openSidebarSelector =
        'button[aria-label*="Open sidebar" i], button[aria-label*="Open menu" i], button[aria-label*="فتح القائمة"]';
      const closeSidebarSelector = 'button[aria-label*="Close sidebar" i], button[aria-label*="إغلاق القائمة"]';

      // The temp-chat header button hydrates slightly after the prompt textbox appears.
      await page
        .locator(tempSelector)
        .filter({ visible: true })
        .first()
        .waitFor({ state: "visible", timeout: 4500 })
        .catch(() => {});

      let tempBtn = await firstVisible(page.locator(tempSelector));
      let openedSidebar = false;

      if (!tempBtn) {
        const openSidebarBtn = await firstVisible(page.locator(openSidebarSelector));
        if (openSidebarBtn) {
          await this.clickCleanly(page, openSidebarBtn, 3000).catch(() => {});
          openedSidebar = true;
          await page
            .locator(tempSelector)
            .filter({ visible: true })
            .first()
            .waitFor({ state: "visible", timeout: 3000 })
            .catch(() => {});
          tempBtn = await firstVisible(page.locator(tempSelector));
        }
      }

      if (!tempBtn) {
        if (openedSidebar) {
          const closeSidebarBtn = await firstVisible(page.locator(closeSidebarSelector));
          await closeSidebarBtn?.click({ timeout: 2000 }).catch(() => {});
        }
        this.log("gemini_temp_chat", { enabled: false, reason: "button_not_visible" });
        return false;
      }

      const isAlreadyOn = async () => {
        const ariaLabel = ((await tempBtn!.getAttribute("aria-label").catch(() => "")) || "").trim();
        const ariaPressed = await tempBtn!.getAttribute("aria-pressed").catch(() => null);
        const hasClass = (await page.locator(".temp-chat-on").count().catch(() => 0)) > 0;
        return ariaPressed === "true" || hasClass || /turn off|إيقاف/i.test(ariaLabel);
      };

      let active = await isAlreadyOn();
      if (!active) {
        await this.clickCleanly(page, tempBtn, 4000);
        await page
          .waitForFunction(
            (sel) => {
              const doc = (globalThis as any).document;
              if (doc.querySelector(".temp-chat-on")) return true;
              const btns = Array.from(doc.querySelectorAll(sel)) as any[];
              return btns.some((btn) => {
                const label = (btn.getAttribute("aria-label") || "").trim();
                const pressed = btn.getAttribute("aria-pressed");
                return pressed === "true" || /turn off|إيقاف/i.test(label);
              });
            },
            tempSelector,
            { timeout: 3500 },
          )
          .catch(() => {});
        active = await isAlreadyOn();
      }

      if (openedSidebar) {
        const closeSidebarBtn = await firstVisible(page.locator(closeSidebarSelector));
        await closeSidebarBtn?.click({ timeout: 2000 }).catch(() => {});
      }

      this.log("gemini_temp_chat", { enabled: active });
      return active;
    } catch (err: any) {
      this.log("gemini_temp_chat", { enabled: false, error: err?.message ?? String(err) });
      return false;
    }
  }

  private async cleanupCreatedChat(page: Page, tempChatActive: boolean): Promise<void> {
    if (this.config.keepChats) return;
    try {
      const match = page.url().match(/\/app\/([A-Za-z0-9_-]{6,})/);
      if (!match) return;
      const chatId = match[1]!;

      const openSidebarBtn = await firstVisible(
        page.locator('button[aria-label*="Open sidebar" i], button[aria-label*="Open menu" i], button[aria-label*="فتح القائمة"]'),
      );
      if (openSidebarBtn) {
        await this.clickCleanly(page, openSidebarBtn, 3000).catch(() => {});
      }

      const chatLink = page.locator(`a[href*="/app/${chatId}"]`).first();
      await chatLink.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
      if (!(await chatLink.isVisible().catch(() => false))) return;

      const convContainer = chatLink.locator("xpath=ancestor::*[@data-test-id='conversation'][1]");
      const hasConvContainer = (await convContainer.count().catch(() => 0)) > 0;
      const rowTarget = hasConvContainer ? convContainer : chatLink.locator("xpath=..");
      await rowTarget.scrollIntoViewIfNeeded().catch(() => {});
      await rowTarget.hover({ timeout: 3000 }).catch(() => {});

      const actionsBtn = rowTarget
        .locator('[data-test-id="actions-menu-button"] button, button[data-test-id="actions-menu-button"], button[aria-label*="More options" i], button[aria-label*="خيارات"]')
        .first();
      await actionsBtn.waitFor({ state: "attached", timeout: 4000 });
      // Trigger DOM click directly so the underlying <a> link cannot intercept pointer events on hover fade-in.
      await actionsBtn.evaluate((el) => (el as any).click());

      const deleteItem = page
        .locator('[data-test-id="delete-button"], [role="menuitem"], .cdk-overlay-pane button')
        .filter({ hasText: /^(Delete|Delete chat|حذف|حذف المحادثة)$/i })
        .first();
      await deleteItem.waitFor({ state: "visible", timeout: 4000 });
      await page.waitForTimeout(200);
      await deleteItem.click({ timeout: 3000 });

      const confirmBtn = page
        .locator('message-dialog button, [role="dialog"] button, mat-dialog-container button')
        .filter({ hasText: /^(Delete|Confirm|حذف|تأكيد)$/i })
        .first();
      await confirmBtn.waitFor({ state: "visible", timeout: 5000 });
      await confirmBtn.click({ timeout: 3000 });
      await chatLink.waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
      this.log("gemini_chat_cleaned_up", { chatId, tempChatActive });
    } catch {
      // Cleanup is strictly best-effort and must never fail a completed image job.
    }
  }

  private async prepareUploadFile(sourceImagePath: string, tempDir: string): Promise<string> {
    if (!existsSync(sourceImagePath)) {
      throw new GeminiAutomationError("INVALID_SOURCE_IMAGE", "ملف الصورة الأصلية غير موجود.", false);
    }
    const raw = await readFile(sourceImagePath);
    try {
      const outPath = join(tempDir, "upload-input.png");
      await sharp(raw, { limitInputPixels: 24_000_000, animated: false }).png().toFile(outPath);
      return outPath;
    } catch {
      throw new GeminiAutomationError("INVALID_SOURCE_IMAGE", "تعذر قراءة الصورة الأصلية كصورة صالحة.", false);
    }
  }

  private async uploadSourceImage(page: Page, uploadPath: string): Promise<void> {
    await this.dismissConsentDialogs(page);
    const trigger = page.locator(UPLOAD_TRIGGER_SELECTOR).first();
    await trigger.waitFor({ state: "visible", timeout: this.config.uploadTimeoutMs });
    await this.clickCleanly(page, trigger, this.config.uploadTimeoutMs);

    await page
      .locator('[role="menuitem"]')
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});

    // Check right after menu opens in case SPA rendered Sign-in state after initial paint.
    await this.checkPageAccess(page);

    const beforePreviews = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      return doc.querySelectorAll(
        'uploader-file-preview, [data-test-id*="image-preview"], [data-test-id*="file-preview"], button[aria-label*="Remove" i], button[aria-label*="إزالة"], img[src^="blob:"], img[src^="data:image/"]',
      ).length as number;
    });

    const menuItem = page
      .locator('[role="menuitem"], button, label')
      .filter({ hasText: /upload files|upload image|تحميل ملف|رفع ملف|رفع صورة/i })
      .first();

    const menuVisible = await menuItem.isVisible().catch(() => false);
    if (menuVisible) {
      const disabled =
        (await menuItem.getAttribute("aria-disabled")) === "true" ||
        (await menuItem.isDisabled().catch(() => false));
      const signInPrompt = await page
        .locator('[role="dialog"], .cdk-overlay-pane, [role="menu"]')
        .filter({ hasText: /sign in to try|تسجيل الدخول/i })
        .first()
        .isVisible()
        .catch(() => false);
      if (disabled || signInPrompt) {
        markGeminiReauthRequired(this.config.profileRoot, "REAUTH_REQUIRED");
        throw new GeminiAutomationError(
          "REAUTH_REQUIRED",
          "الرفع في Gemini Web متوقف لأن الجلسة تحتاج تسجيل دخول بحساب Google.",
          false,
        );
      }

      let fileChooser: FileChooser | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.dismissConsentDialogs(page);
        if (!(await menuItem.isVisible().catch(() => false))) {
          await trigger.click({ timeout: 5000 }).catch(() => {});
          await menuItem.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
        }
        const fileChooserPromise = page
          .waitForEvent("filechooser", { timeout: 6000 })
          .catch(() => null);
        try {
          await menuItem.click({ timeout: 4000 });
          fileChooser = await fileChooserPromise;
          break;
        } catch (error) {
          if (attempt === 0) {
            await this.dismissConsentDialogs(page);
            const hasBackdrop = await page
              .locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing")
              .first()
              .isVisible()
              .catch(() => false);
            if (hasBackdrop && !(await findVisibleSignInControl(page))) {
              await page.keyboard.press("Escape").catch(() => {});
              await page.waitForTimeout(300);
            }
            continue;
          }
          throw error;
        }
      }
      if (fileChooser) {
        await fileChooser.setFiles(uploadPath);
      } else {
        const input = page.locator('input[type="file"]').last();
        await input.waitFor({ state: "attached", timeout: this.config.uploadTimeoutMs });
        await input.setInputFiles(uploadPath);
      }
    } else {
      const input = page.locator('input[type="file"]').last();
      await input.waitFor({ state: "attached", timeout: this.config.uploadTimeoutMs });
      await input.setInputFiles(uploadPath);
    }

    // Wait condition-based until a new attachment preview appears and any upload progress completes.
    await page.waitForFunction(
      (priorCount) => {
        const doc = (globalThis as any).document;
        const previewCount = doc.querySelectorAll(
          'uploader-file-preview, [data-test-id*="image-preview"], [data-test-id*="file-preview"], button[aria-label*="Remove" i], button[aria-label*="إزالة"], img[src^="blob:"], img[src^="data:image/"]',
        ).length;
        const uploading = Boolean(
          doc.querySelector('[aria-label*="Uploading" i], [role="progressbar"][aria-valuetext*="upload" i]'),
        );
        return previewCount > priorCount && !uploading;
      },
      beforePreviews,
      { timeout: this.config.uploadTimeoutMs },
    );

    await this.dismissConsentDialogs(page);
  }

  private async snapshotExistingState(page: Page): Promise<{
    responseCount: number;
    existingImgSrcs: string[];
  }> {
    return page.evaluate((selector) => {
      const doc = (globalThis as any).document;
      const responseCount = doc.querySelectorAll(selector).length as number;
      const existingImgSrcs = (Array.from(doc.querySelectorAll("img")) as any[])
        .map((img) => (img.currentSrc || img.getAttribute("src") || "") as string)
        .filter(Boolean);
      return { responseCount, existingImgSrcs };
    }, RESPONSE_CONTAINER_SELECTOR);
  }

  private async insertPromptAndSubmit(page: Page, prompt: string): Promise<void> {
    await this.dismissConsentDialogs(page);
    const input =
      (await firstVisible(page.locator(PROMPT_INPUT_SELECTOR))) ??
      page.locator(PROMPT_INPUT_SELECTOR).first();
    await input.waitFor({ state: "visible", timeout: this.config.uploadTimeoutMs });
    await this.clickCleanly(page, input, this.config.uploadTimeoutMs);

    const tag = await input.evaluate((el) => el.tagName.toLowerCase());
    if (tag === "textarea" || tag === "input") {
      await input.fill(prompt);
    } else {
      await input.fill(prompt).catch(async () => {
        await page.keyboard.insertText(prompt);
      });
    }

    const sendBtn = await firstVisible(page.locator(SEND_BUTTON_SELECTOR));
    if (sendBtn) {
      await page.waitForFunction(
        (selector) => {
          const doc = (globalThis as any).document;
          const btns = Array.from(doc.querySelectorAll(selector)) as any[];
          return btns.some((btn) => !btn.disabled && btn.getAttribute("aria-disabled") !== "true");
        },
        SEND_BUTTON_SELECTOR,
        { timeout: 10_000 },
      ).catch(() => {});
      await sendBtn.click();
    } else {
      await input.press("Enter");
    }
  }

  private async waitForGeneratedImage(
    page: Page,
    before: { responseCount: number; existingImgSrcs: string[] },
  ): Promise<{ src: string; isInsideNewTurn: boolean }> {
    const deadline = Date.now() + this.config.generationTimeoutMs;
    const seenSrcs = new Set(before.existingImgSrcs);
    let textOnlySince: number | null = null;
    let downloadReadySince: number | null = null;
    let lastDebugKey = "";

    // Wait strictly inside newly created model response turns so user upload previews are never mistaken for outputs.
    while (Date.now() < deadline) {
      await this.checkPageAccess(page);

      const state = await page.evaluate(
        ({ responseSelector, stopSelector, downloadSelector, priorCount, priorSrcs }) => {
          const doc = (globalThis as any).document;
          const priorSet = new Set(priorSrcs);
          const turns = Array.from(doc.querySelectorAll(responseSelector)) as any[];
          const hasNewTurn = turns.length > priorCount;
          const targetTurns = hasNewTurn ? turns.slice(priorCount) : [];
          const stopVisible = (Array.from(doc.querySelectorAll(stopSelector)) as any[]).some((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          const lastTurnEl = targetTurns.length > 0 ? targetTurns[targetTurns.length - 1]! : null;
          const busy =
            Boolean(lastTurnEl?.getAttribute?.("aria-busy") === "true") ||
            (Array.from(doc.querySelectorAll('[aria-busy="true"]')) as any[]).some(
              (el) => !el.closest("side-navigation-v2, bard-sidenav"),
            ) ||
            Boolean(
              lastTurnEl &&
                (Array.from(lastTurnEl.querySelectorAll("mat-progress-spinner, .loading-indicator")) as any[]).some(
                  (el) => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                  },
                ),
            );

          let candidateImg: { src: string; insideTurn: boolean } | null = null;
          let loadingImage = false;
          let hasDownloadBtn = false;
          let rawImgCount = 0;
          const excludeClosest =
            'user-query, user-query-file-preview, user-query-file-carousel, uploader-file-preview, rich-textarea, [role="textbox"], header, nav, side-navigation-v2, bard-sidenav, user-profile-picture';

          if (targetTurns.length > 0) {
            const lastTurn = targetTurns[targetTurns.length - 1]!;
            const scrollTarget = lastTurn.querySelector("generated-image, single-image, img") ?? lastTurn;
            scrollTarget.scrollIntoView?.({ block: "center", behavior: "instant" });

            const collectImgs = Array.from(lastTurn.querySelectorAll("img")) as any[];
            rawImgCount = collectImgs.length;

            for (const img of collectImgs) {
              const src = (img.currentSrc || img.getAttribute("src") || "") as string;
              if (!src || priorSet.has(src)) continue;
              if (img.closest(excludeClosest)) continue;
              if (!img.complete) {
                loadingImage = true;
                continue;
              }
              if (img.naturalWidth >= 256 && img.naturalHeight >= 256) {
                candidateImg = { src, insideTurn: true };
              }
            }

            hasDownloadBtn = (Array.from(lastTurn.querySelectorAll(downloadSelector)) as any[]).some((btn) => {
              const rect = btn.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });

            const messageEl = lastTurn.querySelector("message-content") ?? lastTurn;
            const turnText = String(messageEl.textContent || "").trim();
            return {
              hasNewTurn,
              stopVisible,
              busy,
              loadingImage,
              hasDownloadBtn,
              rawImgCount,
              candidateImg,
              turnText,
            };
          }

          return {
            hasNewTurn,
            stopVisible,
            busy,
            loadingImage: false,
            hasDownloadBtn: false,
            rawImgCount: 0,
            candidateImg: null,
            turnText: "",
          };
        },
        {
          responseSelector: RESPONSE_CONTAINER_SELECTOR,
          stopSelector: STOP_BUTTON_SELECTOR,
          downloadSelector: DOWNLOAD_BUTTON_SELECTOR,
          priorCount: before.responseCount,
          priorSrcs: Array.from(seenSrcs),
        },
      );

      const debugKey = `${state.hasNewTurn}|${state.stopVisible}|${state.busy}|${state.loadingImage}|${state.hasDownloadBtn}|${state.rawImgCount}|${Boolean(state.candidateImg)}|${Boolean(state.turnText)}`;
      if (debugKey !== lastDebugKey) {
        lastDebugKey = debugKey;
        this.log("gemini_wait_state", {
          hasNewTurn: state.hasNewTurn,
          stopVisible: state.stopVisible,
          busy: state.busy,
          loadingImage: state.loadingImage,
          hasDownloadBtn: state.hasDownloadBtn,
          rawImgCount: state.rawImgCount,
          hasCandidateImg: Boolean(state.candidateImg),
        });
      }

      if (state.candidateImg) {
        textOnlySince = null;
        downloadReadySince = null;
        if (!state.stopVisible && !state.busy && !state.loadingImage) {
          return {
            src: (state.candidateImg as { src: string; insideTurn: boolean }).src,
            isInsideNewTurn: (state.candidateImg as { src: string; insideTurn: boolean }).insideTurn,
          };
        }
      } else if (state.hasNewTurn && state.hasDownloadBtn && !state.stopVisible && !state.busy) {
        textOnlySince = null;
        downloadReadySince ??= Date.now();
        if (Date.now() - downloadReadySince >= 5000) {
          return { src: "", isInsideNewTurn: true };
        }
      } else if (state.hasNewTurn && state.turnText && !state.stopVisible && !state.busy && !state.loadingImage) {
        downloadReadySince = null;
        const lower = state.turnText.toLowerCase();
        if (/rate limit|too many requests|quota|reached your limit|try again later|حد الطلبات|حاول لاحقًا/.test(lower)) {
          throw new GeminiAutomationError(
            "RATE_LIMITED",
            "وصل حساب Gemini إلى حد الاستخدام المؤقت؛ ستتم إعادة المحاولة بعد فترة انتظار.",
            true,
          );
        }
        if (/can't generate|cannot generate|against .* policy|violates|غير مسموح|لا يمكنني إنشاء/.test(lower)) {
          throw new GeminiAutomationError(
            "POLICY_REJECTED",
            "رفض Gemini إنشاء الصورة وفق سياسات الاستخدام.",
            false,
          );
        }

        textOnlySince ??= Date.now();
        if (Date.now() - textOnlySince >= 4000) {
          if (/encountering an error|something went wrong|try something else|حدث خطأ/i.test(lower)) {
            throw new GeminiAutomationError(
              "TRANSIENT_FAILURE",
              `أرجع Gemini رسالة خطأ مؤقتة بدل الصورة: ${state.turnText.slice(0, 180)}`,
              true,
            );
          }
          throw new GeminiAutomationError(
            "INVALID_OUTPUT",
            `أرجع Gemini نصًا بدل الصورة المولدة: ${state.turnText.slice(0, 180)}`,
            true,
          );
        }
      } else {
        textOnlySince = null;
        downloadReadySince = null;
      }

      await page.waitForTimeout(500);
    }

    throw new GeminiAutomationError(
      "TIMEOUT",
      "انتهت مهلة انتظار توليد الصورة من Gemini Web.",
      true,
    );
  }

  private async downloadGeneratedImage(
    page: Page,
    generatedSrc: string,
    tempDir: string,
  ): Promise<Buffer> {
    // 1. Prefer the actual Download button attached to the newly generated image.
    const scopedContainer = page
      .locator(RESPONSE_CONTAINER_SELECTOR)
      .last();

    if (generatedSrc) {
      const escapedSrc = generatedSrc.replace(/["\\\n\r]/g, (ch) => `\\${ch}`);
      const imgLocator = page.locator(`img[src="${escapedSrc}"]`).last();
      const imgVisible = await imgLocator.isVisible().catch(() => false);
      if (imgVisible) {
        await imgLocator.scrollIntoViewIfNeeded().catch(() => {});
        await imgLocator.hover().catch(() => {});
      }
    } else {
      const genEl = scopedContainer.locator("generated-image, single-image").last();
      await genEl.scrollIntoViewIfNeeded().catch(() => {});
      await genEl.hover().catch(() => {});
    }

    let downloadBtn = await firstVisible(scopedContainer.locator(DOWNLOAD_BUTTON_SELECTOR));
    if (!downloadBtn && generatedSrc) {
      const allDownloads = page.locator(DOWNLOAD_BUTTON_SELECTOR);
      const count = await allDownloads.count();
      for (let i = count - 1; i >= 0; i--) {
        const candidate = allDownloads.nth(i);
        if (await candidate.isVisible().catch(() => false)) {
          downloadBtn = candidate;
          break;
        }
      }
    }

    if (downloadBtn) {
      await downloadBtn.scrollIntoViewIfNeeded().catch(() => {});
      const downloadPromise = page
        .waitForEvent("download", { timeout: this.config.downloadTimeoutMs })
        .catch(() => null);
      await downloadBtn.click();
      const download = await downloadPromise;
      if (download) {
        const dest = join(tempDir, `downloaded-${Date.now()}`);
        await download.saveAs(dest);
        return readFile(dest);
      }
    }

    // 2. Fallback: fetch the full-resolution binary URL directly via the authenticated browser session (never a screenshot).
    if (generatedSrc.startsWith("blob:") || generatedSrc.startsWith("data:")) {
      const bytes = await page.evaluate(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        return Array.from(new Uint8Array(buf));
      }, generatedSrc);
      return Buffer.from(bytes);
    }

    if (/^https?:\/\//i.test(generatedSrc)) {
      const fullResUrl = generatedSrc.includes("googleusercontent.com")
        ? generatedSrc.replace(/=[ws]\d+(?:-h\d+)?(?:-rw)?(?=$|\?)/, "=s0")
        : generatedSrc;

      for (const candidateUrl of fullResUrl !== generatedSrc ? [fullResUrl, generatedSrc] : [generatedSrc]) {
        const response = await page.context().request.get(candidateUrl, {
          timeout: this.config.downloadTimeoutMs,
        });
        if (response.ok()) {
          return Buffer.from(await response.body());
        }
      }
    }

    throw new GeminiAutomationError(
      "INVALID_OUTPUT",
      "تعذر تنزيل الصورة المولدة بدقتها الكاملة من Gemini Web.",
      true,
    );
  }

  async process(request: ProcessImageRequest): Promise<ProcessImageResult> {
    const tempDir = mkdtempSync(join(tmpdir(), "gemini-job-"));
    let page: Page | null = null;
    try {
      const uploadPath = await this.prepareUploadFile(request.sourceImagePath, tempDir);
      const context = await this.ensureContext(tempDir);
      page = await context.newPage();

      this.log("gemini_navigate", { jobId: request.jobId });
      await page.goto(this.config.geminiUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.config.navigationTimeoutMs,
      });

      // Wait for either the composer or an auth/redirect element.
      await Promise.race([
        page.locator(PROMPT_INPUT_SELECTOR).filter({ visible: true }).first().waitFor({ state: "visible", timeout: this.config.navigationTimeoutMs }),
        page.locator("a, button").filter({ hasText: SIGN_IN_TEXT_PATTERN, visible: true }).first().waitFor({ state: "visible", timeout: this.config.navigationTimeoutMs }),
        page.waitForURL((url) => isAuthOrChallengeUrl(url.toString()) !== null, { timeout: this.config.navigationTimeoutMs }),
      ]).catch(() => {});

      await this.checkPageAccess(page);
      await this.dismissConsentDialogs(page);
      const tempChatActive = await this.enableTemporaryChat(page);

      const before = await this.snapshotExistingState(page);
      this.log("gemini_upload_start", { jobId: request.jobId });
      await this.uploadSourceImage(page, uploadPath);

      this.log("gemini_submit_prompt", { jobId: request.jobId });
      await this.insertPromptAndSubmit(page, request.prompt);

      this.log("gemini_wait_generation", { jobId: request.jobId });
      const generated = await this.waitForGeneratedImage(page, before);

      this.log("gemini_download_result", { jobId: request.jobId, insideNewTurn: generated.isInsideNewTurn });
      const rawBuffer = await this.downloadGeneratedImage(page, generated.src, tempDir);

      // Persist raw temp validation check before handing normalized WebP back to caller.
      await writeFile(join(tempDir, "downloaded-check"), rawBuffer);
      const normalized = await validateAndNormalizeImage(rawBuffer, { minWidth: 256, minHeight: 256 });
      await this.cleanupCreatedChat(page, tempChatActive);
      return normalized;
    } catch (error: any) {
      if (error instanceof GeminiAutomationError) throw error;
      const msg = String(error?.message || error || "Unknown Gemini error");
      if (/timeout/i.test(msg)) {
        throw new GeminiAutomationError("TIMEOUT", `انتهت مهلة العملية أثناء التواصل مع Gemini Web: ${msg}`, true);
      }
      throw new GeminiAutomationError("TRANSIENT_FAILURE", `تعذر إتمام معالجة الصورة عبر Gemini Web: ${msg}`, true);
    } finally {
      if (page) await page.close().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function isInteractiveGeminiSessionAuthenticated(
  context: BrowserContext,
  targetUrl: string,
): Promise<boolean> {
  const pages = context.pages().filter((p) => !p.isClosed());
  if (pages.length === 0) return false;

  let targetOrigin = "";
  try {
    targetOrigin = new URL(targetUrl).origin;
  } catch {}

  const candidatePages = pages.filter((p) => {
    const url = p.url();
    if (isAuthOrChallengeUrl(url)) return false;
    return (targetOrigin && url.startsWith(targetOrigin)) || url.startsWith("https://gemini.google.com");
  });

  if (candidatePages.length === 0) return false;

  const isGoogle = isGoogleOriginUrl(targetUrl);
  if (isGoogle && !(await hasGoogleAuthCookies(context, targetUrl))) {
    return false;
  }

  for (const activePage of candidatePages) {
    const hasSignIn = Boolean(await findVisibleSignInControl(activePage));
    if (hasSignIn) continue;

    const signInDialog = Boolean(
      await firstVisible(
        activePage.locator('[role="dialog"]').filter({ hasText: /sign in|تسجيل الدخول/i }),
      ),
    );
    if (signInDialog) continue;

    const hasTextbox = Boolean(await firstVisible(activePage.locator(PROMPT_INPUT_SELECTOR)));
    const hasUploadTrigger = Boolean(await firstVisible(activePage.locator(UPLOAD_TRIGGER_SELECTOR)));
    if (hasTextbox && hasUploadTrigger) {
      return true;
    }
  }

  return false;
}

/**
 * Opens a headed Chromium window on the persistent profile for one-time manual Google/Gemini sign-in.
 */
export async function runInteractiveGeminiLogin(options: {
  config: ImageProcessingConfig;
  root: string;
  onStatus?: (msg: string) => void;
  onStage?: (stage: "launching" | "waiting_for_login" | "confirming") => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { config, root, onStatus = console.log, onStage, signal } = options;
  if (signal?.aborted) {
    throw new Error("تم إلغاء عملية تسجيل الدخول.");
  }
  const lock = new GeminiProfileLock(config.profileRoot, {
    profileDir: config.loginProfileDir,
    lockName: "login.sqlite",
  });
  let context: BrowserContext | null = null;
  try {
    onStage?.("launching");
    await lock.prepare();
    const executablePath = resolveChromiumExecutable(root);
    mkdirSync(config.loginProfileDir, { recursive: true, mode: 0o700 });
    onStatus(`Opening Chromium with persistent login profile: ${config.loginProfileDir}`);
    context = await chromium.launchPersistentContext(config.loginProfileDir, {
      ...(executablePath ? { executablePath } : {}),
      headless: false,
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--no-first-run",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const closeOnAbort = () => {
      void context?.close().catch(() => {});
    };
    signal?.addEventListener("abort", closeOnAbort, { once: true });

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(config.geminiUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    onStage?.("waiting_for_login");
    onStatus("Please sign in to your Google account in the browser window. Waiting for an authenticated Gemini session...");

    const deadline = Date.now() + 10 * 60_000;
    let authenticated = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      const openPages = context.pages().filter((p) => !p.isClosed());
      if (openPages.length === 0) break;

      if (await isInteractiveGeminiSessionAuthenticated(context, config.geminiUrl)) {
        onStage?.("confirming");
        await openPages[0]!.waitForTimeout(1000).catch(() => {});
        if (await isInteractiveGeminiSessionAuthenticated(context, config.geminiUrl)) {
          authenticated = true;
          break;
        }
        onStage?.("waiting_for_login");
      }
      await openPages[0]!.waitForTimeout(1500).catch(() => {});
    }

    if (signal?.aborted) {
      throw new Error("تم إلغاء عملية تسجيل الدخول.");
    }
    if (!authenticated) {
      throw new Error("Timed out or browser closed before Gemini authentication was confirmed.");
    }

    const activePage = context.pages().find((p) => !p.isClosed()) ?? (await context.newPage());
    const rawUserAgent = await activePage.evaluate(() => navigator.userAgent).catch(() => "");
    const userAgent = normalizeDesktopUserAgent(rawUserAgent) ?? rawUserAgent;
    const storageState = await context.storageState();
    saveEncryptedGeminiStorageState({
      profileRoot: config.profileRoot,
      dataDir: config.dataDir,
      storageState,
      userAgent,
    });

    markGeminiAuthenticated(config.profileRoot);
    onStatus("Gemini authentication confirmed and encrypted auth snapshot saved.");
  } finally {
    if (context) await context.close().catch(() => {});
    lock.release();
  }
}
