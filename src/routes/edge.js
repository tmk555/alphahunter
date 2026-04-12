// ─── Edge Validation & Analytics API Routes ──────────────────────────────────
// Endpoints for Gap 1 (prove the edge), Gap 2 (protect downside),
// and Gap 3 (measure everything).

const express = require('express');

module.exports = function (db, runScan, UNIVERSE, SECTOR_MAP) {
  const router = express.Router();

  // ─── Gap 1: Edge Validation ──────────────────────────────────────────────

  const {
    estimateExecutionCost, roundTripCost,
    getUniverseHistory, getUniverseAsOf, initializeUniverseTracking,
    analyzeSignalDecay, optimizeConvictionWeights, generateEdgeReport,
  } = require('../signals/edge-validation');

  // Execution cost estimate for a trade
  router.post('/edge/execution-cost', (req, res) => {
    try {
      const cost = estimateExecutionCost(req.body);
      res.json(cost);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Round-trip cost (entry + exit)
  router.post('/edge/roundtrip-cost', (req, res) => {
    try {
      const cost = roundTripCost(req.body);
      res.json(cost);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Universe survivorship tracking
  router.get('/edge/universe-history', (_, res) => {
    try {
      res.json(getUniverseHistory());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/edge/universe-init', (_, res) => {
    try {
      const result = initializeUniverseTracking(UNIVERSE, SECTOR_MAP);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/edge/universe-as-of/:date', (req, res) => {
    try {
      res.json(getUniverseAsOf(req.params.date, UNIVERSE));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Signal decay analysis
  router.get('/edge/signal-decay/:signal', (req, res) => {
    try {
      const result = analyzeSignalDecay(req.params.signal, {
        minRS: parseInt(req.query.minRS) || 80,
        minMomentum: parseInt(req.query.minMomentum) || 60,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Conviction weight optimization (walk-forward)
  router.post('/edge/optimize-weights', (req, res) => {
    try {
      const result = optimizeConvictionWeights(req.body);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Full edge report
  router.get('/edge/report', (_, res) => {
    try {
      res.json(generateEdgeReport(UNIVERSE, SECTOR_MAP));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Gap 2a: Breadth Internals ──────────────────────────────────────────

  const {
    computeBreadthFromSnapshots, computeMcClellanOscillator,
    detectBreadthDivergence, getBreadthHistory, getFullBreadthDashboard,
  } = require('../signals/breadth');

  // Full breadth dashboard
  router.get('/breadth', async (req, res) => {
    try {
      const dashboard = await getFullBreadthDashboard();
      res.json(dashboard);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Breadth for a specific date
  router.get('/breadth/:date', (req, res) => {
    try {
      const breadth = computeBreadthFromSnapshots(req.params.date);
      res.json(breadth || { error: 'No data for this date' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // McClellan oscillator
  router.get('/breadth/mcclellan', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 60;
      res.json(computeMcClellanOscillator(days));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Breadth divergence detection
  router.get('/breadth/divergence', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 60;
      res.json(detectBreadthDivergence(days));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Breadth history
  router.get('/breadth/history', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 90;
      res.json(getBreadthHistory(days));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Gap 2b: Correlation & Factor Analysis ──────────────────────────────

  const {
    analyzePortfolioCorrelation, analyzeFactorExposure,
    correlationAdjustedSize, calculatePortfolioVaR,
  } = require('../risk/correlation');

  // Portfolio correlation analysis (requires price data — uses cached scan)
  router.post('/portfolio/correlation', (req, res) => {
    try {
      const { closesMap, positions } = req.body;
      res.json(analyzePortfolioCorrelation(closesMap || {}, positions || []));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Factor exposure
  router.post('/portfolio/factors', (req, res) => {
    try {
      const { positions, closesMap, benchmarkCloses } = req.body;
      res.json(analyzeFactorExposure(positions, closesMap, benchmarkCloses));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Correlation-adjusted position size
  router.post('/portfolio/correlation-size', (req, res) => {
    try {
      const { baseShares, candidateSymbol, closesMap, existingPositions } = req.body;
      res.json(correlationAdjustedSize(baseShares, candidateSymbol, closesMap, existingPositions));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Portfolio VaR
  router.post('/portfolio/var', (req, res) => {
    try {
      const { closesMap, positions, confidence, days } = req.body;
      res.json(calculatePortfolioVaR(closesMap, positions, confidence, days));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Gap 2c: Hedging Framework ──────────────────────────────────────────

  const {
    calculateHedgeRatio, recommendHedgeInstruments,
    logHedgeAction, getHedgeHistory, hedgePerformanceSummary,
  } = require('../risk/hedge-framework');

  // Hedge ratio recommendation
  router.post('/hedge/ratio', (req, res) => {
    try {
      res.json(calculateHedgeRatio(req.body));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Full hedge recommendations
  router.post('/hedge/recommend', (req, res) => {
    try {
      const ratio = calculateHedgeRatio(req.body);
      const instruments = recommendHedgeInstruments({
        ...req.body,
        hedgeRatio: ratio.recommendedHedgeRatio,
      });
      res.json({ ratio, instruments });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Log hedge action
  router.post('/hedge/log', (req, res) => {
    try {
      logHedgeAction(req.body);
      res.json({ logged: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Hedge history
  router.get('/hedge/history', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 90;
      res.json(getHedgeHistory(days));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Hedge performance
  router.get('/hedge/performance', (req, res) => {
    try {
      res.json(hedgePerformanceSummary(req.query.startDate, req.query.endDate));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Gap 3a: Execution Quality ──────────────────────────────────────────

  const {
    logExecution, getExecutionReport, analyzeLiquidity,
  } = require('../risk/execution-quality');

  // Log an execution
  router.post('/execution/log', (req, res) => {
    try {
      const record = logExecution(req.body);
      res.json(record);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Execution quality report
  router.get('/execution/report', (req, res) => {
    try {
      const report = getExecutionReport({
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        symbol: req.query.symbol,
        side: req.query.side,
      });
      res.json(report);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Liquidity analysis for a proposed trade
  router.post('/execution/liquidity', (req, res) => {
    try {
      res.json(analyzeLiquidity(req.body));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Gap 3b: Tax Engine ─────────────────────────────────────────────────

  const {
    getTaxConfig, updateTaxConfig, createTaxLot, sellTaxLots,
    scanTaxLossHarvesting, getYTDTaxSummary, afterTaxPerformance,
  } = require('../risk/tax-engine');

  // Tax config
  router.get('/tax/config', (_, res) => {
    try { res.json(getTaxConfig()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/tax/config', (req, res) => {
    try { res.json(updateTaxConfig(req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Create tax lot
  router.post('/tax/lots', (req, res) => {
    try { res.json(createTaxLot(req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Sell tax lots
  router.post('/tax/sell', (req, res) => {
    try { res.json(sellTaxLots(req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Tax-loss harvesting scanner
  router.post('/tax/harvest', (req, res) => {
    try {
      const { positions, currentPrices } = req.body;
      res.json(scanTaxLossHarvesting(positions || [], currentPrices || {}));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // YTD tax summary
  router.get('/tax/ytd', (_, res) => {
    try { res.json(getYTDTaxSummary()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // After-tax performance
  router.get('/tax/performance', (req, res) => {
    try {
      res.json(afterTaxPerformance(req.query.startDate, req.query.endDate));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Gap 3d: Decision Quality ───────────────────────────────────────────

  const {
    scoreTrade, logDecisionQuality, getDecisionAnalytics, getProcessTrend,
  } = require('../signals/decision-quality');

  // Score a trade's decision quality
  router.post('/decisions/score', (req, res) => {
    try {
      const { trade, context } = req.body;
      const quality = scoreTrade(trade, context);
      if (trade.id) logDecisionQuality(trade.id, quality);
      res.json(quality);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Batch score all unscored trades
  router.post('/decisions/score-all', (req, res) => {
    try {
      const unscored = db.prepare(`
        SELECT t.* FROM trades t
        LEFT JOIN decision_log d ON t.id = d.trade_id
        WHERE t.exit_date IS NOT NULL AND d.trade_id IS NULL
        ORDER BY t.exit_date DESC LIMIT 100
      `).all();

      const results = [];
      for (const trade of unscored) {
        const context = {
          regimeAtEntry: trade.regime_at_entry || trade.entry_regime,
          rsAtEntry: trade.entry_rs,
          sepaAtEntry: trade.entry_sepa,
          exitReason: trade.exit_reason,
          rMultiple: trade.r_multiple,
          wasSystemSignal: trade.was_system_signal !== 0,
        };
        const quality = scoreTrade(trade, context);
        logDecisionQuality(trade.id, quality);
        results.push(quality);
      }
      res.json({ scored: results.length, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Decision analytics
  router.get('/decisions/analytics', (req, res) => {
    try {
      res.json(getDecisionAnalytics({
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Process quality trend
  router.get('/decisions/trend', (req, res) => {
    try {
      const windowSize = parseInt(req.query.windowSize) || 20;
      res.json(getProcessTrend(windowSize));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
