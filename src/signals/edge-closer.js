// ─── Edge Telemetry — Outcome Closer ─────────────────────────────────────────
// Resolves open signal_outcomes rows by reading forward OHLCV bars and
// computing 5/10/20d returns + MFE/MAE + stop/target hit flags.
//
// Invariant: a row is only marked 'resolved' once the full 20-day horizon has
// passed. Before that we record partial-horizon metrics (ret_5d, ret_10d) so
// the dashboard can show fresh telemetry, but status stays 'open' so the
// closer keeps revisiting.
//
// Bar source: the cascading provider manager's `getHistoryFull` — same Yahoo
// → Polygon → FMP → Alpha Vantage chain the rest of the app uses.

const { getDB } = require('../data/database');
const { getOpenSignals, resolveOutcome } = require('./edge-telemetry');

function db() { return getDB(); }

// Default bar fetcher — lazy-required so tests can inject their own.
let barFetcher = null;
function getBarFetcher() {
  if (barFetcher) return barFetcher;
  const { getHistoryFull } = require('../data/providers/manager');
  barFetcher = async (symbol) => getHistoryFull(symbol);
  return barFetcher;
}

// Override used by tests. Fetcher must return `[{date, open, high, low, close, volume}]`
// sorted oldest→newest.
function setBarFetcher(fn) { barFetcher = fn; }

// ─── Core computation ───────────────────────────────────────────────────────
//
// Given the signal's emission_date, entry_price, stop_price, targets, and the
// full bar history, produces the outcome object ready for resolveOutcome().
//
// Convention for long signals (side='long'):
//   - return =   (close - entry) / entry
//   - MFE    =   max((high - entry) / entry) across horizon bars
//   - MAE    =   min((low  - entry) / entry) across horizon bars   (≤ 0)
//   - hit_stop    = any bar low  ≤ stop_price
//   - hit_target1 = any bar high ≥ target1_price
//
// For short signals the sign flips: MFE uses lows, MAE uses highs, stop uses
// highs, targets use lows.
//
// outcome_label:
//   winner  if ret_20d ≥ +5%  (or hit_target1 before 20d)
//   loser   if ret_20d ≤ -3%  (or hit_stop)
//   neutral otherwise
//
// These thresholds are deliberately round numbers — calibration.js re-derives
// hit rates under other definitions ("positive ret_10d", "R ≥ 1", etc.) so
// the label is just a coarse bucket for the dashboard.

const HORIZONS = [5, 10, 20];
const WIN_THRESHOLD = 0.05;
const LOSE_THRESHOLD = -0.03;

