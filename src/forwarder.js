'use strict';

// Follower routing — transparent load distribution across multiple playbig nodes.
//
// When FOLLOWERS is set, this node acts as the routing leader. The client always
// talks to the leader; the leader silently proxies requests to the right follower.
//
// Configuration:
//   FOLLOWERS=host1:port1,host2:port2
//   (full URLs like http://host1:3000 are also accepted)
//
// Behaviour:
//   POST /sessions     → round-robin across followers + self; session ownership
//                        is recorded in the in-memory registry
//   /:id/*             → forwarded to whichever node owns the session
//   GET /sessions      → local sessions only (follower aggregation optional)
//   /health            → local only
//
// The leader always includes itself in the pool. All subsequent calls for a
// session go through the leader — the client needs only the leader URL.

const axios = require('axios');

function parseFollowers(envValue) {
  return (envValue || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s.startsWith('http://') || s.startsWith('https://') ? s : `http://${s}`));
}

class Forwarder {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.followers] - Override FOLLOWERS env var (used in tests)
   */
  constructor(opts = {}) {
    this._followers = opts.followers !== undefined
      ? opts.followers
      : parseFollowers(process.env.FOLLOWERS);

    // Pool: followers first, then null (self). Self is always in the pool.
    this._pool  = [...this._followers, null];
    this._index = 0;

    // sessionId → follower URL string, or null (self)
    this._registry = new Map();
  }

  /** True when at least one follower is configured. */
  get enabled() {
    return this._followers.length > 0;
  }

  get followers() {
    return [...this._followers];
  }

  // ─── registry ─────────────────────────────────────────────────────────────

  register(sessionId, nodeUrl) {
    this._registry.set(sessionId, nodeUrl ?? null);
  }

  unregister(sessionId) {
    this._registry.delete(sessionId);
  }

  /** Returns the node URL for a session, null for self, undefined if unknown. */
  lookup(sessionId) {
    return this._registry.get(sessionId);
  }

  // ─── internal ─────────────────────────────────────────────────────────────

  _nextNode() {
    const node = this._pool[this._index % this._pool.length];
    this._index++;
    return node; // null = self
  }

  // ─── middleware ────────────────────────────────────────────────────────────

  /**
   * Express middleware — mount at /sessions.
   *
   * POST /    → round-robin; if follower wins, proxy and register; if self, let
   *             the route handler run and intercept the response to register.
   * /:id/...  → look up registry; proxy to follower or handle locally.
   */
  middleware() {
    return async (req, res, next) => {
      if (!this.enabled) return next();

      const path = req.path; // relative to the /sessions mount point

      // ── POST / — new session creation ──────────────────────────────────────
      if (req.method === 'POST' && path === '/') {
        const node = this._nextNode();

        if (node === null) {
          // Self's turn — intercept response to register the new session id
          const origJson = res.json.bind(res);
          res.json = (body) => {
            if (res.statusCode === 201 && body && body.id) {
              this.register(body.id, null);
            }
            return origJson(body);
          };
          return next();
        }

        // Follower's turn — proxy and register
        return this._proxyNewSession(node, req, res);
      }

      // ── /:id and /:id/* — session-specific requests ────────────────────────
      const idMatch = path.match(/^\/([^/]+)/);
      if (idMatch) {
        const sessionId = idMatch[1];
        const node = this._registry.get(sessionId);

        if (node === undefined) {
          // Unknown session — let local handler return 404 (or find it if local)
          return next();
        }

        if (node === null) {
          // Owned by self
          if (req.method === 'DELETE' && /^\/[^/]+$/.test(path)) {
            // Unregister after deletion
            const origJson = res.json.bind(res);
            res.json = (body) => {
              this.unregister(sessionId);
              return origJson(body);
            };
          }
          return next();
        }

        // Owned by a follower — proxy the whole request
        if (req.method === 'DELETE' && /^\/[^/]+$/.test(path)) {
          try {
            const response = await this._proxyRequest(node, req);
            this.unregister(sessionId);
            res.setHeader('x-playbig-node', node);
            return res.status(response.status).json(response.data);
          } catch (err) {
            return res.status(502).json({ error: 'Upstream follower error', detail: err.message });
          }
        }

        return this._proxyAndRespond(node, req, res);
      }

      next();
    };
  }

  // ─── proxy helpers ─────────────────────────────────────────────────────────

  async _proxyNewSession(nodeUrl, req, res) {
    try {
      const response = await axios({
        method:       'POST',
        url:          `${nodeUrl}/sessions`,
        data:         req.body,
        headers:      { 'content-type': 'application/json', 'x-forwarded-by': 'playbig-leader' },
        timeout:      60_000,
        responseType: 'json',
        validateStatus: () => true,
      });
      if (response.status === 201 && response.data && response.data.id) {
        this.register(response.data.id, nodeUrl);
      }
      res.setHeader('x-playbig-node', nodeUrl);
      res.status(response.status).json(response.data);
    } catch (err) {
      res.status(502).json({ error: 'Upstream follower error', detail: err.message });
    }
  }

  async _proxyRequest(nodeUrl, req) {
    const url = `${nodeUrl}/sessions${req.path}`;
    return axios({
      method:       req.method,
      url,
      data:         ['POST', 'PUT', 'PATCH'].includes(req.method) ? req.body : undefined,
      params:       Object.keys(req.query).length ? req.query : undefined,
      headers:      { 'content-type': 'application/json', 'x-forwarded-by': 'playbig-leader' },
      timeout:      60_000,
      responseType: 'json',
      validateStatus: () => true,
    });
  }

  async _proxyAndRespond(nodeUrl, req, res) {
    try {
      const response = await this._proxyRequest(nodeUrl, req);
      res.setHeader('x-playbig-node', nodeUrl);
      res.status(response.status).json(response.data);
    } catch (err) {
      res.status(502).json({ error: 'Upstream follower error', detail: err.message });
    }
  }

  // ─── diagnostics ───────────────────────────────────────────────────────────

  status() {
    return {
      enabled:            this.enabled,
      followers:          this._followers,
      poolSize:           this._pool.length,
      registeredSessions: this._registry.size,
      nextIndex:          this._index,
    };
  }
}

const forwarder = new Forwarder();
module.exports = { forwarder, Forwarder };
