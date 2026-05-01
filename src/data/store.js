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
 */
function getHistoryStats(type) {
  try {
    return getDB().prepare(
      `SELECT COUNT(DISTINCT date) AS dateCount, MAX(date) AS lastDate
       FROM rs_snapshots WHERE type = ?`
    ).get(type) || { dateCount: 0, lastDate: null };
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
 * Pulls a 100-day window of (symbol, date, rs_rank) rows once and walks them
 * in JS — replaces N × loadHistory() (N callers each materializing the full
 * 3.7M-row table) with a single ~150k-row scan keyed off the (date, type)
 * index.
 *
 * Pass `symbols` to scope the query (used by routes like /hedge/shorts that
 * only care about ~20 names). Omit to pull every row for the window — that
 * path is for the scanner, where we attach a trend to all 1620 results.
 */
function getRSTrendsBulk(type, symbols = null, opts = {}) {
  const { windowDays = 100 } = opts;
  try {
    const db = getDB();
    const lastRow = db.prepare(
      `SELECT MAX(date) AS d FROM rs_snapshots WHERE type = ?`
    ).get(type);
    const last = lastRow?.d;
    if (!last) return new Map();

    const cutoffT = new Date(last + 'T12:00:00Z');
    cutoffT.setUTCDate(cutoffT.getUTCDate() - windowDays);
    const cutoff = cutoffT.toISOString().slice(0, 10);

    let rows;
    // Symbol-scoped path: chunk to stay well under SQLite's variable limit.
    // Most callers pass <100 names so this is one query in practice.
    if (Array.isArray(symbols) && symbols.length > 0) {
      const cleanSyms = [...new Set(symbols.map(_stripPrefix))];
      const CHUNK = 500;
      rows = [];
      for (let i = 0; i < cleanSyms.length; i += CHUNK) {
        const slice = cleanSyms.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        const part = db.prepare(`
          SELECT symbol, date, rs_rank FROM rs_snapshots
          WHERE type = ? AND date >= ? AND date <= ? AND symbol IN (${placeholders})
          ORDER BY symbol, date ASC
        `).all(type, cutoff, last, ...slice);
        rows.push(...part);
      }
    } else {
      rows = db.prepare(`
        SELECT symbol, date, rs_rank FROM rs_snapshots
        WHERE type = ? AND date >= ? AND date <= ?
        ORDER BY symbol, date ASC
      `).all(type, cutoff, last);
    }

    // Group rows by symbol — ascending date order is preserved by ORDER BY.
    const bySym = new Map();
    for (const r of rows) {
      let arr = bySym.get(r.symbol);
      if (!arr) { arr = []; bySym.set(r.symbol, arr); }
      arr.push(r);
    }

    // Pre-compute the lookback target dates once. Each one is "last - N days"
    // as a YYYY-MM-DD string; the trend logic uses "latest entry whose date
    // <= target" (matches the original getRSTrend findAt() semantics).
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
      const lastEntry = series[series.length - 1];
      const now = lastEntry.rs_rank;
      if (now == null) continue;

      // Latest series entry whose date <= target. Series is sorted
      // ascending so we walk forward and remember the running best.
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
