// ─── /api/daily-plan/* routes ─────────────────────────────────────────────
//
// Endpoints for the Daily Plan tab — the action-loop interface that
// converts tier-1 watchlist names into binary daily decisions.
//
//   GET  /daily-plan/today
//        → today's plan with each row's current decision state +
//          live decoration (price, RS, insider flags) from the scanner.
//
//   POST /daily-plan/today/ensure
//        body: { tier1Items: [{symbol, convictionAtDecision, pivotPrice, ...}] }
//        → idempotently creates 'pending' rows for tier-1 names not
//          yet in today's plan. Caller passes the tier-1 from the
//          (client-side) Watchlist localStorage.
//
//   POST /daily-plan/decision
//        body: { symbol, decision: 'submit'|'wait'|'skip', skipReason?, pivotPrice?, priceAtDecision? }
//        → records the user's decision. After 10:30 AM ET pending rows
//          can still be decided but get logged with `decided_at` past
//          cutoff (counts as adherence — late but not auto).
//
//   GET  /daily-plan/yesterday
//        → yesterday's plan + behavioral feedback (missed winners,
//          skipped losers).

const express = require('express');
const router  = express.Router();

const {
  ensureTodayPlan,
  recordDecision,
  removeFromPlan,
  autoSkipExpiredPending,
  getTodayPlan,
  getYesterdaysOutcomes,
  getAdherenceBaseline,
  getWeeklyReview,
} = require('../data/daily-decisions-store');

// We need the latest scan results to decorate decision rows with live
// price, RS rank, conviction, insider flags. Same source the Scanner /
// Trade Setups tabs use. The factory is wired in server.js the same
// way (UNIVERSE/SECTOR_MAP closure pattern).
//
// Pre-fix: routes/scan.js builds rsData on each call which is expensive;
// we read from rs:full cache instead (60s TTL — fresh enough for the
// Daily Plan view).

module.exports = function() {
  // Helper: build a Map<symbol, scannerRow> from the cached RS scan.
  // Returns null if no scan has run yet (Daily Plan still works, just
  // without live price decoration).
  function _liveByTicker() {
    try {
      const { cacheGet, TTL_QUOTE } = require('../data/cache');
      const cached = cacheGet('rs:full', TTL_QUOTE);
      if (!Array.isArray(cached)) return null;
      const m = new Map();
      for (const s of cached) m.set(s.ticker, s);
      return m;
    } catch (_) { return null; }
  }

  router.get('/daily-plan/today', (req, res) => {
    try {
      // Cutoff sweep first — flips lingering 'pending' to 'auto_skip' if
      // we're past 10:30 AM ET. Idempotent, cheap, safe to call on every
      // GET. The cron also calls this independently for users not
      // viewing the page.
      autoSkipExpiredPending();
      const plan = getTodayPlan(_liveByTicker());
      // Attach 30-day rolling baseline so the UI can color today's
      // adherence relative to YOUR history, not against arbitrary
      // opinion-coded thresholds.
      plan.baseline = getAdherenceBaseline({ days: 30 });
      res.json(plan);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/daily-plan/today/ensure', (req, res) => {
    try {
      const tier1Items = Array.isArray(req.body?.tier1Items) ? req.body.tier1Items : [];
      const result = ensureTodayPlan(tier1Items);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/daily-plan/decision', (req, res) => {
    try {
      const { symbol, decision, skipReason, pivotPrice, priceAtDecision } = req.body || {};
      if (!symbol || !decision) {
        return res.status(400).json({ error: 'symbol and decision required' });
      }
      const result = recordDecision(symbol, decision, { skipReason, pivotPrice, priceAtDecision });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // DELETE /api/daily-plan/today/:symbol — pull a row off today's plan.
  // Used when the user demotes a name from tier-1 to tier-2/3 in the
  // Watchlist after the daily plan was already seeded for that name.
  // Refuses to delete already-decided rows (preserves journal history).
  router.delete('/daily-plan/today/:symbol', (req, res) => {
    try {
      const result = removeFromPlan(req.params.symbol);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/daily-plan/yesterday', (req, res) => {
    try {
      const out = getYesterdaysOutcomes(_liveByTicker());
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Weekly review endpoint — aggregates the past 7 days of decisions
  // and runs behavioral pattern detection (skip-theme clustering,
  // day-of-week variance, sector skew, conviction-bucket calibration).
  // Optional ?days=14 to widen the window.
  router.get('/daily-plan/weekly-review', (req, res) => {
    try {
      const lookbackDays = Math.max(1, Math.min(30, parseInt(req.query.days) || 7));
      const review = getWeeklyReview(_liveByTicker(), { lookbackDays });
      res.json(review);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Live trail-state endpoints — surface the live MA-trail computation
  // that the EOD cron writes to position_trail_state. Daily Plan tab
  // reads these to show the morning "EXITS PENDING" + "STOPS TO RAISE"
  // panels — the bridge between backtest strategy and live execution.
  router.get('/daily-plan/trail-state', (req, res) => {
    try {
      const {
        getAllPositionTrailStates,
        getActiveExitSignals,
        getStopRaiseSuggestions,
      } = require('../data/trail-state-store');
      res.json({
        positions:    getAllPositionTrailStates(),
        exitSignals:  getActiveExitSignals(),
        stopRaises:   getStopRaiseSuggestions(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual trigger — lets the user (or a test) force a trail-state
  // recompute outside the cron schedule. Useful when bars are
  // backfilled mid-day or when verifying the workflow before EOD.
  router.post('/daily-plan/trail-state/recompute', (req, res) => {
    try {
      const { updateAllTrailStates } = require('../data/trail-state-store');
      const result = updateAllTrailStates();
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
