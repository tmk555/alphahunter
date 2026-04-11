// ─── Historical rs_snapshots Backfill ───────────────────────────────────────
// Walks the past N trading days using each symbol's stored 1-year OHLCV bars,
// re-computes the signal stack as if it were that day, ranks cross-sectionally,
// and INSERT-OR-REPLACEs into rs_snapshots. This is what makes the replay /
// walk-forward / monte-carlo modules actually run on real data instead of the
// 23-day live tail.
//
// Why we need this:
//   The live scanner only writes today's snapshot. Without backfill, the
//   backtester is blind. With it, we can replay 6+ months of strategy
//   performance using exactly the same scoring logic as the live system —
//   no separate historical pipeline to drift out of sync.
//
// Bias notes:
//   - Survivorship: Yahoo only returns history for currently-listed symbols.
//     Real backtests should use universe_mgmt + delisted symbols. This module
//     does NOT solve survivorship — it inherits whatever bias the universe has.
//   - Look-ahead: Each historical date is computed using ONLY bars on or
//     before that date (slice truncation). Cross-sectional ranks at date D
//     use only stocks that had ≥63 prior bars by D. Earnings + quote-derived
//     fields (forward PE, earningsTimestamp) are skipped — we only persist the
//     fields that rs_snapshots actually stores.

const { getDB } = require('../data/database');
const { getHistoryFull, pLimit } = require('../data/providers/manager');
const { cacheClear } = require('../data/cache');
const { calcRS, calcRSWeekly, calcRSMonthly, rankToRS, getTimeframeAlignment } = require('./rs');
const { calcSwingMomentum, calcATR, calcVolumeProfile } = require('./momentum');
const { calcVCP } = require('./vcp');
const { calcRSLine } = require('./rsline');
const { calcStage } = require('./stage');

function db() { return getDB(); }

// Build the set of distinct YYYY-MM-DD trading dates that appear in any
// symbol's bar history, restricted to the most recent `lookbackDays` of those.
// We use the union of dates so a symbol that's missing a day (halt, IPO) is
// just absent from that day's snapshot rather than blocking the whole date.
function buildTradingCalendar(barsBySymbol, lookbackDays) {
  const dateSet = new Set();
  for (const sym of Object.keys(barsBySymbol)) {
    for (const bar of barsBySymbol[sym]) dateSet.add(bar.date);
  }
  const allDates = [...dateSet].sort();
  return allDates.slice(-lookbackDays);
}

// Returns the index in `bars` of the bar matching `date` (or last bar before).
// Returns -1 if no bar exists at or before `date` (symbol IPO'd later).
function findBarIndexAtOrBefore(bars, date) {
  // Binary search assumes bars are date-sorted (Yahoo returns chronological).
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) { found = mid; lo = mid + 1; }
    else                         { hi = mid - 1; }
  }
  return found;
}

