// ─── /api/trade-setups/* routes ──────────────────────────────
const express = require('express');
const router  = express.Router();

const { isSwingCandidate, isPositionCandidate } = require('../signals/candidates');
const { getDB } = require('../data/database');
const { logSignalsBatch } = require('../signals/edge-telemetry');
const { runDeepScan, persistDeepScan } = require('../signals/deep-scan');

module.exports = function(runRSScanFn, anthropic, sectorEtfs) {
  // Batch AI trade briefs
  async function getBatchTradeBriefs(candidates, tradeType, regime) {
    const tickers = candidates.map(s => s.ticker);

    let newsMap = {};
    try {
      const r = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'Financial data. Return ONLY raw JSON, no markdown.',
        messages: [{ role: 'user', content:
          `Search next earnings date and latest news for: ${tickers.join(', ')}
Return ONLY: { "TICKER": { "earningsDate": "Mon DD YYYY or null", "daysToEarnings": N or null, "news": "1 sentence" } }` }],
      });
      const t = r.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      const s = t.indexOf('{'), e = t.lastIndexOf('}');
      if (s !== -1) newsMap = JSON.parse(t.slice(s, e+1));
    } catch(err) { console.warn('News batch:', err.message); }

    const stockData = candidates.map(s => ({
      ticker: s.ticker, price: s.price?.toFixed(2),
      ibdRS: s.rsRank, rsTrend: s.rsTrend?.direction || 'unknown',
      rsVs1m: s.rsTrend?.vs1m, rsVs3m: s.rsTrend?.vs3m,
      swingMomentum: s.swingMomentum,
      vsMA50: s.vsMA50?.toFixed(1), vsMA200: s.vsMA200?.toFixed(1),
      ma50: s.ma50?.toFixed(2), ma200: s.ma200?.toFixed(2),
      atr: s.atr, atrPct: s.atrPct,
      volRatio: s.volumeRatio?.toFixed(2), volumeSurge: s.volumeSurge,
      distFromHigh: ((s.distFromHigh||0)*100).toFixed(1),
      chg1w: s.chg1w?.toFixed(1), chg1m: s.chg1m?.toFixed(1),
      sector: s.sector,
      earningsDate: newsMap[s.ticker]?.earningsDate || null,
      daysToEarnings: newsMap[s.ticker]?.daysToEarnings || null,
      recentNews: newsMap[s.ticker]?.news || null,
    }));

    const holdDesc = tradeType === 'swing' ? '2-10 day swing' : '3-8 week position';
    const r2 = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 3500,
      system: `Professional ${tradeType} trader. Market: ${regime?.regime}. ${regime?.warning||''}. Size multiplier: ${regime?.sizeMultiplier}x. ONLY valid JSON array.`,
      messages: [{ role: 'user', content:
        `Generate ${holdDesc} trade setups using IBD RS (long-term strength) AND swingMomentum (short-term movement) together.

KEY RULES:
- BUY: IBD RS rising OR high + swingMomentum ≥ 60 + no earnings risk + above key MAs
- WATCH: good RS but swingMomentum 45-59 (wait for momentum to pick up)
- AVOID: earnings <14 days, RS falling, swingMomentum <40, or extended >5% above 50MA
- Stops: always at ATR-based level (price - 1.5 × ATR), not arbitrary %
- Targets: use prior resistance or measured move from consolidation
- Mention if volumeSurge=true (institutional breakout signal)

Data: ${JSON.stringify(stockData, null, 1)}

Return JSON array:
[{
  "ticker":"XXX",
  "verdict":"BUY|WATCH|AVOID",
  "thesis":"2 sentences: why RS+momentum combo is compelling",
  "entryZone":"$XXX-$XXX",
  "stopLevel":"$XXX (1.5×ATR below entry)",
  "target1":"$XXX",
  "target2":"$XXX",
  "riskReward":"X:1",
  "holdPeriod":"X-Y days",
  "positionSize":"${regime?.sizeMultiplier||1}x normal (regime-adjusted)",
  "earningsRisk":true/false,
  "earningsDate":"date or null",
  "daysToEarnings":N or null,
  "catalysts":["..."],
  "riskFlags":["..."],
  "rsTrendNote":"RS rising Xpts over 4wks / flat / falling — implication",
  "riskScore":1-10,
  "confidence":"high|medium|low"
}]` }],
    });
    const t2 = r2.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    const clean = t2.replace(/```json|```/g, '').trim();
    const s2 = clean.indexOf('['), e2 = clean.lastIndexOf(']');
    if (s2 === -1) throw new Error('No JSON array in setup response');
    const setups = JSON.parse(clean.slice(s2, e2+1));
    return setups.map(setup => ({
      ...setup,
      earningsDate:   newsMap[setup.ticker]?.earningsDate || null,
      daysToEarnings: newsMap[setup.ticker]?.daysToEarnings || null,
      recentNews:     newsMap[setup.ticker]?.news || null,
      tradeType,
    }));
  }

  // POST /api/trade-setups/scan — unified scan (absorbs legacy Top Picks).
  // Filters via isSwingCandidate/isPositionCandidate, scores with convictionScore
  // (RS + SEPA + VCP + rotation), returns both swingSetup + positionSetup per
  // candidate. AI briefs optional (if anthropic is configured).
  //
  // FRESHNESS GUARANTEE (2026-05-01): the route ALWAYS calls runRSScanFn()
  // to get current quotes — it does NOT trust client-supplied `stocks`.
  // Pre-fix: when the UI passed stale rsData (e.g. 90s old) the deep
  // scan ran on stale prices, so Scanner showed live $X but Trade Setups
  // showed cached $Y for the same ticker.
  //
  // Pre-fix the API accepted optional `stocks` in the body. We retain
  // that ONLY as a SHORTLIST filter (subset of tickers to inspect) —
  // NEVER as the data source.
  router.post('/trade-setups/scan', async (req, res) => {
    const { stocks: shortlist = [], mode = 'both', forceRefresh = false } = req.body;

    // Always refresh quotes server-side. runRSScanFn caches at TTL_QUOTE
    // (60s) so back-to-back scan clicks are cheap; first call after the
    // window walks Yahoo for every symbol. forceRefresh=true busts the
    // cache for users who want guaranteed sub-60s freshness.
    if (forceRefresh) {
      try {
        const { cacheInvalidatePrefix } = require('../data/cache');
        cacheInvalidatePrefix('rs:');
      } catch (_) {}
    }
    const allStocks = await runRSScanFn();

    // If caller supplied a shortlist, filter to those tickers. Otherwise
    // run on the full live universe (the typical Trade Setups flow).
    const stocks = shortlist.length
      ? allStocks.filter(s => shortlist.some(x => (x.ticker || x) === s.ticker))
      : allStocks;

    if (!stocks.length) return res.status(400).json({ error: 'No stocks available — runRSScan returned empty' });

    const scan = await runDeepScan({ stocks, mode, sectorEtfs });

    if (!scan.candidates) {
      const sw = stocks.filter(isSwingCandidate).length;
      const pos = stocks.filter(isPositionCandidate).length;
      return res.json({
        results: [], regime: scan.regime, convictionOverrides: [],
        message: `No candidates matched ${mode} filter. Swing: ${sw} (RS≥70, above 50MA, momentum≥50 + near high/vol surge/strong mom). Pullback: ${pos} (RS≥70, above 200MA, pullback to 50MA zone). Try a different mode.`,
        totalInput: stocks.length, scannedCount: 0,
      });
    }

    const tradeMode = mode === 'both' ? 'swing' : mode;
    const results = scan.results;

    if (anthropic) {
      try {
        const briefs = await getBatchTradeBriefs(results, tradeMode, scan.regime);
        for (const r of results) {
          r.brief = briefs.find(b => b.ticker === r.ticker) || null;
        }
        // AI verdict dominates sort when present
        const order = {BUY:0,WATCH:1,AVOID:2};
        results.sort((a,b) => {
          const av = order[a.brief?.verdict] ?? 3;
          const bv = order[b.brief?.verdict] ?? 3;
          if (av !== bv) return av - bv;
          return (b.convictionScore || 0) - (a.convictionScore || 0);
        });
      } catch (e) {
        console.warn('AI briefs failed (continuing with algo levels):', e.message);
      }
    }

    // Layer 1 telemetry: log every emitted LLM brief so we can calibrate
    // confidence tiers against realized 5/10/20d outcomes.
    try {
      const toLog = [];
      for (const r of results) {
        if (!r.brief) continue;
        toLog.push({
          source: 'trade_setup', symbol: r.ticker, strategy: tradeMode,
          setup_type: r.brief.verdict, verdict: r.brief.verdict,
          confidence: r.brief.confidence, conviction_score: r.convictionScore,
          entry_price: r.price, stop_price: r.brief.stopLevel,
          target1_price: r.brief.target1, target2_price: r.brief.target2,
          rs_rank: r.rsRank, swing_momentum: r.swingMomentum, sepa_score: r.sepaScore,
          stage: r.stage, regime: scan.regime?.regime, atr_pct: r.atrPct,
          horizon_days: tradeMode === 'swing' ? 10 : 30,
          meta: {
            thesis: r.brief.thesis, riskFlags: r.brief.riskFlags,
            catalysts: r.brief.catalysts, earningsRisk: r.brief.earningsRisk,
            daysToEarnings: r.brief.daysToEarnings, riskScore: r.brief.riskScore,
            rsTrend: r.rsTrend?.direction,
          },
        });
      }
      if (toLog.length) logSignalsBatch(toLog);
    } catch (_) { /* telemetry never blocks */ }

    persistDeepScan({
      mode, results, regime: scan.regime,
      scannedCount: scan.candidates, totalInput: scan.totalInput,
    });

    res.json({
      results, regime: scan.regime, hasAI: !!anthropic,
      convictionOverrides: scan.convictionOverrides,
      scannedCount: scan.candidates, totalInput: scan.totalInput,
    });
  });

  // GET /api/trade-setups/cached — retrieve last deep scan results (survives refresh)
  // GET /api/trade-setups/cached?mode=both&fresh=1
  //
  // ?fresh=1 → bypass cache, run a live scan, return the fresh result.
  // Useful for "always fresh on tab click" UI behavior. Caller can also
  // hit POST /trade-setups/scan directly for the same effect; this is
  // sugar that keeps the existing GET endpoint backward-compatible.
  router.get('/trade-setups/cached', async (req, res) => {
    if (req.query.fresh === '1' || req.query.fresh === 'true') {
      try {
        const allStocks = await runRSScanFn();
        const scan = await runDeepScan({ stocks: allStocks, mode: req.query.mode || 'both', sectorEtfs });
        persistDeepScan({
          mode: req.query.mode || 'both',
          results: scan.results,
          regime: scan.regime,
          scannedCount: scan.candidates,
          totalInput: scan.totalInput,
        });
        return res.json({
          results: scan.results, regime: scan.regime, liveRegime: scan.regime,
          regimeStale: false, cached: false, cachedAt: new Date().toISOString(),
          ageMinutes: 0, mode: req.query.mode || 'both',
          scannedCount: scan.candidates, totalInput: scan.totalInput,
          convictionOverrides: scan.convictionOverrides,
        });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }
    try {
      const db = getDB();
      const mode = req.query.mode || null;
      let row;
      if (mode) {
        row = db.prepare(`SELECT * FROM deep_scan_cache WHERE mode = ? ORDER BY created_at DESC LIMIT 1`).get(mode);
      } else {
        row = db.prepare(`SELECT * FROM deep_scan_cache ORDER BY created_at DESC LIMIT 1`).get();
      }
      if (!row) return res.json({ results: [], cached: false, message: 'No cached scan results' });

      const results = JSON.parse(row.results);
      const regime = row.regime ? JSON.parse(row.regime) : null;
      const ageMinutes = Math.round((Date.now() - new Date(row.created_at + 'Z').getTime()) / 60000);

      // Surface live regime alongside the cached one so the UI can warn
      // when they differ — previously a NEUTRAL-cached scan kept showing
      // conviction-override badges even after regime improved to BULL.
      // If they differ, regimeStale=true and the UI prompts a refresh.
      let liveRegime = null;
      let regimeStale = false;
      try {
        const { getMarketRegime } = require('../risk/regime');
        const live = await getMarketRegime();
        liveRegime = live ? { regime: live.regime, sizeMultiplier: live.sizeMultiplier, color: live.color } : null;
        if (live?.regime && regime?.regime && live.regime !== regime.regime) {
          regimeStale = true;
        }
      } catch (_) { /* fall back to cached only */ }

      res.json({
        results,
        regime,
        liveRegime,
        regimeStale,
        cached: true,
        cachedAt: row.created_at,
        ageMinutes,
        mode: row.mode,
        scannedCount: row.scanned_count,
        totalInput: row.total_input,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/trade-setups/brief
  router.post('/trade-setups/brief', async (req, res) => {
    if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
    const { stock, mode='swing' } = req.body;
    if (!stock?.ticker) return res.status(400).json({ error: 'stock.ticker required' });
    try {
      const regime = await getMarketRegime();
      const briefs = await getBatchTradeBriefs([stock], mode, regime);
      res.json({ ticker: stock.ticker, brief: briefs[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/trade-setup
  router.post('/trade-setup', async (req, res) => {
    try {
      const { ticker, mode = 'swing' } = req.body;
      if (!ticker) return res.status(400).json({ error: 'ticker required' });
      const stocks = await runRSScanFn();
      const stock  = stocks.find(s => s.ticker === ticker.toUpperCase());
      if (!stock) return res.status(404).json({ error: `${ticker} not in universe` });
      const setup = computeTradeSetup(stock, mode);
      res.json({
        ticker: stock.ticker, price: stock.price,
        ibdRS: stock.rsRank, swingMomentum: stock.swingMomentum,
        atr: stock.atr, atrPct: stock.atrPct,
        vsMA50: stock.vsMA50, vsMA200: stock.vsMA200,
        rsTrend: stock.rsTrend?.direction,
        setup, mode,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
