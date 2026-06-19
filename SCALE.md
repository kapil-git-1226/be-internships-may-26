# Scale Plan — 10k RPS

## 1. Data Model & Indexes

```sql
-- Signals table (current schema, production-ready)
CREATE TABLE signals (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT      NOT NULL,
  type            TEXT      NOT NULL,
  payload         TEXT      NOT NULL,
  idempotency_key TEXT      UNIQUE,          -- enforces atomic idempotency
  created_at      BIGINT    NOT NULL
);

-- Critical indexes
CREATE INDEX idx_user_created   ON signals (user_id, created_at DESC);  -- GET /v1/signals
CREATE INDEX idx_idem_key       ON signals (idempotency_key)
  WHERE idempotency_key IS NOT NULL;                                     -- idempotency lookup
```

At 10k RPS with 60-byte average row, writes ≈ 600 KB/s — manageable for a single Postgres primary with SSD. Partition `signals` by `created_at` month if you expect > 500 M rows.

---

## 2. Idempotency Across Instances

**Current (single-process):**
`INSERT OR IGNORE … / SELECT` on SQLite — race-free within one process.

**Production (multi-instance):**
Replace with one of:

| Pattern | How |
|---|---|
| **DB UNIQUE + upsert** | `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` — atomic in Postgres, survives concurrent writers |
| **Redis atomic SET NX** | `SET idem:{key} {rowId} EX 86400 NX` — first caller wins, all others read the cached response; eliminates DB for hot keys |
| **Distributed lock** | Redlock on `idem:{key}` for 500 ms; only one writer reaches DB; safe but adds latency |

**Recommended**: DB `ON CONFLICT DO NOTHING` + Redis cache of responses (TTL 24 h). Zero extra infra for the happy path; Redis absorbs repeated reads.

---

## 3. Rate Limiting Across Instances

**Current (single-process):**
In-memory sliding-window (JavaScript Map of timestamp rings).
Correct within one process; breaks under horizontal scale because each instance has its own counter.

**Production — Redis sliding window (Lua script):**

```lua
-- atomic sliding window in Redis
local key    = KEYS[1]                  -- "rl:{userId}"
local now    = tonumber(ARGV[1])        -- epoch ms
local window = tonumber(ARGV[2])        -- 60000 ms
local limit  = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, now .. math.random())
  redis.call('PEXPIRE', key, window)
  return 1   -- allowed
end
return 0     -- rejected
```

- Single-threaded Lua in Redis = no races.
- One RTT per request (~0.2 ms on localhost, ~1 ms in same AZ).
- At 10k RPS and 1k unique users → ~10 req/user/s; Redis can handle 1 M ops/s.

**Fallback**: If Redis is down, fail open (allow) or fall back to per-pod limits with a known over-counting risk — acceptable for a short outage window.

---

## 4. Observability

| Signal | How |
|---|---|
| **Structured logs** | Fastify `pino` JSON logs → shipped to Loki / CloudWatch Logs |
| **RED metrics** | `prom-client`: `http_requests_total{route,status}`, `http_request_duration_seconds` → Prometheus + Grafana |
| **Rate limit hits** | Counter `rate_limit_rejected_total{userId}` — alert if > 1 % of traffic |
| **DB errors** | Counter `db_error_total{code}` — alert on any `SQLITE_BUSY` / Postgres errors |
| **Retry exhaustion** | Counter `db_retry_exhausted_total` — page on-call immediately |
| **Idempotency replay %** | `(idem_replays / total_posts) * 100` — spikes mean clients are retrying too aggressively |

**Tracing**: Add `x-request-id` header propagation; emit OpenTelemetry spans for DB calls.

---

## 5. Failure Modes

| Failure | Mitigation |
|---|---|
| **DB transient (SQLITE_BUSY / Postgres lock)** | Exponential backoff + full jitter, max 4 retries (~750 ms worst-case). Idempotent upsert makes retries safe. |
| **DB complete outage** | Circuit breaker (e.g. `opossum`): opens after 5 consecutive failures; returns `503` immediately; half-opens after 30 s. |
| **Redis down (rate limiter)** | Fail open: allow requests, log warning. Alternatively, fall back to per-pod in-memory counter. |
| **Partial DB outage (replica lag)** | Always write/read idempotency checks against primary. Use replica only for `GET /v1/signals`. |
| **OOM / crash** | PM2 / Kubernetes restarts process; SQLite WAL ensures no partial writes; Redis state survives. |
| **Idempotency key collision** | Key space is client-controlled (UUID v4 recommended). Server treats key as opaque; UNIQUE index prevents collision side-effects. |

---

## 6. 10k RPS Design Sketch

### Architecture

```
                    ┌─────────────────┐
 clients ──────────►│  Load Balancer  │  (AWS ALB / nginx)
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  Node.js │  │  Node.js │  │  Node.js │  × N pods
        │ (Fastify)│  │ (Fastify)│  │ (Fastify)│
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │              │              │
     ┌───────┴──────────────┴──────────────┴───────┐
     │              Redis Cluster                   │  rate limit + idem cache
     └───────────────────────┬──────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Postgres (RDS) │  primary (writes)
                    │  + Read Replica │  (GET queries)
                    └─────────────────┘
```

### Sizing (rough)

| Component | Spec | Cost/mo (AWS us-east-1) |
|---|---|---|
| **Node.js pods** | 8 × `t3.small` (2 vCPU, 2 GB) | ~$120 |
| **Redis** | `cache.r7g.large` ElastiCache cluster | ~$130 |
| **Postgres** | `db.r7g.large` RDS Multi-AZ | ~$300 |
| **ALB** | 10k RPS ≈ 0.5 LCU | ~$20 |
| **Total** | | **~$570/mo** |

### Throughput math

- Node.js Fastify on `t3.small`: ~2–3 k RPS per pod (mostly I/O wait).
- 8 pods × 2.5 k = **20k RPS headroom** — 2× buffer over target.
- Redis: 1 M ops/s capacity; at 10k RPS we use ~10k ops/s (rate limit + idem cache).
- Postgres: 10k writes/s feasible on `r7g.large` with WAL + connection pooling (PgBouncer).

### Connection pooling

Use **PgBouncer** in transaction mode between Node pods and Postgres:
- 8 pods × 10 conns = 80 pg connections (instead of 800).
- Postgres max_connections stays at 200; reserved for monitoring and migrations.

### Queue for durability (optional)

For signals that must not be lost under DB outage:
- Publish to **SQS / Kafka** first, respond `202 Accepted`.
- Background consumer inserts into Postgres.
- Idempotency key stored in Redis until consumer confirms insert.
- Trades synchronous consistency for durability.