function computeOutcome(signal, bars) {
  if (!bars || bars.length === 0) return null;
  if (signal.entry_price == null) return null;

  const side = signal.side === 'short' ? 'short' : 'long';
  const entry = +signal.entry_price;
  const stop = signal.stop_price != null ? +signal.stop_price : null;
  const t1 = signal.target1_price != null ? +signal.target1_price : null;
  const t2 = signal.target2_price != null ? +signal.target2_price : null;

  // Find bars strictly AFTER emission_date. The emission bar itself is the
  // reference (entry_price), so forward returns count from the next trading
  // day. Using `>` handles both cases: signal emitted mid-day (today's bar
  // already has close) and signal emitted pre-market (same-day bar valid).
  const emission = signal.emission_date;
  const forward = bars.filter(b => b.date > emission);
  if (forward.length === 0) return null;

  // Returns at each horizon (use min(available, horizon) bar count)
  const closes = {};
  const returns = {};
  for (const h of HORIZONS) {
    if (forward.length >= h) {
      const bar = forward[h - 1];
      const c = +bar.close;
      closes[h] = c;
      returns[h] = side === 'long'
        ? (c - entry) / entry
        : (entry - c) / entry;
    } else {
      closes[h] = null;
      returns[h] = null;
    }
  }

  // MFE/MAE within horizon[last]=20 bars. If fewer bars available, use what
  // we have; MFE/MAE are running values, safe to report partial.
  const horizonBars = forward.slice(0, HORIZONS[HORIZONS.length - 1]);
  let mfe = 0, mae = 0;
  let hitStop = false, hitT1 = false, hitT2 = false;

  for (const b of horizonBars) {
    const high = +b.high;
    const low = +b.low;
    if (side === 'long') {
      mfe = Math.max(mfe, (high - entry) / entry);
      mae = Math.min(mae, (low - entry) / entry);
      if (stop != null && low <= stop) hitStop = true;
      if (t1 != null && high >= t1) hitT1 = true;
      if (t2 != null && high >= t2) hitT2 = true;
    } else {
      mfe = Math.max(mfe, (entry - low) / entry);
      mae = Math.min(mae, (entry - high) / entry);
      if (stop != null && high >= stop) hitStop = true;
      if (t1 != null && low <= t1) hitT1 = true;
      if (t2 != null && low <= t2) hitT2 = true;
    }
  }

  // R-multiple based on stop distance. If stop is missing or == entry (bad
  // data), realized_r is null — calibration can't use it but ret_20d still works.
  let realizedR = null;
  if (stop != null && stop !== entry && returns[20] != null) {
    const riskPerShare = Math.abs(entry - stop);
    const gainPerShare = side === 'long'
      ? (closes[20] - entry)
      : (entry - closes[20]);
    realizedR = gainPerShare / riskPerShare;
  }

  // Outcome label at 20d (or earliest meaningful data point available)
  let label = 'neutral';
  const ret20 = returns[20];
  if (ret20 != null) {
    if (hitT1 || ret20 >= WIN_THRESHOLD) label = 'winner';
    else if (hitStop || ret20 <= LOSE_THRESHOLD) label = 'loser';
  } else if (hitT1) {
    label = 'winner';
  } else if (hitStop) {
    label = 'loser';
  }

  // Determine final status: only 'resolved' once we have the 20d datapoint.
  // Partial resolutions stay 'open' so the closer keeps updating.
  const status = returns[20] != null ? 'resolved' : 'open';

  return {
    status,
    closed_at: status === 'resolved' ? new Date().toISOString() : null,
    close_price_5d: closes[5],
    close_price_10d: closes[10],
    close_price_20d: closes[20],
    ret_5d: returns[5],
    ret_10d: returns[10],
    ret_20d: returns[20],
    max_favorable: mfe,
    max_adverse: mae,
    hit_stop: hitStop,
    hit_target1: hitT1,
    hit_target2: hitT2,
    realized_r: realizedR,
    outcome_label: status === 'resolved' ? label : null,
  };
}

// ─── Orchestration ──────────────────────────────────────────────────────────
//
// Processes all open rows in one pass. Fetches each symbol's bars ONCE and
// reuses it across every open signal for that symbol. On provider failure we
// skip (don't mark), so the next run retries.

async function runOutcomeCloser({ minAgeDays = 5, limit = 500, barsProvider } = {}) {
  const fetcher = barsProvider || getBarFetcher();
  const open = getOpenSignals({ minAgeDays, limit });
  if (open.length === 0) {
    return { examined: 0, updated: 0, resolved: 0, skipped: 0, errors: [] };
  }

  // Group by symbol to minimize provider calls
  const bySymbol = new Map();
  for (const row of open) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row);
  }

  let updated = 0;
  let resolved = 0;
  let skipped = 0;
  const errors = [];

  for (const [symbol, signals] of bySymbol) {
    let bars;
    try {
      bars = await fetcher(symbol);
    } catch (e) {
      errors.push({ symbol, error: e.message });
      skipped += signals.length;
      continue;
    }
    if (!bars || bars.length === 0) {
      skipped += signals.length;
      continue;
    }

    for (const sig of signals) {
      const outcome = computeOutcome(sig, bars);
      if (!outcome) { skipped++; continue; }
      const ok = resolveOutcome(sig.id, outcome);
      if (ok) {
        updated++;
        if (outcome.status === 'resolved') resolved++;
      }
    }
  }

  return { examined: open.length, updated, resolved, skipped, errors };
}

module.exports = {
  runOutcomeCloser,
  computeOutcome,
  setBarFetcher,
  WIN_THRESHOLD,
  LOSE_THRESHOLD,
  HORIZONS,
};
