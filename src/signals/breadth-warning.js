// ─── Breadth Early Warning System ──────────────────────────────────────────
// Detects breadth composite deterioration BEFORE the market regime label
// catches up. Uses rate-of-change over rolling windows to trigger:
//   • Proactive stop tightening on open positions
//   • Reduced new-entry sizing
//   • Earlier hedge flags
//
// Key insight: breadth leads regime by 2-8 weeks. By the time regime
// downgrades from BULL to CAUTION, a good chunk of alpha is already lost.
// This module bridges that gap.

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Warning Levels ────────────────────────────────────────────────────────
// NONE     — breadth stable or improving, no action needed
// CAUTION  — early deterioration detected, reduce new entry sizing
// WARNING  — significant deterioration, tighten stops on profitable positions
// CRITICAL — rapid deterioration or broken breadth, tighten all stops + halt entries

const WARNING_LEVELS = {
  NONE:     { level: 0, label: 'NONE',     color: '#4caf50', sizingMult: 1.0,  stopAction: 'none' },
  CAUTION:  { level: 1, label: 'CAUTION',  color: '#f0a500', sizingMult: 0.75, stopAction: 'reduce_sizing' },
  WARNING:  { level: 2, label: 'WARNING',  color: '#ff8c00', sizingMult: 0.50, stopAction: 'tighten_profitable' },
  CRITICAL: { level: 3, label: 'CRITICAL', color: '#ff3d57', sizingMult: 0.0,  stopAction: 'tighten_all' },
};

// ─── Evaluate Breadth Warning ──────────────────────────────────────────────
// Reads breadth_snapshots, computes rolling deltas, returns warning + actions.

