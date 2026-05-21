'use strict';

// Watchdog: periodically checks every session for expiry, crashes, or
// unresponsiveness and cleans up accordingly.

const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || '10000', 10);

class Monitor {
  constructor() {
    this._timer   = null;
    this._running = false;
    // sessionManager is required lazily to avoid circular-dep issues
    this._mgr = null;
  }

  start() {
    if (this._running) return;
    // Lazy require so monitor.js can be imported before session-manager.js finishes loading
    this._mgr = require('./session-manager').sessionManager;
    this._running = true;
    this._timer = setInterval(() => this._tick(), MONITOR_INTERVAL_MS);
    // Allow the Node process to exit even while the timer is alive
    this._timer.unref();
    console.log(`[monitor] started — interval ${MONITOR_INTERVAL_MS}ms`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._running = false;
    console.log('[monitor] stopped');
  }

  async _tick() {
    const mgr = this._mgr;
    for (const [id, session] of mgr.sessions) {
      try {
        // 1. Expiry
        if (mgr.isExpired(session)) {
          console.log(`[monitor] session ${id} exceeded MAX_SESSION_AGE_MS — terminating`);
          await mgr.endSession(id, 'expired').catch(() => {});
          continue;
        }

        // 2. Browser disconnect / crash (cheap check, no round-trip)
        if (!session.browser.isConnected()) {
          console.warn(`[monitor] session ${id} browser disconnected — marking crashed`);
          session.status = 'crashed';
        }

        // 3. Crashed sessions get cleaned up
        if (session.status === 'crashed') {
          console.log(`[monitor] session ${id} crashed — cleaning up`);
          await mgr.endSession(id, 'crashed').catch(() => {});
          continue;
        }

        // 4. Liveness ping (only for active sessions)
        if (session.status === 'active') {
          try {
            await session.page.evaluate('1', { timeout: 5000 });
          } catch (err) {
            console.warn(`[monitor] session ${id} liveness check failed: ${err.message}`);
            session.status = 'unresponsive';
          }
        }

        // 5. Unresponsive → terminate
        if (session.status === 'unresponsive') {
          console.log(`[monitor] session ${id} unresponsive — terminating`);
          await mgr.endSession(id, 'unresponsive').catch(() => {});
        }
      } catch (err) {
        console.error(`[monitor] error processing session ${id}: ${err.message}`);
      }
    }
  }

  status() {
    return {
      running:      this._running,
      intervalMs:   MONITOR_INTERVAL_MS,
      sessionCount: this._mgr ? this._mgr.sessions.size : 0,
    };
  }
}

const monitor = new Monitor();
module.exports = { monitor };
