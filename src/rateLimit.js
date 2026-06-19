const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;
const buckets = new Map();

export function checkAndConsume(userId, nowMs = Date.now()) {
  const wStart = nowMs - WINDOW_MS;
  const ent = buckets.get(userId) || { ts: nowMs, cnt: 0 };
  if (ent.ts < wStart) {
    ent.ts = nowMs;
    ent.cnt = 0;
  }
  ent.cnt += 1;
  buckets.set(userId, ent);
  const ok = ent.cnt <= RATE;
  const resetMs = ent.ts + WINDOW_MS;
  const remaining = Math.max(RATE - ent.cnt, 0);
  return { ok, remaining, resetMs };
}
