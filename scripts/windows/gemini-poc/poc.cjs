'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PLAYWRIGHT_PATH = 'C:\\WhatsApp-ERP\\releases\\1.0.6\\node_modules\\playwright';
const DEFAULT_CHROME_PATH = 'C:\\WhatsApp-ERP\\releases\\1.0.6\\runtime\\chromium\\chrome\\win64-156.0.8078.47\\chrome-win64\\chrome.exe';
const DEFAULT_PROFILE_DIR = 'C:\\Temp\\gemini-poc\\profile';

const GEMINI_URL = 'https://gemini.google.com/app';
const PROMPT_INPUT_SELECTOR =
  'div[role="textbox"][aria-label*="prompt" i], div[role="textbox"][contenteditable="true"], rich-textarea [contenteditable="true"], div[role="textbox"], textarea';
const SEND_BUTTON_SELECTOR =
  'button[aria-label*="Send" i], button[aria-label*="Submit" i], button[aria-label*="إرسال"], button.send-button';
const STOP_BUTTON_SELECTOR = 'button[aria-label*="Stop" i], button[aria-label*="إيقاف"]';
const RESPONSE_CONTAINER_SELECTOR =
  'model-response, [data-message-author-role="model"], [data-test-id="model-response"], .model-response';
const SIGN_IN_ATTR_SELECTOR =
  'a[data-test-id="sidenav-error-action-link"], a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/signin"], a[aria-label="Sign in" i], a[aria-label="تسجيل الدخول"], button[aria-label="Sign in" i], button[aria-label="تسجيل الدخول"]';
const SIGN_IN_TEXT_PATTERN = /^(Sign in|تسجيل الدخول)$/i;
const CAPTCHA_SELECTOR = 'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], #captcha-form';

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin + parsed.pathname;
  } catch {
    return String(rawUrl || '').split('?')[0].slice(0, 120);
  }
}

function classifyUrl(rawUrl) {
  const lower = String(rawUrl || '').toLowerCase();
  if (lower.includes('accounts.google.com') && (lower.includes('challenge') || lower.includes('captcha'))) {
    return 'captcha';
  }
  if (
    lower.includes('accounts.google.com/v3/signin') ||
    lower.includes('accounts.google.com/servicelogin') ||
    lower.includes('accounts.google.com/interactivelogin')
  ) {
    return 'reauth';
  }
  return 'ok';
}

async function isAnyVisible(locator) {
  try {
    const count = await locator.count();
    const limit = Math.min(count, 8);
    for (let i = 0; i < limit; i++) {
      if (await locator.nth(i).isVisible().catch(() => false)) {
        return true;
      }
    }
  } catch {
    // Page may have navigated or closed while probing.
  }
  return false;
}