// Compute every snapshot field for a single symbol as of historical `date`,
// using only bars on or before that date. Returns null if insufficient
// history (need 63 bars minimum for RS). spyClosesUpToDate is the SPY close
// series truncated to the same date — used for RS Line calc.
function computeSnapshotForSymbolAtDate(sym, bars, date, spyClosesUpToDate) {
  const idx = findBarIndexAtOrBefore(bars, date);
  if (idx < 0) return null;
  const slice = bars.slice(0, idx + 1);
  if (slice.length < 63) return null;

  const closes = slice.map(b => b.close);
  const n = closes.length;
  const price = closes[n - 1];
  if (!price || price <= 0) return null;

  const ma50  = n >= 50  ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50  : null;
  const ma150 = n >= 150 ? closes.slice(-150).reduce((a, b) => a + b, 0) / 150 : null;
  const ma200 = n >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;
  const vsMA50  = ma50  ? +((price - ma50)  / ma50  * 100).toFixed(2) : null;
  const vsMA150 = ma150 ? +((price - ma150) / ma150 * 100).toFixed(2) : null;
  const vsMA200 = ma200 ? +((price - ma200) / ma200 * 100).toFixed(2) : null;

  // SEPA score (subset that's computable from price-only history)
  const distFromHigh = (() => {
    const hi = Math.max(...closes.slice(-252));
    return hi > 0 ? +((hi - price) / hi).toFixed(4) : null;
  })();
  const lo52 = Math.min(...closes.slice(-252));
  const sepa = {
    aboveMA200:      vsMA200 != null && vsMA200 > 0,
    aboveMA150:      vsMA150 != null && vsMA150 > 0,
    ma150AboveMA200: ma150 && ma200 ? ma150 > ma200 : null,
    ma200Rising:     (() => {
      if (n < 252) return null;
      const ma200_4wAgo = closes.slice(-252, -228).reduce((a, b) => a + b, 0) / 24;
      return ma200 > ma200_4wAgo * 1.001;
    })(),
    ma50AboveAll:    ma50 && ma150 && ma200 ? (ma50 > ma150 && ma50 > ma200) : null,
    aboveMA50:       vsMA50 != null && vsMA50 > 0,
    low30pctBelow:   lo52 ? (price - lo52) / price >= 0.30 : null,
    priceNearHigh:   distFromHigh != null && distFromHigh <= 0.25,
  };
  const sepaScore = Object.values(sepa).filter(v => v === true).length;

  // Volume ratio: today vs 50-day avg from the truncated window
  const volWindow = slice.slice(-50).map(b => b.volume || 0);
  const avgVol50 = volWindow.length ? volWindow.reduce((a, b) => a + b, 0) / volWindow.length : 0;
  const todayVol = slice[slice.length - 1].volume || 0;
  const volumeRatio = avgVol50 > 0 ? +(todayVol / avgVol50).toFixed(2) : null;

  const rawRS         = calcRS(closes);
  const rawRSWeekly   = calcRSWeekly(closes);
  const rawRSMonthly  = calcRSMonthly(closes);
  const swingMom      = calcSwingMomentum(closes, null);
  const atr           = calcATR(slice);
  const atrPct        = atr && price ? +(atr / price * 100).toFixed(2) : null;
  const vcp           = calcVCP(closes);
  const rsLineInfo    = calcRSLine(closes, spyClosesUpToDate);
  const stageInfo     = calcStage(closes, ma150);
  const volumeProfile = calcVolumeProfile(slice);

  return {
    ticker: sym,
    price,
    rawRS,
    rawRSWeekly,
    rawRSMonthly,
    rawSwingMomentum: swingMom,
    sepaScore,
    stage: stageInfo?.stage ?? null,
    vsMA50, vsMA200,
    volumeRatio,
    vcpForming: vcp?.vcpForming ? 1 : 0,
    rsLineNewHigh: rsLineInfo?.rsLineNewHigh ? 1 : 0,
    atrPct,
    volumeProfile,
  };
}

