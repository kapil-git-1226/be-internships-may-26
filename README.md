# Signals Challenge (Node.js + Fastify)

Build a minimal production-leaning service that can **handle load**, **rate limit**, and **avoid duplicates** via idempotency.

## Endpoints

- `POST /v1/signals`
  - body: `{ "userId": "string", "type": "string", "payload": "string" }`
  - headers: `X-API-Key`, `Idempotency-Key` (optional)
  - behaviors:
    - **Rate limit** per `userId`: `RATE_LIMIT_PER_MIN` per minute (default 5).
    - **Idempotency**: same `Idempotency-Key` will never create a duplicate row.
- `GET /v1/signals?userId=...&limit=...`
- `GET /healthz`

---

## Implementation Highlights

### 1. Rate Limiter (`src/rateLimit.js`)

Implements a **true sliding-window** algorithm using a per-user ring buffer of request timestamps.

- **Correctness**: Evicts timestamps older than the window on every call. Unlike fixed-window counters, a user cannot exploit window boundaries to double their quota.
- **Concurrency (single process)**: JavaScript is single-threaded; the Map is never accessed from two call frames simultaneously, so no atomic primitive is needed in-process.
- **Multi-instance safety**: Replace the Map with a **Redis sorted-set Lua script** (`ZADD` + `ZREMRANGEBYSCORE` + `ZCARD` in one atomic command). See `SCALE.md` for the full script.

### 2. Atomic Idempotency (`src/signals.js` + `src/db.js`)

Uses **`INSERT OR IGNORE … / SELECT`** (SQLite) which maps to **`INSERT … ON CONFLICT DO NOTHING RETURNING *`** in Postgres.

- **No check-then-insert race**: Two concurrent requests with the same `Idempotency-Key` cannot both succeed at the insert level. SQLite's `UNIQUE` constraint on `idempotency_key` is enforced atomically. One INSERT wins; the loser gets `changes = 0` and the SELECT returns the winner's row — both callers receive the identical response body.
- **Restart-safe**: The row is in the DB before the response is sent; restarts can replay the key safely.

### 3. Retry / Backoff (`src/db.js` — `withRetry`)

All DB calls go through `withRetry(fn, maxRetries=4)`:

- Exponential backoff with **full jitter**: `delay = rand(0, base * 2^attempt)`.
- Retries only transient codes (`SQLITE_BUSY`, `SQLITE_LOCKED`, `simulated_db_failure`).
- Because the upsert is idempotent, retries never create duplicate rows.

### 4. SQLite Optimizations

- **WAL mode**: allows concurrent readers during writes, improving throughput.
- **Prepared statements**: created once at startup, reused on every call (no re-parsing).
- **Indexes**: `(user_id, created_at DESC)` for list queries; partial index on `idempotency_key` for O(log n) lookup.

---

## Running

```bash
cp .env.example .env
npm install
npm run dev
```

## Testing

```bash
npm test
```

Tests cover:
- Idempotency (single key, concurrent burst of 10, no key)
- Rate limiting (sequential, per-user isolation, concurrent burst)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | `change-me` | Secret for `X-API-Key` header |
| `PORT` | `8080` | Listening port |
| `DATABASE_URL` | `./data/signals.db` | SQLite file path |
| `RATE_LIMIT_PER_MIN` | `5` | Max requests per user per minute |
| `DB_FAIL_RATE` | `0` | Fraction of DB calls that fail (0–1) for chaos testing |

---

## Scale Plan

See [`SCALE.md`](./SCALE.md) for the full 10k RPS design, including Redis-backed rate limiting, multi-instance idempotency, Postgres migration path, connection pooling, observability, and failure modes.
