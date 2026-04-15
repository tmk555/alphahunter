// ─── /api/rs-scan and /api/leaders-laggards routes ──────────────────────────
const express = require('express');
const router  = express.Router();

const { runRSScan } = require('../scanner');
const { getRSTrend } = require('../signals/rs');
const { loadHistory, RS_HISTORY } = require('../data/store');
const { calcConviction } = require('../signals/conviction');
const pitUniverse = require('../signals/pit-universe');
const { getActiveUniverseForDate } = require('../signals/universe-tracker');

function loadRSHistory() { return loadHistory(RS_HISTORY); }

module.exports = function(UNIVERSE, SECTOR_MAP) {
  // /api/rs-scan
  router.get('/rs-scan', async (req, res) => {
    try {
      const stocks  = await runRSScan(UNIVERSE, SECTOR_MAP);
      const history = loadRSHistory();
      const withTrend = stocks.map(s => {
        const rsTrend = getRSTrend(s.ticker, history);
        const { convictionScore, reasons: convictionReasons } = calcConviction(s, rsTrend);
        return { ...s, rsTrend, convictionScore, convictionReasons };
      });
      const spyStock = withTrend.find(s => s.ticker === 'SPY');
      const spy3m = spyStock?.chg3m ?? null;
      const final = spy3m != null
        ? withTrend.map(s => ({ ...s, vsSPY3m: s.chg3m != null ? +(s.chg3m - spy3m).toFixed(2) : null }))
        : withTrend;
      res.json({ stocks: final, universeSize: final.length, spy3m });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/universe/as-of?date=YYYY-MM-DD&index=SP500
  //
  // Point-in-time universe membership lookup. Used by the Scanner tab's
  // "as-of date" picker to filter live scan results down to symbols that
  // were actually in the index on that date — a lightweight survivorship-
  // bias control for the live view.
  //
  // Resolution order matches universe-tracker.getActiveUniverseForDate:
  //   1. pit-universe (universe_membership table, index reconstitution)
  //   2. universe_mgmt (internal add/remove tracking)
  //   3. rs_snapshots (existence inference from historical price rows)
  //
  // When any layer is non-empty we also report `source` so the UI can warn
  // the user if only the fallback is available (e.g. "using rs_snapshots —
  // PIT seed not yet imported").
  router.get('/universe/as-of', (req, res) => {
    try {
      const date = req.query.date;
      if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      const indexName = String(req.query.index || 'SP500').toUpperCase();

      // Probe each layer independently so we can report which one answered.
      let source = null;
      let members = [];
      try {
        const pit = pitUniverse.getMembersOn(date, indexName);
        if (pit && pit.length > 0) { members = pit; source = 'pit_membership'; }
      } catch (_) { /* table missing on older DBs */ }

      if (!members.length) {
        // Let the tracker's full fallback chain run and tag the result.
        const fallback = getActiveUniverseForDate(date, indexName);
        if (fallback && fallback.length > 0) {
          members = fallback;
          // If we got here, PIT was empty/missing; tracker will have hit
          // universe_mgmt or rs_snapshots — we can't distinguish cleanly,
          // but "fallback" is accurate enough for a UI warning.
          source = 'fallback';
        }
      }

      // Coverage metadata — helps the UI surface "this index has no data
      // before 2015" without the user having to guess.
      let coverage = null;
      try { coverage = pitUniverse.getCoverage(indexName); } catch (_) {}

      res.json({
        date,
        index: indexName,
        source,
        count: members.length,
        members,
        coverage,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/leaders-laggards
  router.get('/leaders-laggards', async (req, res) => {
    try {
      const stocks  = await runRSScan(UNIVERSE, SECTOR_MAP);
      const history = loadRSHistory();
      const all = stocks.map(s => ({ ...s, rsTrend: getRSTrend(s.ticker, history) }));
      const leaders  = all.filter(s => s.vsMA50 != null && s.vsMA50 > 0).sort((a,b) => b.rsRank-a.rsRank).slice(0,15);
      const lSet     = new Set(leaders.map(s => s.ticker));
      const laggards = all.filter(s => !lSet.has(s.ticker)).sort((a,b) => a.rsRank-b.rsRank).slice(0,15);
      res.json({ leaders, laggards });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Phase 2: Intraday Entry Timing ──────────────────────────────────────────

  router.get('/intraday/:symbol', async (req, res) => {
    try {
      const { getIntradayBars } = require('../data/providers/manager');
      const { getIntradaySignals } = require('../signals/intraday');

      const symbol = req.params.symbol.toUpperCase();
      const timespan = req.query.timespan || 'minute';
      const multiplier = parseInt(req.query.multiplier) || 5;

      // Default to today
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const from = req.query.from || today;
      const to = req.query.to || today;

      const bars = await getIntradayBars(symbol, timespan, multiplier, from, to);
      if (!bars?.length) return res.json({ error: 'No intraday data available', symbol });

      const signals = getIntradaySignals(bars);
      res.json({ symbol, timespan, multiplier, barCount: bars.length, ...signals });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/intraday/:symbol/timing', async (req, res) => {
    try {
      const { getIntradayBars } = require('../data/providers/manager');
      const { getIntradaySignals, evaluateEntryTiming } = require('../signals/intraday');

      const symbol = req.params.symbol.toUpperCase();
      const entryPrice = parseFloat(req.query.entry) || null;
      const side = req.query.side || 'buy';

      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const bars = await getIntradayBars(symbol, 'minute', 5, today, today);
      if (!bars?.length) return res.json({ quality: 'unknown', score: 0, reason: 'No intraday data' });

      const signals = getIntradaySignals(bars);
      const price = entryPrice || bars[bars.length - 1]?.close;
      const timing = evaluateEntryTiming(signals, price, side);
      res.json({ symbol, ...timing, signals });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
