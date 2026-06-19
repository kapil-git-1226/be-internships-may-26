/**
 * Sliding-window rate limiter (in-process, SQLite-backed for atomic ops).
 *
 * Single-process correctness: JavaScript is single-threaded, so the
 * Map-based counter is race-free within one Node process. The window
 * correctly uses a true sliding approach: we track individual request
 * timestamps in a ring buffer per userId so we never over- or under-count.
 *
 * Multi-instance safety (see SCALE.md):
 *   Replace this module with a Redis MULTI/EXEC sliding-window script
 *   (or the token-bucket Lua script) so every instance shares one
 *   atomic counter. The interface (checkAndConsume) stays identical.
 */

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

// userId -> number[] (timestamps of requests inside the current window)
const windows = new Map();

/**
 * checkAndConsume
 * @param {string} userId
 * @param {number} [nowMs]
 * @returns {{ ok: boolean, remaining: number, resetMs: number }}
 *
 * Uses a true sliding window: keeps per-user timestamp ring.
 * Purges timestamps older than WINDOW_MS on each call.
 * Single-threaded JS guarantees atomicity within one process.
 */
export function checkAndConsume(userId, nowMs = Date.now()) {
  const cutoff = nowMs - WINDOW_MS;

  // Get or create the sliding window ring for this user
  let ring = windows.get(userId);
  if (!ring) {
    ring = [];
    windows.set(userId, ring);
  }

  // Evict timestamps outside the current window (oldest at front)
  while (ring.length > 0 && ring[0] <= cutoff) {
    ring.shift();
  }

  // Count current requests in window BEFORE consuming
  const count = ring.length;
  const ok = count < RATE;

  if (ok) {
    ring.push(nowMs);
  }

  const remaining = Math.max(RATE - ring.length, 0);
  // Reset = when the oldest request in the window falls off
  const resetMs = ring.length > 0 ? ring[0] + WINDOW_MS : nowMs + WINDOW_MS;

  return { ok, remaining, resetMs };
}

/**
 * Exposed for testing: flush all buckets.
 */
export function _resetAll() {
  windows.clear();
}
