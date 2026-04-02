// ─── /api/fundamentals/:ticker and /api/news/:ticker routes ─────────────────
const express = require('express');
const router  = express.Router();
const fetch   = require('node-fetch');

const { getYahooFundamentals, yahooQuote, getYahooCrumb } = require('../data/providers/yahoo');

// GET /api/fundamentals/:ticker
router.get('/fundamentals/:ticker', async (req, res) => {
  try {
    const sym  = req.params.ticker.toUpperCase();
    console.log(`  Fetching fundamentals for ${sym}...`);
    const data = await getYahooFundamentals(sym);
    if (!data) {
      console.warn(`  Fundamentals: no data for ${sym}`);
      return res.status(404).json({ error: `No fundamental data for ${sym} — Yahoo v11 may not cover this ticker` });
    }
    console.log(`  ✓ Fundamentals ${sym}: EPS=${data.epsGrowthQoQ}% Rev=${data.revenueGrowthYoY}% Short=${data.shortPercentFloat}%`);
    res.json({ ticker: sym, ...data });
  } catch(e) {
    console.error(`  Fundamentals error ${req.params.ticker}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/news/:ticker
router.get('/news/:ticker', async (req, res) => {
  try {
    const sym = req.params.ticker.toUpperCase();
    const quotes = await yahooQuote([sym]);
    const q = quotes[0];
    const { crumb, cookie } = await getYahooCrumb();
    const newsUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=news&crumb=${encodeURIComponent(crumb)}`;
    let headlines = [];
    try {
      const nr = await fetch(newsUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': cookie }
      });
      const nd = await nr.json();
      const articles = nd?.quoteSummary?.result?.[0]?.news || [];
      headlines = articles.slice(0, 5).map(a => ({
        title:     a.title,
        source:    a.publisher,
        time:      a.providerPublishTime
          ? new Date(a.providerPublishTime * 1000).toLocaleDateString() : null,
        url:       a.link,
      }));
    } catch(_) {}
    res.json({ ticker: sym, headlines, earningsDate: q?.earningsDate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
