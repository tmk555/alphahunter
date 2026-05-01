// ─── /api/hedge/* routes — Short signals, hedge recommendations ─────────────
const express = require('express');
const router  = express.Router();

const { HEDGE_INSTRUMENTS, isShortCandidate, isShortWatchCandidate,
        calcShortConviction, computeShortSetup, getHedgeRecommendation } = require('../signals/short');
const { getMarketRegime } = require('../risk/regime');
const { getPortfolioHeat, getConfig } = require('../risk/portfolio');

module.exports = function(runScan) {

  // ─── Short Candidates — Stage 4 breakdowns with weak RS ───────────────────
  router.get('/hedge/shorts', async (req, res) => {
    try {
      const results = await runScan();
      const { getRSTrendsBulk, RS_HISTORY } = require('../data/store');

      // Pre-filter, then bulk-fetch trends only for the surviving names.
      // The old path loaded the full rs_snapshots table for what's
      // typically <50 short candidates.
      const shortsFiltered = results
        .filter(s => s.sector !== 'Hedge')
        .filter(s => isShortCandidate(s));
      const trends = getRSTrendsBulk(RS_HISTORY, shortsFiltered.map(s => s.ticker));

      const shorts = shortsFiltered
        .map(s => {
          const rsTrend = trends.get(s.ticker) || null;
          const { shortConviction, reasons } = calcShortConviction(s, rsTrend);
          const setup = computeShortSetup(s);
          return { ...s, shortConviction, shortReasons: reasons, shortSetup: setup, rsTrend };
        })
        .sort((a, b) => b.shortConviction - a.shortConviction);

      res.json({
        shorts: shorts.slice(0, 20),
        count: shorts.length,
        totalScanned: results.filter(s => s.sector !== 'Hedge').length,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Short Watch List — Topping stocks that may become short candidates ───
  router.get('/hedge/watch', async (req, res) => {
    try {
      const results = await runScan();
      const watch = results
        .filter(s => s.sector !== 'Hedge')
        .filter(s => isShortWatchCandidate(s) && !isShortCandidate(s))
        .sort((a, b) => a.rsRank - b.rsRank)
        .slice(0, 30);

      res.json({ watch, count: watch.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Hedge Recommendation — What to hedge based on regime + portfolio ──────
  router.get('/hedge/recommendation', async (req, res) => {
    try {
      const regime = await getMarketRegime();
      const { getDB } = require('../data/database');
      const openPositions = getDB().prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();
      const heat = getPortfolioHeat(openPositions);

      const recommendation = getHedgeRecommendation(regime, heat, regime.vixLevel);
      recommendation.instruments = HEDGE_INSTRUMENTS;
      recommendation.portfolioHeat = heat;

      res.json(recommendation);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Hedge Instruments — Current prices and data for inverse ETFs ─────────
  router.get('/hedge/instruments', async (req, res) => {
    try {
      const results = await runScan();
      const hedgeSymbols = Object.keys(HEDGE_INSTRUMENTS);
      const instruments = results
        .filter(s => hedgeSymbols.includes(s.ticker))
        .map(s => ({
          ...s,
          meta: HEDGE_INSTRUMENTS[s.ticker],
        }));

      res.json({ instruments, count: instruments.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