// ─── Main backfill orchestrator ─────────────────────────────────────────────
// Args:
//   symbols           — array of tickers to backfill (e.g. universe)
//   lookbackDays      — how many trading days back to walk (default 180)
//   concurrency       — parallel symbol fetches (default 5)
//   onProgress        — optional callback({ stage, current, total, message })
//
// Returns a summary: { dates, symbols, rowsWritten, durationMs, errors }.
async function runBackfill({
  symbols,
  lookbackDays = 180,
  concurrency = 5,
  onProgress = null,
} = {}) {
  if (!symbols || !symbols.length) throw new Error('symbols[] required');
  const t0 = Date.now();
  const errors = [];

  // Clear provider cache to ensure we fetch the latest OHLCV data from Yahoo/FMP.
  // Without this, cached data from up to 23h ago may produce stale close prices
  // (e.g. MU $355.64 cached vs $355.82 actual close).
  cacheClear();

  // Always include SPY — we need its close series for RS Line and (optionally)
  // for the regime_adaptive backtest path.
  const allSymbols = [...new Set([...symbols, 'SPY'])];

  if (onProgress) onProgress({ stage: 'fetch', current: 0, total: allSymbols.length, message: `Fetching ${allSymbols.length} symbol histories` });

  // Step 1: fetch full bars for every symbol (cached by provider layer)
  const barsBySymbol = {};
  let fetched = 0;
  await pLimit(allSymbols.map(sym => async () => {
    try {
      const bars = await getHistoryFull(sym);
      if (bars && bars.length >= 63) barsBySymbol[sym] = bars;
      else errors.push({ symbol: sym, error: bars ? `only ${bars.length} bars` : 'no data' });
    } catch (e) {
      errors.push({ symbol: sym, error: e.message });
    }
    fetched++;
    if (onProgress && fetched % 10 === 0) {
      onProgress({ stage: 'fetch', current: fetched, total: allSymbols.length, message: `Fetched ${fetched}/${allSymbols.length}` });
    }
  }), concurrency);

  const fetchedSymbols = Object.keys(barsBySymbol);
  if (!fetchedSymbols.length) throw new Error('No symbols returned bar history');

  // Step 2: build the trading calendar from the union of dates
  const dates = buildTradingCalendar(barsBySymbol, lookbackDays);
  if (!dates.length) throw new Error('No trading dates in lookback window');

  if (onProgress) onProgress({ stage: 'compute', current: 0, total: dates.length, message: `Computing ${dates.length} historical snapshots` });

  // Step 3: prepare insert
  const insert = db().prepare(`
    INSERT OR REPLACE INTO rs_snapshots (
      date, symbol, type, rs_rank, raw_rs, swing_momentum, sepa_score, stage,
      price, vs_ma50, vs_ma200, volume_ratio, vcp_forming, rs_line_new_high, atr_pct,
      rs_rank_weekly, rs_rank_monthly, rs_tf_alignment, up_down_ratio_50, accumulation_50
    )
    VALUES (?, ?, 'stock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Step 4: walk dates, compute per-symbol snapshots, rank, persist
  let rowsWritten = 0;
  const spyBars = barsBySymbol['SPY'] || [];

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];

    // Truncate SPY closes to ≤ date for RS Line calc
    const spyIdx = findBarIndexAtOrBefore(spyBars, date);
    const spyClosesUpToDate = spyIdx >= 0 ? spyBars.slice(0, spyIdx + 1).map(b => b.close) : [];

    const items = [];
    for (const sym of fetchedSymbols) {
      const snap = computeSnapshotForSymbolAtDate(sym, barsBySymbol[sym], date, spyClosesUpToDate);
      if (snap) items.push(snap);
    }

    if (!items.length) continue;

    // Cross-sectional ranking — same as live scanner
    rankToRS(items);
    rankToRS(items, 'rawRSWeekly', 'rsRankWeekly');
    rankToRS(items, 'rawRSMonthly', 'rsRankMonthly');
    rankToRS(items, 'rawSwingMomentum', 'swingMomentum');
    for (const s of items) s.rsTimeframeAlignment = getTimeframeAlignment(s, 80);

    // Persist all rows for this date in a single transaction
    const txn = db().transaction(() => {
      for (const s of items) {
        insert.run(
          date, s.ticker, s.rsRank ?? null, s.rawRS ?? null,
          s.swingMomentum ?? null, s.sepaScore ?? null, s.stage ?? null,
          s.price ?? null, s.vsMA50 ?? null, s.vsMA200 ?? null,
          s.volumeRatio ?? null, s.vcpForming ? 1 : 0, s.rsLineNewHigh ? 1 : 0,
          s.atrPct ?? null,
          s.rsRankWeekly ?? null, s.rsRankMonthly ?? null, s.rsTimeframeAlignment ?? null,
          s.volumeProfile?.upDownRatio50 ?? null,
          s.volumeProfile?.accumulation50 ?? null
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
    errors: errors.slice(0, 50), // cap to avoid bloating responses
    errorCount: errors.length,
  };
}

module.exports = { runBackfill };
