// ─── Earnings Estimate Revision API Routes ───────────────────────────────────
// GET  /api/revisions/:symbol  — revision data + score for one stock
// GET  /api/revisions/scan     — revision scores for entire universe (cached)
// POST /api/revisions/refresh  — force refresh revision data

const express = require('express');
const { cacheGet, cacheSet } = require('../data/cache');
const {
  fetchEstimateRevisions,
  scoreRevisions,
  calcRevisionSignal,
  storeRevisions,
  loadPriorRevisions,
  batchFetchRevisions,
} = require('../signals/earningsRevisions');

const TTL_SCAN = 30 * 60 * 1000; // 30 min cache for full scan

module.exports = function (db, runScan) {
  const router = express.Router();

  // GET /api/revisions/scan — scores for entire universe
  // Must be defined BEFORE :symbol to avoid route conflict
  router.get('/revisions/scan', async (req, res) => {
    try {
      const cached = cacheGet('revisions:scan', TTL_SCAN);
      if (cached && !req.query.force) {
        return res.json(cached);
      }

      // Get universe from latest scan
      let scanResults;
      try {
        scanResults = await runScan();
      } catch (e) {
        return res.status(500).json({ error: `Scan failed: ${e.message}` });
      }

      const symbols = (scanResults?.stocks || [])
        .map(s => s.symbol)
        .filter(Boolean)
        .slice(0, 200); // cap to avoid rate limit issues

      if (symbols.length === 0) {
        return res.json({ stocks: [], fetchedAt: new Date().toISOString() });
      }

      console.log(`  Revisions scan: fetching estimates for ${symbols.length} stocks...`);
      const revisionMap = await batchFetchRevisions(symbols, 5);

      const results = [];
      for (const [symbol, current] of revisionMap) {
        const prior = loadPriorRevisions(db, symbol);
        const score = prior ? scoreRevisions(current, prior) : null;

        // Find the stock in scan results for RS data
        const stock = scanResults.stocks.find(s => s.symbol === symbol);
        const signal = stock && score ? calcRevisionSignal(stock, score) : null;

        // Persist current snapshot
        storeRevisions(db, symbol, current);

        results.push({
          symbol,
          estimates: current,
          revision: score,
          signal,
          rsRank: stock?.rsRank || null,
        });
      }

      // Sort by revision score descending (strong upgrades first)
      results.sort((a, b) => {
        const sa = a.revision?.revisionScore ?? 50;
        const sb = b.revision?.revisionScore ?? 50;
        return sb - sa;
      });

      const response = {
        stocks: results,
        totalFetched: revisionMap.size,
        totalWithRevisions: results.filter(r => r.revision != null).length,
        fetchedAt: new Date().toISOString(),
      };

      cacheSet('revisions:scan', response);
      res.json(response);
    } catch (e) {
      console.error('  Revisions scan error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/revisions/:symbol — single stock revision data
  router.get('/revisions/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      console.log(`  Fetching revisions for ${symbol}...`);

      const current = await fetchEstimateRevisions(symbol);
      if (!current) {
        return res.status(404).json({
          error: `No analyst estimate data for ${symbol} — stock may lack coverage`,
        });
      }

      // Load prior snapshot for comparison
      const prior = loadPriorRevisions(db, symbol);
      const revision = prior ? scoreRevisions(current, prior) : null;

      // Persist current snapshot
      storeRevisions(db, symbol, current);

      // Get RS data if available from recent scan
      let signal = null;
      try {
        const scanResults = await runScan();
        const stock = scanResults?.stocks?.find(s => s.symbol === symbol);
        if (stock && revision) {
          signal = calcRevisionSignal(stock, revision);
        }
      } catch (_) {
        // Scan data not available — skip signal calculation
      }

      console.log(`  Revisions ${symbol}: EPS CY=${current.epsCurrentYear} NY=${current.epsNextYear}` +
        (revision ? ` score=${revision.revisionScore} tier=${revision.tier}` : ' (no prior data)'));

      res.json({
        symbol,
        estimates: current,
        revision,
        signal,
        hasPriorData: prior != null,
      });
    } catch (e) {
      console.error(`  Revisions error ${req.params.symbol}:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/revisions/refresh — force refresh (clear cache, re-fetch)
  router.post('/revisions/refresh', async (req, res) => {
    try {
      const { symbols } = req.body || {};

      if (symbols && Array.isArray(symbols) && symbols.length > 0) {
        // Refresh specific symbols
        const upperSymbols = symbols.map(s => s.toUpperCase()).slice(0, 50);
        console.log(`  Revisions refresh: ${upperSymbols.length} symbols...`);
        const revisionMap = await batchFetchRevisions(upperSymbols, 5);

        // Persist all
        for (const [symbol, data] of revisionMap) {
          storeRevisions(db, symbol, data);
        }

        res.json({
          refreshed: revisionMap.size,
          symbols: [...revisionMap.keys()],
          fetchedAt: new Date().toISOString(),
        });
      } else {
        // Refresh entire universe via scan
        let scanResults;
        try {
          scanResults = await runScan();
        } catch (e) {
          return res.status(500).json({ error: `Scan failed: ${e.message}` });
        }

        const allSymbols = (scanResults?.stocks || [])
          .map(s => s.symbol)
          .filter(Boolean)
          .slice(0, 200);

        console.log(`  Revisions refresh: full universe (${allSymbols.length} stocks)...`);
        const revisionMap = await batchFetchRevisions(allSymbols, 5);

        for (const [symbol, data] of revisionMap) {
          storeRevisions(db, symbol, data);
        }

        // Clear scan cache so next GET /scan returns fresh data
        cacheSet('revisions:scan', null);

        res.json({
          refreshed: revisionMap.size,
          totalUniverse: allSymbols.length,
          fetchedAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error('  Revisions refresh error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
