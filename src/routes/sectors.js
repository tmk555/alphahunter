// ─── /api/sectors, /api/industries, /api/industry-stocks routes ──────────────
const express = require('express');
const router  = express.Router();

const { runRSScan, runETFScan } = require('../scanner');
const { getRSTrend } = require('../signals/rs');
const { loadHistory, RS_HISTORY, SEC_HISTORY, IND_HISTORY } = require('../data/store');

module.exports = function(SECTOR_ETFS, INDUSTRY_ETFS, INDUSTRY_STOCKS, UNIVERSE, SECTOR_MAP) {
  // /api/sectors
  router.get('/sectors', async (req, res) => {
    try {
      const sectorsOut = await runETFScan(SECTOR_ETFS, SEC_HISTORY, 'SEC_');
      res.json({ sectors: sectorsOut });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/industries
  router.get('/industries', async (req, res) => {
    try {
      const industriesOut = await runETFScan(INDUSTRY_ETFS, IND_HISTORY, 'IND_');
      res.json({ industries: industriesOut });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/industry-stocks/:etf
  router.get('/industry-stocks/:etf', async (req, res) => {
    try {
      const etf    = req.params.etf.toUpperCase();
      const tickers = INDUSTRY_STOCKS[etf] || [];
      const stocks  = await runRSScan(UNIVERSE, SECTOR_MAP);
      const history = loadHistory(RS_HISTORY);
      const result  = tickers
        .map(t => stocks.find(s => s.ticker === t))
        .filter(Boolean)
        .map(s => ({ ...s, rsTrend: getRSTrend(s.ticker, history) }))
        .sort((a,b) => b.rsRank - a.rsRank);
      res.json({ etf, stocks: result, total: result.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
