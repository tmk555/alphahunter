// ─── /api/trade-setups/* routes ──────────────────────────────
const express = require('express');
const router  = express.Router();

const { isSwingCandidate, isPositionCandidate, computeTradeSetup } = require('../signals/candidates');
const { getMarketRegime } = require('../risk/regime');

module.exports = function(runRSScanFn, anthropic) {
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

  // POST /api/trade-setups/scan
  router.post('/trade-setups/scan', async (req, res) => {
    const { stocks = [], mode = 'swing' } = req.body;
    if (!stocks.length) return res.status(400).json({ error: 'No stocks provided' });

    const filter = mode==='swing' ? isSwingCandidate : mode==='position' ? isPositionCandidate
                 : s => isSwingCandidate(s)||isPositionCandidate(s);
    const candidates = stocks.filter(filter).slice(0, 20);
    const regime = await getMarketRegime();

    if (!candidates.length) {
      const sw = stocks.filter(isSwingCandidate).length, pos = stocks.filter(isPositionCandidate).length;
      return res.json({ results:[], regime,
        message:`No candidates matched. Swing: ${sw} stocks (RS≥70+SwingMom≥55+within 7% of high+vol≥1.1x). Position: ${pos} stocks (RS≥65+above 200MA).`,
        totalInput: stocks.length, scannedCount: 0 });
    }

    const tradeMode = mode==='both' ? 'swing' : mode;
    const results = candidates.map(s => ({
      ...s,
      algoSetup: computeTradeSetup(s, tradeMode),
      brief: null,
    }));

    if (anthropic) {
      try {
        const briefs = await getBatchTradeBriefs(candidates, tradeMode, regime);
        for (const r of results) {
          r.brief = briefs.find(b => b.ticker === r.ticker) || null;
        }
      } catch(e) {
        console.warn('AI briefs failed (continuing with algo levels):', e.message);
      }
    }

    const order = {BUY:0,WATCH:1,AVOID:2};
    results.sort((a,b) => {
      const av = order[a.brief?.verdict] ?? 3;
      const bv = order[b.brief?.verdict] ?? 3;
      return av !== bv ? av - bv : b.rsRank - a.rsRank;
    });

    res.json({ results, regime, hasAI: !!anthropic, scannedCount: candidates.length, totalInput: stocks.length });
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
