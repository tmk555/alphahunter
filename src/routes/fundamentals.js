// ─── /api/fundamentals/:ticker and /api/news/:ticker routes ─────────────────
const express = require('express');
const router  = express.Router();
const fetch   = require('node-fetch');

const { yahooQuote, getYahooCrumb } = require('../data/providers/yahoo');
// Route through the multi-provider manager — NOT Yahoo directly. The manager
// runs the Yahoo cascade and then SEC EDGAR augmentation:
//   • splices in SEC's latest 10-Q EPS when it post-dates Yahoo's freshest
//     (Yahoo lags 24-72h after a 10-Q filing — e.g. AMZN's Q1 2026 print is
//     missing from Yahoo for days while SEC has it minutes after filing)
//   • overrides epsGrowthYoY with true per-share diluted EPS YoY (Yahoo's
//     net-income proxy distorts buyback-heavy names)
//   • exposes filingMarkers with actual 10-Q/10-K filed dates for the UI
//
// Pre-fix this route called getYahooFundamentals directly, so the SEC plumbing
// existed in manager.js but never reached the Levels card.
const { getFundamentals } = require('../data/providers/manager');

// GET /api/fundamentals/:ticker
router.get('/fundamentals/:ticker', async (req, res) => {
  try {
    const sym  = req.params.ticker.toUpperCase();
    console.log(`  Fetching fundamentals for ${sym}...`);
    const data = await getFundamentals(sym);
    if (!data) {
      console.warn(`  Fundamentals: no data for ${sym}`);
      return res.status(404).json({ error: `No fundamental data for ${sym} — Yahoo v11 may not cover this ticker` });
    }
    console.log(`  ✓ Fundamentals ${sym}: EPS=${data.epsGrowthQoQ}% Rev=${data.revenueGrowthYoY}% Short=${data.shortPercentFloat}% src=${data.epsDataSource||'yahoo'}`);
    res.json({ ticker: sym, ...data });
  } catch(e) {
    console.error(`  Fundamentals error ${req.params.ticker}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/news/:ticker
//
// News cascade: Finnhub (when FINNHUB_API_KEY set) → Yahoo. Finnhub returns
// direct publisher URLs (Reuters, CNBC, Bloomberg) instead of Yahoo's
// ad-heavy wrapper that redirects through finance.yahoo.com/m/...
// interstitials. Drops back to Yahoo when:
//   • no Finnhub key configured
//   • Finnhub returns null (rate limit, key invalid, no news for symbol)
//
// `source` field surfaces which provider answered so the UI can show
// "via Finnhub" vs "via Yahoo" and the user knows whether the URLs
// they're clicking are direct.
router.get('/news/:ticker', async (req, res) => {
  try {
    const sym = req.params.ticker.toUpperCase();

    // Finnhub first (direct publisher URLs)
    let headlines = null;
    let provider = null;
    try {
      const fh = require('../data/providers/finnhub');
      const fhNews = await fh.getCompanyNews(sym, { days: 14, limit: 5 });
      if (Array.isArray(fhNews) && fhNews.length) {
        headlines = fhNews;
        provider = 'finnhub';
      }
    } catch (_) { /* fall through to Yahoo */ }

    // Yahoo fallback — keeps the original behavior when Finnhub unavailable
    let earningsDate = null;
    if (!headlines) {
      const quotes = await yahooQuote([sym]);
      const q = quotes[0];
      earningsDate = q?.earningsDate;
      const { crumb, cookie } = await getYahooCrumb();
      const newsUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=news&crumb=${encodeURIComponent(crumb)}`;
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
        provider = 'yahoo';
      } catch(_) { headlines = []; }
    } else {
      // Pull earnings date once even when news came from Finnhub
      try { earningsDate = (await yahooQuote([sym]))?.[0]?.earningsDate; } catch (_) {}
    }

    res.json({ ticker: sym, headlines: headlines || [], earningsDate, provider });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
