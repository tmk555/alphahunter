// ─── 3-Tranche Scale-In Workflow ─────────────────────────────────────────────
// Builds positions gradually instead of all-at-once entries.
// Pilot (1/3) → Confirmation (1/3) → Full Breakout (1/3)
// Stops tighten as tranches fill. Reduces risk of full-size entries on shakeouts.
const { getDB } = require('../data/database');
const { notifyTradeEvent } = require('../notifications/channels');

function db() { return getDB(); }

function marketDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── Create Scale-In Plan ───────────────────────────────────────────────────

function createScaleInPlan(params) {
  const {
    tradeId, symbol, totalShares, entryPrice, stopPrice, target1, target2,
    tranche2Trigger = 'confirmation',
    tranche3Trigger = 'breakout',
  } = params;

  if (!tradeId || !symbol || !totalShares || !entryPrice || !stopPrice) {
    throw new Error('tradeId, symbol, totalShares, entryPrice, stopPrice required');
  }

  // Split shares: ceil(1/3), ceil(remaining/2), rest
  const t1qty = Math.max(1, Math.ceil(totalShares / 3));
  const remaining = totalShares - t1qty;
  const t2qty = Math.max(1, Math.ceil(remaining / 2));
  const t3qty = totalShares - t1qty - t2qty;

  // Tranche 2 trigger: confirmation = hold above entry for 3+ days
  const t2TriggerPrice = entryPrice; // Must stay above entry price

  // Tranche 3 trigger: breakout = halfway to target1 or 3% above entry
  const t3TriggerPrice = target1
    ? +(entryPrice + (target1 - entryPrice) * 0.5).toFixed(2)
    : +(entryPrice * 1.03).toFixed(2);

  const result = db().prepare(`
    INSERT INTO scale_in_plans
      (trade_id, symbol, total_shares,
       tranche1_qty, tranche1_price, tranche1_filled_at,
       tranche2_qty, tranche2_trigger, tranche2_trigger_price,
       tranche3_qty, tranche3_trigger, tranche3_trigger_price,
       current_tranche, stop_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active')
  `).run(
    tradeId, symbol.toUpperCase(), totalShares,
    t1qty, entryPrice, marketDate(),  // Tranche 1 fills immediately (pilot)
    t2qty, tranche2Trigger, t2TriggerPrice,
    t3qty, tranche3Trigger, t3TriggerPrice,
    2, // Start at tranche 2 since pilot is immediate
    stopPrice,
  );

  // Update the parent trade to reflect pilot size
  db().prepare('UPDATE trades SET shares = ?, initial_shares = ?, remaining_shares = ? WHERE id = ?')
    .run(t1qty, totalShares, t1qty, tradeId);

  const plan = getScaleInPlan(result.lastInsertRowid);

  notifyTradeEvent({
    event: 'scale_in',
    symbol: symbol.toUpperCase(),
    details: {
      shares: t1qty,
      price: entryPrice,
      message: `Scale-in plan created: Pilot ${t1qty}/${totalShares} shares. Next: ${tranche2Trigger} at $${t2TriggerPrice}`,
    },
  }).catch(e => console.error('Notification error:', e.message));

  return plan;
}

// ─── Evaluate Scale-In Trigger ──────────────────────────────────────────────

