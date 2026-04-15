// ─── /api/regime, /api/macro, /api/cycle-auto-detect routes ─────────────────
//
// Two parallel macro layers live here:
//
//   1. /api/macro           — LIVE ETF-proxy regime (Yahoo quotes). Used by
//                             the Dashboard ticker / Market Pulse.
//   2. /api/macro/fred/*    — HISTORICAL FRED series from macro_series
//                             (DGS10, T10Y2Y, CPI, UNRATE, VIX, HY OAS, …).
//                             Used by the Macro tab.
//
// Keeping them side-by-side means the UI can mix real-time proxies with
// true historical macro without the two code paths bleeding into each other.
const express = require('express');
const router  = express.Router();

const { yahooQuote } = require('../data/providers/yahoo');
const { getMarketRegime, autoDetectCycleState } = require('../risk/regime');
const macroFred = require('../signals/macro-fred');

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

// ─── FRED historical macro series ──────────────────────────────────────────
//
// These routes surface the macro_series table populated by
// scripts/fetch-fred.js. All queries use point-in-time semantics where
// relevant — getValueOn / getMacroSnapshot apply the RELEASE_LAG_DAYS shift
// by default so the UI can't accidentally display future-leaked values.

// /api/macro/fred/available — list of series with basic coverage metadata
router.get('/macro/fred/available', (req, res) => {
  try {
    const series = macroFred.getAvailableSeries();
    // Annotate each row with its configured release-lag so the UI can show
    // "what you see here was real-world public by this date" without having
    // to hard-code the table client-side.
    const annotated = series.map(s => ({
      ...s,
      releaseLagDays: macroFred.getReleaseLag(s.series_id),
    }));
    res.json({ series: annotated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// /api/macro/fred/series/:id?start=YYYY-MM-DD&end=YYYY-MM-DD
// Time-series slice for charting. Does NOT apply release-lag (it's the full
// historical record) — use /snapshot for point-in-time, release-aware reads.
router.get('/macro/fred/series/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').toUpperCase();
    if (!id) return res.status(400).json({ error: 'series id required' });
    // Default window: ~5 years back from today. Lets the UI load instantly
    // with a reasonable default while allowing explicit ranges for zooms.
    const today = new Date().toISOString().slice(0, 10);
    const defaultStart = (() => {
      const d = new Date();
      d.setUTCFullYear(d.getUTCFullYear() - 5);
      return d.toISOString().slice(0, 10);
    })();
    const start = req.query.start || defaultStart;
    const end   = req.query.end   || today;
    const rows = macroFred.getSeriesRange(id, start, end);
    const latest = macroFred.getLatest(id);
    res.json({
      seriesId: id,
      start, end,
      releaseLagDays: macroFred.getReleaseLag(id),
      latest: latest || null,
      points: rows,  // [{date, value}, …]
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// /api/macro/fred/snapshot?date=YYYY-MM-DD&ids=DGS10,T10Y2Y,…
// Point-in-time snapshot with release-lag applied per series. Used by the
// Macro tab's "status bar" and by strategy code that wants a consistent
// view of the macro landscape on a given date.
router.get('/macro/fred/snapshot', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const idsParam = req.query.ids;
    const ids = idsParam
      ? String(idsParam).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : null;
    const lagDays = req.query.lagDays != null ? Number(req.query.lagDays) : undefined;
    const opts = Number.isFinite(lagDays) ? { lagDays } : {};
    const snapshot = macroFred.getMacroSnapshot(date, ids, opts);
    res.json({ date, lagApplied: !('lagDays' in opts), values: snapshot });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
