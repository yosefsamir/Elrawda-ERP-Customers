// Shared by the production worker and the isolated pilot.
// Uses a platform-matching Chrome User Agent without HeadlessChrome token,
// preventing WhatsApp Web from rejecting headless browser initialization.
function browserOptions(chromePath, env = process.env) {
  const args = ['--disable-dev-shm-usage', '--no-first-run'];
  if (env.CHROME_NO_SANDBOX === 'true' || env.WHATSAPP_TEST_NO_SANDBOX === '1') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  const isWin = process.platform === 'win32';
  const userAgent = isWin
    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  return {
    userAgent,
    puppeteer: {
      headless: true,
      protocolTimeout: 60000,
      args,
      ...(chromePath ? { executablePath: chromePath } : {}),
    },
  };
}
module.exports = { browserOptions };
