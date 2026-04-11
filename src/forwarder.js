'use strict';

// Leader-mode round-robin forwarder.
//
// When LEADER_MODE=true the leader maintains its own session pool AND forwards
// new-session requests to slave nodes in round-robin order.
//
// Pool composition:
//   SLAVE_URLS=http://slave1:3000,http://slave2:3000   (required)
//   FORWARD_INCLUDE_SELF=true                           (default: include leader itself)
//
// When the leader is included in the pool it handles sessions locally on its
// own turn; slave turns are proxied via HTTP.

const axios = require('axios');

const SLAVE_URLS = (process.env.SLAVE_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const INCLUDE_SELF = process.env.FORWARD_INCLUDE_SELF !== 'false';

class Forwarder {
  constructor() {
    this._index  = 0;
    // Build the pool: slaves + optionally a sentinel for self
    this._pool   = [...SLAVE_URLS, ...(INCLUDE_SELF ? [null] : [])];
    // null in the pool means "handle locally"
  }

  /** Return next target URL, or null meaning "handle locally". */
  _next() {
    if (!this._pool.length) return null; // no pool → always local
    const target = this._pool[this._index % this._pool.length];
    this._index++;
    return target; // null = self, string = remote slave
  }

  /**
   * Express middleware.
   * Only intercepts POST /sessions (session creation) and distributes it.
   * All other paths (get info, run action, etc.) stay local because sessions
   * are pinned to the node that created them — the client uses the slave URL
   * directly for subsequent calls.
   */
  middleware() {
    return async (req, res, next) => {
      // Only round-robin new session creation
      if (req.method !== 'POST' || req.path !== '/') return next();
      if (!SLAVE_URLS.length) return next(); // no slaves configured

      const target = this._next();
      if (target === null) {
        // Leader's own turn — handle locally
        return next();
      }
      return this._proxy(target, req, res);
    };
  }

  async _proxy(slaveBase, req, res) {
    try {
      const url      = `${slaveBase}${req.originalUrl}`;
      const response = await axios({
        method:       req.method,
        url,
        data:         req.body,
        headers: {
          'content-type':    'application/json',
          'x-forwarded-by':  'playbig-leader',
        },
        timeout:        60_000,
        responseType:   'json',
        validateStatus: () => true, // pass all status codes through
      });
      // Surface the slave base URL so the client can talk to it directly
      res.setHeader('x-playbig-slave', slaveBase);
      res.status(response.status).json(response.data);
    } catch (err) {
      res.status(502).json({ error: 'Upstream slave error', detail: err.message });
    }
  }

  status() {
    return {
      mode:         'leader',
      slaves:        SLAVE_URLS,
      includeSelf:   INCLUDE_SELF,
      poolSize:      this._pool.length,
      nextIndex:     this._index,
    };
  }
}

const forwarder = new Forwarder();
module.exports = { forwarder };
