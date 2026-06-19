import { upsertSignal, listSignals, withRetry } from './db.js';
import { checkAndConsume } from './rateLimit.js';

function nowMs() {
  return Date.now();
}

/**
 * POST /v1/signals
 *
 * Idempotency: Uses atomic INSERT OR IGNORE + SELECT in db.upsertSignal.
 * This eliminates the classic check-then-insert race condition: even if
 * two concurrent requests arrive simultaneously with the same Idempotency-Key,
 * SQLite's UNIQUE constraint ensures only one row is ever created, and both
 * callers receive the identical resource.
 *
 * Retry: withRetry() handles transient DB failures (SQLITE_BUSY, simulated
 * DB_FAIL_RATE) with exponential backoff + full jitter. Because upsertSignal
 * is idempotent, retrying never creates duplicate rows.
 */
export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};

  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  // Rate limit check (in-process sliding window; see rateLimit.js for multi-instance notes)
  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) {
    return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
  }

  try {
    const t = nowMs();

    // withRetry wraps the upsert to handle transient failures.
    // upsertSignal is atomic: safe to retry without creating duplicates.
    const { row, created } = await withRetry(() =>
      upsertSignal(userId, type, payload, idem, t)
    );

    // Return 200 for both new and duplicate idempotent requests (same body).
    // Some APIs use 201 for created and 200 for replay; we keep it simple with 200.
    const statusCode = created ? 201 : 200;
    return reply.code(statusCode).send({
      id: row.id,
      userId: row.userId,
      type: row.type,
      payload: row.payload,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
    });
  } catch (e) {
    req.log.error({ err: e, ctx: 'postSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

/**
 * GET /v1/signals?userId=...&limit=...
 */
export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });

  const lim = Math.min(Number(limit) || 20, 100);

  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return reply.code(200).send({ items: rows });
  } catch (e) {
    req.log.error({ err: e, ctx: 'getSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
