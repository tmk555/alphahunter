// ─── Live MA-trail translation layer ───────────────────────────────────
//
// What this module does (the gap that was blocking real-money use):
//   The replay engine's staged_position trail strategy was only running
//   in BACKTEST. Live trading still used ATR stops because nothing in
//   production read each open position's price daily, computed MA values,
//   and emitted exit signals. So if the sweep showed PF 2.5 with MA
//   trails, the user's live PF was still ~1.0 from ATR stops — the
//   strategy in their backtest wasn't the strategy in their live account.
//
// This module fixes that. After market close each weekday:
//   1. Pull every open trade (`trades` where exit_date IS NULL)
//   2. For each, fetch ~120 days of price history → compute today's
//      13EMA / 26EMA / 50SMA
//   3. Determine the trail stage based on gain% + days held
//      (mirrors src/signals/replay.js evaluateExit's staged_position)
//   4. Compare today's close to the relevant trail MA
//   5. If close < trail MA → flag exit_signal=true, exit at next open
//      Otherwise → store suggested_stop = trail MA (UI surfaces as
//      "broker stop should be raised to $X")
//   6. Persist to position_trail_state for Daily Plan + cron consumption
//
// The user reads this through Daily Plan's "EXITS PENDING" panel each
// morning — one click closes flagged positions.

const { getDB } = require('./database');
const { computeMAsForPriceSeries } = require('../signals/replay');

// ── Trail-stage thresholds (must match replay.js evaluateExit) ────────
// Gain% takes precedence over days when both fire — so a trade that
// hits +20% in 5 days jumps straight to mature without going through
// the day-based middle stages.
function _stageForPosition({ gainPct, daysHeld, prevMaxGainPct = 0 }) {
  // Ratchet — once mature, never downgrade even on a pullback.
  const stagePoints = Math.max(gainPct || 0, prevMaxGainPct || 0);
  if (stagePoints >= 20 || daysHeld >= 45) return 'mature';
  if (stagePoints >= 12 || daysHeld >= 25) return 'intermediate';
  if (stagePoints >= 5  || daysHeld >= 10) return 'adolescence';
  return 'birth';
}

// Trail MA selector for each stage. Birth uses ATR (no MA trail yet).
function _trailMAForStage(stage) {
  if (stage === 'mature')        return 'sma50';
  if (stage === 'intermediate')  return 'ema26';
  if (stage === 'adolescence')   return 'ema13';
  return null;  // birth — ATR initial stop active, no MA trail
}

// Pull ~120 days of bars for a symbol (need 50 days for SMA50 + ~60
// warm-up for the EMAs to seed properly).
function _loadRecentBars(symbol, days = 120) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return getDB().prepare(`
    SELECT date, close AS price
    FROM daily_bars
    WHERE symbol = ? AND date >= ?
    ORDER BY date ASC
  `).all(symbol, cutoff);
}

// Today's snapshot — most recent close + computed MAs.
function _computeTodaysTrailMAs(symbol) {
  const bars = _loadRecentBars(symbol, 120);
  if (!bars.length || bars.length < 50) return null;
  const mas = computeMAsForPriceSeries(bars);
  const last = mas[mas.length - 1];
  const lastBar = bars[bars.length - 1];
  return {
    date:  lastBar.date,
    close: lastBar.price,
    ema13: last.ema13,
    ema26: last.ema26,
    sma50: last.sma50,
  };
}

// Compute trail state for a single open position.
// Returns the row to UPSERT into position_trail_state, or null if no data.
function computeTrailStateFor({ symbol, entry_date, entry_price, prevMaxGainPct = 0 }) {
  const today = _computeTodaysTrailMAs(symbol);
  if (!today) return null;

  // Days held from entry to today (calendar days; trading-day variant
  // would need a calendar lookup, calendar days is close enough for
  // stage gating).
  const daysHeld = Math.max(0, Math.floor(
    (new Date(today.date) - new Date(entry_date)) / 86400_000
  ));
  const gainPct = entry_price > 0
    ? +(((today.close - entry_price) / entry_price) * 100).toFixed(2)
    : 0;
  const newMaxGain = Math.max(prevMaxGainPct, gainPct);

  const stage = _stageForPosition({ gainPct, daysHeld, prevMaxGainPct: newMaxGain });
  const trailKey = _trailMAForStage(stage);

  // Birth stage = ATR initial stop is active in the broker, no MA trail
  // yet. We don't emit an exit signal for birth-stage positions even if
  // close happens to be below 13EMA — would whipsaw out of fresh entries.
  let exitSignal = 0, exitReason = null, suggestedStop = null;
  if (trailKey) {
    const maValue = today[trailKey];
    if (maValue != null) {
      suggestedStop = +maValue.toFixed(2);
      if (today.close < maValue) {
        exitSignal = 1;
        exitReason = `Closed below ${trailKey} ($${today.close.toFixed(2)} < $${maValue.toFixed(2)}) at stage=${stage}`;
      }
    }
  }

  return {
    symbol,
    entry_date,
    entry_price,
    current_stage: stage,
    max_gain_pct: newMaxGain,
    ema13: today.ema13 != null ? +today.ema13.toFixed(2) : null,
    ema26: today.ema26 != null ? +today.ema26.toFixed(2) : null,
    sma50: today.sma50 != null ? +today.sma50.toFixed(2) : null,
    suggested_stop: suggestedStop,
    exit_signal: exitSignal,
    exit_reason: exitReason,
  };
}

