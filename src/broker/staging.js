// ─── Order Staging Engine ────────────────────────────────────────────────────
// Converts trade setups into staged bracket orders ready for one-click submission.
//
// On submission, we route through the vendor-neutral BrokerAdapter interface
// (src/broker/index.js). This is intentional: business logic must never
// hard-code a vendor. To swap Alpaca for Schwab/TOS later, only the factory
// and adapter change — this file stays untouched.
//
// Scale-out strategies (full_in_scale_out, scale_in_scale_out) are submitted
// as MULTI-TRANCHE brackets: qty is split across N independent brackets, each
// with its own take-profit. This makes the broker itself the source of truth
// for partial exits — when target1 hits, the broker closes tranche 1 and
// leaves tranches 2/3 running, without any Node-side polling.
const { getDB } = require('../data/database');
const { getBroker } = require('./index');
const { preTradeCheck } = require('../risk/portfolio');
const { getMarketRegime } = require('../risk/regime');
const { notifyTradeEvent } = require('../notifications/channels');

// ─── Tranche splitting ──────────────────────────────────────────────────────
//
// Decides how to split `qty` across N bracket orders for the O'Neil/Minervini
// pyramid: 1/3 at target1, 1/3 at target2, 1/3 runner. Handles small-qty
// edge cases where you can't cleanly divide by 3.
//
// Runner target: brackets require a take-profit, but the runner's exit is
// meant to be a trailing stop — it shouldn't hit the TP organically. We set
// the runner's TP to 2× the target2-to-entry gap above entry. That number
// is unreachable in normal market moves; the trailing stop (maintained by
// the monitor via replaceStopsForSymbol) is the real exit.
function splitTranchesForScaleOut({ qty, entry, stop, target1, target2 }) {
  if (!(qty > 0)) throw new Error('splitTranches: qty must be > 0');
  if (!target1)   throw new Error('splitTranches: target1 required');

  const r = Math.abs(entry - stop);
  const gap2 = target2 != null ? Math.abs(target2 - entry) : r * 3;
  const runnerTarget = +((entry > stop ? entry + gap2 * 2 : entry - gap2 * 2).toFixed(2));

  // 3 tranches: full pyramid. Runner gets the remainder so we never lose
  // shares to rounding — e.g. qty=10 → 3/3/4, qty=11 → 3/3/5.
  if (qty >= 3 && target2 != null) {
    const third = Math.floor(qty / 3);
    return [
      { qty: third,             takeProfitLimitPrice: target1,      label: 'target1' },
      { qty: third,             takeProfitLimitPrice: target2,      label: 'target2' },
      { qty: qty - 2 * third,   takeProfitLimitPrice: runnerTarget, label: 'runner'  },
    ];
  }

  // 2 tranches: half at target1, half at target2 (or runner if no target2).
  if (qty >= 2) {
    const half = Math.floor(qty / 2);
    const t2   = target2 != null ? target2 : runnerTarget;
    const label2 = target2 != null ? 'target2' : 'runner';
    return [
      { qty: half,        takeProfitLimitPrice: target1, label: 'target1' },
      { qty: qty - half,  takeProfitLimitPrice: t2,      label: label2   },
    ];
  }

  // Single share: fall back to target1 as a plain bracket.
  return [{ qty, takeProfitLimitPrice: target1, label: 'target1' }];
}

function isScaleOutStrategy(exitStrategy) {
  return exitStrategy === 'full_in_scale_out'
      || exitStrategy === 'scale_in_scale_out'
      || exitStrategy === 'scale_in_out'; // legacy alias
}

function db() { return getDB(); }

// ─── Stage a bracket order from a trade setup ───────────────────────────────

