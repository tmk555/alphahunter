// ─── FRED Macro Series (read/write API) ─────────────────────────────────────
//
// Persists historical observations from FRED (Federal Reserve Economic Data)
// into the `macro_series` table and exposes a point-in-time query layer with
// forward-fill semantics.
//
// Why this exists separately from src/signals/macro.js:
//
//   • src/signals/macro.js computes LIVE regime signals from ETF proxies
//     (TLT/SHY, HYG/LQD, etc.) — good for today's regime, not for backtests.
//   • This module stores ACTUAL economic data from FRED so replay.js can
//     ask "what was the 10Y/2Y spread on 2018-03-15?" and get a real answer.
//
// Forward-fill: monthly series like UNRATE and CPIAUCSL only have
// observations on specific dates (usually the 1st of the month). A backtest
// running on any given day wants the most-recent-known value. getValueOn()
// does `date <= ?` + ORDER BY DESC LIMIT 1 to handle this cleanly — it's
// the same pattern as financial "last observation carry forward."

const fs = require('fs');
const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Import ─────────────────────────────────────────────────────────────────
//
// Bulk-insert observations. `INSERT OR REPLACE` on the composite PK
// (series_id, date) makes reruns idempotent — re-importing an updated
// CSV just overwrites stale values.

/**
 * @param {Array<{series_id:string, date:string, value:number|null}>} rows
 * @returns {{inserted:number, skipped:number}}
 */
