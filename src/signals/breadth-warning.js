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
  const currentScore = latest.composite_score;

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
  if (!warningLevel || warningLevel === 'NONE') return { adjustments: [], actions: [] };

  const trades = db().prepare(
    'SELECT * FROM trades WHERE exit_date IS NULL'
  ).all();

  if (!trades.length) return { adjustments: [], actions: [] };

  const adjustments = [];

  for (const trade of trades) {
    const entry = trade.entry_price;
    const currentStop = trade.stop_price;
    const isShort = trade.side === 'short';
    if (!entry || !currentStop) continue;

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

    if (newStop === null) continue;

    // Safety: only tighten, never loosen stops
    const isTighter = isShort
      ? newStop < currentStop
      : newStop > currentStop;

    if (!isTighter) continue;

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
    actions: warningLevel === 'CRITICAL'
      ? ['tighten_all_stops', 'halt_new_entries', 'evaluate_hedges']
      : warningLevel === 'WARNING'
        ? ['tighten_profitable_stops', 'reduce_new_sizing']
        : ['reduce_new_sizing'],
  };
}

// ─── Apply Stop Adjustments ────────────────────────────────────────────────
// Writes tighter stops to the trades table and updates alert subscriptions.

function applyStopAdjustments(adjustments) {
  if (!adjustments?.length) return { applied: 0 };

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
  const applyAll = db().transaction(() => {
    for (const adj of adjustments) {
      // Update stop price
      updateStop.run(adj.newStop, adj.tradeId);

      // Deactivate old stop alert and create new one
      deactivateAlerts.run(adj.tradeId, 'stop_violation');
      insertAlert.run(
        adj.symbol,
        'stop_violation',
        adj.newStop,
        adj.side === 'short' ? 'above' : 'below',
        adj.tradeId,
        `${adj.symbol} breadth-tightened stop at $${adj.newStop}`,
      );

      // Log the breadth warning action
      logAlert.run(
        'breadth_warning',
        adj.symbol,
        `${adj.reason} — stop moved from $${adj.currentStop} to $${adj.newStop}`,
        JSON.stringify(adj),
      );

      applied.push(adj);
    }
  });

  applyAll();
  return { applied: applied.length, adjustments: applied };
}

// ─── Full Early Warning Check (called from monitor cron) ───────────────────
// Evaluates warning, computes adjustments, optionally auto-applies.

function runBreadthEarlyWarning({ autoApply = false } = {}) {
  const warning = evaluateBreadthWarning();

  if (warning.level === 0) {
    return { warning, adjustments: null, applied: false };
  }

  const { adjustments, actions } = computeStopAdjustments(warning.label);

  let applyResult = null;
  if (autoApply && adjustments.length > 0) {
    applyResult = applyStopAdjustments(adjustments);
    console.log(`  Breadth Early Warning [${warning.label}]: Applied ${applyResult.applied} stop adjustment(s)`);
  } else if (adjustments.length > 0) {
    console.log(`  Breadth Early Warning [${warning.label}]: ${adjustments.length} stop adjustment(s) pending (auto-apply disabled)`);
  }

  return {
    warning,
    adjustments,
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
