// ─── Persistent OHLCV bars cache (SQLite-backed) ────────────────────────────
//
// Why this exists:
//   getHistoryFull's in-memory cache (TTL_HIST=23h) gets wiped on every
//   server restart. With a 1620-symbol universe, the first scan after boot
//   paid the full provider sweep — Alpaca rate-limits per-symbol calls at
//   ~200/min, so the wall time was 7-8 minutes. With this cache backed by
//   SQLite, restart is free: the next scan reads from disk in <1s.
//
// Freshness model:
//   - "Fresh" = the cache contains a bar dated today (during/after market
//     close) OR last-trading-day (before today's session has data).
//   - If fresh, return cached bars; provider not consulted.
//   - If stale (last bar older than expected), fetch from provider, splice
//     the new bars in (INSERT OR REPLACE), return the merged dataset.
//
// Today's bar handling:
//   During market hours we want a *live* today bar (changing intraday).
//   The cache shouldn't pin yesterday's close as "today" — we only consider
//   the cache fresh once today's session has closed AND we've persisted a
//   bar dated today. Before market close, "fresh" means "has bars through
//   the last completed trading day."
//
// Single-user assumption:
//   No row-level locking; better-sqlite3 uses a single writer. Our scanner
//   parallelism is bounded by pLimit at the call site, so concurrent writes
//   to the same symbol are rare. INSERT OR REPLACE is idempotent if it does.

const { getDB } = require('./database');

// Maximum age in trading days that we'll accept before a refresh is
// triggered. Set to 1 so a session-end bar from yesterday triggers a
// refresh during today's session — keeps the live scan honest.
const MAX_STALE_TRADING_DAYS = 1;

// ── Trading-calendar helpers (US equities) ───────────────────────────────
// We don't have a real holiday calendar wired up — these helpers are
// "business-day" approximations: weekends excluded, holidays ignored. A
// holiday will cause one extra cache-miss per affected symbol (the cache
// thinks "1 trading day stale" → fetches from provider → provider returns
// the same set of bars → cache stays consistent). Acceptable.

function todayET() {
  // YYYY-MM-DD in America/New_York. Matches the date keys provider modules
  // emit (they all derive from epoch seconds → toISOString slice).
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');  // noon UTC, no DST hassles
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function lastWeekdayOnOrBefore(dateStr) {
  let d = dateStr;
  while (isWeekend(d)) {
    const dt = new Date(d + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 1);
    d = dt.toISOString().slice(0, 10);
  }
  return d;
}

function priorWeekday(dateStr) {
  const dt = new Date(dateStr + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  return lastWeekdayOnOrBefore(dt.toISOString().slice(0, 10));
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Read all cached bars for a symbol. Returns [] if symbol unknown.
 * Bars are sorted ascending by date.
 */
function getCachedBars(symbol) {
  try {
    const db = getDB();
    const rows = db.prepare(
      `SELECT date, open, high, low, close, volume
       FROM daily_bars
       WHERE symbol = ?
       ORDER BY date ASC`
    ).all(symbol);
    return rows;
  } catch (_) {
    return [];
  }
}

/**
 * Persist a batch of bars for a symbol. Idempotent (INSERT OR REPLACE).
 * Skips rows missing a date or close (provider quirks — keep the table
 * useful instead of poisoning it with NULL closes).
 */
function saveBars(symbol, bars) {
  if (!Array.isArray(bars) || bars.length === 0) return 0;
  try {
    const db = getDB();
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO daily_bars (symbol, date, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows) => {
      let n = 0;
      for (const b of rows) {
        if (!b || !b.date || b.close == null) continue;
        stmt.run(
          symbol,
          b.date,
          b.open ?? null,
          b.high ?? null,
          b.low ?? null,
          b.close,
          b.volume ?? 0
        );
        n++;
      }
      return n;
    });
    return insertMany(bars);
  } catch (_) {
    return 0;
  }
}

/**
 * Is the cache fresh enough to skip a provider fetch?
 *
 * "Fresh" means the most recent cached bar is dated today (post-close) or
 * yesterday's last weekday (pre-close on a regular session). On weekends
 * Friday's bar counts as fresh through Monday open.
 *
 * Returns false if no bars exist or the gap exceeds MAX_STALE_TRADING_DAYS
 * weekday-business-days.
 */
function isFresh(symbol) {
  try {
    const db = getDB();
    const row = db.prepare(
      `SELECT MAX(date) AS last FROM daily_bars WHERE symbol = ?`
    ).get(symbol);
    if (!row || !row.last) return false;

    const today = todayET();
    const expected = lastWeekdayOnOrBefore(today);
    if (row.last >= expected) return true;

    // Allow up to MAX_STALE_TRADING_DAYS business-day lag (e.g. before a
    // session has produced a today bar, accept yesterday's close).
    let probe = expected;
    for (let i = 0; i < MAX_STALE_TRADING_DAYS; i++) {
      probe = priorWeekday(probe);
      if (row.last >= probe) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Per-symbol stats — useful for diagnostics endpoints. {count, first, last}.
 */
function stats(symbol) {
  try {
    const db = getDB();
    return db.prepare(
      `SELECT COUNT(*) AS count, MIN(date) AS first, MAX(date) AS last
       FROM daily_bars WHERE symbol = ?`
    ).get(symbol);
  } catch (_) {
    return { count: 0, first: null, last: null };
  }
}

module.exports = {
  getCachedBars,
  saveBars,
  isFresh,
  stats,
};