function evaluateScaleInTrigger(planId, currentPrice, currentData = {}) {
  const plan = getScaleInPlan(planId);
  if (!plan || plan.status !== 'active') return null;

  const { daysHeld = 0, volume_ratio = 1.0, rsRank, momentum } = currentData;
  const tranche = plan.current_tranche;

  // All tranches filled
  if (tranche > 3) return null;

  let shouldTrigger = false;
  let qty = 0;
  let reason = '';

  if (tranche === 2) {
    qty = plan.tranche2_qty;
    const trigger = plan.tranche2_trigger;
    const triggerPrice = plan.tranche2_trigger_price;

    switch (trigger) {
      case 'confirmation':
        // Hold above entry for 3+ days with volume confirmation
        shouldTrigger = currentPrice > triggerPrice && daysHeld >= 3 && volume_ratio >= 0.9;
        reason = `Confirmed: price above $${triggerPrice} for ${daysHeld} days`;
        break;
      case 'pullback_hold':
        // Price pulled back to near entry (±2%) and held (didn't hit stop)
        const nearEntry = Math.abs(currentPrice - triggerPrice) / triggerPrice < 0.02;
        shouldTrigger = nearEntry && daysHeld >= 2 && currentPrice > plan.stop_price;
        reason = `Pullback held: price near $${triggerPrice}, stop intact`;
        break;
      case 'breakout':
        shouldTrigger = currentPrice >= triggerPrice;
        reason = `Breakout above $${triggerPrice}`;
        break;
      default:
        shouldTrigger = currentPrice > triggerPrice && daysHeld >= 3;
        reason = 'Default confirmation trigger';
    }
  } else if (tranche === 3) {
    qty = plan.tranche3_qty;
    const trigger = plan.tranche3_trigger;
    const triggerPrice = plan.tranche3_trigger_price;

    switch (trigger) {
      case 'breakout':
        shouldTrigger = currentPrice >= triggerPrice;
        reason = `Breakout above $${triggerPrice}`;
        break;
      case 'new_high':
        shouldTrigger = currentPrice >= triggerPrice;
        reason = `New high above $${triggerPrice}`;
        break;
      case 'volume_surge':
        shouldTrigger = volume_ratio >= 1.5 && currentPrice > plan.tranche1_price;
        reason = `Volume surge (${volume_ratio.toFixed(1)}x) above entry`;
        break;
      default:
        shouldTrigger = currentPrice >= triggerPrice;
        reason = 'Default breakout trigger';
    }
  }

  if (!shouldTrigger) return null;

  return {
    shouldTrigger: true,
    trancheNum: tranche,
    qty,
    reason,
    symbol: plan.symbol,
    planId: plan.id,
    currentPrice,
  };
}

// ─── Fill Tranche ───────────────────────────────────────────────────────────

function fillTranche(planId, trancheNum, fillPrice) {
  const plan = getScaleInPlan(planId);
  if (!plan) throw new Error(`Scale-in plan ${planId} not found`);
  if (plan.status !== 'active') throw new Error('Plan is not active');

  const date = marketDate();

  if (trancheNum === 1) {
    db().prepare('UPDATE scale_in_plans SET tranche1_price = ?, tranche1_filled_at = ?, current_tranche = 2 WHERE id = ?')
      .run(fillPrice, date, planId);
  } else if (trancheNum === 2) {
    db().prepare('UPDATE scale_in_plans SET tranche2_trigger_price = ?, tranche2_filled_at = ?, current_tranche = 3 WHERE id = ?')
      .run(fillPrice, date, planId);
  } else if (trancheNum === 3) {
    db().prepare('UPDATE scale_in_plans SET tranche3_trigger_price = ?, tranche3_filled_at = ?, current_tranche = 4, status = \'completed\' WHERE id = ?')
      .run(fillPrice, date, planId);
  }

  // Update parent trade shares
  const filledQty = _totalFilledShares(planId, trancheNum);
  db().prepare('UPDATE trades SET shares = ?, remaining_shares = ? WHERE id = ?')
    .run(filledQty, filledQty, plan.trade_id);

  // Tighten stop as tranches fill
  const newStop = _computeTightenedStop(plan, trancheNum, fillPrice);
  if (newStop) {
    db().prepare('UPDATE scale_in_plans SET stop_price = ? WHERE id = ?').run(newStop, planId);
    db().prepare('UPDATE trades SET stop_price = ? WHERE id = ?').run(newStop, plan.trade_id);
  }

  // Send notification
  const trancheQty = trancheNum === 1 ? plan.tranche1_qty : trancheNum === 2 ? plan.tranche2_qty : plan.tranche3_qty;
  notifyTradeEvent({
    event: 'scale_in',
    symbol: plan.symbol,
    details: {
      shares: trancheQty,
      price: fillPrice,
      message: `Tranche ${trancheNum}/3 filled: +${trancheQty} shares at $${fillPrice}. Total: ${filledQty}/${plan.total_shares}`,
    },
  }).catch(e => console.error('Notification error:', e.message));

  return getScaleInPlan(planId);
}

