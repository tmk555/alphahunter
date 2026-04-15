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

// ─── Range aggregates (for backtest context) ───────────────────────────────
//
// The replay engine wants a compact, human-readable summary of the macro
// environment during a backtest window. These helpers aggregate daily/
// monthly FRED series over [startDate, endDate] and classify the period
// into a coarse regime label. The output feeds the "Macro context during
// run" card in the ReplayTab.
//
// Intentional design notes:
//   • getSeriesRange() does NOT apply release-lag — it returns the full
//     historical record. That's the right choice for backtest *context*
//     (post-hoc storytelling about what actually happened). For backtest
//     decisions strategy code should still use getValueOn/getMacroSnapshot.
//   • The regime classifier mirrors the thresholds in the Scanner's
//     as-of banner so both UIs agree on how a date should be labeled.
//   • All helpers tolerate missing series — if a series has no rows in
//     the window, its stats entry is `null` and the regime classifier
//     ignores it rather than crashing.

/** Mean/min/max/first/last for a numeric array. Null on empty. */
function _numStats(vals) {
  if (!vals || vals.length === 0) return null;
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return {
    count: vals.length,
    mean: +(sum / vals.length).toFixed(4),
    min: +min.toFixed(4),
    max: +max.toFixed(4),
    first: +vals[0].toFixed(4),
    last: +vals[vals.length - 1].toFixed(4),
  };
}

/** Count of rows whose value satisfies `predicate`. */
function _countWhere(rows, predicate) {
  if (!rows) return 0;
  let n = 0;
  for (const r of rows) if (predicate(r.value)) n++;
  return n;
}

/**
 * Coarse regime classifier. Mirrors the thresholds used in the Scanner
 * tab's as-of banner so the two surfaces agree.
 *
 *   RISK_OFF : avg VIX ≥ 25 OR avg T10Y2Y < 0 OR avg HY OAS ≥ 6
 *   RISK_ON  : avg VIX < 18 AND avg T10Y2Y > 0 AND avg HY OAS < 4
 *   NEUTRAL  : anything in between
 *   UNKNOWN  : none of the three signals are available
 *
 * `stats` is the dailyStats object from getMacroContextForRange.
 */
function classifyRegime(stats) {
  const vix   = stats?.VIXCLS?.mean;
  const curve = stats?.T10Y2Y?.mean;
  const oas   = stats?.BAMLH0A0HYM2?.mean;
  if (vix == null && curve == null && oas == null) return 'UNKNOWN';
  const riskOff =
    (vix   != null && vix   >= 25) ||
    (curve != null && curve <   0) ||
    (oas   != null && oas   >=  6);
  if (riskOff) return 'RISK_OFF';
  const riskOn =
    (vix   != null && vix   <  18) &&
    (curve != null && curve >   0) &&
    (oas   != null && oas   <   4);
  if (riskOn) return 'RISK_ON';
  return 'NEUTRAL';
}

/**
 * Aggregate FRED macro data over a date range for backtest context.
 *
 * Returns a structured summary with snapshots at start/mid/end (release-lag
 * aware), per-series daily aggregates (mean/min/max/first/last + stress
 * counters), monthly first/last/delta, and a coarse regime label.
 *
 * Missing series are represented as `null` entries rather than being
 * omitted — the UI can render "— no data" without re-checking existence.
 *
 * @param {string} startDate ISO YYYY-MM-DD
 * @param {string} endDate   ISO YYYY-MM-DD
 * @returns {object}
 */
function getMacroContextForRange(startDate, endDate) {
  if (!startDate) throw new Error('getMacroContextForRange: startDate required');
  if (!endDate)   throw new Error('getMacroContextForRange: endDate required');

  // Daily series that matter for backtest context. Order matters — the UI
  // iterates in display order.
  const DAILY_IDS = ['DGS10', 'DGS2', 'T10Y2Y', 'VIXCLS', 'BAMLH0A0HYM2', 'DFF'];
  // Monthly/lagged macro — we summarize via first/last because the deltas
  // are what matter to a position trader (UNRATE change, CPI change).
  const MONTHLY_IDS = ['UNRATE', 'CPIAUCSL', 'INDPRO', 'FEDFUNDS'];

  const dailyStats = {};
  for (const id of DAILY_IDS) {
    const rows = getSeriesRange(id, startDate, endDate);
    const vals = rows.map(r => r.value).filter(v => v != null);
    const stats = _numStats(vals);
    if (stats) {
      // Per-series derived stress counters. Cheap to compute here rather
      // than forcing the UI to re-scan the raw series.
      if (id === 'T10Y2Y')       stats.daysInverted = _countWhere(rows, v => v != null && v < 0);
      if (id === 'VIXCLS') {
        stats.daysElevated = _countWhere(rows, v => v != null && v >= 20);
        stats.daysStressed = _countWhere(rows, v => v != null && v >= 30);
      }
      if (id === 'BAMLH0A0HYM2') stats.daysStressed = _countWhere(rows, v => v != null && v >= 6);
    }
    dailyStats[id] = stats;  // null when no data — UI handles it
  }

  const monthlyStats = {};
  for (const id of MONTHLY_IDS) {
    const rows = getSeriesRange(id, startDate, endDate);
    if (rows.length === 0) { monthlyStats[id] = null; continue; }
    const first = rows[0].value;
    const last  = rows[rows.length - 1].value;
    const entry = {
      count: rows.length,
      first: +first.toFixed(4),
      last:  +last.toFixed(4),
      change: +(last - first).toFixed(4),
    };
    // CPI/INDPRO are index levels — the trader cares about percent change,
    // not absolute-level change.
    if (id === 'CPIAUCSL' || id === 'INDPRO') {
      entry.pctChange = first > 0 ? +(((last - first) / first) * 100).toFixed(2) : null;
    }
    monthlyStats[id] = entry;
  }

  // Point-in-time snapshots at start / mid / end so the UI can draw
  // "curve inverted → still inverted → normalized" style narratives.
  // Lag is applied (default behavior) so these reflect what was actually
  // public on each date.
  const midDate = (() => {
    const s = new Date(`${startDate}T00:00:00Z`).getTime();
    const e = new Date(`${endDate}T00:00:00Z`).getTime();
    return new Date((s + e) / 2).toISOString().slice(0, 10);
  })();
  const snapshotIds = [...DAILY_IDS, ...MONTHLY_IDS];
  const snapshots = {
    start: { date: startDate, values: getMacroSnapshot(startDate, snapshotIds) },
    mid:   { date: midDate,   values: getMacroSnapshot(midDate,   snapshotIds) },
    end:   { date: endDate,   values: getMacroSnapshot(endDate,   snapshotIds) },
  };

  // Approximate trading days = daily series with the most rows (typically
  // DGS10 or VIXCLS). Good enough for UI display.
  const tradingDays = Math.max(
    0,
    ...DAILY_IDS.map(id => dailyStats[id]?.count || 0)
  );

  return {
    startDate,
    endDate,
    tradingDays,
    snapshots,
    dailyStats,
    monthlyStats,
    regime: classifyRegime(dailyStats),
  };
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
  // Range aggregation — used by the replay engine to attach macro context
  // to backtest results. `classifyRegime` is exposed so the Scanner's
  // as-of banner and the ReplayTab macro card can agree on labels.
  getMacroContextForRange,
  classifyRegime,
  // Release-lag introspection — exposed so dashboards and tests can see
  // and override the per-series shift without reaching into internals.
  getReleaseLag,
  RELEASE_LAG_DAYS,
};
