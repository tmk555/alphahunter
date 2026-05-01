// ─── /api/health route ──────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const { getHistoryStats, RS_HISTORY } = require('../data/store');
const alpaca = require('../broker/alpaca');
const { getMonitorStatus } = require('../broker/monitor');
const { getActiveAlerts } = require('../broker/alerts');

module.exports = function(UNIVERSE, SECTOR_MAP, anthropic) {
  router.get('/health', async (_, res) => {
    // Was loadHistory() + Object.keys(...).sort() — that materialized the
    // full 3.7M-row rs_snapshots table just to read its dimensions. The
    // targeted helper runs a single COUNT(DISTINCT)/MAX query instead.
    const { dateCount, lastDate } = getHistoryStats(RS_HISTORY);
    const brokerConfig = alpaca.getConfig();
    res.json({
      ok: true,
      claude: !!anthropic,
      broker: brokerConfig.configured ? (brokerConfig.base.includes('paper') ? 'paper' : 'live') : false,
      activeAlerts: getActiveAlerts().length,
      monitor: getMonitorStatus(),
      rsHistoryDays: dateCount,
      lastSnapshot: lastDate || 'none',
      universeSize: UNIVERSE.length,
      sectorBreakdown: Object.entries(SECTOR_MAP).reduce((acc,[,sec]) => { acc[sec]=(acc[sec]||0)+1; return acc; }, {}),
      rsModel: 'REAL IBD 12-month daily closes',
      time: new Date().toISOString(),
    });
  });

  return router;
};
