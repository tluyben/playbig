'use strict';

const { chromium } = require('playwright');

async function checkChromium() {
  process.stdout.write('[startup] Checking Chromium … ');
  try {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const version  = browser.version();
    await browser.close();
    console.log(`OK (${version})`);
  } catch (err) {
    console.error('\n[startup] Chromium launch failed.');
    console.error('  Run:  sudo scripts/install-chromium.sh   (system deps)');
    console.error('  Then: node -e "require(\'playwright/install\')"');
    console.error('  Or build the Docker image: docker compose build');
    console.error('');
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { checkChromium };
