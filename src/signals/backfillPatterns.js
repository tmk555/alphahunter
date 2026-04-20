// ─── Historical pattern_detections Backfill ─────────────────────────────────
// Walks each symbol's stored bar history day-by-day and runs detectPatterns()
// on the trailing slice, writing one row per (symbol, date, pattern_type)
// into pattern_detections. Mirrors the approach used by rs_snapshots backfill
// (src/signals/backfill.js) so that replay/backtest/factor_combo can filter
// by historical pattern_type just like they do for rs_rank.
//
// Look-ahead: each date uses ONLY bars on or before that date.
// Upsert semantics: ON CONFLICT(symbol, date, pattern_type) overwrites so the
// script is idempotent — safe to re-run after code changes to pattern detectors.

const { getDB } = require('../data/database');
const { getHistoryFull, pLimit } = require('../data/providers/manager');
const { detectPatterns } = require('./patterns');

function db() { return getDB(); }

function buildTradingCalendar(barsBySymbol, lookbackDays) {
  const dateSet = new Set();
  for (const sym of Object.keys(barsBySymbol)) {
    for (const bar of barsBySymbol[sym]) dateSet.add(bar.date);
  }
  return [...dateSet].sort().slice(-lookbackDays);
}

function findBarIndexAtOrBefore(bars, date) {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) { found = mid; lo = mid + 1; }
    else                         { hi = mid - 1; }
  }
  return found;
}

async function runPatternBackfill({
  symbols,
  lookbackDays = 365,
  concurrency = 5,
  onProgress = null,
} = {}) {
  if (!symbols || !symbols.length) throw new Error('symbols[] required');
  const t0 = Date.now();
  const errors = [];

  if (onProgress) onProgress({ stage: 'fetch', current: 0, total: symbols.length, message: `Fetching ${symbols.length} symbol histories` });

  // Step 1: fetch full bars for every symbol (provider cache will hit if
  // rs_snapshots backfill has just run against the same universe)
  const barsBySymbol = {};
  let fetched = 0;
  await pLimit(symbols.map(sym => async () => {
    try {
      const bars = await getHistoryFull(sym);
      if (bars && bars.length >= 150) barsBySymbol[sym] = bars;
      else errors.push({ symbol: sym, error: bars ? `only ${bars.length} bars` : 'no data' });
    } catch (e) {
      errors.push({ symbol: sym, error: e.message });
    }
    fetched++;
    if (onProgress && fetched % 10 === 0) {
      onProgress({ stage: 'fetch', current: fetched, total: symbols.length, message: `Fetched ${fetched}/${symbols.length}` });
    }
  }), concurrency);

  const fetchedSymbols = Object.keys(barsBySymbol);
  if (!fetchedSymbols.length) throw new Error('No symbols returned bar history');

  const dates = buildTradingCalendar(barsBySymbol, lookbackDays);
  if (!dates.length) throw new Error('No trading dates in lookback window');

  if (onProgress) onProgress({ stage: 'compute', current: 0, total: dates.length, message: `Scanning ${dates.length} dates × ${fetchedSymbols.length} symbols` });

  const upsert = db().prepare(`
    INSERT INTO pattern_detections (symbol, date, pattern_type, confidence, pivot_price, stop_price, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, date, pattern_type) DO UPDATE SET
      confidence  = excluded.confidence,
      pivot_price = excluded.pivot_price,
      stop_price  = excluded.stop_price,
      details     = excluded.details
  `);

  let rowsWritten = 0;
  let datesScanned = 0;

  for (const date of dates) {
    const perDateRows = [];
    for (const sym of fetchedSymbols) {
      const bars = barsBySymbol[sym];
      const idx = findBarIndexAtOrBefore(bars, date);
      if (idx < 0) continue;
      const slice = bars.slice(0, idx + 1);
      if (slice.length < 150) continue;

      const closes = slice.map(b => b.close);
      const n = closes.length;
      const ma50  = n >= 50  ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50  : null;
      const ma150 = n >= 150 ? closes.slice(-150).reduce((a, b) => a + b, 0) / 150 : null;
      const ma200 = n >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;

      let pd;
      try { pd = detectPatterns(slice, closes, ma50, ma150, ma200); }
      catch(_) { continue; }

      if (!pd || !pd.patterns) continue;
      for (const [type, p] of Object.entries(pd.patterns)) {
        if (!p || !p.detected) continue;
        perDateRows.push([
          sym, date, type,
          p.confidence || 0,
          p.pivotPrice || null,
          p.stopPrice || null,
          JSON.stringify(p),
        ]);
      }
    }

    if (perDateRows.length) {
      const txn = db().transaction(() => {
        for (const row of perDateRows) { upsert.run(...row); rowsWritten++; }
      });
      txn();
    }

    datesScanned++;
    if (onProgress && datesScanned % 10 === 0) {
      onProgress({ stage: 'compute', current: datesScanned, total: dates.length, message: `Scanned ${datesScanned}/${dates.length} dates, ${rowsWritten} rows` });
    }
  }

  return {
    dates: dates.length,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    symbolsRequested: symbols.length,
    symbolsWithData: fetchedSymbols.length,
    rowsWritten,
    durationMs: Date.now() - t0,
    errors: errors.slice(0, 50),
    errorCount: errors.length,
  };
}

module.exports = { runPatternBackfill };