// Find all open positions. Long-only — short positions have inverted
// trail logic that lives in a separate path.
function _getOpenPositions() {
  return getDB().prepare(`
    SELECT id AS trade_id, symbol, entry_date, entry_price, sector
    FROM trades
    WHERE exit_date IS NULL AND (side = 'long' OR side IS NULL)
    ORDER BY entry_date ASC
  `).all();
}

// Read prior-day max gain so the ratchet works across days. Returns 0
// for first-time computation on a fresh position.
function _getPrevMaxGain(symbol, entry_date) {
  try {
    const r = getDB().prepare(`
      SELECT max_gain_pct FROM position_trail_state
      WHERE symbol = ? AND entry_date = ?
    `).get(symbol, entry_date);
    return r?.max_gain_pct || 0;
  } catch (_) { return 0; }
}

// EOD update — the cron handler. Returns summary for diagnostics.
function updateAllTrailStates() {
  const open = _getOpenPositions();
  if (!open.length) return { open: 0, updated: 0, exits: 0 };

  const upsert = getDB().prepare(`
    INSERT INTO position_trail_state
      (symbol, trade_id, entry_date, entry_price, current_stage, max_gain_pct,
       ema13, ema26, sma50, suggested_stop, exit_signal, exit_reason, updated_at)
    VALUES
      (@symbol, @trade_id, @entry_date, @entry_price, @current_stage, @max_gain_pct,
       @ema13, @ema26, @sma50, @suggested_stop, @exit_signal, @exit_reason, @updated_at)
    ON CONFLICT(symbol, entry_date) DO UPDATE SET
      current_stage  = excluded.current_stage,
      max_gain_pct   = excluded.max_gain_pct,
      ema13          = excluded.ema13,
      ema26          = excluded.ema26,
      sma50          = excluded.sma50,
      suggested_stop = excluded.suggested_stop,
      exit_signal    = excluded.exit_signal,
      exit_reason    = excluded.exit_reason,
      updated_at     = excluded.updated_at
  `);

  let updated = 0, exits = 0, errors = 0;
  const txn = getDB().transaction((positions) => {
    for (const p of positions) {
      try {
        const prevMaxGain = _getPrevMaxGain(p.symbol, p.entry_date);
        const state = computeTrailStateFor({
          symbol: p.symbol,
          entry_date: p.entry_date,
          entry_price: p.entry_price,
          prevMaxGainPct: prevMaxGain,
        });
        if (!state) continue;
        upsert.run({
          ...state,
          trade_id: p.trade_id,
          updated_at: new Date().toISOString(),
        });
        updated++;
        if (state.exit_signal) exits++;
      } catch (e) {
        errors++;
      }
    }
  });
  txn(open);

  return { open: open.length, updated, exits, errors };
}

// Read paths — used by Daily Plan tab + diagnostics.

// All currently-open positions with their trail state. Always returns
// a row per open position even if state hasn't been computed yet
// (tradier UI shows "trail state pending — run after market close").
function getAllPositionTrailStates() {
  const db = getDB();
  return db.prepare(`
    SELECT
      t.id AS trade_id, t.symbol, t.entry_date, t.entry_price, t.shares,
      t.sector, t.stop_price AS broker_stop_price,
      ts.current_stage, ts.max_gain_pct,
      ts.ema13, ts.ema26, ts.sma50,
      ts.suggested_stop, ts.exit_signal, ts.exit_reason, ts.updated_at
    FROM trades t
    LEFT JOIN position_trail_state ts
      ON t.symbol = ts.symbol AND t.entry_date = ts.entry_date
    WHERE t.exit_date IS NULL AND (t.side = 'long' OR t.side IS NULL)
    ORDER BY t.entry_date ASC
  `).all();
}

// Just the exit-flagged ones — small list for the Daily Plan banner.
function getActiveExitSignals() {
  return getDB().prepare(`
    SELECT
      t.id AS trade_id, t.symbol, t.entry_date, t.entry_price, t.shares,
      ts.current_stage, ts.max_gain_pct,
      ts.suggested_stop, ts.exit_reason, ts.updated_at
    FROM trades t
    JOIN position_trail_state ts
      ON t.symbol = ts.symbol AND t.entry_date = ts.entry_date
    WHERE t.exit_date IS NULL AND ts.exit_signal = 1
    ORDER BY ts.updated_at DESC
  `).all();
}

// Stop-update suggestions: positions where the current trail MA is
// HIGHER than the broker stop on file. Means the user should raise the
// broker stop to the suggested level (lock in more profit).
function getStopRaiseSuggestions() {
  return getDB().prepare(`
    SELECT
      t.id AS trade_id, t.symbol, t.stop_price AS broker_stop_price,
      ts.suggested_stop, ts.current_stage,
      ROUND(((ts.suggested_stop - t.stop_price) / t.stop_price) * 100, 1) AS raise_pct
    FROM trades t
    JOIN position_trail_state ts
      ON t.symbol = ts.symbol AND t.entry_date = ts.entry_date
    WHERE t.exit_date IS NULL
      AND ts.exit_signal = 0
      AND ts.suggested_stop IS NOT NULL
      AND t.stop_price IS NOT NULL
      AND ts.suggested_stop > t.stop_price * 1.005   -- only suggest if raise is ≥0.5%
    ORDER BY raise_pct DESC
  `).all();
}

module.exports = {
  computeTrailStateFor,    // pure function — exported for testing
  updateAllTrailStates,    // cron handler
  getAllPositionTrailStates,
  getActiveExitSignals,
  getStopRaiseSuggestions,
  // Constants exposed for testing/inspection
  _stageForPosition,
  _trailMAForStage,
};
