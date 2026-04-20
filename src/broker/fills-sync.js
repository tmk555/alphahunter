// ─── Broker fills → trade journal sync ───────────────────────────────────────
// Shared implementation for /api/trades/sync (manual) and the broker_fills_sync
// scheduler job. Pulls the last 7 days of filled orders from Alpaca, inserts
// missing entries into `trades`, mirrors staged_order context, creates tax
// lots, and (the reason this lives outside the route) calls logExecution so
// slippage lands in execution_log in near-real-time.

const { getDB } = require('../data/database');
const alpaca = require('./alpaca');
const { getMarketRegime } = require('../risk/regime');
const { createTaxLot, sellTaxLots } = require('../risk/tax-engine');
const { logExecution } = require('../risk/execution-quality');
const { assignStrategy } = require('../risk/strategy-manager');

async function syncBrokerFills() {
  const db = getDB();

  const since  = new Date(Date.now() - 7 * 86400000).toISOString();
  const orders = await alpaca.getOrders({ status: 'closed', limit: 100, after: since });
  const filled = orders.filter(o => o.status === 'filled' && o.side === 'buy');

  // Dedupe strictly on alpaca_order_id — the old symbol:date guard blocked
  // subsequent pyramid tranches on the same day from ever being synced.
  const existing     = db.prepare('SELECT alpaca_order_id FROM trades WHERE alpaca_order_id IS NOT NULL').all();
  const existingIds  = new Set(existing.map(t => t.alpaca_order_id));

  // Backfill sector on older auto-synced trades that predated sector capture.
  const backfilled = db.prepare(`
    UPDATE trades
       SET sector = (SELECT u.sector FROM universe_mgmt u WHERE u.symbol = trades.symbol)
     WHERE sector IS NULL
       AND symbol IN (SELECT symbol FROM universe_mgmt)
  `).run().changes;

  const todayStr     = new Date().toISOString().split('T')[0];
  const synced       = [];
  const stmt         = db.prepare(`
    INSERT INTO trades (symbol, side, entry_date, entry_price, shares, sector, alpaca_order_id, needs_review, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const sectorLookup = db.prepare('SELECT sector FROM universe_mgmt WHERE symbol = ?');

  for (const order of filled) {
    if (existingIds.has(order.id)) continue;
    let fillDate = (order.filled_at || order.created_at).split('T')[0];
    if (fillDate > todayStr) fillDate = todayStr;          // clamp UTC-offset future dates

    const staged = db.prepare(
      'SELECT stop_price, target1_price, target2_price, source, conviction_score, strategy, exit_strategy, entry_price, created_at FROM staged_orders WHERE alpaca_order_id = ?'
    ).get(order.id);

    const sector = sectorLookup.get(order.symbol)?.sector || null;

    stmt.run(
      order.symbol,
      order.side === 'buy' ? 'long' : 'short',
      fillDate,
      +order.filled_avg_price,
      +order.filled_qty,
      sector,
      order.id,
      `[AUTO-SYNCED] Filled at $${(+order.filled_avg_price).toFixed(2)} via ${staged?.source || 'broker'}. Add your trade thesis and setup notes.`,
    );

    if (staged) {
      db.prepare('UPDATE trades SET stop_price=?, target1=?, target2=?, strategy=?, exit_strategy=?, was_system_signal=1 WHERE alpaca_order_id=?')
        .run(staged.stop_price, staged.target1_price, staged.target2_price, staged.strategy || null, staged.exit_strategy || 'full_in_scale_out', order.id);
    }

    let snapData = null;
    try {
      const snap = db.prepare(`
        SELECT rs_rank, sepa_score, swing_momentum FROM rs_snapshots
        WHERE symbol = ? AND date <= ? AND type = 'stock' ORDER BY date DESC LIMIT 1
      `).get(order.symbol, fillDate);
      if (snap) {
        snapData = snap;
        db.prepare('UPDATE trades SET entry_rs=?, entry_sepa=? WHERE alpaca_order_id=? AND entry_rs IS NULL')
          .run(snap.rs_rank, snap.sepa_score, order.id);
      }
      const regime = getMarketRegime();
      if (regime?.regime) {
        db.prepare('UPDATE trades SET regime_at_entry=? WHERE alpaca_order_id=? AND regime_at_entry IS NULL')
          .run(regime.regime, order.id);
      }
    } catch (_) {}

    if (!staged?.strategy) {
      try {
        const scanRow  = db.prepare(`SELECT data FROM scan_results WHERE symbol = ? ORDER BY date DESC LIMIT 1`).get(order.symbol);
        const scanData = scanRow ? JSON.parse(scanRow.data) : {};
        const assigned = assignStrategy({
          symbol: order.symbol,
          rsRank: snapData?.rs_rank || scanData.rsRank || 0,
          swingMomentum: snapData?.swing_momentum || scanData.swingMomentum || 0,
          vcpForming: scanData.vcpForming || false,
          patternDetected: scanData.bestPattern || false,
        });
        db.prepare('UPDATE trades SET strategy=? WHERE alpaca_order_id=? AND strategy IS NULL')
          .run(assigned.strategy, order.id);
        console.log(`  Strategy auto-assigned: ${order.symbol} → ${assigned.strategy} (${assigned.confidence}%)`);
      } catch (_) {}
    }

    const lastTradeId = db.prepare('SELECT id FROM trades WHERE alpaca_order_id = ?').get(order.id)?.id;

    if (lastTradeId) {
      try {
        createTaxLot({
          tradeId: lastTradeId,
          symbol: order.symbol,
          shares: +order.filled_qty,
          costBasis: +order.filled_avg_price,
          acquiredDate: fillDate,
        });
      } catch (_) {}
    }

    // Slippage capture. intended_price = staged limit, else staged entry_price,
    // else fill price (0 slippage when we can't tell).
    if (lastTradeId) {
      try {
        const signalDate  = staged?.created_at?.split('T')[0] || fillDate;
        const buyIntended = order.limit_price != null ? +order.limit_price
          : staged?.entry_price ? +staged.entry_price
          : +order.filled_avg_price;
        logExecution({
          tradeId: lastTradeId,
          symbol: order.symbol,
          side: 'buy',
          intendedPrice: buyIntended,
          fillPrice: +order.filled_avg_price,
          shares: +order.filled_qty,
          orderType: order.type || 'market',
          signalDate,
          orderDate: (order.submitted_at || order.created_at)?.split('T')[0],
          fillDate,
        });
      } catch (_) {}
    }

    synced.push({ symbol: order.symbol, price: +order.filled_avg_price, qty: +order.filled_qty, date: fillDate });
  }

  // Sells → auto-exit journal entries.
  const sells  = orders.filter(o => o.status === 'filled' && o.side === 'sell');
  const exited = [];
  for (const sell of sells) {
    const trade = db.prepare(
      'SELECT * FROM trades WHERE symbol = ? AND exit_date IS NULL AND side = ? ORDER BY entry_date DESC LIMIT 1'
    ).get(sell.symbol, 'long');
    if (!trade) continue;

    let exitDate = (sell.filled_at || sell.created_at).split('T')[0];
    if (exitDate > todayStr) exitDate = todayStr;
    const exitPrice   = +sell.filled_avg_price;
    const pnl_dollars = (exitPrice - trade.entry_price) * (trade.shares || 0);
    const pnl_percent = +((exitPrice / trade.entry_price - 1) * 100).toFixed(2);
    const risk        = trade.entry_price - (trade.stop_price || trade.entry_price * 0.95);
    const r_multiple  = risk > 0 ? +((exitPrice - trade.entry_price) / risk).toFixed(2) : 0;

    db.prepare(`
      UPDATE trades SET exit_date=?, exit_price=?, exit_reason='auto_sync',
        pnl_dollars=?, pnl_percent=?, r_multiple=?, needs_review=1,
        notes=COALESCE(notes,'') || ? WHERE id=?
    `).run(exitDate, exitPrice, pnl_dollars, pnl_percent, r_multiple,
      `\n[AUTO-EXIT] Sold at $${exitPrice.toFixed(2)}. Update exit reason and review.`, trade.id);

    try {
      sellTaxLots({
        symbol: sell.symbol,
        shares: trade.shares || +sell.filled_qty,
        salePrice: exitPrice,
        saleDate: exitDate,
        method: 'fifo',
      });
    } catch (_) {}

    try {
      logExecution({
        tradeId: trade.id,
        symbol: sell.symbol,
        side: 'sell',
        intendedPrice: trade.target1 || exitPrice,
        fillPrice: exitPrice,
        shares: +sell.filled_qty || trade.shares,
        orderType: sell.type || 'market',
        signalDate: exitDate,
        orderDate: (sell.submitted_at || sell.created_at)?.split('T')[0],
        fillDate: exitDate,
      });
    } catch (_) {}

    exited.push({ symbol: sell.symbol, exitPrice, pnl_percent });
  }

  return { synced, exited, backfilled };
}

module.exports = { syncBrokerFills };
