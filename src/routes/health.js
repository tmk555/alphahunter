// ─── /api/health route ──────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const { loadHistory, RS_HISTORY } = require('../data/store');
const alpaca = require('../broker/alpaca');
const { getMonitorStatus } = require('../broker/monitor');
const { getActiveAlerts } = require('../broker/alerts');

module.exports = function(UNIVERSE, SECTOR_MAP, anthropic) {
  router.get('/health', async (_, res) => {
    const h = loadHistory(RS_HISTORY), dates = Object.keys(h).sort();
    const brokerConfig = alpaca.getConfig();
    res.json({
      ok: true,
      claude: !!anthropic,
      broker: brokerConfig.configured ? (brokerConfig.base.includes('paper') ? 'paper' : 'live') : false,
      activeAlerts: getActiveAlerts().length,
      monitor: getMonitorStatus(),
      rsHistoryDays: dates.length,
      lastSnapshot: dates[dates.length-1] || 'none',
      universeSize: UNIVERSE.length,
      sectorBreakdown: Object.entries(SECTOR_MAP).reduce((acc,[,sec]) => { acc[sec]=(acc[sec]||0)+1; return acc; }, {}),
      rsModel: 'REAL IBD 12-month daily closes',
      time: new Date().toISOString(),
    });
  });

  return router;
};
