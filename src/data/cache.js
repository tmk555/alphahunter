// ─── In-memory cache with TTL ─────────────────────────────────────────────────
const CACHE = {};

const TTL_QUOTE = 10 * 60 * 1000;   // 10 min
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
