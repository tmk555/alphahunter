// ─── Order Staging Engine ────────────────────────────────────────────────────
// Converts trade setups into staged bracket orders ready for one-click submission
const { getDB } = require('../data/database');
const alpaca = require('./alpaca');
const { preTradeCheck } = require('../risk/portfolio');
const { getMarketRegime } = require('../risk/regime');
const { notifyTradeEvent } = require('../notifications/channels');

function db() { return getDB(); }

// ─── Stage a bracket order from a trade setup ───────────────────────────────

function stageOrder({ symbol, side = 'buy', order_type = 'limit', qty, entry_price, stop_price,
                      target1_price, target2_price, time_in_force = 'gtc', source, conviction_score, notes,
                      exit_strategy = 'full_size', strategy: replayStrategy }) {
  const validExitStrategies = ['full_size', 'scale_in_out'];
  const exitStrat = validExitStrategies.includes(exit_strategy) ? exit_strategy : 'full_size';
  const stmt = db().prepare(`
    INSERT INTO staged_orders (symbol, side, order_type, qty, entry_price, stop_price,
      target1_price, target2_price, time_in_force, source, conviction_score, notes, exit_strategy, strategy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    symbol.toUpperCase(), side, order_type, qty, entry_price, stop_price,
    target1_price || null, target2_price || null, time_in_force,
    source || 'manual', conviction_score || null, notes || null, exitStrat,
    replayStrategy || null,
  );
  const order = getStagedOrder(result.lastInsertRowid);
  // Don't send Telegram for staging — only notify on actual fills/stops/exits
  return order;
}

function stageFromSetup(stock, setup, sizing, source = 'swinglab', exitStrategy = 'full_size', strategy = null) {
  // Parse numeric values from setup strings (e.g., "$185.50" → 185.50)
  const parsePrice = (s) => {
    if (typeof s === 'number') return s;
    const m = String(s).match(/\$?([\d.]+)/);
    return m ? +m[1] : null;
  };

  const entryLow = parsePrice(setup.entryZone?.split('–')?.[0]);
  const stopLevel = parsePrice(setup.stopLevel);
  const target1 = parsePrice(setup.target1);
  const target2 = parsePrice(setup.target2);

  if (!entryLow || !stopLevel || !sizing.shares) {
    throw new Error('Invalid setup or sizing — cannot stage order');
  }

  return stageOrder({
    symbol: stock.ticker || stock.symbol,
    side: 'buy',
    order_type: 'limit',
    qty: sizing.shares,
    entry_price: entryLow,
    stop_price: stopLevel,
    target1_price: target1,
    target2_price: target2,
    source,
    conviction_score: stock.convictionScore || null,
    exit_strategy: exitStrategy,
    strategy,
  });
}

// ─── Query ──────────────────────────────────────────────────────────────────

function getStagedOrder(id) {
  return db().prepare('SELECT * FROM staged_orders WHERE id = ?').get(id);
}

function getStagedOrders({ status, symbol } = {}) {
  let query = 'SELECT * FROM staged_orders WHERE 1=1';
  const params = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (symbol) { query += ' AND symbol = ?'; params.push(symbol.toUpperCase()); }
  query += ' ORDER BY created_at DESC';
  return db().prepare(query).all(...params);
}

// ─── Submit to Alpaca ───────────────────────────────────────────────────────

async function submitStagedOrder(stagedId) {
  const staged = getStagedOrder(stagedId);
  if (!staged) throw new Error(`Staged order #${stagedId} not found`);
  if (staged.status !== 'staged') throw new Error(`Order #${stagedId} is ${staged.status}, not staged`);

  // Run pre-trade check as final gate
  const openPositions = db().prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();
  const regime = await getMarketRegime();

  const candidate = {
    symbol: staged.symbol,
    sector: null, // Will be populated if available
    entryPrice: staged.entry_price,
    stopPrice: staged.stop_price,
    shares: staged.qty,
  };

  const riskCheck = preTradeCheck(candidate, openPositions, regime);

  // Store risk check result regardless of outcome
  db().prepare('UPDATE staged_orders SET risk_check = ? WHERE id = ?')
    .run(JSON.stringify(riskCheck), stagedId);

  if (!riskCheck.approved) {
    const failedRules = riskCheck.checks.filter(c => !c.pass).map(c => c.rule).join(', ');
    throw new Error(`Pre-trade check failed: ${failedRules}`);
  }

  // Build Alpaca bracket order
  const orderParams = {
    symbol: staged.symbol,
    qty: staged.qty,
    side: staged.side,
    type: staged.order_type,
    time_in_force: staged.time_in_force,
  };

  if (staged.order_type === 'limit') {
    orderParams.limit_price = staged.entry_price;
  }

  // Use bracket order if we have both stop and target
  if (staged.stop_price && staged.target1_price) {
    orderParams.order_class = 'bracket';
    orderParams.take_profit = { limit_price: staged.target1_price };
    orderParams.stop_loss = { stop_price: staged.stop_price };
  } else if (staged.stop_price) {
    // OTO: entry + stop only
    orderParams.order_class = 'oto';
    orderParams.stop_loss = { stop_price: staged.stop_price };
  }

  const order = await alpaca.submitOrder(orderParams);

  // Update staged order with Alpaca order ID
  const now = new Date().toISOString();
  db().prepare(`
    UPDATE staged_orders SET status = 'submitted', alpaca_order_id = ?, submitted_at = ? WHERE id = ?
  `).run(order.id, now, stagedId);

  const result = { staged: getStagedOrder(stagedId), alpacaOrder: order, riskCheck };
  notifyTradeEvent({ event: 'submitted', symbol: staged.symbol, details: { shares: staged.qty, price: staged.entry_price, stop: staged.stop_price, message: `Order submitted to broker (${order.id})` } }).catch(e => console.error('Notification error:', e.message));
  return result;
}

// ─── Sync Status ────────────────────────────────────────────────────────────

async function syncOrderStatus(stagedId) {
  const staged = getStagedOrder(stagedId);
  if (!staged?.alpaca_order_id) return staged;

  const order = await alpaca.getOrder(staged.alpaca_order_id);
  let newStatus = staged.status;

  if (order.status === 'filled') {
    newStatus = 'filled';
    db().prepare('UPDATE staged_orders SET status = ?, filled_at = ? WHERE id = ?')
      .run('filled', order.filled_at, stagedId);
  } else if (['cancelled', 'expired', 'rejected'].includes(order.status)) {
    newStatus = order.status === 'rejected' ? 'cancelled' : order.status;
    db().prepare('UPDATE staged_orders SET status = ? WHERE id = ?').run(newStatus, stagedId);
  }

  return { ...getStagedOrder(stagedId), alpacaStatus: order.status };
}

// ─── Cancel ─────────────────────────────────────────────────────────────────

async function cancelStagedOrder(stagedId) {
  const staged = getStagedOrder(stagedId);
  if (!staged) throw new Error(`Staged order #${stagedId} not found`);

  if (staged.status === 'submitted' && staged.alpaca_order_id) {
    await alpaca.cancelOrder(staged.alpaca_order_id);
  }

  db().prepare('UPDATE staged_orders SET status = ? WHERE id = ?').run('cancelled', stagedId);
  return getStagedOrder(stagedId);
}

// ─── Expire Stale Orders ────────────────────────────────────────────────────

function expireStaleOrders() {
  const result = db().prepare(`
    UPDATE staged_orders SET status = 'expired'
    WHERE status = 'staged' AND created_at < datetime('now', '-24 hours')
  `).run();
  if (result.changes > 0) console.log(`  Expired ${result.changes} stale staged orders`);
  return result.changes;
}

module.exports = {
  stageOrder, stageFromSetup,
  getStagedOrder, getStagedOrders,
  submitStagedOrder, syncOrderStatus, cancelStagedOrder,
  expireStaleOrders,
};
