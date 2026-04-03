// ─── /api/daily-picks route ──────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const { getRSTrend } = require('../signals/rs');
const { calcConviction } = require('../signals/conviction');
const { computeTradeSetup } = require('../signals/candidates');
const { getMarketRegime } = require('../risk/regime');
const { loadHistory, RS_HISTORY } = require('../data/store');

module.exports = function(runRSScanFn) {
  router.get('/daily-picks', async (req, res) => {
    try {
      const stocks  = await runRSScanFn();
      const history = loadHistory(RS_HISTORY);
      const regime  = await getMarketRegime();

      const scored = stocks
        .filter(s => s.rsRank >= 60 && s.swingMomentum >= 40)
        .map(s => {
          const trend = getRSTrend(s.ticker, history);
          const { convictionScore, reasons } = calcConviction(s, trend);
          const swingSetup    = computeTradeSetup(s, 'swing');
          const positionSetup = computeTradeSetup(s, 'position');
          return { ...s, rsTrend: trend, convictionScore, reasons, swingSetup, positionSetup };
        })
        .sort((a, b) => b.convictionScore - a.convictionScore)
        .slice(0, 7);

      res.json({
        picks: scored,
        regime,
        date: new Date().toISOString().split('T')[0],
        note: regime.swingOk === false
          ? 'BEAR REGIME — no new long setups recommended'
          : `${scored.length} candidates ranked by conviction (RS + Accel + Momentum + SEPA)`,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
