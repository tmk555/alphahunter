// ─── Historical earnings_drift_snapshots Backfill ────────────────────────────
// Populates earnings_drift_snapshots(symbol, date, ...) by walking each
// symbol's stored OHLCV bars, truncating to each historical date, and
// re-running calcEarningsDrift as if it were that day. Historical daysTo-
// Earnings isn't available, so the fallback path in calcEarningsDrift
// (detect the biggest 3%+ gap in the last 30 bars) is what drives the
// backfilled scores — known_earnings will always be 0 for these rows.

const { getDB } = require('../data/database');
const { getHistoryFull, pLimit } = require('../data/providers/manager');
const { cacheClear } = require('../data/cache');
const { calcEarningsDrift } = require('./earningsDrift');

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

// Returns the calcEarningsDrift output for `sym` as of historical `date`,
// or null when there's no qualifying gap in the 30-day window.
function computeDriftForSymbolAtDate(sym, bars, date) {
  const idx = findBarIndexAtOrBefore(bars, date);
  if (idx < 0) return null;
  const slice = bars.slice(0, idx + 1);
  if (slice.length < 30) return null;

  // null daysToEarnings → forces the detectEarningsReaction fallback
  // inside calcEarningsDrift. null quote → skips the volume bonus.
  return calcEarningsDrift(slice, null, null);
}

async function runEarningsDriftBackfill({
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
      if (bars && bars.length >= 30) barsBySymbol[sym] = bars;
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

  if (onProgress) onProgress({ stage: 'compute', current: 0, total: dates.length, message: `Computing ${dates.length} earnings-drift snapshots` });

  const insert = db().prepare(`
    INSERT OR REPLACE INTO earnings_drift_snapshots (
      symbol, date, score, gap_pct, days_since_reaction, drift_pct,
      held_gains, known_earnings, strong
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let rowsWritten = 0;

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];

    const rows = [];
    for (const sym of fetchedSymbols) {
      const drift = computeDriftForSymbolAtDate(sym, barsBySymbol[sym], date);
      if (drift) rows.push({ symbol: sym, date, ...drift });
    }
    if (!rows.length) continue;

    const txn = db().transaction(() => {
      for (const r of rows) {
        insert.run(
          r.symbol, r.date, r.score, r.gapPct, r.daysSinceReaction, r.driftPct,
          r.heldGains ? 1 : 0, r.knownEarnings ? 1 : 0, r.strong ? 1 : 0,
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

module.exports = { runEarningsDriftBackfill };
