// ─── Watchlist-to-Execution Automation Engine ─────────────────────────────────
// Auto-stages bracket orders from trade setups and manages conditional entries.
// Turns the gap between "I see a setup" and "I have an order ready" into zero.
const { getDB } = require('../data/database');
const { stageOrder } = require('./staging');
const { notifyTradeEvent } = require('../notifications/channels');

function db() { return getDB(); }

function marketDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── Auto-Stage from Watchlist ──────────────────────────────────────────────
// For each watchlist symbol in scan results as a candidate, auto-stage orders.

function autoStageFromWatchlist(watchlistSymbols, scanResults, config = {}) {
  const {
    accountSize = 100000,
    riskPerTrade = 1.5,
    regimeMultiplier = 1.0,
  } = config;

  const scanMap = {};
  for (const s of scanResults) scanMap[s.ticker || s.symbol] = s;

  const staged = [];
  const skipped = [];
  const errors = [];

  for (const symbol of watchlistSymbols) {
    const stock = scanMap[symbol.toUpperCase()];
    if (!stock) {
      skipped.push({ symbol, reason: 'Not in scan results' });
      continue;
    }

    // Must be a viable candidate (RS >= 70, above 200MA, positive momentum)
    if ((stock.rsRank || 0) < 70) {
      skipped.push({ symbol, reason: `RS ${stock.rsRank} < 70` });
      continue;
    }
    if ((stock.vsMA200 || 0) < 0) {
      skipped.push({ symbol, reason: 'Below 200MA' });
      continue;
    }

    try {
      const price = stock.price;
      const atrPct = stock.atrPct || 2.5;
      const atr = price * (atrPct / 100);

      const entryPrice = price;
      const stopPrice = +(price - 1.5 * atr).toFixed(2);
      const target1 = +(price + 2.5 * atr).toFixed(2);
      const target2 = +(price + 4 * atr).toFixed(2);

      const riskPerShare = entryPrice - stopPrice;
      const dollarRisk = accountSize * (riskPerTrade / 100) * regimeMultiplier;
      const qty = Math.max(1, Math.floor(dollarRisk / riskPerShare));

      const order = stageOrder({
        symbol: symbol.toUpperCase(),
        side: 'buy',
        order_type: 'limit',
        qty,
        entry_price: entryPrice,
        stop_price: stopPrice,
        target1_price: target1,
        target2_price: target2,
        source: 'auto_watchlist',
        conviction_score: stock.convictionScore || null,
        notes: `Auto-staged: RS ${stock.rsRank}, Mom ${stock.swingMomentum}, SEPA ${stock.sepaScore}`,
      });

      staged.push({ symbol, orderId: order.id, qty, entry: entryPrice, stop: stopPrice });
    } catch (e) {
      errors.push({ symbol, error: e.message });
    }
  }

  return { staged, skipped, errors, total: watchlistSymbols.length };
}

// ─── Conditional Entry CRUD ────────────────────────────────────────────────

