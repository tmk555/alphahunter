// ─── Scaling / Partial Profit-Taking Engine ──────────────────────────────────
// Implements the classic O'Neil/Minervini exit pyramid:
//   • Sell 1/3 at target1 (typically +2–3R or +20%)
//   • Sell 1/3 at target2 (typically +5R or +50%)
//   • Trail the final 1/3 with a wider stop (50MA or 8% trail)
// Also handles stop-to-breakeven trigger after target1 hit.

const { getDB } = require('../data/database');

function db() { return getDB(); }

// Compute the next scaling action for a position based on current price
// Returns null if no action, or { action, shares, reason } object
function evaluateScalingAction(trade, currentPrice) {
  if (!trade || !currentPrice) return null;

  const shares = trade.remaining_shares ?? trade.shares ?? 0;
  if (shares <= 0) return null;

  // Check exit strategy — skip partial exits for full-out strategies
  const exitStrat = trade.exit_strategy || 'full_in_scale_out';
  const isScaleOut = exitStrat === 'full_in_scale_out' || exitStrat === 'scale_in_scale_out'
    || exitStrat === 'scale_in_out'; // legacy alias

  const initial   = trade.initial_shares ?? trade.shares;
  const target1   = trade.target1;
  const target2   = trade.target2;
  const stopPrice = trade.stop_price;
  const entry     = trade.entry_price;
  const isShort   = trade.side === 'short';

  let partials = [];
  try { partials = JSON.parse(trade.partial_exits || '[]'); } catch (_) {}
  const tookT1 = partials.some(p => p.level === 'target1');
  const tookT2 = partials.some(p => p.level === 'target2');

  // Helper: long target hit when price >= target; short target when price <= target
  const hit = (lvl) => isShort ? currentPrice <= lvl : currentPrice >= lvl;

  // Stop-out (full exit)
  if (stopPrice && (isShort ? currentPrice >= stopPrice : currentPrice <= stopPrice)) {
    return { action: 'full_exit', shares, level: 'stop', price: currentPrice,
             reason: `Stop ${stopPrice} hit at ${currentPrice}` };
  }

  // Target 1 — sell 1/3, move stop to breakeven (only for scale-out strategies)
  if (isScaleOut && target1 && !tookT1 && hit(target1)) {
    const sellQty = Math.max(1, Math.floor(initial / 3));
    const actualQty = Math.min(sellQty, shares);
    return {
      action: 'partial_exit',
      shares: actualQty,
      level: 'target1',
      price: target1,
      moveStopTo: entry,                  // breakeven
      reason: `Target1 ${target1} hit — sell 1/3, stop to breakeven`,
    };
  }

  // Target 2 — sell another 1/3, move stop up (only for scale-out strategies)
  if (isScaleOut && target2 && !tookT2 && hit(target2)) {
    const sellQty = Math.max(1, Math.floor(initial / 3));
    const actualQty = Math.min(sellQty, shares);
    // Move stop to halfway between entry and current price (lock in gains)
    const newStop = isShort
      ? +(entry - (entry - currentPrice) * 0.5).toFixed(2)
      : +(entry + (currentPrice - entry) * 0.5).toFixed(2);
    return {
      action: 'partial_exit',
      shares: actualQty,
      level: 'target2',
      price: target2,
      moveStopTo: newStop,
      activateTrailing: true,
      reason: `Target2 ${target2} hit — sell 1/3, raise stop to ${newStop}, trail final third`,
    };
  }

  // Trailing stop maintenance for the final third (after target2)
  if (isScaleOut && tookT2 && trade.trailing_stop_active) {
    // Per-trade trail percentage — defaults to 8% but the rotation/deterioration
    // watcher can tighten it to 4% when the trade's thesis erodes
    // (industry rotation down, individual RS collapse, stage→distribution).
    const trailPct = trade.trail_pct ?? 0.08;
    const newTrail = isShort
      ? +(currentPrice * (1 + trailPct)).toFixed(2)
      : +(currentPrice * (1 - trailPct)).toFixed(2);
    // Only tighten, never loosen
    if (isShort ? newTrail < stopPrice : newTrail > stopPrice) {
      return {
        action: 'update_stop',
        moveStopTo: newTrail,
        reason: `Trailing stop tightened to ${newTrail} (${(trailPct*100).toFixed(0)}% trail)`,
      };
    }
  }

  return null;
}

// Apply a scaling action to the trades table
function applyScalingAction(tradeId, action) {
  const trade = db().prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade) throw new Error(`Trade ${tradeId} not found`);

  let partials = [];
  try { partials = JSON.parse(trade.partial_exits || '[]'); } catch (_) {}

  if (action.action === 'partial_exit') {
    const isShort = trade.side === 'short';
    const pnlPerShare = isShort
      ? trade.entry_price - action.price
      : action.price - trade.entry_price;
    const realizedPnl = pnlPerShare * action.shares;
    const newRemaining = (trade.remaining_shares ?? trade.shares) - action.shares;

    partials.push({
      level: action.level,
      shares: action.shares,
      price: action.price,
      pnl: +realizedPnl.toFixed(2),
      timestamp: new Date().toISOString(),
    });

    db().prepare(`
      UPDATE trades
      SET remaining_shares = ?,
          partial_exits = ?,
          realized_pnl_dollars = COALESCE(realized_pnl_dollars,0) + ?,
          stop_price = COALESCE(?, stop_price),
          trailing_stop_active = COALESCE(?, trailing_stop_active)
      WHERE id = ?
    `).run(
      newRemaining,
      JSON.stringify(partials),
      realizedPnl,
      action.moveStopTo ?? null,
      action.activateTrailing ? 1 : null,
      tradeId,
    );

    return { ...action, realizedPnl, remaining: newRemaining };
  }

  if (action.action === 'update_stop') {
    db().prepare('UPDATE trades SET stop_price = ? WHERE id = ?')
      .run(action.moveStopTo, tradeId);
    return action;
  }

  if (action.action === 'full_exit') {
    // Caller is expected to actually close the position via broker;
    // we just flag it. Don't auto-write exit_date here.
    return action;
  }

  return action;
}

// Evaluate all open positions and return any pending actions
function scanOpenPositionsForScaling(currentPrices) {
  const trades = db().prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();
  const actions = [];
  for (const t of trades) {
    const price = currentPrices[t.symbol];
    if (price == null) continue;
    const action = evaluateScalingAction(t, price);
    if (action) actions.push({ trade: t, action });
  }
  return actions;
}

module.exports = { evaluateScalingAction, applyScalingAction, scanOpenPositionsForScaling };
