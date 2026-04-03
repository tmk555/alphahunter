// ─── /api/rs-scan and /api/leaders-laggards routes ──────────────────────────
const express = require('express');
const router  = express.Router();

const { runRSScan } = require('../scanner');
const { getRSTrend } = require('../signals/rs');
const { loadHistory, RS_HISTORY } = require('../data/store');

function loadRSHistory() { return loadHistory(RS_HISTORY); }

module.exports = function(UNIVERSE, SECTOR_MAP) {
  // /api/rs-scan
  router.get('/rs-scan', async (req, res) => {
    try {
      const stocks  = await runRSScan(UNIVERSE, SECTOR_MAP);
      const history = loadRSHistory();
      const withTrend = stocks.map(s => ({ ...s, rsTrend: getRSTrend(s.ticker, history) }));
      const spyStock = withTrend.find(s => s.ticker === 'SPY');
      const spy3m = spyStock?.chg3m ?? null;
      const final = spy3m != null
        ? withTrend.map(s => ({ ...s, vsSPY3m: s.chg3m != null ? +(s.chg3m - spy3m).toFixed(2) : null }))
        : withTrend;
      res.json({ stocks: final, universeSize: final.length, spy3m });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/leaders-laggards
  router.get('/leaders-laggards', async (req, res) => {
    try {
      const stocks  = await runRSScan(UNIVERSE, SECTOR_MAP);
      const history = loadRSHistory();
      const all = stocks.map(s => ({ ...s, rsTrend: getRSTrend(s.ticker, history) }));
      const leaders  = all.filter(s => s.vsMA50 != null && s.vsMA50 > 0).sort((a,b) => b.rsRank-a.rsRank).slice(0,15);
      const lSet     = new Set(leaders.map(s => s.ticker));
      const laggards = all.filter(s => !lSet.has(s.ticker)).sort((a,b) => a.rsRank-b.rsRank).slice(0,15);
      res.json({ leaders, laggards });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
