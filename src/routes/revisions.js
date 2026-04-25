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

  // Helper: read the rolled-up score the daily revision_scan job persisted.
  // Used as a fallback when Yahoo's live estimate fetch fails (weekend
  // throttling, off-hours quirks, ticker without coverage). Without this,
  // the Scanner row could show a revisionScore from yesterday's job while
  // the Levels-tab panel silently disappeared because /api/revisions/:sym
  // returned 404 — exactly the divergence the user reported for TXN on
  // 2026-04-25 (Saturday).
  function loadCachedRevisionScore(symbol) {
    try {
      const row = db.prepare(`
        SELECT date, revision_score, direction, tier,
               eps_current_yr_chg, eps_next_yr_chg, rev_chg, acceleration
        FROM revision_scores
        WHERE symbol = ?
        ORDER BY date DESC LIMIT 1
      `).get(symbol);
      if (!row || row.revision_score == null) return null;
      return {
        revisionScore: row.revision_score,
        direction:     row.direction,
        tier:          row.tier,
        epsCurrentYrChg: row.eps_current_yr_chg,
        epsNextYrChg:    row.eps_next_yr_chg,
        revChg:          row.rev_chg,
        acceleration:    row.acceleration,
        cachedFromDate:  row.date,  // marker so the UI can show "as of YYYY-MM-DD"
      };
    } catch (_) { return null; }
  }

  // GET /api/revisions/:symbol — single stock revision data
  router.get('/revisions/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      console.log(`  Fetching revisions for ${symbol}...`);

      const current = await fetchEstimateRevisions(symbol);

      // Live-fetch failed: try the daily-job's cached score so the Levels
      // panel can still surface SOMETHING that matches the Scanner row.
      // 200 with `liveDataFailed: true` lets the UI render the badge from
      // cache + a small "as of X" label. Old behavior was a 404 → silent
      // empty panel even though revision_scores had the answer.
      if (!current) {
        const cached = loadCachedRevisionScore(symbol);
        if (cached) {
          console.log(`  Revisions ${symbol}: live fetch failed, served cached score=${cached.revisionScore} (as of ${cached.cachedFromDate})`);
          return res.json({
            symbol,
            estimates: null,
            revision: cached,
            signal: null,
            hasPriorData: true,
            liveDataFailed: true,
            source: 'revision_scores_cache',
          });
        }
        return res.status(404).json({
          error: `No analyst estimate data for ${symbol} — stock may lack coverage and no cached score is available`,
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

      // If the live fetch succeeded but there's no prior (first-ever snapshot),
      // serve the daily-job cached score as a stop-gap — Levels panel
      // otherwise hides until tomorrow's job pulls a second snapshot.
      let outRevision = revision;
      let source = 'live';
      if (!revision) {
        const cached = loadCachedRevisionScore(symbol);
        if (cached) {
          outRevision = cached;
          source = 'revision_scores_cache';
        }
      }

      console.log(`  Revisions ${symbol}: EPS CY=${current.epsCurrentYear} NY=${current.epsNextYear}` +
        (outRevision ? ` score=${outRevision.revisionScore} tier=${outRevision.tier} (${source})` : ' (no prior data, no cached score)'));

      res.json({
        symbol,
        estimates: current,
        revision: outRevision,
        signal,
        hasPriorData: prior != null,
        source,
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
