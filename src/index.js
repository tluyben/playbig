'use strict';

require('dotenv').config();

const { checkChromium } = require('./chromium-check');
const { createServer }  = require('./server');
const { sessionManager } = require('./session-manager');
const { monitor }        = require('./monitor');

async function main() {
  console.log('playbig starting…');

  await checkChromium();

  const port = parseInt(process.env.PORT || '3000', 10);
  const app  = createServer();

  const server = app.listen(port, () => {
    const mode = process.env.LEADER_MODE === 'true' ? 'LEADER' : 'STANDALONE';
    console.log(`playbig listening on port ${port}  [${mode}]`);
    if (process.env.LEADER_MODE === 'true') {
      const slaves = (process.env.SLAVE_URLS || '').split(',').filter(Boolean);
      console.log(`  slaves: ${slaves.join(', ') || '(none configured)'}`);
      console.log(`  includeSelf: ${process.env.FORWARD_INCLUDE_SELF !== 'false'}`);
    }
    const maxAge = parseInt(process.env.MAX_SESSION_AGE_MS || '0', 10);
    if (maxAge) console.log(`  maxSessionAge: ${maxAge}ms`);
  });

  // ── graceful shutdown ────────────────────────────────────────────────────
  async function shutdown(signal) {
    console.log(`\n[${signal}] shutting down gracefully…`);
    monitor.stop();
    server.close(async () => {
      await sessionManager.destroyAll();
      console.log('playbig stopped.');
      process.exit(0);
    });
    // Force-exit if shutdown takes too long
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
