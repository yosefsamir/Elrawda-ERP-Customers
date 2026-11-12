'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PLAYWRIGHT_PATH = 'C:\\WhatsApp-ERP\\releases\\1.0.6\\node_modules\\playwright';
const DEFAULT_CHROME_PATH = 'C:\\WhatsApp-ERP\\releases\\1.0.6\\runtime\\chromium\\chrome\\win64-156.0.8078.47\\chrome-win64\\chrome.exe';
const DEFAULT_PROFILE_DIR = 'C:\\Temp\\gemini-poc\\profile';
const DEFAULT_FAILURE_SCREENSHOT = 'C:\\Temp\\gemini-poc\\failure-screenshot.png';

const GEMINI_URL = 'https://gemini.google.com/app';
const TEST_PROMPT = 'Reply with one word only: PONG';

const PROMPT_INPUT_SELECTOR =
  'div[role="textbox"][aria-label*="prompt" i], div[role="textbox"][contenteditable="true"], rich-textarea [contenteditable="true"], div[role="textbox"], textarea';
const SEND_BUTTON_SELECTOR =
  'button[aria-label*="Send" i], button[aria-label*="Submit" i], button[aria-label*="إرسال"], button.send-button';
const STOP_BUTTON_SELECTOR = 'button[aria-label*="Stop" i], button[aria-label*="إيقاف"]';
const RESPONSE_TURN_SELECTOR = 'model-response';
const RESPONSE_CONTAINER_SELECTOR =
  'model-response, [data-message-author-role="model"], [data-test-id="model-response"], .model-response';
const USER_QUERY_SELECTOR = 'user-query, [data-message-author-role="user"], .user-query-container';
const SIGN_IN_ATTR_SELECTOR =
  'a[data-test-id="sidenav-error-action-link"], a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/signin"], a[aria-label="Sign in" i], a[aria-label="تسجيل الدخول"], button[aria-label="Sign in" i], button[aria-label="تسجيل الدخول"]';
const SIGN_IN_TEXT_PATTERN = /^(Sign in|تسجيل الدخول)$/i;
const CAPTCHA_SELECTOR = 'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], #captcha-form';
const DIALOG_OVERLAY_SELECTOR =
  '.cdk-overlay-pane, [role="dialog"], mat-dialog-container, [role="alert"], simple-snack-bar, mat-snack-bar-container';

const CONSENT_ACCEPT_PATTERN =
  /^(agree|i agree|accept|accept all|continue|got it|ok|okay|understand|i understand|allow|start|next|done|موافق|أوافق|متابعة|حسنًا|فهمت|قبول)$/i;
const CONSENT_DISMISS_PATTERN =
  /^(close|dismiss|no thanks|not now|skip|maybe later|cancel|إغلاق|تجاهل|ليس الآن|تخطي|لاحقًا|إلغاء|لا شكرًا)$/i;
const DANGEROUS_BUTTON_PATTERN = /sign out|log out|delete|remove|clear all|تسجيل الخروج|حذف|إزالة/i;

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin + parsed.pathname;
  } catch {
    return String(rawUrl || '').split('?')[0].slice(0, 140);
  }
}

