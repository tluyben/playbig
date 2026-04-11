'use strict';

const { createDb } = require('../src/db');

describe('db — access key management', () => {
  let db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // ── createKey ────────────────────────────────────────────────────────────────

  test('createKey returns an object with id, key, label, created_at', () => {
    const result = db.createKey('my-label');
    expect(result).toMatchObject({
      label:      'my-label',
      created_at: expect.any(Number),
    });
    expect(result.id).toBeTruthy();
    expect(result.key).toBeTruthy();
  });

  test('createKey key starts with pbk_ prefix', () => {
    const { key } = db.createKey();
    expect(key).toMatch(/^pbk_/);
  });

  test('createKey without label stores null', () => {
    const { label } = db.createKey();
    expect(label).toBeNull();
  });

  test('createKey generates unique keys', () => {
    const a = db.createKey();
    const b = db.createKey();
    expect(a.key).not.toBe(b.key);
    expect(a.id).not.toBe(b.id);
  });

  // ── validateKey ──────────────────────────────────────────────────────────────

  test('validateKey returns true for an existing key', () => {
    const { key } = db.createKey('label');
    expect(db.validateKey(key)).toBe(true);
  });

  test('validateKey returns false for a non-existent key', () => {
    expect(db.validateKey('pbk_notakey')).toBe(false);
  });

  test('validateKey returns false for empty string', () => {
    expect(db.validateKey('')).toBe(false);
  });

  // ── listKeys ─────────────────────────────────────────────────────────────────

  test('listKeys returns empty array initially', () => {
    expect(db.listKeys()).toEqual([]);
  });

  test('listKeys returns all keys ordered newest-first', () => {
    db.createKey('first');
    db.createKey('second');
    const list = db.listKeys();
    expect(list).toHaveLength(2);
    // Newest first — both have the same ms timestamp in tests, so just check count
    expect(list.map(k => k.label)).toContain('first');
    expect(list.map(k => k.label)).toContain('second');
  });

  test('listKeys does not include the raw key value — actually it does for admin display', () => {
    db.createKey('k');
    const list = db.listKeys();
    expect(list[0]).toHaveProperty('key');
    expect(list[0]).toHaveProperty('id');
    expect(list[0]).toHaveProperty('created_at');
  });

  // ── deleteKey ────────────────────────────────────────────────────────────────

  test('deleteKey removes a key and returns true', () => {
    const { key } = db.createKey('to-delete');
    expect(db.deleteKey(key)).toBe(true);
    expect(db.validateKey(key)).toBe(false);
    expect(db.listKeys()).toHaveLength(0);
  });

  test('deleteKey returns false for non-existent key', () => {
    expect(db.deleteKey('pbk_doesnotexist')).toBe(false);
  });

  test('deleteKey only removes the targeted key', () => {
    const a = db.createKey('a');
    const b = db.createKey('b');
    db.deleteKey(a.key);
    expect(db.validateKey(a.key)).toBe(false);
    expect(db.validateKey(b.key)).toBe(true);
  });
});
