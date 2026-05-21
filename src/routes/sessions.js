'use strict';

const express = require('express');
const { sessionManager } = require('../session-manager');
const { lookupKey, validateKey } = require('../db');

const router = express.Router();

// ── Auth ────────────────────────────────────────────────────────────────────
// When REQUIRE_SESSION_AUTH=1, every /sessions request must carry a valid
// API key in `Authorization: Bearer <key>` (same key store the MCP route
// uses, managed via /admin/keys). Default-off so standalone playbig
// deployments keep working; the herd sidecar sets it to 1 so untrusted
// bwrap'd steps can't reach /sessions by guessing the localhost port.
//
// On success the matched key row is attached to req.apiKey so downstream
// routes (notably POST /sessions) can stamp the session with the caller's
// label — used by the usage callback for attribution back to a user/job.
function sessionAuth(req, res, next) {
  if (process.env.REQUIRE_SESSION_AUTH !== '1') return next();
  const auth = req.headers['authorization'] || '';
  const key  = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!key) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing access key' });
  }
  const row = lookupKey(key);
  if (!row) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing access key' });
  }
  req.apiKey = row;
  next();
}
router.use(sessionAuth);
// validateKey kept around for older call sites that still use it.
void validateKey;

// ── POST /sessions ─────────────────────────────────────────────────────────
// Create a new isolated browser session.
// Body: { url?, options?: { launch?, context?, waitUntil?, timeout? } }
router.post('/', async (req, res, next) => {
  try {
    const { url, options } = req.body || {};
    // The auth middleware leaves req.apiKey populated (or undefined when
    // REQUIRE_SESSION_AUTH is off). Forward the matched key's label to
    // the session so the usage callback can attribute it back to a user.
    const apiKeyLabel = req.apiKey?.label ?? null;
    const apiKeyId    = req.apiKey?.id    ?? null;
    const id      = await sessionManager.createSession({
      url, options, apiKeyLabel, apiKeyId,
    });
    const session = sessionManager.getSession(id);
    res.status(201).json(sessionManager.sessionInfo(session));
  } catch (err) { next(err); }
});

// ── GET /sessions ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({ sessions: sessionManager.listSessions() });
});

// ── GET /sessions/:id ──────────────────────────────────────────────────────
router.get('/:id', (req, res, next) => {
  try {
    const s = sessionManager.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    res.json(sessionManager.sessionInfo(s));
  } catch (err) { next(err); }
});

// ── DELETE /sessions/:id ───────────────────────────────────────────────────
// Kills the browser and removes the session.
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await sessionManager.endSession(req.params.id);
    res.json(result);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

// ── POST /sessions/:id/action ──────────────────────────────────────────────
// Run a named Playwright action on the session.
// Body: { action: string, params?: object }
//
// Actions (see session-manager.js for full list):
//   navigate, reload, back, forward, url, title, content,
//   click, dblclick, fill, type, pressKey, hover, select, check, uncheck, focus,
//   waitForSelector, waitForNavigation, waitForLoadState, waitForTimeout,
//   getAttribute, innerText, innerHTML, inputValue, isVisible, isEnabled, isChecked, count,
//   setViewport (alias: resize), scroll,
//   snapshot   ← accessibility tree
//   handleDialog, dialogs,
//   uploadFile,
//   cookies, setCookies, clearCookies,
//   screenshot, pdf,
//   evaluate   ← runs in BROWSER context (page.evaluate)
//   exec       ← runs on SERVER with (page, context, browser) available
router.post('/:id/action', async (req, res, next) => {
  try {
    const { action, params } = req.body || {};
    if (!action) return res.status(400).json({ error: '"action" is required' });
    const result = await sessionManager.runAction(req.params.id, action, params || {});
    res.json({ ok: true, result });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// ── GET /sessions/:id/logs ─────────────────────────────────────────────────
// Query params: since=<timestamp_ms>  type=<log|warn|error|info|…>
router.get('/:id/logs', (req, res, next) => {
  try {
    const s = sessionManager.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });

    let logs   = s.consoleLogs;
    let errors = s.pageErrors;

    if (req.query.since) {
      const since = parseInt(req.query.since, 10);
      logs   = logs.filter(l => l.timestamp > since);
      errors = errors.filter(e => e.timestamp > since);
    }
    if (req.query.type) {
      logs = logs.filter(l => l.type === req.query.type);
    }

    res.json({ logs, pageErrors: errors });
  } catch (err) { next(err); }
});

// ── DELETE /sessions/:id/logs ──────────────────────────────────────────────
router.delete('/:id/logs', (req, res, next) => {
  try {
    const s = sessionManager.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    s.consoleLogs = [];
    s.pageErrors  = [];
    res.json({ cleared: true });
  } catch (err) { next(err); }
});

// ── GET /sessions/:id/network ──────────────────────────────────────────────
// Query params: since=<timestamp_ms>  url=<substring filter>
router.get('/:id/network', (req, res, next) => {
  try {
    const s = sessionManager.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });

    let requests  = s.networkRequests;
    let responses = s.networkResponses;

    if (req.query.since) {
      const since = parseInt(req.query.since, 10);
      requests  = requests.filter(r => r.timestamp > since);
      responses = responses.filter(r => r.timestamp > since);
    }
    if (req.query.url) {
      const needle = req.query.url;
      requests  = requests.filter(r => r.url.includes(needle));
      responses = responses.filter(r => r.url.includes(needle));
    }

    res.json({ requests, responses });
  } catch (err) { next(err); }
});

// ── DELETE /sessions/:id/network ───────────────────────────────────────────
router.delete('/:id/network', (req, res, next) => {
  try {
    const s = sessionManager.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    s.networkRequests  = [];
    s.networkResponses = [];
    res.json({ cleared: true });
  } catch (err) { next(err); }
});

module.exports = router;