async function firstVisible(locator) {
  try {
    const count = await locator.count();
    const limit = Math.min(count, 8);
    for (let i = 0; i < limit; i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  } catch {
    // Ignore transient locator error.
  }
  return null;
}

async function inspectCookieFlags(context) {
  try {
    const cookies = await context.cookies(['https://gemini.google.com', 'https://accounts.google.com', 'https://www.google.com']);
    const hasGoogleSid = cookies.some((c) => c.name === 'SID' && c.domain.endsWith('google.com'));
    const hasGoogleSapisid = cookies.some((c) => c.name === 'SAPISID' && c.domain.endsWith('google.com'));
    const hasAccountsLsid = cookies.some((c) => c.name === 'LSID' && c.domain.includes('accounts.google.com'));
    const hasGeminiOsid = cookies.some((c) => c.name === 'OSID' && c.domain.includes('gemini.google.com'));
    return {
      cookieCount: cookies.length,
      hasGoogleSid,
      hasGoogleSapisid,
      hasAccountsLsid,
      hasGeminiOsid,
    };
  } catch {
    return {
      cookieCount: 0,
      hasGoogleSid: false,
      hasGoogleSapisid: false,
      hasAccountsLsid: false,
      hasGeminiOsid: false,
    };
  }
}

async function isSignInVisible(page) {
  if (await isAnyVisible(page.locator(SIGN_IN_ATTR_SELECTOR))) return true;
  if (await isAnyVisible(page.locator('a, button').filter({ hasText: SIGN_IN_TEXT_PATTERN }))) return true;
  return false;
}

async function readResponseTexts(page) {
  try {
    return await page.locator(RESPONSE_CONTAINER_SELECTOR).evaluateAll((els) =>
      els.map((el) => String(el.innerText || el.textContent || '').trim()).filter(Boolean),
    );
  } catch {
    return [];
  }
}

async function runMinimalGeminiPrompt(page) {
  const startedAt = Date.now();
  const promptBox = await firstVisible(page.locator(PROMPT_INPUT_SELECTOR));
  if (!promptBox) {
    return { ok: false, error: 'PROMPT_INPUT_NOT_VISIBLE', elapsedMs: Date.now() - startedAt };
  }

  const beforeTexts = await readResponseTexts(page);
  const beforeCount = beforeTexts.length;
  const beforeLast = beforeCount > 0 ? beforeTexts[beforeCount - 1] : '';

  await promptBox.click({ timeout: 10_000 });
  await promptBox.fill('Reply with one word only: PONG');

  const sendBtn = await firstVisible(page.locator(SEND_BUTTON_SELECTOR));
  if (sendBtn) {
    await sendBtn.click({ timeout: 10_000 });
  } else {
    await page.keyboard.press('Enter');
  }

  let stableTicks = 0;
  let lastCandidate = '';
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const texts = await readResponseTexts(page);
    const current = texts.length > beforeCount
      ? texts[texts.length - 1]
      : (texts.length > 0 && texts[texts.length - 1] !== beforeLast ? texts[texts.length - 1] : '');

    const generating = await isAnyVisible(page.locator(STOP_BUTTON_SELECTOR));
    if (current && !generating) {
      if (current === lastCandidate) {
        stableTicks += 1;
        if (stableTicks >= 2) {
          const singleLine = current.replace(/\s+/g, ' ').trim();
          return {
            ok: true,
            replyChars: singleLine.length,
            preview: singleLine.slice(0, 120),
            elapsedMs: Date.now() - startedAt,
          };
        }
      } else {
        lastCandidate = current;
        stableTicks = 1;
      }
    }
  }

  if (lastCandidate) {
    const singleLine = lastCandidate.replace(/\s+/g, ' ').trim();
    return {
      ok: true,
      replyChars: singleLine.length,
      preview: singleLine.slice(0, 120),
      elapsedMs: Date.now() - startedAt,
      note: 'Returned text before stop indicator fully stabilized',
    };
  }

  return {
    ok: false,
    error: 'RESPONSE_TIMEOUT',
    elapsedMs: Date.now() - startedAt,
  };
}

function writeJsonSafe(outPath, data) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function runLoginMode(chromium, chromePath, profileDir, outPath) {
  fs.mkdirSync(profileDir, { recursive: true });
  console.log('[poc] Launching Chromium interactively for Google/Gemini login...');
  console.log('[poc] Profile dir:', profileDir);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: false,
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--window-size=1280,900',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  let closed = false;
  context.on('close', () => {
    closed = true;
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});

  console.log('[poc] Browser is open. Sign in to Google/Gemini, wait until chat loads, then CLOSE the browser window.');

  let announcedReady = false;
  let lastSnapshot = {
    hasGoogleSid: false,
    promptVisible: false,
    signInVisible: false,
    url: sanitizeUrl(page.url()),
  };

  const deadline = Date.now() + 15 * 60_000;
  while (!closed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const pages = context.pages().filter((p) => !p.isClosed());
    if (pages.length === 0) break;
    const active = pages[0];
    const flags = await inspectCookieFlags(context);
    const promptVisible = await isAnyVisible(active.locator(PROMPT_INPUT_SELECTOR));
    const signInVisible = await isSignInVisible(active);
    lastSnapshot = {
      ...flags,
      promptVisible,
      signInVisible,
      url: sanitizeUrl(active.url()),
    };

    if (!announcedReady && flags.hasGoogleSid && promptVisible && !signInVisible) {
      announcedReady = true;
      console.log('[poc] Authenticated Gemini session detected (SID=true, promptVisible=true). You may close Chromium now.');
    }
  }

  await context.close().catch(() => {});

  const result = {
    mode: 'login',
    timestamp: new Date().toISOString(),
    windowsUser: process.env.USERNAME || null,
    profileDir,
    ...lastSnapshot,
    ok: Boolean(lastSnapshot.hasGoogleSid && lastSnapshot.promptVisible && !lastSnapshot.signInVisible),
  };
  writeJsonSafe(outPath, result);
  console.log('[poc] Login phase finished:', JSON.stringify(result));
  return result.ok ? 0 : 2;
}

