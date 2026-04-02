// ─── /api/health route ──────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const { loadHistory, RS_HISTORY_FILE } = require('../data/store');

module.exports = function(UNIVERSE, SECTOR_MAP, anthropic) {
  router.get('/health', async (_, res) => {
    const h = loadHistory(RS_HISTORY_FILE), dates = Object.keys(h).sort();
    res.json({
      ok: true,
      claude: !!anthropic,
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