function evaluateBreadthWarning() {
  const history = db().prepare(`
    SELECT date, composite_score, pct_above_50ma, pct_above_200ma,
           new_highs, new_lows, regime
    FROM breadth_snapshots
    ORDER BY date DESC LIMIT 30
  `).all().reverse();

  if (history.length < 5) {
    return {
      ...WARNING_LEVELS.NONE,
      message: 'Insufficient breadth history for early warning',
      history: [],
      deltas: null,
    };
  }

  const latest = history[history.length - 1];
  // Pre-fix `currentScore` was just the persisted snapshot value (latest
  // breadth_snapshot row, written by the daily 16:30 ET cron). Analytics'
  // /api/breadth recomputes the composite LIVE from current quotes, so
  // the two tabs displayed different numbers (Market Pulse 48, Analytics
  // 45 — same trader, same minute). Confusing.
  //
  // Fix: try the live recompute first; fall back to the persisted value
  // only if the live path fails. Deltas still use the persisted history
  // (deltas need a stable historical baseline regardless of intraday
  // moves), so ALL the warning thresholds and 1W/2W/3W deltas are
  // unchanged — only the headline currentScore is now live.
  let currentScore = latest.composite_score;
  let scoreSource  = 'persisted_snapshot';
  let scoreAsOf    = latest.date;
  try {
    const { computeBreadthFromSnapshots, computeCompositeBreadthScore,
            assessVIXTermStructure } = require('./breadth');
    const _db = db();
    const latestDate = _db.prepare(
      `SELECT MAX(date) as date FROM rs_snapshots WHERE type = 'stock'`
    ).get()?.date;
    if (latestDate) {
      const liveBreadth = computeBreadthFromSnapshots(latestDate);
      if (liveBreadth) {
        const vixHistory = _db.prepare(
          `SELECT price FROM rs_snapshots WHERE symbol = '^VIX' AND type='sector' AND price>0
           ORDER BY date DESC LIMIT 252`
        ).all().map(r => r.price).reverse();
        const vixLatest = vixHistory.length ? vixHistory[vixHistory.length - 1] : null;
        const vixStruct = vixLatest && vixHistory.length > 20
          ? assessVIXTermStructure(vixLatest, vixHistory) : null;
        const liveComposite = computeCompositeBreadthScore(liveBreadth, vixStruct, null);
        if (liveComposite && Number.isFinite(liveComposite.score)) {
          currentScore = liveComposite.score;
          scoreSource  = 'live_recompute';
          scoreAsOf    = latestDate;
        }
      }
    }
  } catch (_) { /* fall through with persisted score */ }

  // ── Rolling deltas over multiple windows ─────────────────────────────
  const delta5d  = _computeDelta(history, 5);   // ~1 week
  const delta10d = _computeDelta(history, 10);  // ~2 weeks
  const delta15d = _computeDelta(history, 15);  // ~3 weeks

  // ── MA50 breadth rate of change (most sensitive leading indicator) ───
  const ma50Delta5d  = _computeFieldDelta(history, 'pct_above_50ma', 5);
  const ma50Delta10d = _computeFieldDelta(history, 'pct_above_50ma', 10);

  // ── New highs/lows momentum ─────────────────────────────────────────
  const recentHL = history.slice(-5);
  const avgNewHighs = recentHL.reduce((s, r) => s + (r.new_highs || 0), 0) / recentHL.length;
  const avgNewLows  = recentHL.reduce((s, r) => s + (r.new_lows || 0), 0) / recentHL.length;
  const hlRatio = avgNewLows > 0 ? +(avgNewHighs / avgNewLows).toFixed(2) : 99;

  // ── Determine warning level ─────────────────────────────────────────
  const reasons = [];
  let warningLevel = 'NONE';

  // CRITICAL triggers (any one is enough)
  if (currentScore <= 25) {
    warningLevel = 'CRITICAL';
    reasons.push(`Composite score ${currentScore} — breadth broken`);
  } else if (delta10d <= -15) {
    warningLevel = 'CRITICAL';
    reasons.push(`Composite dropped ${Math.abs(delta10d)} pts in 2 weeks — rapid deterioration`);
  } else if (delta15d <= -20) {
    warningLevel = 'CRITICAL';
    reasons.push(`Composite dropped ${Math.abs(delta15d)} pts in 3 weeks — sustained collapse`);
  } else if (ma50Delta10d <= -15) {
    warningLevel = 'CRITICAL';
    reasons.push(`% above 50MA dropped ${Math.abs(ma50Delta10d)} pts in 2 weeks`);
  }

  // WARNING triggers (need at least 2 signals for robustness)
  if (warningLevel === 'NONE') {
    let warningSignals = 0;
    if (delta10d <= -10) { warningSignals++; reasons.push(`Composite -${Math.abs(delta10d)} pts over 2 weeks`); }
    if (ma50Delta10d <= -10) { warningSignals++; reasons.push(`% above 50MA -${Math.abs(ma50Delta10d)} pts over 2 weeks`); }
    if (hlRatio < 0.5) { warningSignals++; reasons.push(`New lows dominating (H/L ratio: ${hlRatio})`); }
    if (currentScore <= 40) { warningSignals++; reasons.push(`Composite score ${currentScore} in MIXED zone`); }
    if (delta5d <= -8) { warningSignals++; reasons.push(`Composite -${Math.abs(delta5d)} pts in 1 week — sharp drop`); }

    if (warningSignals >= 2) warningLevel = 'WARNING';
  }

  // CAUTION triggers (single signal is enough — early flag)
  if (warningLevel === 'NONE') {
    if (delta10d <= -5) { warningLevel = 'CAUTION'; reasons.push(`Composite -${Math.abs(delta10d)} pts over 2 weeks`); }
    else if (delta5d <= -5) { warningLevel = 'CAUTION'; reasons.push(`Composite -${Math.abs(delta5d)} pts in 1 week`); }
    else if (ma50Delta5d <= -8) { warningLevel = 'CAUTION'; reasons.push(`% above 50MA dropped ${Math.abs(ma50Delta5d)} pts in 1 week`); }
    else if (currentScore <= 45 && delta5d < 0) { warningLevel = 'CAUTION'; reasons.push(`Low composite (${currentScore}) still declining`); }
  }

  const warning = WARNING_LEVELS[warningLevel];

  return {
    ...warning,
    currentScore,
    // Diagnostics so the UI can show "as of HH:MM (live)" vs "from
    // YYYY-MM-DD snapshot" — proves to the user the same composite is
    // displayed on Market Pulse AND Analytics.
    scoreSource,
    scoreAsOf,
    reasons,
    deltas: {
      composite5d: delta5d,
      composite10d: delta10d,
      composite15d: delta15d,
      ma50_5d: ma50Delta5d,
      ma50_10d: ma50Delta10d,
      hlRatio,
    },
    latest: {
      date: latest.date,
      score: currentScore,
      pctAbove50MA: latest.pct_above_50ma,
      pctAbove200MA: latest.pct_above_200ma,
      regime: latest.regime,
    },
    history: history.slice(-15).map(h => ({
      date: h.date,
      score: h.composite_score,
      pctAbove50MA: h.pct_above_50ma,
    })),
    message: warningLevel === 'NONE'
      ? 'Breadth stable — no early warning signals'
      : `BREADTH ${warningLevel}: ${reasons.join('; ')}`,
  };
}

// ─── Compute Stop Adjustments for Open Positions ───────────────────────────
// Given a warning level, returns recommended stop changes for each open trade.
// Does NOT mutate the database — caller decides whether to apply.

