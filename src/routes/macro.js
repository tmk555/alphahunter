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

// Route through the manager cascade so the Dashboard macro strip survives a
// single-provider outage. Polygon/FMP both populate the 52W / 50D MA / 200D MA
// fields this route reads, so the shape is compatible with Yahoo fallthrough.
const { getQuotes, getHistory } = require('../data/providers/manager');
const { getMarketRegime, autoDetectCycleState } = require('../risk/regime');
const macroFred = require('../signals/macro-fred');

const MACRO_SYMBOLS = [
  {t:'SPY',n:'S&P 500'},{t:'QQQ',n:'Nasdaq 100'},{t:'IWM',n:'Russell 2000'},
  // Index futures — Yahoo's =F suffix convention. Useful as overnight/pre-open
  // tape since futures trade ~23 hours vs cash indices' 6.5 hours.
  {t:'ES=F',n:'S&P Fut'},{t:'NQ=F',n:'Nasdaq Fut'},{t:'RTY=F',n:'Russell Fut'},
  {t:'^VIX',n:'VIX'},{t:'TLT',n:'20yr Bond'},{t:'GLD',n:'Gold'},
  {t:'UUP',n:'US Dollar'},{t:'USO',n:'Crude Oil'},{t:'^TNX',n:'10Y Yield'},{t:'^IRX',n:'3M Yield'},
];

// Extra symbols fetched for macro overlay sparklines only (not shown as tiles)
const OVERLAY_SYMBOLS = ['HYG', 'LQD', 'SHY', 'XLI'];

// /api/regime
router.get('/regime', async (req, res) => {
  try { res.json(await getMarketRegime()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// /api/macro
router.get('/macro', async (req, res) => {
  try {
    const quotes = await getQuotes(MACRO_SYMBOLS.map(m => m.t));

    // Fetch up to 1 year (252 trading days) of history per symbol in parallel
    // Client slices down to 5D / 1M / 3M / 1Y as the user picks a period.
    // Cached 23h — first call is the only expensive one.
    const allSymbols = [...MACRO_SYMBOLS.map(m => m.t), ...OVERLAY_SYMBOLS];
    const histories = await Promise.all(
      allSymbols.map(async sym => {
        try {
          const closes = await getHistory(sym);
          return { symbol: sym, history: (closes || []).slice(-252) };
        } catch (_) { return { symbol: sym, history: [] }; }
      })
    );
    const histMap = Object.fromEntries(histories.map(h => [h.symbol, h.history]));

    const macro = quotes.map(q => {
      const meta = MACRO_SYMBOLS.find(m => m.t === q.symbol) || {};
      return { symbol: q.symbol, name: meta.n, price: q.regularMarketPrice,
               chg1d: q.regularMarketChangePercent, w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
               ma50: q.fiftyDayAverage, ma200: q.twoHundredDayAverage,
               history: histMap[q.symbol] || [] };
    });

    const t10 = macro.find(r => r.symbol==='^TNX'), t3m = macro.find(r => r.symbol==='^IRX');
    const spread = t10?.price && t3m?.price ? +(t10.price - t3m.price).toFixed(2) : null;

    // Helper to align two series and compute ratio/spread per bar
    const alignPair = (a, b, fn) => {
      if (!a?.length || !b?.length) return [];
      const len = Math.min(a.length, b.length);
      const oa = a.length - len, ob = b.length - len;
      const out = [];
      for (let i = 0; i < len; i++) {
        const v = fn(a[i+oa], b[i+ob]);
        if (v != null && !isNaN(v)) out.push(+v.toFixed(4));
      }
      return out;
    };

    // Build yield curve spread history (10Y - 3M)
    const spreadHistory = alignPair(histMap['^TNX'], histMap['^IRX'], (x,y) => x - y);

    // Build 30-day sparkline series for each macro overlay component
    const overlayHistory = {
      yieldCurve:   spreadHistory,                                                                              // 10Y - 3M spread
      creditSpread: alignPair(histMap['HYG'], histMap['LQD'], (h,l) => h/l),                                    // HYG/LQD ratio (higher = risk-on)
      dollar:       histMap['UUP'] || [],                                                                        // UUP price
      commodities:  alignPair(histMap['USO'], histMap['GLD'], (o,g) => (o+g)/2),                                // USO+GLD avg (fallback to USO)
      ismProxy:     alignPair(histMap['XLI'], histMap['SPY'], (x,s) => x/s),                                    // XLI/SPY ratio
      intermarket:  histMap['SPY'] || [],                                                                        // SPY proxy
    };
    // Fallbacks when paired series are empty
    if (!overlayHistory.commodities.length) overlayHistory.commodities = histMap['USO'] || [];

    const regime = await getMarketRegime();
    res.json({ macro, yieldSpread: spread, spreadHistory, overlayHistory, regime });
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
