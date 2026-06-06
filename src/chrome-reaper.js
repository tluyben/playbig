'use strict';

// OS-level safety net: SIGKILL any Chromium process older than a hard cap,
// independent of playbig's session bookkeeping. This is the breaker — stray
// Chromes can never accumulate. It catches the cases the session map can't:
//   - a session whose browser.close() hung (map entry already removed)
//   - a renderer/zygote child that outlived its parent
//   - session age-expiry misconfigured to 0
// Nothing Chromium runs longer than the cap, period.

const { execSync } = require('child_process');

const SESSION_AGE_MS = parseInt(process.env.MAX_SESSION_AGE_MS || '1800000', 10);
// Hard OS cap (seconds): the session age + 5 min grace, or a 45-min floor if
// age-expiry is disabled. Overridable via CHROME_REAP_MAX_AGE_SECONDS.
const HARD_CAP_S = Math.max(
  parseInt(process.env.CHROME_REAP_MAX_AGE_SECONDS || '0', 10) || 0,
  SESSION_AGE_MS > 0 ? Math.round(SESSION_AGE_MS / 1000) + 300 : 2700,
);
const INTERVAL_MS = parseInt(process.env.CHROME_REAP_INTERVAL_MS || '60000', 10);

// Match the chromium binary + its children (renderer, zygote, gpu, etc.) and
// the headless shell. Deliberately broad — in a playbig/herd container every
// chrome process is a browser-session process.
const CHROME_RE = /chrom(e|ium)|headless_shell/i;

/** One sweep: kill chromium processes older than the hard cap. Returns count. */
function sweep() {
  let out;
  try {
    // pid, elapsed-seconds, command name — procps `ps`.
    out = execSync('ps -eo pid=,etimes=,comm= 2>/dev/null', { encoding: 'utf8' });
  } catch {
    return 0;
  }
  let killed = 0;
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const etimes = parseInt(m[2], 10);
    const comm = m[3];
    if (!CHROME_RE.test(comm)) continue;
    if (etimes < HARD_CAP_S) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
      console.warn(`[chrome-reaper] SIGKILL ${comm} pid ${pid} (age ${etimes}s > cap ${HARD_CAP_S}s)`);
    } catch {
      /* already gone, or not permitted */
    }
  }
  return killed;
}

let timer = null;

function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sweep();
    } catch (e) {
      console.error('[chrome-reaper] sweep error:', e.message);
    }
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[chrome-reaper] started — hard cap ${HARD_CAP_S}s, every ${INTERVAL_MS}ms`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, sweep };
