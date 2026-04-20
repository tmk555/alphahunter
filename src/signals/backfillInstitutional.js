// ─── Historical institutional_flow Backfill ─────────────────────────────────
// Populates institutional_flow(symbol, date, ...) by walking each symbol's
// stored OHLCV bars, truncating to each historical date, and re-running
// detectUnusualVolume + detectDarkPoolProxy + computeInstitutionalScore as
// if it were that day. Mirrors src/signals/backfill.js for rs_snapshots.
//
// Why we need this:
//   The live scanner computes institutionalData in-memory per scan and stores
//   only the aggregate score on rs_snapshots.institutional_score. The
//   institutional_flow table itself has always been empty, so the replay
//   engine and deep_scan backtests can't see historical accum/distribution
//   signals. This fills the gap.
//
// Bias notes:
//   - Look-ahead free: each date's calc uses only bars ≤ date.
//   - avgVolume baseline is derived from the truncated bar window, not from
//     a live quote field (which wouldn't be available historically anyway).
//   - Survivorship inherits whatever universe you pass in.

const { getDB } = require('../data/database');
const { getHistoryFull, pLimit } = require('../data/providers/manager');
const { cacheClear } = require('../data/cache');
const {
  detectUnusualVolume,
  detectDarkPoolProxy,
  computeInstitutionalScore,
} = require('./institutional');

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

// Compute institutional flow for one symbol at historical `date`. Returns
// null when the truncated bar slice is too short (< 50 bars — detectors need
// at least 50 for the baseline volume window).
function computeFlowForSymbolAtDate(sym, bars, date) {
  const idx = findBarIndexAtOrBefore(bars, date);
  if (idx < 0) return null;
  const slice = bars.slice(0, idx + 1);
  if (slice.length < 50) return null;

  const unusualVol = detectUnusualVolume(slice, null); // null → derive avg from slice
  const darkPool   = detectDarkPoolProxy(slice);
  const composite  = computeInstitutionalScore(unusualVol, darkPool, null);

  return {
    symbol: sym,
    date,
    flow_score: unusualVol.flowScore,
    net_flow: unusualVol.netFlow,
    accum_days_20: unusualVol.accumDays20,
    dist_days_20: unusualVol.distDays20,
    power_days: unusualVol.powerDays,
    dark_pool_score: darkPool.darkPoolScore,
    details: {
      institutionalScore: composite.institutionalScore,
      tier: composite.tier,
      signals: composite.signals,
      accumDays50: unusualVol.accumDays50,
      distDays50: unusualVol.distDays50,
      stealthDays: darkPool.stealthDays,
      absorptionDays: darkPool.absorptionDays,
    },
  };
}

async function runInstitutionalBackfill({
  symbols,
  lookbackDays = 252,
  concurrency = 5,
  onProgress = null,
} = {}) {
  if (!symbols || !symbols.length) throw new Error('symbols[] required');
  const t0 = Date.now();
  const errors = [];

  cacheClear();

  if (onProgress) onProgress({ stage: 'fetch', current: 0, total: symbols.length, message: `Fetching ${symbols.length} symbol histories` });

  const barsBySymbol = {};
  let fetched = 0;
  await pLimit(symbols.map(sym => async () => {
    try {
      const bars = await getHistoryFull(sym);
      if (bars && bars.length >= 50) barsBySymbol[sym] = bars;
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

  if (onProgress) onProgress({ stage: 'compute', current: 0, total: dates.length, message: `Computing ${dates.length} historical flow snapshots` });

  const insert = db().prepare(`
    INSERT OR REPLACE INTO institutional_flow (
      symbol, date, flow_score, net_flow, accum_days_20, dist_days_20,
      power_days, dark_pool_score, details
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let rowsWritten = 0;

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];

    const rows = [];
    for (const sym of fetchedSymbols) {
      const flow = computeFlowForSymbolAtDate(sym, barsBySymbol[sym], date);
      if (flow) rows.push(flow);
    }
    if (!rows.length) continue;

    const txn = db().transaction(() => {
      for (const r of rows) {
        insert.run(
          r.symbol, r.date, r.flow_score, r.net_flow,
          r.accum_days_20, r.dist_days_20, r.power_days, r.dark_pool_score,
          JSON.stringify(r.details),
        );
        rowsWritten++;
      }
    });
    txn();

    if (onProgress && (d + 1) % 10 === 0) {
      onProgress({ stage: 'compute', current: d + 1, total: dates.length, message: `Computed ${d + 1}/${dates.length} dates, ${rowsWritten} rows` });
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

module.exports = { runInstitutionalBackfill };
