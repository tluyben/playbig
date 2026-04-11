'use strict';

// ── Admin key-management routes ───────────────────────────────────────────────
//
// All routes require:  Authorization: Bearer <ADMIN_SECRET>
//
// ADMIN_SECRET must be set in the environment; if it is absent the entire
// endpoint returns 503 so the service is safe to deploy without it.
//
// These routes are intentionally NOT mounted under /sessions and are therefore
// never forwarded to follower nodes — they are leader-local.

const express = require('express');
const { createKey, deleteKey, listKeys } = require('../db');

const router = express.Router();

// ── Admin auth ────────────────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(503).json({
      error: 'Key management is disabled: ADMIN_SECRET is not set in the environment.'
    });
  }
  if (req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(adminAuth);

// ── GET /admin/keys ───────────────────────────────────────────────────────────
// Returns all registered access keys.
router.get('/', (_req, res) => {
  res.json({ keys: listKeys() });
});

// ── POST /admin/keys ──────────────────────────────────────────────────────────
// Create a new access key.
// Body (optional): { label?: string }
// Response: { id, key, label, created_at }
router.post('/', (req, res) => {
  const { label } = req.body || {};
  const result = createKey(label);
  res.status(201).json(result);
});

// ── DELETE /admin/keys/:key ───────────────────────────────────────────────────
// Revoke an access key.
router.delete('/:key', (req, res) => {
  if (!deleteKey(req.params.key)) {
    return res.status(404).json({ error: 'Key not found' });
  }
  res.json({ deleted: true });
});

module.exports = router;