function computeStopAdjustments(warningLevel) {
  if (!warningLevel || warningLevel === 'NONE') return { adjustments: [], skipped: [], actions: [] };

  const trades = db().prepare(
    'SELECT * FROM trades WHERE exit_date IS NULL'
  ).all();

  if (!trades.length) return { adjustments: [], skipped: [], actions: [] };

  const adjustments = [];
  // Trades that the rules wouldn't / couldn't tighten — surfaced so the
  // user can see WHICH positions weren't acted on and why. Previously these
  // were silently dropped, leading to "did not tighten all positions"
  // confusion when the row count in PENDING ADJUSTMENTS was less than the
  // open-position count.
  const skipped = [];

  for (const trade of trades) {
    const entry = trade.entry_price;
    const currentStop = trade.stop_price;
    const isShort = trade.side === 'short';
    if (!entry || !currentStop) {
      skipped.push({
        tradeId: trade.id, symbol: trade.symbol, side: trade.side,
        entryPrice: entry || null, currentStop: currentStop || null,
        reason: !entry
          ? 'No entry price recorded — set manually before tightening'
          : 'No stop price set — needs a stop before tightening rules apply',
      });
      continue;
    }

    // Determine if position is profitable (use current stop vs entry as proxy)
    // A stop above entry (for long) means we've already moved to breakeven or better
    const isProfitable = isShort
      ? currentStop < entry
      : currentStop > entry;

    // Distance from entry to current stop (in ATR terms, approximated)
    const stopDistance = Math.abs(entry - currentStop);
    const stopPct = (stopDistance / entry) * 100;

    let newStop = null;
    let reason = null;

    if (warningLevel === 'CRITICAL') {
      // Tighten ALL positions
      if (isProfitable) {
        // Move to breakeven or tighter
        newStop = entry;
        reason = 'Breadth CRITICAL — stop to breakeven';
      } else {
        // Tighten unprofitable: halve the stop distance (2 ATR → 1 ATR)
        const tighterDistance = stopDistance * 0.5;
        newStop = isShort
          ? +(entry + tighterDistance).toFixed(2)
          : +(entry - tighterDistance).toFixed(2);
        reason = 'Breadth CRITICAL — stop tightened to 1 ATR';
      }
    } else if (warningLevel === 'WARNING') {
      if (isProfitable) {
        // Move profitable positions to breakeven
        newStop = entry;
        reason = 'Breadth WARNING — profitable stop to breakeven';
      } else {
        // Tighten unprofitable by 25% (2 ATR → 1.5 ATR)
        const tighterDistance = stopDistance * 0.75;
        newStop = isShort
          ? +(entry + tighterDistance).toFixed(2)
          : +(entry - tighterDistance).toFixed(2);
        reason = 'Breadth WARNING — stop tightened to 1.5 ATR';
      }
    }
    // CAUTION: no stop changes, only sizing reduction

    if (newStop === null) {
      skipped.push({
        tradeId: trade.id, symbol: trade.symbol, side: trade.side,
        entryPrice: entry, currentStop,
        reason: warningLevel === 'CAUTION'
          ? 'CAUTION level only reduces new sizing — open stops left in place'
          : 'No tightening rule matched this position',
      });
      continue;
    }

    // Safety: only tighten, never loosen stops
    const isTighter = isShort
      ? newStop < currentStop
      : newStop > currentStop;

    if (!isTighter) {
      skipped.push({
        tradeId: trade.id, symbol: trade.symbol, side: trade.side,
        entryPrice: entry, currentStop, candidateStop: +newStop.toFixed(2),
        reason: 'Current stop is already tighter than the rule would set',
      });
      continue;
    }

    adjustments.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      entryPrice: entry,
      currentStop,
      newStop,
      isProfitable,
      reason,
      stopDistanceBefore: +stopPct.toFixed(1),
      stopDistanceAfter: +((Math.abs(entry - newStop) / entry) * 100).toFixed(1),
    });
  }

  return {
    adjustments,
    skipped,
    actions: warningLevel === 'CRITICAL'
      ? ['tighten_all_stops', 'halt_new_entries', 'evaluate_hedges']
      : warningLevel === 'WARNING'
        ? ['tighten_profitable_stops', 'reduce_new_sizing']
        : ['reduce_new_sizing'],
  };
}

// ─── Apply Stop Adjustments ────────────────────────────────────────────────
// Writes tighter stops to the trades table, updates alert subscriptions,
// AND patches every open stop leg at the broker. Without the broker patch,
// the local DB and the actual bracket order diverge — the position could
// get stopped out at the OLD price while the app thinks the stop is tighter.
// That silent divergence is a real-money risk, not a logging issue.

