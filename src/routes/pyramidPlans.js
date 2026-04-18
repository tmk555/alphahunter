// ─── /api/pyramid-plans/* routes ────────────────────────────────────────────
// Create, list, inspect, and cancel automated pyramid entry plans.
const express = require('express');
const router  = express.Router();

const {
  createPyramidPlan, getPyramidPlans, getPyramidPlan,
  cancelPyramidPlan, detectPivotForPyramid, computeAddTriggers,
} = require('../broker/pyramid-plans');
const { getVolumePace } = require('../signals/volume-pace');

module.exports = function(runScan) {
  // ─── List pyramid plans ─────────────────────────────────────────────────
  router.get('/pyramid-plans', (req, res) => {
    try {
      const { status, symbol } = req.query;
      const plans = getPyramidPlans({ status, symbol });
      res.json({ plans, count: plans.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Get single plan ────────────────────────────────────────────────────
  router.get('/pyramid-plans/:id', (req, res) => {
    try {
      const plan = getPyramidPlan(+req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      res.json(plan);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Preview pyramid triggers for a symbol (no create) ──────────────────
  // Useful for the UI confirmation modal: shows detected pivot + computed
  // add1/add2 triggers so the user sees what will happen before committing.
  router.post('/pyramid-plans/preview', async (req, res) => {
    try {
      const { ticker, pivot: pivotOverride, atr: atrOverride } = req.body;
      if (!ticker) return res.status(400).json({ error: 'ticker required' });

      // Get fresh stock data from scan
      const scanResults = await runScan();
      const stock = scanResults.find(s => s.ticker === ticker.toUpperCase());
      if (!stock) return res.status(404).json({ error: `${ticker} not found in scan results` });

      // Try to get price history for pattern detection
      let closes = null, highs = null, lows = null;
      try {
        const { getHistoryFull } = require('../data/providers/manager');
        const bars = await getHistoryFull(ticker.toUpperCase());
        if (bars && bars.length) {
          closes = bars.map(b => b.close);
          highs  = bars.map(b => b.high);
          lows   = bars.map(b => b.low);
        }
      } catch (_) {}

      const atr = atrOverride || stock.atr || (stock.price * 0.02);

      let detected = null;
      if (!pivotOverride) {
        detected = detectPivotForPyramid(stock, closes, highs, lows);
        if (!detected) {
          return res.json({
            ok: false,
            error: 'No pattern detected — supply manual pivot to use pyramid mode, or pick a different exit strategy.',
            price: stock.price,
            atr: +atr.toFixed(2),
          });
        }
      }

      const pivot = pivotOverride || detected.pivot;
      const triggers = computeAddTriggers(pivot, atr);
      const stop = detected?.stop || +(pivot * 0.95).toFixed(2);
      const pace = await getVolumePace(ticker.toUpperCase());

      // ATR-based exit targets — mirror createPyramidPlan logic
      const target1 = +Math.max(pivot * 1.025, pivot + 2.5 * atr).toFixed(2);
      const target2 = +Math.max(pivot * 1.04,  pivot + 4.0 * atr).toFixed(2);
      const runner  = +Math.max(pivot * 1.08,  pivot + 8.0 * atr).toFixed(2);
      const riskDist = pivot - stop;
      const t1R = riskDist > 0 ? +((target1 - pivot) / riskDist).toFixed(2) : 0;
      const t2R = riskDist > 0 ? +((target2 - pivot) / riskDist).toFixed(2) : 0;

      res.json({
        ok: true,
        ticker: ticker.toUpperCase(),
        price: stock.price,
        atr: +atr.toFixed(2),
        pattern: detected ? {
          name: detected.patternName,
          confidence: detected.confidence,
        } : null,
        triggers: {
          pilot: pivot,
          add1:  triggers.add1,
          add2:  triggers.add2,
        },
        targets: {
          pilotTp: target1,   // pilot exits here
          add1Tp:  target2,   // add1 exits here
          add2Tp:  runner,    // add2 runner — trailing stop handles real exit
          t1R, t2R,
        },
        pilotDistPct: +(((pivot - stock.price) / stock.price) * 100).toFixed(2),
        stop,
        stopDistPct: +(((pivot - stop) / pivot) * 100).toFixed(2),
        volumePaceNow: pace,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Create pyramid plan ────────────────────────────────────────────────
  router.post('/pyramid-plans', async (req, res) => {
    try {
      const { ticker, totalQty, pivot, stopPrice, target1_price, target2_price,
              atr, volumePaceMin, notes, expiryDays } = req.body;
      if (!ticker) return res.status(400).json({ error: 'ticker required' });
      if (!(totalQty > 0)) return res.status(400).json({ error: 'totalQty must be > 0' });

      // Fresh scan + history for pattern detection
      const scanResults = await runScan();
      const stock = scanResults.find(s => s.ticker === ticker.toUpperCase());
      if (!stock) return res.status(404).json({ error: `${ticker} not found in scan results` });

      let closes = null, highs = null, lows = null;
      try {
        const { getHistoryFull } = require('../data/providers/manager');
        const bars = await getHistoryFull(ticker.toUpperCase());
        if (bars && bars.length) {
          closes = bars.map(b => b.close);
          highs  = bars.map(b => b.high);
          lows   = bars.map(b => b.low);
        }
      } catch (_) {}

      const plan = createPyramidPlan({
        symbol: ticker, totalQty: +totalQty, pivot, stopPrice,
        target1_price, target2_price,
        atr: atr || stock.atr || (stock.price * 0.02),
        closes, highs, lows,
        source: 'manual', convictionScore: stock.convictionScore,
        volumePaceMin, notes, expiryDays,
      });

      res.json(plan);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── Cancel pyramid plan ────────────────────────────────────────────────
  router.post('/pyramid-plans/:id/cancel', async (req, res) => {
    try {
      const plan = await cancelPyramidPlan(+req.params.id);
      res.json(plan);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