function stageOrder({ symbol, side = 'buy', order_type = 'limit', qty, entry_price, stop_price,
                      target1_price, target2_price, time_in_force = 'gtc', source, conviction_score, notes,
                      exit_strategy = 'full_in_scale_out', strategy: replayStrategy }) {
  const validExitStrategies = ['full_in_full_out', 'full_in_scale_out', 'scale_in_scale_out', 'scale_in_full_out',
    'full_size', 'scale_in_out']; // last two are legacy aliases
  const exitStrat = validExitStrategies.includes(exit_strategy) ? exit_strategy : 'full_in_scale_out';
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

function stageFromSetup(stock, setup, sizing, source = 'swinglab', exitStrategy = 'full_in_scale_out', strategy = null) {
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

// ─── Submit through broker adapter ──────────────────────────────────────────

async function submitStagedOrder(stagedId) {
  const staged = getStagedOrder(stagedId);
  if (!staged) throw new Error(`Staged order #${stagedId} not found`);
  if (staged.status !== 'staged') throw new Error(`Order #${stagedId} is ${staged.status}, not staged`);

  // Run pre-trade check as final gate — unchanged from previous behavior.
  const openPositions = db().prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();
  const regime = await getMarketRegime();
  const candidate = {
    symbol: staged.symbol,
    sector: null,
    entryPrice: staged.entry_price,
    stopPrice: staged.stop_price,
    shares: staged.qty,
  };
  const riskCheck = preTradeCheck(candidate, openPositions, regime);
  db().prepare('UPDATE staged_orders SET risk_check = ? WHERE id = ?')
    .run(JSON.stringify(riskCheck), stagedId);
  if (!riskCheck.approved) {
    const failedRules = riskCheck.checks.filter(c => !c.pass).map(c => c.rule).join(', ');
    throw new Error(`Pre-trade check failed: ${failedRules}`);
  }

  const broker = getBroker();
  const exitStrategy = staged.exit_strategy || 'full_in_scale_out';
  const timeInForce  = staged.time_in_force || 'gtc';
  const entryLimit   = staged.order_type === 'limit' ? staged.entry_price : undefined;

  // ── Dispatch: multi-tranche vs single bracket ─────────────────────────
  // Scale-out strategies split qty across N brackets so the BROKER natively
  // closes each tranche at its own target. Everything else uses a single
  // bracket at target1 (full_in_full_out and legacy full_size aliases).
  let submission;       // broker response
  let primaryOrderId;   // id we store in alpaca_order_id for legacy compat
  let tranchesMeta;     // null for single-bracket; array for multi-tranche

  if (isScaleOutStrategy(exitStrategy) && staged.target1_price) {
    const tranches = splitTranchesForScaleOut({
      qty:     staged.qty,
      entry:   staged.entry_price,
      stop:    staged.stop_price,
      target1: staged.target1_price,
      target2: staged.target2_price,
    });
    submission = await broker.submitMultiTrancheBracket({
      symbol:          staged.symbol,
      side:            staged.side,
      entryType:       staged.order_type,
      entryLimitPrice: entryLimit,
      stopPrice:       staged.stop_price,
      timeInForce,
      tranches,
    });
    primaryOrderId = submission.tranches[0].order.id;
    tranchesMeta = submission.tranches.map(({ label, order }) => ({
      label,
      qty:         order.qty,
      orderId:     order.id,
      tp:          order.legs?.find(l => l.type === 'limit')?.limitPrice ?? null,
      stopOrderId: order.legs?.find(l => l.type === 'stop' || l.type === 'stop_limit')?.id ?? null,
    }));
  } else {
    submission = await broker.submitBracketOrder({
      symbol:               staged.symbol,
      qty:                  staged.qty,
      side:                 staged.side,
      entryType:            staged.order_type,
      entryLimitPrice:      entryLimit,
      stopPrice:            staged.stop_price,
      takeProfitLimitPrice: staged.target1_price || staged.target2_price,
      timeInForce,
    });
    primaryOrderId = submission.id;
    tranchesMeta = null;
  }

  const now = new Date().toISOString();
  db().prepare(`
    UPDATE staged_orders
    SET status = 'submitted', alpaca_order_id = ?, submitted_at = ?, tranches_json = ?
    WHERE id = ?
  `).run(primaryOrderId, now, tranchesMeta ? JSON.stringify(tranchesMeta) : null, stagedId);

  const result = { staged: getStagedOrder(stagedId), submission, riskCheck };
  const message = tranchesMeta
    ? `Multi-tranche submitted (${tranchesMeta.length} brackets, primary ${primaryOrderId})`
    : `Order submitted to broker (${primaryOrderId})`;
  notifyTradeEvent({
    event: 'submitted',
    symbol: staged.symbol,
    details: { shares: staged.qty, price: staged.entry_price, stop: staged.stop_price, message },
  }).catch(e => console.error('Notification error:', e.message));
  return result;
}

// ─── Sync Status ────────────────────────────────────────────────────────────
//
// Polls the broker for the primary (or single) order's status. For multi-
// tranche submissions, this looks at the first tranche only — individual
// tranches move independently after they arm, so per-tranche tracking is
// the monitor's job, not this reconciler's.

async function syncOrderStatus(stagedId) {
  const staged = getStagedOrder(stagedId);
  if (!staged?.alpaca_order_id) return staged;

  const broker = getBroker();
  const order = await broker.getOrder(staged.alpaca_order_id);
  if (!order) return staged;

  if (order.status === 'filled') {
    db().prepare('UPDATE staged_orders SET status = ?, filled_at = ? WHERE id = ?')
      .run('filled', order.filledAt || new Date().toISOString(), stagedId);
  } else if (['cancelled', 'expired', 'rejected'].includes(order.status)) {
    const newStatus = order.status === 'rejected' ? 'cancelled' : order.status;
    db().prepare('UPDATE staged_orders SET status = ? WHERE id = ?').run(newStatus, stagedId);
  }

  return { ...getStagedOrder(stagedId), brokerStatus: order.status };
}

// ─── Cancel ─────────────────────────────────────────────────────────────────
//
// For multi-tranche submissions, we must cancel EVERY tranche's parent —
// cancelling just the primary would leave the sibling brackets running.
// The broker adapter's cancelOrder propagates to child legs automatically.

async function cancelStagedOrder(stagedId) {
  const staged = getStagedOrder(stagedId);
  if (!staged) throw new Error(`Staged order #${stagedId} not found`);

  const broker = getBroker();
  if (staged.status === 'submitted') {
    const ids = [];
    if (staged.tranches_json) {
      try {
        const meta = JSON.parse(staged.tranches_json);
        for (const t of meta) if (t.orderId) ids.push(t.orderId);
      } catch (_) { /* fall through to single-ID path */ }
    }
    if (!ids.length && staged.alpaca_order_id) ids.push(staged.alpaca_order_id);
    for (const id of ids) {
      try { await broker.cancelOrder(id); }
      catch (e) { console.error(`  cancelStagedOrder: ${id} → ${e.message}`); }
    }
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
  // Exposed for unit tests — the tranche split logic is pure and worth
  // pinning independently of the DB/broker roundtrip.
  splitTranchesForScaleOut, isScaleOutStrategy,
};