async function applyStopAdjustments(adjustments) {
  if (!adjustments?.length) return { applied: 0, brokerPatched: 0, brokerFailed: 0 };

  const updateStop = db().prepare('UPDATE trades SET stop_price = ? WHERE id = ?');
  const deactivateAlerts = db().prepare(
    'UPDATE alert_subscriptions SET active = 0 WHERE trade_id = ? AND alert_type = ?'
  );
  const insertAlert = db().prepare(`
    INSERT INTO alert_subscriptions (symbol, alert_type, trigger_price, direction, trade_id, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const logAlert = db().prepare(`
    INSERT INTO alerts (type, symbol, message, data) VALUES (?, ?, ?, ?)
  `);

  const applied = [];
  // Phase 1: local DB updates inside a transaction so they're atomic.
  const applyAll = db().transaction(() => {
    for (const adj of adjustments) {
      updateStop.run(adj.newStop, adj.tradeId);
      deactivateAlerts.run(adj.tradeId, 'stop_violation');
      insertAlert.run(
        adj.symbol, 'stop_violation', adj.newStop,
        adj.side === 'short' ? 'above' : 'below', adj.tradeId,
        `${adj.symbol} breadth-tightened stop at $${adj.newStop}`,
      );
      logAlert.run(
        'breadth_warning', adj.symbol,
        `${adj.reason} — stop moved from $${adj.currentStop} to $${adj.newStop}`,
        JSON.stringify(adj),
      );
      applied.push(adj);
    }
  });
  applyAll();

  // Phase 2: patch broker bracket stop legs so they match the new local stop.
  // Done outside the DB transaction because broker calls are I/O and slow.
  // On failure per-symbol, we log but don't roll back — the local row IS the
  // source of truth for the monitor, and the monitor's next tick will attempt
  // to reconcile via evaluateScalingAction → replaceStopsForSymbol again.
  let brokerPatched = 0, brokerFailed = 0;
  try {
    const { getBroker } = require('../broker');
    const broker = getBroker();
    for (const adj of applied) {
      try {
        const result = await broker.replaceStopsForSymbol({
          symbol: adj.symbol,
          newStopPrice: adj.newStop,
        });
        if (result?.length) brokerPatched++;
        else console.warn(`  breadth-warning: no open stop legs found for ${adj.symbol} (position may be closed or bracket parent not filled yet)`);
      } catch (e) {
        brokerFailed++;
        console.error(`  breadth-warning broker patch failed for ${adj.symbol}: ${e.message}`);
      }
    }
  } catch (e) {
    // Broker not configured — local stops still moved, user will see divergence
    // in the Trading tab's orders grid. Not fatal.
    console.warn(`  breadth-warning: broker unavailable, local stops moved but Alpaca not patched: ${e.message}`);
  }

  return { applied: applied.length, brokerPatched, brokerFailed, adjustments: applied };
}

// ─── Full Early Warning Check (called from monitor cron) ───────────────────
// Evaluates warning, computes adjustments, optionally auto-applies.

async function runBreadthEarlyWarning({ autoApply = false } = {}) {
  const warning = evaluateBreadthWarning();

  if (warning.level === 0) {
    return { warning, adjustments: null, skipped: [], applied: false };
  }

  const { adjustments, skipped, actions } = computeStopAdjustments(warning.label);

  let applyResult = null;
  if (autoApply && adjustments.length > 0) {
    applyResult = await applyStopAdjustments(adjustments);
    console.log(`  Breadth Early Warning [${warning.label}]: Applied ${applyResult.applied} local, ${applyResult.brokerPatched} broker legs (${applyResult.brokerFailed} failed) · ${skipped.length} skipped`);
  } else if (adjustments.length > 0) {
    console.log(`  Breadth Early Warning [${warning.label}]: ${adjustments.length} stop adjustment(s) pending (auto-apply disabled), ${skipped.length} skipped`);
  }

  return {
    warning,
    adjustments,
    skipped,
    actions,
    applied: applyResult,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _computeDelta(history, lookback) {
  if (history.length < lookback + 1) return null;
  const now = history[history.length - 1].composite_score;
  const then = history[history.length - 1 - lookback]?.composite_score;
  if (now == null || then == null) return null;
  return +(now - then).toFixed(1);
}

function _computeFieldDelta(history, field, lookback) {
  if (history.length < lookback + 1) return null;
  const now = history[history.length - 1][field];
  const then = history[history.length - 1 - lookback]?.[field];
  if (now == null || then == null) return null;
  return +(now - then).toFixed(1);
}

module.exports = {
  evaluateBreadthWarning,
  computeStopAdjustments,
  applyStopAdjustments,
  runBreadthEarlyWarning,
  WARNING_LEVELS,
};