function redactText(rawText, maxLen = 200) {
  const cleaned = String(rawText || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLen);
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

async function firstEnabledVisible(locator) {
  try {
    const count = await locator.count();
    const limit = Math.min(count, 10);
    for (let i = 0; i < limit; i++) {
      const candidate = locator.nth(i);
      const vis = await candidate.isVisible().catch(() => false);
      if (!vis) continue;
      const disabled = await candidate.isDisabled().catch(() => false);
      const ariaDisabled = await candidate.getAttribute('aria-disabled').catch(() => null);
      if (!disabled && ariaDisabled !== 'true') {
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

async function snapshotOverlaysAndAlerts(page) {
  try {
    const raw = await page.evaluate((selector) => {
      const els = Array.from(document.querySelectorAll(selector));
      const items = [];
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
        if (!visible) continue;
        const text = String(el.innerText || el.textContent || '').trim();
        const buttons = Array.from(el.querySelectorAll('button, a[role="button"]'))
          .filter((b) => {
            const br = b.getBoundingClientRect();
            return br.width > 0 && br.height > 0;
          })
          .map((b) => String(b.innerText || b.getAttribute('aria-label') || '').trim())
          .filter(Boolean)
          .slice(0, 6);
        if (!text && buttons.length === 0) continue;
        items.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || null,
          text,
          buttons,
        });
      }
      return items.slice(0, 10);
    }, DIALOG_OVERLAY_SELECTOR);

    return raw.map((item) => ({
      tag: item.tag,
      role: item.role,
      text: redactText(item.text, 200),
      buttons: item.buttons.map((b) => redactText(b, 60)),
    }));
  } catch {
    return [];
  }
}

async function dismissBlockingOverlays(page) {
  const dismissed = [];
  for (let round = 0; round < 3; round++) {
    let clickedInRound = false;
    const overlays = page.locator('.cdk-overlay-pane, [role="dialog"], mat-dialog-container');
    const count = await overlays.count().catch(() => 0);

    for (let i = count - 1; i >= 0; i--) {
      const dialog = overlays.nth(i);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const text = (await dialog.innerText().catch(() => '')) || '';
      if (/sign in|تسجيل الدخول/i.test(text) && !/creating content|policy|agree|got it/i.test(text)) {
        continue;
      }

      const btns = dialog.locator('button');
      const btnCount = Math.min(await btns.count().catch(() => 0), 10);
      for (let b = 0; b < btnCount; b++) {
        const btn = btns.nth(b);
        if (!(await btn.isVisible().catch(() => false))) continue;
        if (await btn.isDisabled().catch(() => false)) continue;
        const label = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('aria-label').catch(() => '')) || '').trim();
        if (!label || DANGEROUS_BUTTON_PATTERN.test(label)) continue;
        if (
          CONSENT_ACCEPT_PATTERN.test(label) ||
          CONSENT_DISMISS_PATTERN.test(label) ||
          /^(close|dismiss|got it|agree|accept|ok|إغلاق|حسنًا|موافق)$/i.test(label)
        ) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          dismissed.push({ round, label: redactText(label, 60), dialogText: redactText(text, 120) });
          clickedInRound = true;
          await page.waitForTimeout(300);
          break;
        }
      }
      if (clickedInRound) break;
    }

    if (!clickedInRound) break;
  }
  return dismissed;
}

async function snapshotSendButtons(page) {
  try {
    const raw = await page.evaluate((selector) => {
      return Array.from(document.querySelectorAll(selector)).map((btn) => {
        const rect = btn.getBoundingClientRect();
        const style = window.getComputedStyle(btn);
        return {
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none',
          disabled: Boolean(btn.disabled),
          ariaDisabled: btn.getAttribute('aria-disabled'),
          ariaLabel: btn.getAttribute('aria-label') || '',
          className: String(btn.className || '').slice(0, 80),
          text: String(btn.innerText || '').trim().slice(0, 40),
        };
      });
    }, SEND_BUTTON_SELECTOR);
    return raw.slice(0, 8);
  } catch {
    return [];
  }
}

