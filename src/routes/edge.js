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
    backfillBreadthHistory,
  } = require('../signals/breadth');

  // Full breadth dashboard
  router.get('/breadth', async (req, res) => {
    try {
      const dashboard = await getFullBreadthDashboard();
      res.json(dashboard);
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

  // Backfill breadth snapshots from all historical RS scan data
  router.post('/breadth/backfill', (req, res) => {
    try {
      const result = backfillBreadthHistory();
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Breadth Early Warning System ───────────────────────────────────────

  const {
    evaluateBreadthWarning, computeStopAdjustments,
    applyStopAdjustments, runBreadthEarlyWarning,
  } = require('../signals/breadth-warning');

  // Get current breadth warning status
  router.get('/breadth/early-warning', (req, res) => {
    try {
      const warning = evaluateBreadthWarning();
      const { adjustments, actions } = computeStopAdjustments(warning.label);
      res.json({ ...warning, pendingAdjustments: adjustments, actions });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Apply breadth-based stop tightening (manual trigger)
  router.post('/breadth/early-warning/apply', (req, res) => {
    try {
      const result = runBreadthEarlyWarning({ autoApply: true });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Breadth for a specific date (must be AFTER all /breadth/* named routes)
  router.get('/breadth/:date', (req, res) => {
    try {
      const breadth = computeBreadthFromSnapshots(req.params.date);
      res.json(breadth || { error: 'No data for this date' });
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

  // Backfill tax lots from existing trades that don't have them yet
  router.post('/tax/backfill', (req, res) => {
    try {
      const trades = db.prepare(`
        SELECT t.* FROM trades t
        LEFT JOIN tax_lots tl ON t.id = tl.trade_id
        WHERE tl.trade_id IS NULL AND t.entry_price > 0
        ORDER BY t.entry_date ASC
      `).all();

      let created = 0;
      let disposed = 0;
      for (const t of trades) {
        try {
          createTaxLot({
            tradeId: t.id,
            symbol: t.symbol,
            shares: t.shares || t.initial_shares,
            costBasis: t.entry_price,
            acquiredDate: t.entry_date,
          });
          created++;

          // If the trade is closed, also dispose the tax lot
          if (t.exit_date && t.exit_price) {
            try {
              sellTaxLots({
                symbol: t.symbol,
                shares: t.shares || t.initial_shares,
                salePrice: t.exit_price,
                saleDate: t.exit_date,
                method: 'fifo',
              });
              disposed++;
            } catch (_) {}
          }
        } catch (_) {}
      }
      res.json({ backfilled: created, disposed, total: trades.length });
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

  // Batch score all unscored trades (enriches missing context from rs_snapshots)
  router.post('/decisions/score-all', (req, res) => {
    try {
      // Include already-scored trades if rescore=true, so we can fix stale scores
      const rescore = req.query.rescore === 'true' || req.body.rescore;
      const query = rescore
        ? `SELECT t.* FROM trades t WHERE t.exit_date IS NOT NULL ORDER BY t.exit_date DESC LIMIT 100`
        : `SELECT t.* FROM trades t LEFT JOIN decision_log d ON t.id = d.trade_id
           WHERE t.exit_date IS NOT NULL AND d.trade_id IS NULL
           ORDER BY t.exit_date DESC LIMIT 100`;
      const unscored = db.prepare(query).all();

      const results = [];
      for (const trade of unscored) {
        // Enrich context from rs_snapshots at entry time
        const snapshot = db.prepare(`
          SELECT swing_momentum, sepa_score, rs_rank, stage
          FROM rs_snapshots
          WHERE symbol = ? AND date <= ? AND type = 'stock'
          ORDER BY date DESC LIMIT 1
        `).get(trade.symbol, trade.entry_date);

        // Calculate portfolio heat at entry: sum of open risk as % of account
        let portfolioHeatAtEntry = null;
        try {
          const openAtEntry = db.prepare(`
            SELECT entry_price, stop_price, shares FROM trades
            WHERE entry_date <= ? AND (exit_date IS NULL OR exit_date > ?) AND id != ?
          `).all(trade.entry_date, trade.entry_date, trade.id);
          if (openAtEntry.length > 0) {
            const { getConfig } = require('../risk/portfolio');
            const cfg = getConfig();
            const accountValue = cfg.accountValue || 100000;
            let totalRisk = 0;
            for (const t of openAtEntry) {
              const risk = Math.abs(t.entry_price - (t.stop_price || t.entry_price * 0.95)) * (t.shares || 0);
              totalRisk += risk;
            }
            portfolioHeatAtEntry = +(totalRisk / accountValue * 100).toFixed(1);
          }
        } catch (_) {}

        // Determine if this was a system signal (had staged order with conviction score)
        const staged = trade.alpaca_order_id
          ? db.prepare('SELECT conviction_score, strategy FROM staged_orders WHERE alpaca_order_id = ?').get(trade.alpaca_order_id)
          : null;
        const wasSystemSignal = staged?.conviction_score > 0 || trade.was_system_signal === 1 || trade.strategy != null;

        // Check if sizing followed rules (within 20% of recommended size)
        let followedSizingRules = null;
        if (trade.stop_price && trade.entry_price && trade.shares) {
          try {
            const { getConfig } = require('../risk/portfolio');
            const cfg = getConfig();
            const riskPerShare = Math.abs(trade.entry_price - trade.stop_price);
            const maxRiskDollars = (cfg.accountValue || 100000) * (cfg.maxRiskPerTrade || 0.01);
            const recommendedShares = riskPerShare > 0 ? Math.floor(maxRiskDollars / riskPerShare) : 0;
            if (recommendedShares > 0) {
              const ratio = trade.shares / recommendedShares;
              followedSizingRules = ratio >= 0.5 && ratio <= 1.5; // within 50-150% of recommended
            }
          } catch (_) {}
        }

        const context = {
          regimeAtEntry: trade.regime_at_entry || trade.entry_regime,
          rsAtEntry: trade.entry_rs || snapshot?.rs_rank,
          momentumAtEntry: snapshot?.swing_momentum || null,
          sepaAtEntry: trade.entry_sepa || snapshot?.sepa_score,
          portfolioHeatAtEntry,
          exitReason: trade.exit_reason,
          rMultiple: trade.r_multiple,
          wasSystemSignal,
          followedSizingRules,
          plannedStop: trade.stop_price,
          actualExit: trade.exit_price,
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

  // ─── Momentum Scout: discover breakout stocks outside the universe ────────
  const { runMomentumScout, getExpansionWatchlist } = require('../signals/momentum-scout');

  router.get('/momentum-scout', async (req, res) => {
    try {
      const result = await runMomentumScout(SECTOR_MAP);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/momentum-scout/watchlist', (req, res) => {
    res.json(getExpansionWatchlist());
  });

  // ─── Universe Management (DB-backed, no file editing) ─────────────────────

  // Add stock to universe at runtime + persist to DB
  router.post('/edge/universe/add', (req, res) => {
    try {
      const { symbol, sector } = req.body;
      if (!symbol || !sector) return res.status(400).json({ error: 'symbol and sector required' });
      const sym = symbol.toUpperCase().trim();
      const validSectors = ['Technology','Comm Services','Consumer Disc','Industrials',
        'Energy','Financials','Healthcare','Materials','Cons Staples','Real Estate','Utilities'];
      if (!validSectors.includes(sector)) {
        return res.status(400).json({ error: `Invalid sector. Must be one of: ${validSectors.join(', ')}` });
      }
      if (SECTOR_MAP[sym]) {
        return res.json({ message: `${sym} already in universe (${SECTOR_MAP[sym]})`, existed: true });
      }
      // Add to live runtime universe
      SECTOR_MAP[sym] = sector;
      UNIVERSE.push(sym);
      // Persist to DB so it survives restarts
      db.prepare(`INSERT OR REPLACE INTO universe_mgmt (symbol, sector, status, added_date)
        VALUES (?, ?, 'active', datetime('now'))`).run(sym, sector);
      // Sync universe tracker
      try {
        const { syncUniverse } = require('../signals/universe-tracker');
        syncUniverse(UNIVERSE, SECTOR_MAP);
      } catch(_){}
      res.json({ added: sym, sector, universeSize: UNIVERSE.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Remove stock from universe
  router.post('/edge/universe/remove', (req, res) => {
    try {
      const { symbol } = req.body;
      if (!symbol) return res.status(400).json({ error: 'symbol required' });
      const sym = symbol.toUpperCase().trim();
      if (!SECTOR_MAP[sym]) {
        return res.status(404).json({ error: `${sym} not in universe` });
      }
      const sector = SECTOR_MAP[sym];
      delete SECTOR_MAP[sym];
      const idx = UNIVERSE.indexOf(sym);
      if (idx !== -1) UNIVERSE.splice(idx, 1);
      // Mark removed in DB
      db.prepare(`UPDATE universe_mgmt SET status = 'removed', removed_date = datetime('now')
        WHERE symbol = ? AND status = 'active'`).run(sym);
      // Freeze snapshot
      try {
        const { freezeSnapshot } = require('../signals/universe-tracker');
        freezeSnapshot(sym, 'manual_removal');
      } catch(_){}
      res.json({ removed: sym, sector, universeSize: UNIVERSE.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // List current universe (for UI)
  router.get('/edge/universe', (req, res) => {
    try {
      const bySector = {};
      for (const [sym, sector] of Object.entries(SECTOR_MAP)) {
        if (sector === 'Hedge') continue;
        if (!bySector[sector]) bySector[sector] = [];
        bySector[sector].push(sym);
      }
      res.json({ universeSize: UNIVERSE.length, bySector, sectors: Object.keys(bySector).sort() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Phase 1: Universe Tracking (Survivorship Bias Fix) ──────────────────

  router.post('/edge/universe-sync', (req, res) => {
    try {
      const { syncUniverse } = require('../signals/universe-tracker');
      const allSymbols = Object.keys(UNIVERSE).filter(s => UNIVERSE[s] !== 'Hedge');
      const result = syncUniverse(allSymbols, UNIVERSE);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/edge/universe-frozen', (req, res) => {
    try {
      const { getFrozenSnapshots } = require('../signals/universe-tracker');
      const limit = parseInt(req.query.limit) || 50;
      const snapshots = getFrozenSnapshots(limit);
      res.json({ snapshots, count: snapshots.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/edge/universe-size', (req, res) => {
    try {
      const { getUniverseSizeOverTime } = require('../signals/universe-tracker');
      const { start, end } = req.query;
      const sizes = getUniverseSizeOverTime(start, end);
      res.json({ sizes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/edge/universe-changes', (req, res) => {
    try {
      const { getUniverseChanges } = require('../signals/universe-tracker');
      const { start, end } = req.query;
      const changes = getUniverseChanges(start, end);
      res.json(changes);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
