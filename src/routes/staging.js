// ─── /api/staging/* routes ──────────────────────────────────────────────────
// Order staging: create, review, and one-click submit bracket orders
const express = require('express');
const router  = express.Router();

const { stageOrder, stageFromSetup, getStagedOrders, getStagedOrder,
        submitStagedOrder, syncOrderStatus, cancelStagedOrder } = require('../broker/staging');
const { computeTradeSetup } = require('../signals/candidates');
const { calculatePositionSize } = require('../risk/position-sizer');
const { getConfig } = require('../risk/portfolio');
const { getMarketRegime } = require('../risk/regime');

module.exports = function(db, runScan) {
  // ─── List staged orders ─────────────────────────────────────────────────────
  router.get('/staging', (req, res) => {
    try {
      const { status, symbol } = req.query;
      const orders = getStagedOrders({ status, symbol });
      res.json({ orders, count: orders.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Get single staged order ────────────────────────────────────────────────
  router.get('/staging/:id', (req, res) => {
    try {
      const order = getStagedOrder(+req.params.id);
      if (!order) return res.status(404).json({ error: 'Staged order not found' });
      res.json(order);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Stage order manually ──────────────────────────────────────────────────
  router.post('/staging', (req, res) => {
    try {
      const { symbol, entry_price, stop_price, target1_price, target2_price,
              qty, side, time_in_force, notes } = req.body;
      if (!symbol || !entry_price || !stop_price || !qty) {
        return res.status(400).json({ error: 'symbol, entry_price, stop_price, and qty required' });
      }
      const staged = stageOrder({
        symbol, entry_price, stop_price, target1_price, target2_price,
        qty, side, time_in_force, source: 'manual', notes,
      });
      res.json(staged);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Stage from trade setup (auto-calculate everything) ───────────────────
  router.post('/staging/from-setup', async (req, res) => {
    try {
      const { ticker, mode = 'swing' } = req.body;
      if (!ticker) return res.status(400).json({ error: 'ticker required' });

      // Run scanner to get fresh stock data
      const scanResults = await runScan();
      const stock = scanResults.find(s => s.ticker === ticker.toUpperCase());
      if (!stock) return res.status(404).json({ error: `${ticker} not found in scan results` });

      // Compute trade setup
      const setup = computeTradeSetup(stock, mode);

      // Calculate position size
      const config = getConfig();
      const regime = await getMarketRegime();
      const entryPrice = stock.price;
      const stopPrice = parseFloat(setup.stopLevel.replace(/[^0-9.]/g, ''));

      const sizing = calculatePositionSize({
        accountSize: config.accountSize,
        riskPerTrade: config.riskPerTrade,
        entryPrice,
        stopPrice,
        regimeMultiplier: regime.sizeMultiplier,
        maxPositionPct: config.maxPositionPct,
      });

      // Stage the bracket order
      const staged = stageFromSetup(stock, setup, sizing, mode === 'swing' ? 'swinglab' : 'position');

      res.json({
        staged,
        setup,
        sizing: {
          shares: sizing.shares,
          dollarRisk: sizing.dollarRisk,
          positionValue: sizing.positionValue,
          portfolioPct: sizing.portfolioPct,
          regimeMultiplier: regime.sizeMultiplier,
        },
        stock: {
          ticker: stock.ticker,
          price: stock.price,
          rsRank: stock.rsRank,
          sepaScore: stock.sepaScore,
          convictionScore: stock.convictionScore,
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Submit staged order (one-click) ───────────────────────────────────────
  router.post('/staging/:id/submit', async (req, res) => {
    try {
      const result = await submitStagedOrder(+req.params.id);
      res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ─── Cancel staged order ──────────────────────────────────────────────────
  router.post('/staging/:id/cancel', async (req, res) => {
    try {
      const result = await cancelStagedOrder(+req.params.id);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Sync order status from Alpaca ────────────────────────────────────────
  router.get('/staging/:id/status', async (req, res) => {
    try {
      const result = await syncOrderStatus(+req.params.id);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