function _totalFilledShares(planId, upToTranche) {
  const plan = getScaleInPlan(planId);
  let total = 0;
  if (upToTranche >= 1 && plan.tranche1_filled_at) total += plan.tranche1_qty;
  if (upToTranche >= 2 && plan.tranche2_filled_at) total += plan.tranche2_qty;
  if (upToTranche >= 3 && plan.tranche3_filled_at) total += plan.tranche3_qty;
  return total;
}

function _computeTightenedStop(plan, trancheNum, fillPrice) {
  const entry = plan.tranche1_price || fillPrice;
  const risk = entry - plan.stop_price;

  if (trancheNum === 2) {
    // After tranche 2: tighten stop to 1.5x ATR (from 2x)
    return +(entry - risk * 0.75).toFixed(2);
  }
  if (trancheNum === 3) {
    // After full size: tighten stop to breakeven or 1x ATR
    return +(entry - risk * 0.5).toFixed(2);
  }
  return null;
}

// ─── Update Stop ────────────────────────────────────────────────────────────

function updateScaleInStop(planId, newStop) {
  const plan = getScaleInPlan(planId);
  if (!plan) throw new Error(`Scale-in plan ${planId} not found`);

  db().prepare('UPDATE scale_in_plans SET stop_price = ? WHERE id = ?').run(newStop, planId);
  db().prepare('UPDATE trades SET stop_price = ? WHERE id = ?').run(newStop, plan.trade_id);

  return getScaleInPlan(planId);
}

// ─── Query Helpers ──────────────────────────────────────────────────────────

function getScaleInPlan(planId) {
  return db().prepare('SELECT * FROM scale_in_plans WHERE id = ?').get(planId);
}

function getActivePlans() {
  return db().prepare("SELECT * FROM scale_in_plans WHERE status = 'active' ORDER BY created_at DESC").all();
}

function cancelPlan(planId) {
  db().prepare("UPDATE scale_in_plans SET status = 'cancelled' WHERE id = ?").run(planId);
  return getScaleInPlan(planId);
}

// ─── Check All Active Plans ─────────────────────────────────────────────────
// Called by the monitor cron cycle.

async function checkAllActivePlans(currentPrices, scanData = {}) {
  const plans = getActivePlans();
  if (!plans.length) return { triggered: [], checked: 0 };

  const triggered = [];

  for (const plan of plans) {
    const price = currentPrices[plan.symbol];
    if (!price) continue;

    // Build current data from scan snapshots
    const stockData = scanData[plan.symbol] || {};
    const trade = db().prepare('SELECT * FROM trades WHERE id = ?').get(plan.trade_id);
    const daysHeld = trade?.entry_date
      ? Math.floor((Date.now() - new Date(trade.entry_date).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    const result = evaluateScaleInTrigger(plan.id, price, {
      daysHeld,
      volume_ratio: stockData.volume_ratio || 1.0,
      rsRank: stockData.rs_rank,
      momentum: stockData.swing_momentum,
    });

    if (result) {
      try {
        fillTranche(plan.id, result.trancheNum, price);
        triggered.push(result);
      } catch (e) {
        console.error(`  Scale-in fill error for ${plan.symbol}: ${e.message}`);
      }
    }
  }

  return { triggered, checked: plans.length };
}

module.exports = {
  createScaleInPlan,
  evaluateScaleInTrigger,
  fillTranche,
  updateScaleInStop,
  getScaleInPlan,
  getActivePlans,
  cancelPlan,
  checkAllActivePlans,
};
