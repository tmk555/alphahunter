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

      const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 7));

      const ranked = stocks
        .filter(s => s.rsRank >= 60 && s.swingMomentum >= 40)
        .map(s => {
          const trend = getRSTrend(s.ticker, history);
          const { convictionScore, reasons } = calcConviction(s, trend);
          const swingSetup    = computeTradeSetup(s, 'swing');
          const positionSetup = computeTradeSetup(s, 'position');
          return { ...s, rsTrend: trend, convictionScore, reasons, swingSetup, positionSetup };
        })
        .sort((a, b) => b.convictionScore - a.convictionScore);

      const totalQualified = ranked.length;
      const picks = ranked.slice(0, limit);

      res.json({
        picks,
        totalQualified,
        regime,
        date: new Date().toISOString().split('T')[0],
        note: regime.swingOk === false
          ? 'BEAR REGIME — no new long setups recommended'
          : `${picks.length} of ${totalQualified} candidates ranked by conviction (RS + Accel + Momentum + SEPA)`,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
