// ─── /api/rs-history routes ──────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const { getRSTrendsBulk, getHistoryDates, getSymbolHistory, getSnapshotOnDate,
        RS_HISTORY, SEC_HISTORY, IND_HISTORY } = require('../data/store');

function makeHistoryEndpoint(histType, prefix) {
  return async (req, res) => {
    try {
      const ticker = req.query.ticker?.toUpperCase();
      if (ticker) {
        // Single-ticker time series. getSymbolHistory strips any SEC_/IND_
        // prefix internally so callers can pass either shape.
        const series = getSymbolHistory(histType, ticker)
          .map(r => ({ date: r.date, rs: r.rs_rank }))
          .filter(p => p.rs != null);
        return res.json({ ticker, series });
      }

      // Bulk overview: list of dates + trends for symbols active in the last
      // 7 days. Pre-fix this materialized the entire {date: {symbol: rank}}
      // tree just to walk a 7-day slice.
      const dates = getHistoryDates(histType);
      if (dates.length === 0) {
        return res.json({ dates: [], trends: [], totalDays: 0 });
      }
      const recentDates = dates.slice(-7);
      const activeKeys = new Set();
      for (const d of recentDates) {
        for (const k of Object.keys(getSnapshotOnDate(histType, d))) activeKeys.add(k);
      }
      const keys = [...activeKeys].filter(k =>
        prefix ? k.startsWith(prefix) : !k.startsWith('SEC_') && !k.startsWith('IND_')
      );
      // Bulk helper strips prefixes and emits a Map keyed by clean symbol.
      const trendMap = getRSTrendsBulk(histType, keys);
      const trends = keys.map(k => {
        const displayTicker = prefix ? k.replace(prefix, '') : k;
        const trend = trendMap.get(displayTicker);
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
