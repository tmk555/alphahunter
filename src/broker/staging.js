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

function stageFromSetup(stock, setup, sizing, source = 'swing', exitStrategy = 'full_in_scale_out', strategy = null) {
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
//
// On a terminal transition (filled/cancelled/expired/rejected) this also
// fires a `notifyTradeEvent` so the user gets a phone alert. Idempotency:
// the monitor's poller only walks rows WHERE status='submitted', so once we
// flip past 'submitted' the row is no longer touched — one notification per
// transition, no duplicates.

async function syncOrderStatus(stagedId) {
  const staged = getStagedOrder(stagedId);
  if (!staged?.alpaca_order_id) return staged;

  const broker = getBroker();
  const order = await broker.getOrder(staged.alpaca_order_id);
  if (!order) return staged;

  const wasStatus  = staged.status;
  let notifyEvent  = null;
  let newLocalStatus = null;

  if (order.status === 'filled') {
    db().prepare('UPDATE staged_orders SET status = ?, filled_at = ? WHERE id = ?')
      .run('filled', order.filledAt || new Date().toISOString(), stagedId);
    newLocalStatus = 'filled';
    notifyEvent    = 'filled';
  } else if (['cancelled', 'expired', 'rejected'].includes(order.status)) {
    // Existing behavior: collapse broker 'rejected' → local 'cancelled'
    // for the DB status. But we still fire the 'rejected' notification so
    // the user sees *why* it didn't fill (priority-1 Pushover alert).
    newLocalStatus = order.status === 'rejected' ? 'cancelled' : order.status;
    db().prepare('UPDATE staged_orders SET status = ? WHERE id = ?').run(newLocalStatus, stagedId);
    notifyEvent    = order.status; // 'cancelled' | 'expired' | 'rejected'
  }

  if (notifyEvent && wasStatus !== newLocalStatus) {
    const fillPrice = order.filledAvgPrice || staged.entry_price;
    notifyTradeEvent({
      event:  notifyEvent,
      symbol: staged.symbol,
      details: {
        shares: order.filledQty || staged.qty,
        price:  fillPrice,
        stop:   staged.stop_price,
        message: notifyEvent === 'filled'
          ? `Broker filled bracket entry @ $${Number(fillPrice).toFixed(2)}`
          : notifyEvent === 'rejected'
            ? `Broker REJECTED order — check Alpaca dashboard for reason`
            : `Broker order ${notifyEvent}`,
      },
    }).catch(e => console.error(`Notification error (${notifyEvent} ${staged.symbol}):`, e.message));
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
  // Capture pre-cancel state so we can decide whether to notify and what to say.
  const wasStatus = staged.status;

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

  // Only fire a notification on meaningful transitions. A cancel on an
  // already-terminal row (filled/expired/cancelled) is a no-op we don't
  // want to spam the user about.
  if (wasStatus === 'staged' || wasStatus === 'submitted') {
    notifyTradeEvent({
      event:  'cancelled',
      symbol: staged.symbol,
      details: {
        shares:  staged.qty,
        price:   staged.entry_price,
        stop:    staged.stop_price,
        message: wasStatus === 'submitted'
          ? `Submitted order cancelled at broker (user action)`
          : `Staged order cancelled before submission (user action)`,
      },
    }).catch(e => console.error(`Notification error (cancelled ${staged.symbol}):`, e.message));
  }

  return getStagedOrder(stagedId);
}

// ─── Expire Stale Orders ────────────────────────────────────────────────────
//
// Runs on the hourly cron in monitor.js. Captures the affected rows BEFORE
// flipping status so each expiry can fire an individual notification — a
// staged order going stale without ever being submitted is a user action
// worth flagging (it's a setup they should either re-stage or re-evaluate).

function expireStaleOrders() {
  const stale = db().prepare(`
    SELECT id, symbol, qty, entry_price, stop_price FROM staged_orders
    WHERE status = 'staged' AND created_at < datetime('now', '-24 hours')
  `).all();

  if (!stale.length) return 0;

  const placeholders = stale.map(() => '?').join(',');
  db().prepare(`UPDATE staged_orders SET status = 'expired' WHERE id IN (${placeholders})`)
    .run(...stale.map(r => r.id));

  console.log(`  Expired ${stale.length} stale staged orders`);

  for (const row of stale) {
    notifyTradeEvent({
      event:  'expired',
      symbol: row.symbol,
      details: {
        shares:  row.qty,
        price:   row.entry_price,
        stop:    row.stop_price,
        message: `Staged order auto-expired after 24 hours (never submitted)`,
      },
    }).catch(e => console.error(`Notification error (expired ${row.symbol}):`, e.message));
  }

  return stale.length;
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
