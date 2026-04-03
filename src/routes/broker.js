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

  return router;
};
