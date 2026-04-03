// ─── /api/rs-history routes ──────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const { getRSTrend } = require('../signals/rs');
const { loadHistory, RS_HISTORY, SEC_HISTORY, IND_HISTORY } = require('../data/store');

function makeHistoryEndpoint(histType, prefix) {
  return async (req, res) => {
    try {
      const history = loadHistory(histType);
      const dates   = Object.keys(history).sort();
      const ticker  = req.query.ticker?.toUpperCase();
      if (ticker) {
        const series = dates
          .map(d => ({ date: d, rs: history[d]?.[ticker] ?? null }))
          .filter(p => p.rs != null);
        return res.json({ ticker, series });
      }
      const last   = history[dates[dates.length-1]] || {};
      const recentDates = dates.slice(-7);
      const allKeys = new Set();
      for (const d of recentDates) {
        const snap = history[d] || {};
        for (const k of Object.keys(snap)) allKeys.add(k);
      }
      const keys = [...allKeys].filter(k =>
        prefix ? k.startsWith(prefix) : !k.startsWith('SEC_') && !k.startsWith('IND_')
      );
      const trends = keys.map(k => {
        const displayTicker = prefix ? k.replace(prefix, '') : k;
        const trend = getRSTrend(k, history);
        if (!trend) return null;
        return { ticker: displayTicker, rawKey: k, ...trend };
      }).filter(Boolean).sort((a,b) => b.current - a.current);
      res.json({ dates, trends, totalDays: dates.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  };
}

router.get('/rs-history',            makeHistoryEndpoint(RS_HISTORY,  null));
router.get('/rs-history/sectors',    makeHistoryEndpoint(SEC_HISTORY, 'SEC_'));
router.get('/rs-history/industries', makeHistoryEndpoint(IND_HISTORY, 'IND_'));

module.exports = router;
