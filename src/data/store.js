// ─── Data persistence (SQLite for RS history, JSON for simple CRUD) ──────────
const fs   = require('fs');
const path = require('path');
const { getDB } = require('./database');

const DATA_DIR         = path.join(__dirname, '..', '..', 'data');
const WATCHLIST_FILE   = path.join(DATA_DIR, 'watchlist.json');
const CYCLE_STATE_FILE = path.join(DATA_DIR, 'cycle-state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Type constants used as keys for loadHistory/saveHistory
const RS_HISTORY   = 'stock';
const SEC_HISTORY  = 'sector';
const IND_HISTORY  = 'industry';

// Load RS history from SQLite — returns { date: { symbol: rank, ... }, ... }
function loadHistory(type) {
  const db = getDB();
  const rows = db.prepare(
    `SELECT date, symbol, rs_rank FROM rs_snapshots WHERE type = ? ORDER BY date`
  ).all(type);
  const h = {};
  for (const r of rows) {
    if (!h[r.date]) h[r.date] = {};
    // Add prefix for sector/industry to match existing code expectations
    const key = type === 'sector' ? 'SEC_' + r.symbol
              : type === 'industry' ? 'IND_' + r.symbol
              : r.symbol;
    h[r.date][key] = r.rs_rank;
  }
  return h;
}

// Save RS snapshot to SQLite — scores is { symbol: rank, ... }
// Upsert rs_rank only; never clobber columns written by the richer backfill path
// (price, stage, vcp_forming, rs_line_new_high, pattern_type, atr_pct, etc.).
function saveHistory(type, scores, dateStr) {
  const db = getDB();
  const upsert = db.prepare(`
    INSERT INTO rs_snapshots (date, symbol, type, rs_rank)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date, symbol, type) DO UPDATE SET rs_rank = excluded.rs_rank
  `);
  const txn = db.transaction(() => {
    for (const [key, rank] of Object.entries(scores)) {
      // Strip prefix for storage
      const symbol = key.replace(/^SEC_/, '').replace(/^IND_/, '');
      upsert.run(dateStr, symbol, type, rank);
    }
  });
  txn();

  // Note: pruning handled by rs_history_cleanup scheduler job (default keepDays: 365)
  // Removed aggressive 95-day prune that was destroying replay/backtest data
}

// ── Targeted RS-history readers ──────────────────────────────────────────────
//
// loadHistory() materializes the entire rs_snapshots table for a type into
// `{date: {symbol: rank}}`. With 3.7M+ stock-type rows that's a ~500MB
// allocation in V8 dictionary mode every call — and most callers only need
// 1-100 rows. The OOM the user hit (heap → 3.7GB, GC reclaiming <3%) traced
// back to multiple loadHistory() calls overlapping in scan + route paths.
//
// These helpers read only what each consumer actually needs. Keep loadHistory
// around for any caller we missed during the migration — but anything new
// should go through the targeted readers below.

const _PREFIX_BY_TYPE = { sector: 'SEC_', industry: 'IND_' };

function _stripPrefix(symbol) {
  return symbol.replace(/^(SEC_|IND_)/, '');
}

/**
 * Counts and most-recent date for a history type. Replaces
 *   const h = loadHistory(t); const dates = Object.keys(h).sort();
 *   { dateCount: dates.length, lastDate: dates[dates.length-1] }
 * for callers that only need the dimensions, not the data.
 *
 * COUNT(DISTINCT date) over 3.7M rows runs ~1.8s even with the
 * (date, type) index — slow enough to make /api/health feel hung. Cached
 * keyed on lastDate: when the scanner persists a new snapshot, lastDate
 * advances, the cache invalidates, and we recompute. MAX(date) alone is
 * an index-edge probe, so the freshness check is sub-ms.
 */
const _statsCache = {};   // type → { lastDate, dateCount }

function getHistoryStats(type) {
  try {
    const db = getDB();
    const last = db.prepare(
      `SELECT MAX(date) AS d FROM rs_snapshots WHERE type = ?`
    ).get(type)?.d || null;
    if (!last) return { dateCount: 0, lastDate: null };

    const cached = _statsCache[type];
    if (cached && cached.lastDate === last) {
      return { dateCount: cached.dateCount, lastDate: last };
    }
    const dateCount = db.prepare(
      `SELECT COUNT(DISTINCT date) AS n FROM rs_snapshots WHERE type = ?`
    ).get(type)?.n || 0;
    _statsCache[type] = { lastDate: last, dateCount };
    return { dateCount, lastDate: last };
  } catch (_) { return { dateCount: 0, lastDate: null }; }
}

/**
 * All distinct snapshot dates for a type, ascending. Cheap (one column,
 * indexed). Used by endpoints that need the date list without the
 * cross-product of every symbol's rank.
 */
function getHistoryDates(type) {
  try {
    return getDB().prepare(
      `SELECT DISTINCT date FROM rs_snapshots WHERE type = ? ORDER BY date ASC`
    ).all(type).map(r => r.date);
  } catch (_) { return []; }
}

/**
 * The single-date snapshot { symbol → rank } for a type. Returns the
 * prefixed key shape that loadHistory() emits (SEC_/IND_), so call sites
 * that did `history[date][SEC_XLK]` keep working when swapped in.
 */
function getSnapshotOnDate(type, date) {
  try {
    const rows = getDB().prepare(
      `SELECT symbol, rs_rank FROM rs_snapshots
       WHERE type = ? AND date = ?`
    ).all(type, date);
    const prefix = _PREFIX_BY_TYPE[type] || '';
    const out = {};
    for (const r of rows) out[prefix + r.symbol] = r.rs_rank;
    return out;
  } catch (_) { return {}; }
}

/**
 * Time series for one symbol — `[{date, rs_rank}, ...]` ascending. Replaces
 * loadHistory() + per-date drilling for the per-ticker `/api/rs-history?ticker=`
 * shape.
 */
function getSymbolHistory(type, symbol) {
  try {
    const cleanSym = _stripPrefix(symbol);
    return getDB().prepare(
      `SELECT date, rs_rank FROM rs_snapshots
       WHERE type = ? AND symbol = ?
       ORDER BY date ASC`
    ).all(type, cleanSym);
  } catch (_) { return []; }
}

/**
 * Bulk RS-trend computation — returns `Map<cleanSymbol, trend>` for all the
 * passed symbols. Same shape getRSTrend(ticker, history) returns:
 *   { current, direction, note, vs1w, vs2w, vs4w, vs1m, vs2m, vs3m }
 *
 * Performance shape (measured on the 3.7M-row stock table):
 *   - Full date-window scan (no symbols filter):  ~100 ms
 *   - IN-clause path with 1620 symbols (4×500):   ~6000 ms
 *   - IN-clause path with ~50 symbols:            ~30 ms
 *
 * The IN-clause is dramatically slower for large N — SQLite's planner
 * picks a less efficient lookup strategy than a clean date-range scan
 * over idx_rs_snapshots_date_type. So above LARGE_N we always do the
 * full scan and filter the resulting Map in JS.
 *
 * Cache: the full Map for each type is memoized keyed on lastDate. A new
 * scan persisting advances lastDate which auto-invalidates. lastDate
 * itself is an index-edge probe (~1 ms), so freshness checks are cheap.
 */
const LARGE_N = 200;
const _bulkTrendCache = {};   // type → { lastDate, fullMap }

function _buildAllTrends(db, type, last, windowDays) {
  const cutoffT = new Date(last + 'T12:00:00Z');
  cutoffT.setUTCDate(cutoffT.getUTCDate() - windowDays);
  const cutoff = cutoffT.toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT symbol, date, rs_rank FROM rs_snapshots
    WHERE type = ? AND date >= ? AND date <= ?
    ORDER BY symbol, date ASC
  `).all(type, cutoff, last);

  const bySym = new Map();
  for (const r of rows) {
    let arr = bySym.get(r.symbol);
    if (!arr) { arr = []; bySym.set(r.symbol, arr); }
    arr.push(r);
  }

  const lookbacks = [7, 14, 28, 60, 90];
  const targetByDays = {};
  for (const d of lookbacks) {
    const t = new Date(last + 'T12:00:00Z');
    t.setUTCDate(t.getUTCDate() - d);
    targetByDays[d] = t.toISOString().slice(0, 10);
  }

  const out = new Map();
  for (const [sym, series] of bySym) {
    if (series.length < 2) continue;
    const now = series[series.length - 1].rs_rank;
    if (now == null) continue;

    const findAt = (daysAgo) => {
      const target = targetByDays[daysAgo];
      let best = null;
      for (const r of series) {
        if (r.date <= target) best = r;
        else break;
      }
      return best?.rs_rank ?? null;
    };

    const w1 = findAt(7),  w2 = findAt(14), w4 = findAt(28);
    const m3 = findAt(90), m2 = findAt(60);
    const dir  = w1 != null ? (now-w1 > 3 ? 'rising' : now-w1 < -3 ? 'falling' : 'flat') : 'new';
    const note = now < 50 && dir === 'rising' ? 'low-RS-rising' : dir;
    out.set(sym, {
      current: now, direction: dir, note,
      vs1w: w1 != null ? +(now-w1).toFixed(0) : null,
      vs2w: w2 != null ? +(now-w2).toFixed(0) : null,
      vs4w: w4 != null ? +(now-w4).toFixed(0) : null,
      vs3m: m3 != null ? +(now-m3).toFixed(0) : null,
      vs1m: w4 != null ? +(now-w4).toFixed(0) : null,  // 4 weeks ≈ 1 month
      vs2m: m2 != null ? +(now-m2).toFixed(0) : null,
    });
  }
  return out;
}

function _filterTrendMap(fullMap, symbols) {
  const out = new Map();
  for (const s of symbols) {
    const clean = _stripPrefix(s);
    const t = fullMap.get(clean);
    if (t) out.set(clean, t);
  }
  return out;
}

function getRSTrendsBulk(type, symbols = null, opts = {}) {
  const { windowDays = 100 } = opts;
  try {
    const db = getDB();
    const last = db.prepare(
      `SELECT MAX(date) AS d FROM rs_snapshots WHERE type = ?`
    ).get(type)?.d || null;
    if (!last) return new Map();

    // Full-Map cache hit: lastDate hasn't moved → return memoized.
    const cached = _bulkTrendCache[type];
    if (cached && cached.lastDate === last && cached.windowDays === windowDays) {
      return symbols ? _filterTrendMap(cached.fullMap, symbols) : cached.fullMap;
    }

    // Small symbol set with no cached map: targeted IN query is fastest
    // (typically <50 ms for 50 symbols). Doesn't seed the full-Map cache —
    // we leave that to the next "full" caller.
    if (Array.isArray(symbols) && symbols.length > 0 && symbols.length <= LARGE_N) {
      const cleanSyms = [...new Set(symbols.map(_stripPrefix))];
      const cutoffT = new Date(last + 'T12:00:00Z');
      cutoffT.setUTCDate(cutoffT.getUTCDate() - windowDays);
      const cutoff = cutoffT.toISOString().slice(0, 10);
      const placeholders = cleanSyms.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT symbol, date, rs_rank FROM rs_snapshots
        WHERE type = ? AND date >= ? AND date <= ? AND symbol IN (${placeholders})
        ORDER BY symbol, date ASC
      `).all(type, cutoff, last, ...cleanSyms);
      // Pretend this came back as a "full" series for these symbols and reuse
      // the same trend-build pass. Slightly clunky — we synthesize a tiny
      // cached-shape object so _buildAllTrends's logic can be mirrored inline.
      const bySym = new Map();
      for (const r of rows) {
        let arr = bySym.get(r.symbol);
        if (!arr) { arr = []; bySym.set(r.symbol, arr); }
        arr.push(r);
      }
      const lookbacks = [7, 14, 28, 60, 90];
      const targetByDays = {};
      for (const d of lookbacks) {
        const t = new Date(last + 'T12:00:00Z');
        t.setUTCDate(t.getUTCDate() - d);
        targetByDays[d] = t.toISOString().slice(0, 10);
      }
      const out = new Map();
      for (const [sym, series] of bySym) {
        if (series.length < 2) continue;
        const now = series[series.length - 1].rs_rank;
        if (now == null) continue;
        const findAt = (daysAgo) => {
          const target = targetByDays[daysAgo];
          let best = null;
          for (const r of series) {
            if (r.date <= target) best = r;
            else break;
          }
          return best?.rs_rank ?? null;
        };
        const w1 = findAt(7),  w2 = findAt(14), w4 = findAt(28);
        const m3 = findAt(90), m2 = findAt(60);
        const dir  = w1 != null ? (now-w1 > 3 ? 'rising' : now-w1 < -3 ? 'falling' : 'flat') : 'new';
        const note = now < 50 && dir === 'rising' ? 'low-RS-rising' : dir;
        out.set(sym, {
          current: now, direction: dir, note,
          vs1w: w1 != null ? +(now-w1).toFixed(0) : null,
          vs2w: w2 != null ? +(now-w2).toFixed(0) : null,
          vs4w: w4 != null ? +(now-w4).toFixed(0) : null,
          vs3m: m3 != null ? +(now-m3).toFixed(0) : null,
          vs1m: w4 != null ? +(now-w4).toFixed(0) : null,
          vs2m: m2 != null ? +(now-m2).toFixed(0) : null,
        });
      }
      return out;
    }

    // Large or no-filter path: build the full Map once, cache it, filter on
    // the way out if a symbol set was passed.
    const fullMap = _buildAllTrends(db, type, last, windowDays);
    _bulkTrendCache[type] = { lastDate: last, windowDays, fullMap };
    return symbols ? _filterTrendMap(fullMap, symbols) : fullMap;
  } catch (_) { return new Map(); }
}

function loadWatchlist() {
  try {
    return fs.existsSync(WATCHLIST_FILE)
      ? JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'))
      : [];
  } catch(_) { return []; }
}

function saveWatchlist(wl) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(wl, null, 2));
}

function loadCycleState() {
  try {
    return fs.existsSync(CYCLE_STATE_FILE)
      ? JSON.parse(fs.readFileSync(CYCLE_STATE_FILE, 'utf8'))
      : null;
  } catch(_) { return null; }
}

function saveCycleState(state) {
  fs.writeFileSync(CYCLE_STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = {
  DATA_DIR,
  RS_HISTORY, SEC_HISTORY, IND_HISTORY,
  WATCHLIST_FILE, CYCLE_STATE_FILE,
  loadHistory, saveHistory,
  // Targeted readers — prefer these over loadHistory in new code.
  getHistoryStats, getHistoryDates, getSnapshotOnDate, getSymbolHistory,
  getRSTrendsBulk,
  loadWatchlist, saveWatchlist,
  loadCycleState, saveCycleState,
};