function createConditionalEntry(params) {
  const {
    symbol, conditionType = 'pullback', triggerPrice, entryPrice, stopPrice,
    target1Price, target2Price, qty, side = 'buy', source = 'manual',
    convictionScore, expiryDate,
  } = params;

  if (!symbol || !triggerPrice || !entryPrice || !stopPrice || !qty) {
    throw new Error('symbol, triggerPrice, entryPrice, stopPrice, qty required');
  }

  // Default expiry: 2 weeks from now
  const defaultExpiry = new Date();
  defaultExpiry.setDate(defaultExpiry.getDate() + 14);
  const expiry = expiryDate || defaultExpiry.toISOString().slice(0, 10);

  const result = db().prepare(`
    INSERT INTO conditional_entries
      (symbol, condition_type, trigger_price, entry_price, stop_price,
       target1_price, target2_price, qty, side, source, conviction_score, expiry_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol.toUpperCase(), conditionType, triggerPrice, entryPrice, stopPrice,
    target1Price || null, target2Price || null,
    qty, side, source, convictionScore || null, expiry,
  );

  return db().prepare('SELECT * FROM conditional_entries WHERE id = ?').get(result.lastInsertRowid);
}

// ─── Check Conditional Entries Against Current Prices ────────────────────────

async function checkConditionalEntries(currentPrices) {
  const pending = db().prepare(
    "SELECT * FROM conditional_entries WHERE status = 'pending'"
  ).all();

  if (!pending.length) return { triggered: [], expired: [] };

  const triggered = [];
  const expired = [];
  const today = marketDate();

  for (const entry of pending) {
    const price = currentPrices[entry.symbol];
    if (!price) continue;

    // Check expiry
    if (entry.expiry_date && entry.expiry_date < today) {
      db().prepare("UPDATE conditional_entries SET status = 'expired' WHERE id = ?").run(entry.id);
      expired.push({ id: entry.id, symbol: entry.symbol, reason: 'expired' });
      continue;
    }

    // Check trigger conditions
    let shouldTrigger = false;

    switch (entry.condition_type) {
      case 'pullback':
        // Trigger when price drops TO or BELOW trigger (pullback to entry zone)
        shouldTrigger = price <= entry.trigger_price;
        break;
      case 'breakout':
        // Trigger when price rises TO or ABOVE trigger (breakout above resistance)
        shouldTrigger = price >= entry.trigger_price;
        break;
      case 'limit':
        // Simple limit: trigger when price <= trigger (buy at discount)
        shouldTrigger = price <= entry.trigger_price;
        break;
      default:
        shouldTrigger = false;
    }

    if (shouldTrigger) {
      try {
        // Auto-stage a bracket order
        const defaults = _computeDefaultTargets(entry.entry_price, entry.stop_price);
        const order = stageOrder({
          symbol: entry.symbol,
          side: entry.side,
          order_type: 'limit',
          qty: entry.qty,
          entry_price: entry.entry_price,
          stop_price: entry.stop_price,
          target1_price: entry.target1_price || defaults.target1,
          target2_price: entry.target2_price || defaults.target2,
          source: `conditional_${entry.condition_type}`,
          conviction_score: entry.conviction_score,
          notes: `Conditional ${entry.condition_type} triggered at $${price}`,
        });

        // Update conditional entry status
        db().prepare(`
          UPDATE conditional_entries
          SET status = 'triggered', triggered_at = datetime('now'), staged_order_id = ?
          WHERE id = ?
        `).run(order.id, entry.id);

        triggered.push({
          id: entry.id, symbol: entry.symbol, price,
          triggerPrice: entry.trigger_price, orderId: order.id,
          conditionType: entry.condition_type,
        });

        // Send notification
        notifyTradeEvent({
          event: 'conditional_triggered',
          symbol: entry.symbol,
          details: {
            price,
            message: `${entry.condition_type.toUpperCase()} triggered: ${entry.symbol} at $${price} (trigger: $${entry.trigger_price})`,
            conditionType: entry.condition_type,
            stagedOrderId: order.id,
          },
        }).catch(e => console.error('Notification error:', e.message));

      } catch (e) {
        console.error(`  Conditional trigger error for ${entry.symbol}: ${e.message}`);
      }
    }
  }

  return { triggered, expired };
}

function _computeDefaultTargets(entryPrice, stopPrice) {
  const risk = entryPrice - stopPrice;
  return {
    target1: +(entryPrice + 2.5 * risk).toFixed(2),
    target2: +(entryPrice + 4 * risk).toFixed(2),
  };
}

// ─── Auto-Stage from AI Trade Briefs ────────────────────────────────────────

function autoStageFromTradeBriefs(briefs) {
  const staged = [];
  const skipped = [];

  for (const brief of briefs) {
    // Only auto-stage BUY verdicts
    const verdict = (brief.verdict || '').toUpperCase();
    if (verdict !== 'BUY') {
      skipped.push({ symbol: brief.symbol, verdict, reason: 'Not a BUY verdict' });
      continue;
    }

    try {
      const parsePrice = (s) => {
        if (typeof s === 'number') return s;
        if (!s) return null;
        const m = String(s).match(/\$?([\d.]+)/);
        return m ? +m[1] : null;
      };

      // Parse entry zone (take lower bound for limit order)
      const entryRaw = brief.entryZone || brief.entry_zone || brief.entry;
      let entryPrice = null;
      if (typeof entryRaw === 'string' && entryRaw.includes('–')) {
        entryPrice = parsePrice(entryRaw.split('–')[0]);
      } else if (typeof entryRaw === 'string' && entryRaw.includes('-') && !entryRaw.startsWith('-')) {
        entryPrice = parsePrice(entryRaw.split('-')[0]);
      } else {
        entryPrice = parsePrice(entryRaw);
      }

      const stopPrice = parsePrice(brief.stopLevel || brief.stop_level || brief.stop);
      const target1 = parsePrice(brief.target1);
      const target2 = parsePrice(brief.target2);
      const qty = brief.shares || brief.qty || 0;

      if (!entryPrice || !stopPrice || !qty) {
        skipped.push({ symbol: brief.symbol, reason: 'Missing entry/stop/shares' });
        continue;
      }

      const order = stageOrder({
        symbol: (brief.symbol || brief.ticker).toUpperCase(),
        side: 'buy',
        order_type: 'limit',
        qty,
        entry_price: entryPrice,
        stop_price: stopPrice,
        target1_price: target1,
        target2_price: target2,
        source: 'ai_brief',
        conviction_score: brief.conviction || null,
        notes: `AI Brief: ${brief.catalyst || brief.thesis || 'N/A'}`,
      });

      staged.push({ symbol: brief.symbol, orderId: order.id, qty, entry: entryPrice });
    } catch (e) {
      skipped.push({ symbol: brief.symbol, error: e.message });
    }
  }

  return { staged, skipped, total: briefs.length };
}

// ─── Query Helpers ──────────────────────────────────────────────────────────

function getConditionalEntries(status = null) {
  if (status) {
    return db().prepare('SELECT * FROM conditional_entries WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return db().prepare('SELECT * FROM conditional_entries ORDER BY created_at DESC').all();
}

function cancelConditionalEntry(id) {
  db().prepare("UPDATE conditional_entries SET status = 'cancelled' WHERE id = ?").run(id);
}

function expireOldEntries() {
  const today = marketDate();
  const result = db().prepare(
    "UPDATE conditional_entries SET status = 'expired' WHERE status = 'pending' AND expiry_date < ?"
  ).run(today);
  return result.changes;
}

module.exports = {
  autoStageFromWatchlist,
  createConditionalEntry,
  checkConditionalEntries,
  autoStageFromTradeBriefs,
  getConditionalEntries,
  cancelConditionalEntry,
  expireOldEntries,
};
