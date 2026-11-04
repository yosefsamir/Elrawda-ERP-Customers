const test = require('node:test');
const assert = require('node:assert/strict');
const { browserOptions } = require('./browser.cjs');

test('native browser identity and sandbox remain enabled in service mode', () => {
  const options = browserOptions('C:\\Chrome\\chrome.exe', {});
  assert.ok(typeof options.userAgent === 'string' && !options.userAgent.includes('HeadlessChrome'));
  assert.equal(options.puppeteer.headless, true);
  assert.equal(options.puppeteer.executablePath, 'C:\\Chrome\\chrome.exe');
  assert.ok(!options.puppeteer.args.includes('--no-sandbox'));
});
test('the browser stays hidden even when a stale environment requests a visible window', () => {
  assert.equal(browserOptions(undefined, { WHATSAPP_HEADLESS: 'false' }).puppeteer.headless, true);
});
