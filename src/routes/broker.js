// ─── /api/broker/* routes ───────────────────────────────────────────────────
// Alpaca broker account, positions, orders, market clock
const express = require('express');
const router  = express.Router();

const alpaca = require('../broker/alpaca');

module.exports = function(db) {
  // ─── Account ────────────────────────────────────────────────────────────────
  router.get('/broker/account', async (req, res) => {
    try {
      const account = await alpaca.getAccount();
      res.json({
        equity:        +account.equity,
        buyingPower:   +account.buying_power,
        cash:          +account.cash,
        portfolioValue: +account.portfolio_value,
        daytradeCount:  account.daytrade_count,
        patternDayTrader: account.pattern_day_trader,
        tradingBlocked:   account.trading_blocked,
        status:         account.status,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Positions ──────────────────────────────────────────────────────────────
  router.get('/broker/positions', async (req, res) => {
    try {
      const positions = await alpaca.getPositions();
      // Enrich with local trade data. Multi-tranche positions have multiple
      // trade rows per symbol (one per tranche). Only the row synced from the
      // original staged_order has stop/target populated — sibling tranche
      // rows have NULLs because they didn't match an alpaca_order_id lookup.
      // So we:
      //   1. Group trades by symbol
      //   2. Prefer the row that HAS stop_price/target data (real setup context)
      //   3. Aggregate totals across all tranches (shares, partial_exits, etc.)
      const localTrades = db.prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();
      const tradesBySymbol = {};
      for (const t of localTrades) {
        if (!tradesBySymbol[t.symbol]) tradesBySymbol[t.symbol] = [];
        tradesBySymbol[t.symbol].push(t);
      }
      // For each symbol pick the "canonical" trade row — one with setup data.
      // Fall back to the first row if none have stop data.
      const tradeMap = {};
      for (const [sym, rows] of Object.entries(tradesBySymbol)) {
        const withStop = rows.find(r => r.stop_price != null);
        const withTarget = rows.find(r => r.target1 != null);
        tradeMap[sym] = withStop || withTarget || rows[0];
      }

      // Also fetch matching staged_orders for tranches_json (lets UI show
      // each tranche's individual TP level). We key by symbol; for multi-
      // tranche setups this will pick the most recent submitted row.
      const stagedRows = db.prepare(
        "SELECT * FROM staged_orders WHERE status IN ('submitted','filled') AND tranches_json IS NOT NULL ORDER BY created_at DESC"
      ).all();
      const stagedMap = {};
      for (const s of stagedRows) {
        if (!stagedMap[s.symbol]) stagedMap[s.symbol] = s;
      }

      const enriched = positions.map(p => {
        const local = tradeMap[p.symbol];
        const staged = stagedMap[p.symbol];
        let trancheTargets = null;
        if (staged?.tranches_json) {
          try {
            trancheTargets = JSON.parse(staged.tranches_json)
              .map(t => ({ label: t.label, qty: t.qty, tp: t.tp }));
          } catch (_) {}
        }
        // Parse partial exits so UI can know if any tranches already fired
        let partialExits = [];
        try { partialExits = JSON.parse(local?.partial_exits || '[]'); } catch (_) {}

        return {
          symbol:         p.symbol,
          qty:            +p.qty,
          side:           p.side,
          marketValue:    +p.market_value,
          costBasis:      +p.cost_basis,
          currentPrice:   +p.current_price,
          avgEntryPrice:  +p.avg_entry_price,
          unrealizedPL:   +p.unrealized_pl,
          unrealizedPLPct: +p.unrealized_plpc * 100,
          changeToday:    +p.change_today * 100,
          // Local enrichments
          localStop:         local?.stop_price || staged?.stop_price || null,
          // ORIGINAL stop from staged_orders — used for R-multiple calc.
          // This never changes even after stop moves to breakeven post-T1.
          localInitialStop:  staged?.stop_price || local?.stop_price || null,
          localTarget1:      local?.target1 || staged?.target1_price || null,
          localTarget2:      local?.target2 || staged?.target2_price || null,
          localEntryRS:      local?.entry_rs || null,
          localTradeId:      local?.id || null,
          localEntryDate:    local?.entry_date || null,
          localStrategy:     local?.strategy || null,
          localExitStrategy: local?.exit_strategy || staged?.exit_strategy || null,
          localPartialExits: partialExits,  // [{level: 'target1', shares, price, pnl, timestamp}, ...]
          localTrailPct:     local?.trail_pct ?? null,
          trancheTargets,    // array of {label, qty, tp} for multi-tranche display
        };
      });

      res.json({ positions: enriched, count: enriched.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Orders ─────────────────────────────────────────────────────────────────
  //
  // Returns flat Alpaca orders enriched with local staged_orders data.
  // After a bracket parent fills, the stop-loss and take-profit legs appear
  // as independent flat orders. We match each order's ID against our
  // staged_orders.tranches_json to attach the tranche label, shared stop
  // price, and target prices so the UI can group and display them clearly.
  router.get('/broker/orders', async (req, res) => {
    try {
      const { status = 'open', limit = 50 } = req.query;
      // Alpaca's status=open filter excludes OCO bracket siblings whose status
      // is 'held' (e.g. the stop leg sitting dormant alongside an active TP).
      // Fetch all statuses and drop terminal ones server-side so the UI sees
      // every live order attached to an open position.
      let orders;
      if (status === 'open') {
        const raw = await alpaca.getOrders({ status: 'all', limit: 500 });
        const terminal = new Set(['filled','canceled','cancelled','expired','rejected','done_for_day','replaced']);
        orders = raw.filter(o => !terminal.has(o.status)).slice(0, +limit);
      } else {
        orders = await alpaca.getOrders({ status, limit: +limit });
      }

      // ── Build enrichment map from staged_orders ──
      let enrichById = {};    // orderId → enrichment
      let enrichBySymbol = {}; // symbol  → enrichment (fallback)
      try {
        const submitted = db.prepare(
          "SELECT * FROM staged_orders WHERE status IN ('submitted', 'filled') AND alpaca_order_id IS NOT NULL ORDER BY created_at DESC"
        ).all();
        for (const staged of submitted) {
          const base = {
            stagedId:     staged.id,
            stopPrice:    staged.stop_price,
            entryPrice:   staged.entry_price,
            target1:      staged.target1_price,
            target2:      staged.target2_price,
            exitStrategy: staged.exit_strategy,
          };
          // Map the primary (first tranche) order ID
          enrichById[staged.alpaca_order_id] = { ...base, trancheLabel: null };

          // Map individual tranche parent + stop leg IDs
          if (staged.tranches_json) {
            try {
              const tranches = JSON.parse(staged.tranches_json);
              for (const t of tranches) {
                if (t.orderId)     enrichById[t.orderId]     = { ...base, trancheLabel: t.label, trancheTP: t.tp };
                if (t.stopOrderId) enrichById[t.stopOrderId] = { ...base, trancheLabel: t.label, isStopLeg: true };
              }
            } catch (_) { /* malformed JSON, skip */ }
          }
          // Symbol-level fallback (most recent staged order wins)
          if (!enrichBySymbol[staged.symbol]) enrichBySymbol[staged.symbol] = base;
        }
      } catch (_) { /* non-critical — orders still work without enrichment */ }

      // ── Attach enrichment to each order ──
      const enriched = orders.map(o => ({
        ...o,
        _staged: enrichById[o.id] || enrichBySymbol[o.symbol] || null,
      }));

      res.json({ orders: enriched, count: enriched.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/broker/orders/:id', async (req, res) => {
    try {
      const order = await alpaca.getOrder(req.params.id);
      res.json(order);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/broker/orders', async (req, res) => {
    try {
      const { symbol, qty, side, type, time_in_force, limit_price, stop_price,
              order_class, take_profit, stop_loss } = req.body;
      if (!symbol || !qty || !side || !type) {
        return res.status(400).json({ error: 'symbol, qty, side, and type are required' });
      }
      const order = await alpaca.submitOrder({
        symbol, qty, side, type, time_in_force: time_in_force || 'day',
        limit_price, stop_price, order_class, take_profit, stop_loss,
      });
      res.json(order);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/broker/orders/:id', async (req, res) => {
    try {
      await alpaca.cancelOrder(req.params.id);
      res.json({ ok: true, cancelled: req.params.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Market Clock ──────────────────────────────────────────────────────────
  router.get('/broker/clock', async (req, res) => {
    try {
      const clock = await alpaca.getClock();
      res.json({
        isOpen:    clock.is_open,
        nextOpen:  clock.next_open,
        nextClose: clock.next_close,
        timestamp: clock.timestamp,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Connection Status ────────────────────────────────────────────────────
  router.get('/broker/status', async (req, res) => {
    try {
      const connection = await alpaca.validateConnection();
      const { getMonitorStatus } = require('../broker/monitor');
      const monitor = getMonitorStatus();
      res.json({ broker: connection, monitor });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Real-Time Stream Status & Prices ─────────────────────────────────────
  router.get('/broker/stream/status', (req, res) => {
    try {
      const { priceStream } = require('../broker/monitor');
      res.json(priceStream.getStatus());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/broker/stream/prices', (req, res) => {
    try {
      const { priceStream } = require('../broker/monitor');
      const symbols = req.query.symbols ? req.query.symbols.split(',') : null;
      const allPrices = priceStream.getAllPrices();
      if (symbols) {
        const filtered = {};
        for (const s of symbols) {
          if (allPrices[s]) filtered[s] = allPrices[s];
        }
        res.json(filtered);
      } else {
        res.json(allPrices);
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // SSE endpoint for real-time price updates to the UI
  router.get('/broker/stream/sse', (req, res) => {
    try {
      const { priceStream } = require('../broker/monitor');

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const symbols = req.query.symbols ? req.query.symbols.split(',') : null;

      const handler = (symbol, update) => {
        if (symbols && !symbols.includes(symbol)) return;
        res.write(`data: ${JSON.stringify({ symbol, ...update })}\n\n`);
      };

      priceStream.on('price', handler);

      req.on('close', () => {
        priceStream.removeListener('price', handler);
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Manual Close Position ─────────────────────────────────────────────────
  router.post('/broker/close-position', async (req, res) => {
    try {
      const { tradeId, symbol, shares, exitPrice, exitType = 'manual' } = req.body;
      if (!symbol) return res.status(400).json({ error: 'symbol is required' });

      let brokerOrder = null;

      // 1. Cancel any open orders for this symbol (OCO/bracket legs, stops, etc.)
      try {
        const openOrders = await alpaca.getOrders({ status: 'open', limit: 200 });
        const related = openOrders.filter(o => o.symbol === symbol.toUpperCase());
        for (const o of related) {
          try { await alpaca.cancelOrder(o.id); } catch (_) { /* already filled/cancelled */ }
        }
      } catch (_) { /* no open orders or broker unavailable */ }

      // 2. Submit sell order via Alpaca
      try {
        if (exitPrice) {
          brokerOrder = await alpaca.submitOrder({
            symbol: symbol.toUpperCase(),
            qty: shares || undefined,
            side: 'sell',
            type: 'limit',
            time_in_force: 'day',
            limit_price: exitPrice,
          });
        } else {
          brokerOrder = await alpaca.closePosition(symbol.toUpperCase());
        }
      } catch (e) {
        console.warn(`Broker close-position warning for ${symbol}: ${e.message}`);
      }

      // 3. Update trade record in database
      let updatedTrade = null;
      const findTrade = tradeId
        ? db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId)
        : db.prepare('SELECT * FROM trades WHERE symbol = ? AND exit_date IS NULL ORDER BY id DESC LIMIT 1')
            .get(symbol.toUpperCase());

      if (findTrade) {
        const usedExitPrice = exitPrice || findTrade.entry_price;
        const pnlDollars = findTrade.side === 'long'
          ? (usedExitPrice - findTrade.entry_price) * (findTrade.shares || 0)
          : (findTrade.entry_price - usedExitPrice) * (findTrade.shares || 0);
        const pnlPercent = findTrade.entry_price
          ? ((usedExitPrice - findTrade.entry_price) / findTrade.entry_price) * 100
              * (findTrade.side === 'long' ? 1 : -1)
          : 0;
        const rMultiple = findTrade.stop_price && findTrade.entry_price !== findTrade.stop_price
          ? (usedExitPrice - findTrade.entry_price) / (findTrade.entry_price - findTrade.stop_price)
          : null;

        db.prepare(`
          UPDATE trades
          SET exit_date = datetime('now'), exit_price = ?, exit_reason = ?,
              pnl_dollars = ?, pnl_percent = ?, r_multiple = ?
          WHERE id = ? AND exit_date IS NULL
        `).run(usedExitPrice, exitType, pnlDollars, pnlPercent, rMultiple, findTrade.id);

        updatedTrade = db.prepare('SELECT * FROM trades WHERE id = ?').get(findTrade.id);
      }

      // 4. Fire notification
      try {
        const { notifyTradeEvent } = require('../notifications/channels');
        await notifyTradeEvent({
          event: 'manual_exit',
          symbol: symbol.toUpperCase(),
          details: {
            shares: updatedTrade?.shares || shares,
            price: exitPrice || updatedTrade?.exit_price,
            pnl: updatedTrade?.pnl_dollars,
            pnl_pct: updatedTrade?.pnl_percent,
            reason: 'Manual exit via UI',
            message: brokerOrder ? `Broker order submitted (${brokerOrder.id})` : 'Journal updated (no broker order)',
          },
        });
      } catch (e) {
        console.warn(`Manual exit notification failed for ${symbol}: ${e.message}`);
      }

      res.json({
        ok: true,
        trade: updatedTrade,
        brokerOrder: brokerOrder ? { id: brokerOrder.id, status: brokerOrder.status, type: brokerOrder.type } : null,
        cancelledOrders: true,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