async function runHeadlessMode(chromium, chromePath, profileDir, outPath) {
  if (!fs.existsSync(profileDir)) {
    const missing = {
      mode: 'headless',
      timestamp: new Date().toISOString(),
      ok: false,
      error: 'PROFILE_DIR_MISSING',
      profileDir,
    };
    writeJsonSafe(outPath, missing);
    console.error('[poc] Profile dir does not exist:', profileDir);
    return 1;
  }

  const responses = [];
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation', '--headless'],
    args: [
      '--headless=new',
      '--window-size=1280,900',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    page.on('response', (res) => {
      try {
        const u = new URL(res.url());
        if (
          u.hostname === 'gemini.google.com' ||
          u.hostname === 'accounts.google.com' ||
          u.hostname === 'consent.google.com'
        ) {
          responses.push({
            status: res.status(),
            url: u.origin + u.pathname,
          });
        }
      } catch {
        // Ignore malformed URL.
      }
    });

    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Allow client-side auth redirects / UI hydration to settle.
    const settleDeadline = Date.now() + 15_000;
    while (Date.now() < settleDeadline) {
      const promptUp = await isAnyVisible(page.locator(PROMPT_INPUT_SELECTOR));
      const signInUp = await isSignInVisible(page);
      const urlKind = classifyUrl(page.url());
      if (promptUp || signInUp || urlKind !== 'ok') break;
      await page.waitForTimeout(1000);
    }

    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
    const currentUrl = sanitizeUrl(page.url());
    const urlKind = classifyUrl(page.url());
    const captchaVisible = await isAnyVisible(page.locator(CAPTCHA_SELECTOR));
    const signInVisible = await isSignInVisible(page);
    const promptVisible = await isAnyVisible(page.locator(PROMPT_INPUT_SELECTOR));
    const cookieFlags = await inspectCookieFlags(context);

    const authOk = Boolean(
      urlKind === 'ok' &&
      !captchaVisible &&
      !signInVisible &&
      promptVisible &&
      cookieFlags.hasGoogleSid,
    );

    let geminiOp = { ok: false, skipped: true, reason: 'AUTH_FAILED' };
    if (authOk) {
      geminiOp = await runMinimalGeminiPrompt(page);
    }

    const result = {
      mode: 'headless',
      timestamp: new Date().toISOString(),
      windowsUser: process.env.USERNAME || null,
      profileDir,
      currentUrl,
      urlKind,
      userAgentHasHeadless: /HeadlessChrome/i.test(userAgent),
      userAgent,
      ...cookieFlags,
      captchaVisible,
      signInVisible,
      promptVisible,
      authOk,
      geminiOp,
      ok: Boolean(authOk && geminiOp.ok),
      recentHttp: responses.slice(-15),
    };

    writeJsonSafe(outPath, result);
    console.log('[poc] Headless result:', JSON.stringify(result));
    if (!authOk) return 2;
    if (!geminiOp.ok) return 3;
    return 0;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const mode = (process.argv[2] || '').toLowerCase();
  const outPath = process.argv[3] || process.env.POC_RESULT_JSON || '';

  if (mode !== 'login' && mode !== 'headless') {
    console.error('Usage: node poc.cjs <login|headless> [jsonOutPath]');
    process.exit(1);
  }

  const playwrightPath = process.env.POC_PLAYWRIGHT_PATH || DEFAULT_PLAYWRIGHT_PATH;
  const chromePath = process.env.POC_CHROME_PATH || DEFAULT_CHROME_PATH;
  const profileDir = process.env.POC_PROFILE_DIR || DEFAULT_PROFILE_DIR;

  if (!fs.existsSync(playwrightPath)) {
    console.error('[poc] Missing Playwright directory:', playwrightPath);
    process.exit(1);
  }
  if (!fs.existsSync(chromePath)) {
    console.error('[poc] Missing Chromium executable:', chromePath);
    process.exit(1);
  }

  const { chromium } = require(playwrightPath);
  const code =
    mode === 'login'
      ? await runLoginMode(chromium, chromePath, profileDir, outPath)
      : await runHeadlessMode(chromium, chromePath, profileDir, outPath);
  process.exit(code);
}

main().catch((err) => {
  console.error('[poc] Unhandled error:', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
