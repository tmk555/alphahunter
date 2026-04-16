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
      // Enrich with local trade data
      const localTrades = db.prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();
      const tradeMap = {};
      for (const t of localTrades) tradeMap[t.symbol] = t;

      const enriched = positions.map(p => {
        const local = tradeMap[p.symbol];
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
          localStop:      local?.stop_price || null,
          localTarget1:   local?.target1 || null,
          localTarget2:   local?.target2 || null,
          localEntryRS:   local?.entry_rs || null,
          localTradeId:   local?.id || null,
        };
      });

      res.json({ positions: enriched, count: enriched.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Orders ─────────────────────────────────────────────────────────────────
  router.get('/broker/orders', async (req, res) => {
    try {
      const { status = 'open', limit = 50 } = req.query;
      const orders = await alpaca.getOrders({ status, limit: +limit });
      res.json({ orders, count: orders.length });
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
