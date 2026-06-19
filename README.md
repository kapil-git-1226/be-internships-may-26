# Signals Challenge (Node.js + Fastify)

Build a minimal production-leaning service that can **handle load**, **rate limit**, and **avoid duplicates** via idempotency.

## Endpoints (to keep)
- `POST /v1/signals`
  - body: `{ "userId": "string", "type": "string", "payload": "string" }`
  - headers: `X-API-Key`, `Idempotency-Key` (optional)
  - behaviors:
    - **Rate limit** per `userId`: `RATE_LIMIT_PER_MIN` per minute (default 5).
    - **Idempotency**: same `Idempotency-Key` should not create duplicates.
- `GET /v1/signals?userId=...&limit=...`
- `GET /healthz`

## Your Tasks
1. **Implement a robust rate limiter** in `src/rateLimit.js`.
2. **Make idempotency safe across scale** in `src/signals.js`.
3. **Handle DB failure** gracefully with retry/backoff.
4. **Think for 10k RPS.** Add a `SCALE.md`.
5. **Finish the tests** in `tests/*.test.js`.

## Deliverables
- Working service, passing tests, updated README, SCALE.md.
- Optional deploy link.
---

## Extra Production Constraints (must pass)

- **Atomic Idempotency:** Survive concurrent requests and restarts. Avoid check-then-insert races; use a DB-level unique constraint or atomic upsert pattern. Return the same resource for identical `Idempotency-Key`.
- **Concurrency-Safe Rate Limit:** Must behave correctly under burst and parallel calls. Naive in-memory counters that race will fail hidden checks. Explain how this becomes multi-instance safe.
- **Transient DB Failures:** Implement retry/backoff (with jitter) or circuit breaker when DB errors occur (we simulate via `DB_FAIL_RATE`). No duplicates on retry.
- **Scale Plan (10k RPS):** Fill `SCALE.md` with a clear, concise approach (indexes, pooling, caching, queues, horizontal scale, idempotency store).

> We will run additional **hidden concurrency/multi-instance tests** during evaluation.
