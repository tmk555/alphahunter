// ─── /api/sectors, /api/industries, /api/industry-stocks routes ──────────────
const express = require('express');
const router  = express.Router();

const { runRSScan, runETFScan } = require('../scanner');
const { getRSTrend } = require('../signals/rs');
const { loadHistory, RS_HISTORY, SEC_HISTORY, IND_HISTORY } = require('../data/store');
const { computeRotation, getSectorRotationHistory } = require('../signals/rotation');

module.exports = function(SECTOR_ETFS, INDUSTRY_ETFS, INDUSTRY_STOCKS, UNIVERSE, SECTOR_MAP) {
  // /api/sectors
  router.get('/sectors', async (req, res) => {
    try {
      const sectorsOut = await runETFScan(SECTOR_ETFS, SEC_HISTORY, 'SEC_');
      res.json({ sectors: sectorsOut });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/sectors/rotation — Quantitative sector rotation model
  router.get('/sectors/rotation', async (req, res) => {
    try {
      const sectorsOut = await runETFScan(SECTOR_ETFS, SEC_HISTORY, 'SEC_');
      const rotation = computeRotation(sectorsOut);
      if (!rotation) return res.json({ error: 'Insufficient sector data for rotation model' });
      res.json(rotation);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/sectors/rotation/history — Historical sector rotation rankings
  router.get('/sectors/rotation/history', (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
      const history = getSectorRotationHistory(days);
      res.json({ days, snapshots: history.length, history });
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