async function readDomTurnSnapshot(page) {
  try {
    return await page.evaluate(
      ({ turnSelector, broadSelector, userSelector, stopSelector }) => {
        const turns = Array.from(document.querySelectorAll(turnSelector));
        const broad = Array.from(document.querySelectorAll(broadSelector));
        const userQueries = Array.from(document.querySelectorAll(userSelector));
        const stopVisible = Array.from(document.querySelectorAll(stopSelector)).some((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const busyVisible =
          Array.from(document.querySelectorAll('[aria-busy="true"]')).some(
            (el) => !el.closest('side-navigation-v2, bard-sidenav'),
          ) ||
          Array.from(document.querySelectorAll('mat-progress-spinner, .loading-indicator')).some((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });

        const turnTexts = turns.map((turn) => {
          const msg = turn.querySelector('message-content') || turn;
          return String(msg.innerText || msg.textContent || '').trim();
        });
        const broadNonEmpty = broad
          .map((el) => String(el.innerText || el.textContent || '').trim())
          .filter(Boolean);

        return {
          turnCount: turns.length,
          broadCount: broad.length,
          broadNonEmptyCount: broadNonEmpty.length,
          userQueryCount: userQueries.length,
          messageContentCount: document.querySelectorAll('message-content').length,
          stopVisible,
          busyVisible,
          turnTexts,
          latestBroadText: broadNonEmpty.length > 0 ? broadNonEmpty[broadNonEmpty.length - 1] : '',
        };
      },
      {
        turnSelector: RESPONSE_TURN_SELECTOR,
        broadSelector: RESPONSE_CONTAINER_SELECTOR,
        userSelector: USER_QUERY_SELECTOR,
        stopSelector: STOP_BUTTON_SELECTOR,
      },
    );
  } catch {
    return {
      turnCount: 0,
      broadCount: 0,
      broadNonEmptyCount: 0,
      userQueryCount: 0,
      messageContentCount: 0,
      stopVisible: false,
      busyVisible: false,
      turnTexts: [],
      latestBroadText: '',
    };
  }
}

async function readPromptBoxText(promptBox) {
  try {
    return await promptBox.evaluate((el) => String(el.value !== undefined ? el.value : (el.innerText || el.textContent || '')).trim());
  } catch {
    return '';
  }
}

async function captureFailureDiagnostics(page, screenshotPath) {
  const overlaysAndAlerts = await snapshotOverlaysAndAlerts(page);

  let domSummary = null;
  try {
    const rawDom = await page.evaluate(
      ({ promptSel, sendSel, stopSel, turnSel, broadSel, userSel }) => {
        const isVis = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const visibleToolbarButtons = Array.from(
          document.querySelectorAll('main button, rich-textarea button, .input-area button, [data-test-id*="send"] button'),
        )
          .filter(isVis)
          .slice(0, 12)
          .map((b) => ({
            ariaLabel: b.getAttribute('aria-label') || '',
            text: String(b.innerText || '').trim().slice(0, 40),
            disabled: Boolean(b.disabled),
            ariaDisabled: b.getAttribute('aria-disabled'),
          }));

        const mainEl = document.querySelector('main') || document.body;
        const clone = mainEl.cloneNode(true);
        for (const el of clone.querySelectorAll('side-navigation-v2, bard-sidenav, nav, user-profile-picture')) {
          el.remove();
        }
        const mainText = String(clone.innerText || clone.textContent || '');
        const promptEl = Array.from(document.querySelectorAll(promptSel)).find(isVis) || null;
        const promptText = promptEl
          ? String(promptEl.value !== undefined ? promptEl.value : (promptEl.innerText || promptEl.textContent || '')).trim()
          : '';

        return {
          title: document.title || '',
          userQueryCount: document.querySelectorAll(userSel).length,
          turnCount: document.querySelectorAll(turnSel).length,
          broadContainerCount: document.querySelectorAll(broadSel).length,
          messageContentCount: document.querySelectorAll('message-content').length,
          sendSelectorCount: document.querySelectorAll(sendSel).length,
          stopVisibleCount: Array.from(document.querySelectorAll(stopSel)).filter(isVis).length,
          promptTextLen: promptText.length,
          visibleToolbarButtons,
          mainText,
        };
      },
      {
        promptSel: PROMPT_INPUT_SELECTOR,
        sendSel: SEND_BUTTON_SELECTOR,
        stopSel: STOP_BUTTON_SELECTOR,
        turnSel: RESPONSE_TURN_SELECTOR,
        broadSel: RESPONSE_CONTAINER_SELECTOR,
        userSel: USER_QUERY_SELECTOR,
      },
    );

    domSummary = {
      title: redactText(rawDom.title, 80),
      userQueryCount: rawDom.userQueryCount,
      turnCount: rawDom.turnCount,
      broadContainerCount: rawDom.broadContainerCount,
      messageContentCount: rawDom.messageContentCount,
      sendSelectorCount: rawDom.sendSelectorCount,
      stopVisibleCount: rawDom.stopVisibleCount,
      promptTextLen: rawDom.promptTextLen,
      visibleToolbarButtons: rawDom.visibleToolbarButtons.map((b) => ({
        ...b,
        ariaLabel: redactText(b.ariaLabel, 60),
        text: redactText(b.text, 40),
      })),
      mainTextSnippet: redactText(rawDom.mainText, 350),
    };
  } catch (err) {
    domSummary = { captureError: redactText(err && err.message ? err.message : String(err), 150) };
  }

  let savedScreenshot = null;
  if (screenshotPath) {
    try {
      await page.evaluate(() => {
        const privacySelectors = [
          'bard-sidenav',
          'side-navigation-v2',
          '[data-test-id="conversations-list"]',
          'user-profile-picture',
          '[data-ogsr-up]',
          'a[aria-label*="Google Account" i]',
          'button[aria-label*="Google Account" i]',
          'img[alt*="Google Account" i]',
          'img[src*="googleusercontent.com"]',
        ];
        for (const sel of privacySelectors) {
          for (const el of document.querySelectorAll(sel)) {
            el.style.filter = 'blur(16px)';
            el.style.visibility = 'hidden';
          }
        }
      });
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: false });
      savedScreenshot = screenshotPath;
    } catch {
      savedScreenshot = null;
    }
  }

  return {
    currentUrlAtFailure: sanitizeUrl(page.url()),
    overlaysAndAlerts,
    domSummary,
    screenshotPath: savedScreenshot,
  };
}

