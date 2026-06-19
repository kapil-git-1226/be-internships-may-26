/**
 * db.js — SQLite adapter using node-sqlite3-wasm (pure WebAssembly)
 *
 * node-sqlite3-wasm has the same synchronous API as better-sqlite3
 * but compiles to WASM so it works on any Node version without
 * Visual Studio / node-gyp / native compilation.
 */
import sqlite3 from 'node-sqlite3-wasm';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new sqlite3.Database(dbPath);

// WAL mode for better concurrent read performance
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

// Schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_idem_key ON signals(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`);

// ---------------------------------------------------------------------------
// Failure simulation
// ---------------------------------------------------------------------------
function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retry / backoff with jitter
// ---------------------------------------------------------------------------
const MAX_RETRIES = 8;
const BASE_DELAY_MS = 50;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * withRetry - wraps any fn() that may throw a transient DB error.
 * Uses exponential backoff + full jitter: delay = rand(0, base * 2^attempt)
 * Idempotency is preserved: on retry, upsertSignal finds the existing row.
 */
export async function withRetry(fn, retries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const isTransient =
        err.code === 'SQLITE_BUSY' ||
        err.code === 'SQLITE_LOCKED' ||
        err.message === 'simulated_db_failure';
      if (!isTransient || attempt === retries) throw err;
      const cap = BASE_DELAY_MS * Math.pow(2, attempt);
      const delay = Math.random() * cap; // full jitter
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Prepared statements (created once, reused)
// ---------------------------------------------------------------------------
const stmtInsertOrIgnore = db.prepare(
  'INSERT OR IGNORE INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
);

const stmtGetByIdem = db.prepare(
  `SELECT id,
          user_id       AS userId,
          type,
          payload,
          idempotency_key AS idempotencyKey,
          created_at    AS createdAt
   FROM signals
   WHERE idempotency_key = ?`
);

const stmtInsert = db.prepare(
  'INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
);

const stmtList = db.prepare(
  `SELECT id,
          user_id       AS userId,
          type,
          payload,
          idempotency_key AS idempotencyKey,
          created_at    AS createdAt
   FROM signals
   WHERE user_id = ?
   ORDER BY created_at DESC
   LIMIT ?`
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * upsertSignal - ATOMIC idempotency via INSERT OR IGNORE + SELECT.
 *
 * SQLite's UNIQUE constraint on idempotency_key guarantees that two
 * concurrent requests with the same key cannot both insert a new row.
 * One will silently be ignored; the subsequent SELECT returns the winner.
 *
 * Returns { row, created }:
 *   - row:     the persisted signal object
 *   - created: true if this call inserted, false if it was a duplicate
 */
export function upsertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();

  if (idemKey) {
    // Atomic: INSERT OR IGNORE, then always SELECT
    const info = stmtInsertOrIgnore.run([userId, type, String(payload), idemKey, nowMs]);
    const row = stmtGetByIdem.get([idemKey]);
    return { row, created: info.changes === 1 };
  }

  // No idempotency key: plain insert
  maybeFail();
  const info = stmtInsert.run([userId, type, String(payload), null, nowMs]);
  return {
    row: {
      id: info.lastInsertRowid,
      userId,
      type,
      payload: String(payload),
      idempotencyKey: null,
      createdAt: nowMs,
    },
    created: true,
  };
}

export function getByIdemKey(idemKey) {
  maybeFail();
  return stmtGetByIdem.get([idemKey]);
}

export function listSignals(userId, limit) {
  maybeFail();
  return stmtList.all([userId, limit]);
}
