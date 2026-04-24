// ─── In-memory cache with TTL ─────────────────────────────────────────────────
const CACHE = {};

// Quotes used to be cached 10 min, which felt "cached" on the UI — a tile could
// display a price that was 9 minutes old and the user had no way to tell.
// 60s is a better compromise: still absorbs tight UI poll bursts (e.g. ticker
// bar + MarketPulse both hitting /api/macro within the same second) so we
// don't hammer upstream providers, but feels real-time on a per-minute
// refresh. Scanner / signal jobs that read quotes run on a multi-minute
// cadence anyway and won't notice the tighter TTL.
const TTL_QUOTE = 60 * 1000;          // 60 sec  (was 10 min)
const TTL_HIST  = 23 * 60 * 60 * 1000; // 23 hr

function cacheGet(key, ttl) {
  const i = CACHE[key];
  if (!i || Date.now() - i.ts > ttl) return null;
  return i.data;
}

function cacheSet(key, data) {
  CACHE[key] = { data, ts: Date.now() };
}

function cacheClear() {
  for (const key of Object.keys(CACHE)) delete CACHE[key];
}

module.exports = { CACHE, TTL_QUOTE, TTL_HIST, cacheGet, cacheSet, cacheClear };