async function runMinimalGeminiPrompt(page, netTracker, screenshotPath) {
  const startedAt = Date.now();
  const overlaysBeforeSubmit = await snapshotOverlaysAndAlerts(page);
  const dismissedDialogs = await dismissBlockingOverlays(page);

  const promptBox = await firstVisible(page.locator(PROMPT_INPUT_SELECTOR));
  if (!promptBox) {
    const failureDiag = await captureFailureDiagnostics(page, screenshotPath);
    return {
      ok: false,
      error: 'PROMPT_INPUT_NOT_VISIBLE',
      elapsedMs: Date.now() - startedAt,
      overlaysBeforeSubmit,
      dismissedDialogs,
      failureDiag,
    };
  }

  const beforeSnap = await readDomTurnSnapshot(page);
  const beforeLastBroad = beforeSnap.latestBroadText;

  await promptBox.click({ timeout: 10_000 });
  await promptBox.fill(TEST_PROMPT);
  let promptTextAfterFill = await readPromptBoxText(promptBox);
  let usedKeyboardInsertFallback = false;

  if (!promptTextAfterFill.includes('PONG')) {
    usedKeyboardInsertFallback = true;
    await promptBox.click({ timeout: 5_000 }).catch(() => {});
    await page.keyboard.insertText(TEST_PROMPT);
    promptTextAfterFill = await readPromptBoxText(promptBox);
  }

  const sendBtnsBeforeWait = await snapshotSendButtons(page);

  // Wait for an enabled, visible Send button (Angular/Material frequently keeps aria-disabled="true" briefly).
  const waitSendStart = Date.now();
  const enabledSendBtnFound = await page
    .waitForFunction(
      (selector) => {
        const btns = Array.from(document.querySelectorAll(selector));
        return btns.some((btn) => {
          const rect = btn.getBoundingClientRect();
          const style = window.getComputedStyle(btn);
          const vis =
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none';
          return vis && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        });
      },
      SEND_BUTTON_SELECTOR,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  const enabledSendBtnWaitMs = Date.now() - waitSendStart;
  const sendBtnsAfterWait = await snapshotSendButtons(page);

  let submitMethod = 'none';
  let fallbackEnterUsed = false;

  if (enabledSendBtnFound) {
    const enabledBtn = await firstEnabledVisible(page.locator(SEND_BUTTON_SELECTOR));
    if (enabledBtn) {
      await enabledBtn.click({ timeout: 10_000 });
      submitMethod = 'enabled_send_button_click';
    }
  }

  if (submitMethod === 'none') {
    await promptBox.press('Enter');
    submitMethod = 'enter_key_no_enabled_send_btn';
  }

  await page.waitForTimeout(800);
  let promptTextAfterSubmit = await readPromptBoxText(promptBox);
  let afterSubmitSnap = await readDomTurnSnapshot(page);

  // If textbox was not cleared and no new user query or stream started, try pressing Enter once.
  if (
    promptTextAfterSubmit.includes('PONG') &&
    afterSubmitSnap.userQueryCount <= beforeSnap.userQueryCount &&
    netTracker.streamGenerateEvents.length === 0
  ) {
    fallbackEnterUsed = true;
    await promptBox.focus().catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    promptTextAfterSubmit = await readPromptBoxText(promptBox);
    afterSubmitSnap = await readDomTurnSnapshot(page);
  }

  const submitDiagnostics = {
    overlaysBeforeSubmit,
    dismissedDialogs,
    beforeTurnCount: beforeSnap.turnCount,
    beforeBroadCount: beforeSnap.broadCount,
    beforeUserQueryCount: beforeSnap.userQueryCount,
    promptLenAfterFill: promptTextAfterFill.length,
    promptMatchedAfterFill: promptTextAfterFill.includes('PONG'),
    usedKeyboardInsertFallback,
    sendBtnsBeforeWait,
    enabledSendBtnFound,
    enabledSendBtnWaitMs,
    sendBtnsAfterWait,
    submitMethod,
    fallbackEnterUsed,
    promptLenAfterSubmit: promptTextAfterSubmit.length,
    userQueryCountAfterSubmit: afterSubmitSnap.userQueryCount,
    urlAfterSubmit: sanitizeUrl(page.url()),
  };

  let stableTicks = 0;
  let lastCandidate = '';
  let maxTurnCountObserved = Math.max(beforeSnap.turnCount, afterSubmitSnap.turnCount);
  let maxUserQueryCountObserved = Math.max(beforeSnap.userQueryCount, afterSubmitSnap.userQueryCount);
  let maxTurnTextLenObserved = 0;
  let stopSeenCount = afterSubmitSnap.stopVisible ? 1 : 0;
  let busySeenCount = afterSubmitSnap.busyVisible ? 1 : 0;
  let firstNewTurnAtMs = afterSubmitSnap.turnCount > beforeSnap.turnCount ? Date.now() - startedAt : null;

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const snap = await readDomTurnSnapshot(page);
    if (snap.turnCount > maxTurnCountObserved) {
      maxTurnCountObserved = snap.turnCount;
      if (firstNewTurnAtMs === null) firstNewTurnAtMs = Date.now() - startedAt;
    }
    if (snap.userQueryCount > maxUserQueryCountObserved) {
      maxUserQueryCountObserved = snap.userQueryCount;
    }
    if (snap.stopVisible) stopSeenCount += 1;
    if (snap.busyVisible) busySeenCount += 1;

    let current = '';
    if (snap.turnCount > beforeSnap.turnCount) {
      current = snap.turnTexts[snap.turnCount - 1] || '';
    } else if (snap.latestBroadText && snap.latestBroadText !== beforeLastBroad) {
      current = snap.latestBroadText;
    }

    if (current.length > maxTurnTextLenObserved) {
      maxTurnTextLenObserved = current.length;
    }

    if (current && !snap.stopVisible && !snap.busyVisible) {
      if (current === lastCandidate) {
        stableTicks += 1;
        if (stableTicks >= 2) {
          const singleLine = current.replace(/\s+/g, ' ').trim();
          return {
            ok: true,
            replyChars: singleLine.length,
            preview: redactText(singleLine, 120),
            elapsedMs: Date.now() - startedAt,
            submitDiagnostics,
            pollDiagnostics: {
              maxTurnCountObserved,
              maxUserQueryCountObserved,
              maxTurnTextLenObserved,
              stopSeenCount,
              busySeenCount,
              firstNewTurnAtMs,
            },
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
      preview: redactText(singleLine, 120),
      elapsedMs: Date.now() - startedAt,
      note: 'Returned text before stop/busy indicator cleared',
      submitDiagnostics,
      pollDiagnostics: {
        maxTurnCountObserved,
        maxUserQueryCountObserved,
        maxTurnTextLenObserved,
        stopSeenCount,
        busySeenCount,
        firstNewTurnAtMs,
      },
    };
  }

  const failureDiag = await captureFailureDiagnostics(page, screenshotPath);
  return {
    ok: false,
    error: 'RESPONSE_TIMEOUT',
    elapsedMs: Date.now() - startedAt,
    submitDiagnostics,
    pollDiagnostics: {
      maxTurnCountObserved,
      maxUserQueryCountObserved,
      maxTurnTextLenObserved,
      stopSeenCount,
      busySeenCount,
      firstNewTurnAtMs,
    },
    failureDiag,
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

  const screenshotPath =
    process.env.POC_SCREENSHOT_PATH ||
    (outPath ? path.join(path.dirname(outPath), 'failure-screenshot.png') : DEFAULT_FAILURE_SCREENSHOT);
  if (fs.existsSync(screenshotPath)) {
    fs.unlinkSync(screenshotPath);
  }

  const runStartMs = Date.now();
  const netTracker = {
    cspReportCount: 0,
    httpEvents: [],
    streamGenerateEvents: [],
    failedRequests: [],
    consoleErrors: [],
  };

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

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        if (netTracker.consoleErrors.length < 15) {
          netTracker.consoleErrors.push(redactText(msg.text(), 180));
        }
      }
    });

    page.on('pageerror', (err) => {
      if (netTracker.consoleErrors.length < 15) {
        netTracker.consoleErrors.push('pageerror: ' + redactText(err && err.message ? err.message : String(err), 180));
      }
    });

    page.on('requestfailed', (req) => {
      try {
        const u = new URL(req.url());
        if (u.hostname.endsWith('google.com') && netTracker.failedRequests.length < 20) {
          netTracker.failedRequests.push({
            tMs: Date.now() - runStartMs,
            method: req.method(),
            url: u.origin + u.pathname,
            errorText: req.failure() ? req.failure().errorText : 'failed',
          });
        }
      } catch {
        // Ignore malformed URL.
      }
    });

    page.on('response', (res) => {
      try {
        const u = new URL(res.url());
        if (
          u.hostname === 'gemini.google.com' ||
          u.hostname === 'accounts.google.com' ||
          u.hostname === 'consent.google.com'
        ) {
          if (u.pathname.includes('/cspreport')) {
            netTracker.cspReportCount += 1;
            return;
          }
          const entry = {
            tMs: Date.now() - runStartMs,
            status: res.status(),
            url: u.origin + u.pathname,
          };
          netTracker.httpEvents.push(entry);
          if (u.pathname.includes('StreamGenerate') || u.pathname.includes('BardFrontendService')) {
            netTracker.streamGenerateEvents.push(entry);
          }
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

    let geminiOp;
    if (authOk) {
      geminiOp = await runMinimalGeminiPrompt(page, netTracker, screenshotPath);
    } else {
      const failureDiag = await captureFailureDiagnostics(page, screenshotPath);
      geminiOp = { ok: false, skipped: true, reason: 'AUTH_FAILED', failureDiag };
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
      cspReportCount: netTracker.cspReportCount,
      streamGenerateEvents: netTracker.streamGenerateEvents,
      failedRequests: netTracker.failedRequests,
      consoleErrors: netTracker.consoleErrors,
      recentHttp: netTracker.httpEvents.slice(-40),
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
