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

// POST /api/fundamentals/bulk
//
// Triggers a getFundamentals() pass for each ticker in the body, which
// populates fundamentals_snapshot via the upsert in providers/manager.js.
// Used to bootstrap the snapshot table for the CAN SLIM 6/6 filter chip
// — without it, only stocks the user has viewed individually appear.
//
// Rate-limited at 4 concurrent (Yahoo throttles aggressively; SEC EDGAR
// is public-good so we keep it polite). 50 stocks ≈ ~30-60 sec.
router.post('/fundamentals/bulk', async (req, res) => {
  const tickers = Array.isArray(req.body?.tickers) ? req.body.tickers.map(t => String(t).toUpperCase()).slice(0, 100) : [];
  if (!tickers.length) return res.status(400).json({ error: 'tickers array required' });

  let fetched = 0, failed = 0;
  const errors = [];
  const concurrency = 4;
  let idx = 0;
  async function worker() {
    while (idx < tickers.length) {
      const i = idx++;
      const sym = tickers[i];
      try {
        const data = await getFundamentals(sym);
        if (data) fetched++;
        else { failed++; errors.push({ sym, err: 'no_data' }); }
      } catch (e) {
        failed++;
        errors.push({ sym, err: e.message?.slice(0, 80) || 'error' });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  res.json({
    requested: tickers.length,
    fetched,
    failed,
    errors: errors.slice(0, 10),  // cap error list for response size
  });
});

// GET /api/fundamentals/:ticker
router.get('/fundamentals/:ticker', async (req, res) => {
  const sym = req.params.ticker.toUpperCase();
  try {
    console.log(`  Fetching fundamentals for ${sym}...`);
    const data = await getFundamentals(sym);
    if (!data) {
      // Reached when *both* Yahoo and SEC came up empty — this happens for
      // foreign ADRs (file 20-F not 10-K, no XBRL company facts) when Yahoo
      // is also down or doesn't recognize the symbol. Return a friendly
      // message the UI can render as "no data" instead of a hard error.
      console.warn(`  Fundamentals: no data for ${sym} (neither Yahoo nor SEC EDGAR)`);
      return res.status(404).json({
        error: `No fundamental data for ${sym}`,
        detail: 'Both Yahoo and SEC EDGAR returned empty. Foreign ADRs (file 20-F) are SEC-coverage exempt; very recent IPOs may not yet be in either dataset.',
      });
    }
    console.log(`  ✓ Fundamentals ${sym}: EPS=${data.epsGrowthQoQ}% Rev=${data.revenueGrowthYoY}% Short=${data.shortPercentFloat}% src=${data.epsDataSource||'yahoo'}`);
    res.json({ ticker: sym, ...data });
  } catch(e) {
    // Last-resort guard. The cascade-resilient getFundamentals is supposed
    // to have already absorbed provider failures; if we land here, something
    // else broke (DB error, JSON parsing, etc.). Surface as 500 with the
    // ticker so the user can correlate.
    console.error(`  Fundamentals fatal error ${sym}:`, e.message);
    res.status(500).json({
      error: `Fundamentals lookup failed for ${sym}`,
      detail: e.message,
    });
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
