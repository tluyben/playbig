'use strict';

const Database    = require('better-sqlite3');
const { randomBytes } = require('crypto');

// ── Schema setup ─────────────────────────────────────────────────────────────

function _init(db) {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_keys (
      id         TEXT    PRIMARY KEY,
      key        TEXT    UNIQUE NOT NULL,
      label      TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  return db;
}

// ── Instance factory (used directly in tests with ':memory:') ─────────────────

function createDb(path) {
  const d = _init(new Database(path));

  function createKey(label) {
    const id  = randomBytes(4).toString('hex');
    const key = `pbk_${randomBytes(24).toString('hex')}`;
    const now = Date.now();
    d.prepare('INSERT INTO access_keys (id, key, label, created_at) VALUES (?, ?, ?, ?)').run(id, key, label || null, now);
    return { id, key, label: label || null, created_at: now };
  }

  function deleteKey(key) {
    return d.prepare('DELETE FROM access_keys WHERE key = ?').run(key).changes > 0;
  }

  function listKeys() {
    return d.prepare('SELECT id, key, label, created_at FROM access_keys ORDER BY created_at DESC').all();
  }

  function validateKey(key) {
    return d.prepare('SELECT 1 FROM access_keys WHERE key = ?').get(key) != null;
  }

  function close() { d.close(); }

  return { createKey, deleteKey, listKeys, validateKey, close };
}

// ── Module-level singleton (production) ──────────────────────────────────────

let _default = null;

function _defaultDb() {
  if (!_default) _default = createDb(process.env.DB_PATH || './content.db');
  return _default;
}

function createKey(label)  { return _defaultDb().createKey(label); }
function deleteKey(key)    { return _defaultDb().deleteKey(key); }
function listKeys()        { return _defaultDb().listKeys(); }
function validateKey(key)  { return _defaultDb().validateKey(key); }

module.exports = { createKey, deleteKey, listKeys, validateKey, createDb };
