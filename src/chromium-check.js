'use strict';

const { chromium } = require('playwright');
const { execSync }  = require('child_process');

async function tryLaunch() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const version  = browser.version();
  await browser.close();
  return version;
}

async function checkChromium() {
  process.stdout.write('[startup] Checking Chromium … ');
  try {
    const version = await tryLaunch();
    console.log(`OK (${version})`);
    return;
  } catch (err) {
    if (!err.message.includes("Executable doesn't exist")) {
      // Not a missing-binary problem — could be missing system libs etc.
      console.error('\n[startup] Chromium launch failed.');
      console.error('  System dependencies may be missing.');
      console.error('  Run:  sudo bash scripts/install-chromium.sh');
      console.error('');
      console.error(err.message);
      process.exit(1);
    }
  }

  // Browser binary is missing — try to install it automatically.
  console.log('not found.');
  console.log('[startup] Playwright browser binary missing — installing now…');
  try {
    execSync('npx playwright install chromium', { stdio: 'inherit' });
  } catch (installErr) {
    console.error('[startup] Auto-install failed.');
    console.error('  Try manually:  npx playwright install chromium');
    console.error('  If system deps are missing:  sudo bash scripts/install-chromium.sh');
    process.exit(1);
  }

  // Retry after install.
  console.log('[startup] Verifying Chromium after install … ');
  try {
    const version = await tryLaunch();
    console.log(`[startup] Chromium OK (${version})`);
  } catch (err) {
    console.error('[startup] Chromium still broken after install — system dependencies may be missing.');
    console.error('  Run:  sudo bash scripts/install-chromium.sh');
    console.error('');
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { checkChromium };