function importSeries(rows) {
  if (!Array.isArray(rows)) throw new Error('importSeries: rows must be an array');
  if (rows.length === 0) return { inserted: 0, skipped: 0 };

  const stmt = db().prepare(`
    INSERT OR REPLACE INTO macro_series (series_id, date, value)
    VALUES (?, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;
  const txn = db().transaction((batch) => {
    for (const r of batch) {
      if (!r.series_id || !r.date) { skipped++; continue; }
      const v = r.value == null ? null : Number(r.value);
      stmt.run(
        String(r.series_id).toUpperCase(),
        r.date,
        Number.isFinite(v) ? v : null,
      );
      inserted++;
    }
  });
  txn(rows);
  return { inserted, skipped };
}

// ─── FRED CSV parser ───────────────────────────────────────────────────────
//
// FRED's public CSV endpoint (https://fred.stlouisfed.org/graph/fredgraph.csv?id=X)
// returns text like:
//
//   DATE,DGS10
//   2020-01-02,1.88
//   2020-01-03,1.80
//   2020-01-06,.       ← missing observation, literal dot
//
// We normalize the dot-sentinel to null so the column is queryable with
// `value IS NOT NULL`. Header column 1 is sometimes "DATE", sometimes
// "observation_date"; column 2 is the series ID or a friendlier name.

/**
 * @param {string} csvText
 * @param {string} seriesId  Passed explicitly so we don't need to trust the header.
 * @returns {Array<{series_id:string, date:string, value:number|null}>}
 */
function parseFredCsv(csvText, seriesId) {
  if (!seriesId) throw new Error('parseFredCsv: seriesId is required');
  const lines = String(csvText || '').split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length < 2) continue;
    const date = cells[0].trim();
    const raw  = cells[1].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    let value = null;
    if (raw !== '' && raw !== '.') {
      const n = Number(raw);
      if (Number.isFinite(n)) value = n;
    }
    out.push({ series_id: seriesId.toUpperCase(), date, value });
  }
  return out;
}

function loadFromCsvFile(filePath, seriesId) {
  if (!fs.existsSync(filePath)) throw new Error(`FRED CSV not found: ${filePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseFredCsv(text, seriesId);
  return importSeries(rows);
}

// ─── Release-lag table ─────────────────────────────────────────────────────
//
// FRED stores each observation under `observation_date = start of period`.
// For monthly series that means "March 2020 unemployment" is labeled
// 2020-03-01 — but BLS doesn't actually PUBLISH the March number until the
// first Friday of April (≈ 2020-04-03). A naive point-in-time query on
// 2020-03-23 would "see" the March 4.4% reading roughly 10 days before the
// market did, which is look-ahead bias — and for release-day catalysts like
// CPI it produces fake backtest alpha.
//
// RELEASE_LAG_DAYS is a conservative per-series delay (in calendar days)
// subtracted from the query date inside getValueOn. The values here are
// upper bounds of real publication delay, so a backtest NEVER sees data it
// couldn't have acted on. Daily market series (yields, VIX, HY OAS) are
// release-accurate by construction, so their lag is 0.
//
// Sources (typical historical release calendars):
//   • UNRATE   — BLS Employment Situation, 1st Friday of next month  → ~35d
//   • CPIAUCSL — BLS CPI, ~10-14d after month end                    → ~45d
//   • INDPRO   — Fed G.17 Industrial Production, ~mid-next-month     → ~50d
//   • FEDFUNDS — Monthly average, published ~1st business day of next month
//                by the NY Fed once the month has fully closed        → ~32d
//   • DFF      — Daily effective fed funds rate, 1 business day lag  →   2d
//
// If a series is absent from this map, lag defaults to 0 — callers
// opting into an unlisted series should either add it here or accept that
// daily-market assumption.
const RELEASE_LAG_DAYS = {
  // Daily market data — available at end-of-day the same day.
  DGS10:        0,
  DGS2:         0,
  T10Y2Y:       0,
  BAMLH0A0HYM2: 0,
  VIXCLS:       0,
  // DFF is reported T+1 by the NY Fed; 2 calendar days is a safe buffer
  // that covers weekends.
  DFF:          2,
  // Monthly macro — release lag dominated by statistical agency cadence.
  UNRATE:       35,
  CPIAUCSL:     45,
  INDPRO:       50,
  FEDFUNDS:     32,
};

/** Subtract N calendar days from a YYYY-MM-DD string. */
function shiftDate(dateStr, days) {
  if (!days) return dateStr;
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Release-lag in days for a series. Unknown series default to 0. */
function getReleaseLag(seriesId) {
  if (!seriesId) return 0;
  return RELEASE_LAG_DAYS[String(seriesId).toUpperCase()] ?? 0;
}

// ─── Query ──────────────────────────────────────────────────────────────────

/**
 * Most recent non-null observation for a series.
 *
 * Unlike getValueOn, this is purely "what's the newest row we have" — no
 * release-lag applied. Use this for UI/diagnostics; use getValueOn for any
 * backtest-adjacent code.
 *
 * @returns {{date:string, value:number}|null}
 */
function getLatest(seriesId) {
  if (!seriesId) throw new Error('getLatest: seriesId required');
  return db().prepare(`
    SELECT date, value FROM macro_series
    WHERE series_id = ? AND value IS NOT NULL
    ORDER BY date DESC LIMIT 1
  `).get(String(seriesId).toUpperCase()) || null;
}

/**
 * Point-in-time lookup with forward-fill AND release-lag:
 *
 *   1. The query date is first shifted backward by RELEASE_LAG_DAYS[series]
 *      so the backtest can only "see" observations that were actually
 *      public by that date.
 *   2. The most recent non-null observation with `date <= shifted_date`
 *      is returned — forward-fill.
 *
 * This is the core of backtest safety: daily market series (DGS10, VIX,
 * HY OAS) have a lag of 0 and behave exactly as before; monthly series
 * (UNRATE, CPIAUCSL, INDPRO) get ~30-50 day shifts so the backtest never
 * front-runs BLS/Fed publication calendars.
 *
 * Pass `{ lagDays: 0 }` to force-disable the shift (e.g. when charting
 * known history, or when the caller has already applied their own lag).
 *
 * Returns null when no non-null observation exists on-or-before the
 * shifted date.
 *
 * @param {string} seriesId
 * @param {string} date             ISO 'YYYY-MM-DD'
 * @param {{lagDays?: number}=} opts
 * @returns {{date:string, value:number}|null}
 */
function getValueOn(seriesId, date, opts = {}) {
  if (!seriesId) throw new Error('getValueOn: seriesId required');
  if (!date)     throw new Error('getValueOn: date required');
  const lag = opts.lagDays != null ? opts.lagDays : getReleaseLag(seriesId);
  const effectiveDate = shiftDate(date, lag);
  return db().prepare(`
    SELECT date, value FROM macro_series
    WHERE series_id = ? AND value IS NOT NULL AND date <= ?
    ORDER BY date DESC LIMIT 1
  `).get(String(seriesId).toUpperCase(), effectiveDate) || null;
}

/**
 * Snapshot of every known series on a given date. Each series is looked up
 * independently via getValueOn, so a snapshot can mix daily series (DGS10)
 * with monthly series (UNRATE) and still get consistent point-in-time
 * values — and each series applies its own release-lag automatically.
 *
 * Returns a map keyed by series_id; missing series map to null.
 *
 * Pass `{ lagDays: 0 }` to disable the release-lag shift across all series
 * (e.g. for charting historical data where we don't care about look-ahead).
 *
 * @param {string}   date             ISO 'YYYY-MM-DD'
 * @param {string[]=} seriesIds       Optional allow-list; default = every
 *                                    distinct series_id currently in the table.
 * @param {{lagDays?: number}=} opts  Optional override: {lagDays: 0} disables lag
 */
function getMacroSnapshot(date, seriesIds = null, opts = {}) {
  if (!date) throw new Error('getMacroSnapshot: date required');
  const ids = Array.isArray(seriesIds) && seriesIds.length
    ? seriesIds.map(s => String(s).toUpperCase())
    : db().prepare('SELECT DISTINCT series_id FROM macro_series').all().map(r => r.series_id);
  const out = {};
  for (const id of ids) {
    const row = getValueOn(id, date, opts);
    out[id] = row ? row.value : null;
  }
  return out;
}

/**
 * Time series slice between two dates (inclusive). Used by charts and for
 * rolling-window macro features like "10Y yield 20-day change."
 */
function getSeriesRange(seriesId, startDate, endDate) {
  if (!seriesId)  throw new Error('getSeriesRange: seriesId required');
  if (!startDate) throw new Error('getSeriesRange: startDate required');
  if (!endDate)   throw new Error('getSeriesRange: endDate required');
  return db().prepare(`
    SELECT date, value FROM macro_series
    WHERE series_id = ?
      AND value IS NOT NULL
      AND date >= ?
      AND date <= ?
    ORDER BY date ASC
  `).all(String(seriesId).toUpperCase(), startDate, endDate);
}

// ─── Metadata ───────────────────────────────────────────────────────────────

function getAvailableSeries() {
  return db().prepare(`
    SELECT series_id,
           COUNT(*) AS observations,
           MIN(date) AS earliest,
           MAX(date) AS latest
    FROM macro_series
    WHERE value IS NOT NULL
    GROUP BY series_id
    ORDER BY series_id
  `).all();
}

/** Wipe a single series — used by tests, rollback, and re-import. */
function clearSeries(seriesId) {
  if (!seriesId) throw new Error('clearSeries: seriesId required');
  db().prepare('DELETE FROM macro_series WHERE series_id = ?')
    .run(String(seriesId).toUpperCase());
}

module.exports = {
  importSeries,
  parseFredCsv,
  loadFromCsvFile,
  getLatest,
  getValueOn,
  getMacroSnapshot,
  getSeriesRange,
  getAvailableSeries,
  clearSeries,
  // Release-lag introspection — exposed so dashboards and tests can see
  // and override the per-series shift without reaching into internals.
  getReleaseLag,
  RELEASE_LAG_DAYS,
};
