// ─── /api/regime, /api/macro, /api/cycle-auto-detect routes ─────────────────
const express = require('express');
const router  = express.Router();

const { yahooQuote } = require('../data/providers/yahoo');
const { getMarketRegime, autoDetectCycleState } = require('../risk/regime');

const MACRO_SYMBOLS = [
  {t:'SPY',n:'S&P 500'},{t:'QQQ',n:'Nasdaq 100'},{t:'IWM',n:'Russell 2000'},
  {t:'^VIX',n:'VIX'},{t:'TLT',n:'20yr Bond'},{t:'GLD',n:'Gold'},
  {t:'UUP',n:'US Dollar'},{t:'USO',n:'Crude Oil'},{t:'^TNX',n:'10Y Yield'},{t:'^IRX',n:'3M Yield'},
];

// /api/regime
router.get('/regime', async (req, res) => {
  try { res.json(await getMarketRegime()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// /api/macro
router.get('/macro', async (req, res) => {
  try {
    const quotes = await yahooQuote(MACRO_SYMBOLS.map(m => m.t));
    const macro  = quotes.map(q => {
      const meta = MACRO_SYMBOLS.find(m => m.t === q.symbol) || {};
      return { symbol: q.symbol, name: meta.n, price: q.regularMarketPrice,
               chg1d: q.regularMarketChangePercent, w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
               ma50: q.fiftyDayAverage, ma200: q.twoHundredDayAverage };
    });
    const t10 = macro.find(r => r.symbol==='^TNX'), t3m = macro.find(r => r.symbol==='^IRX');
    const spread = t10?.price && t3m?.price ? +(t10.price - t3m.price).toFixed(2) : null;
    const regime = await getMarketRegime();
    res.json({ macro, yieldSpread: spread, regime });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// /api/cycle-auto-detect
router.get('/cycle-auto-detect', async (req, res) => {
  try {
    const result = await autoDetectCycleState();
    if (!result) return res.status(500).json({ error: 'Could not detect cycle state' });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
