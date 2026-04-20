// ─── /api/replay/* routes ───────────────────────────────────────────────────
// Signal replay / backtest engine
const express = require('express');
const router  = express.Router();

const {
  BUILT_IN_STRATEGIES,
  getAvailableDateRange,
  runReplay,
  runWalkForward,
  runMonteCarlo,
  compareStrategies,
  getReplayHistory,
  getReplayResult,
  deleteReplayResult,
  saveMCResult,
  getMCHistory,
  getMCResult,
  saveWFResult,
  getWFHistory,
  getWFResult,
} = require('../signals/replay');
const { runBackfill } = require('../signals/backfill');
const { runInstitutionalBackfill } = require('../signals/backfillInstitutional');
const { FULL_UNIVERSE } = require('../../universe');

// ─── Available strategies ─────────────────────────────────────────────────
router.get('/replay/strategies', (req, res) => {
  try {
    const strategies = Object.entries(BUILT_IN_STRATEGIES).map(([key, s]) => ({
      key, ...s,
    }));
    res.json({ strategies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Available data range ─────────────────────────────────────────────────
router.get('/replay/range', (req, res) => {
  try {
    res.json(getAvailableDateRange());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Run replay ───────────────────────────────────────────────────────────
router.post('/replay/run', (req, res) => {
  try {
    const { strategy, tradeMode, params, startDate, endDate, maxPositions, initialCapital, execution, indexName } = req.body;
    if (!strategy || !startDate || !endDate) {
      return res.status(400).json({ error: 'strategy, startDate, and endDate required' });
    }
    const result = runReplay({
      strategy, tradeMode: tradeMode || undefined, params, startDate, endDate,
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
      execution: execution || {},
      indexName: indexName || 'SP500',
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Compare strategies ───────────────────────────────────────────────────
router.post('/replay/compare', (req, res) => {
  try {
    const { strategies, startDate, endDate, maxPositions, initialCapital, tradeMode } = req.body;
    if (!strategies || !startDate || !endDate) {
      return res.status(400).json({ error: 'strategies[], startDate, and endDate required' });
    }
    const result = compareStrategies({
      strategies, startDate, endDate, tradeMode: tradeMode || undefined,
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Walk-forward optimization ────────────────────────────────────────────
router.post('/replay/walk-forward', (req, res) => {
  try {
    const {
      strategy, startDate, endDate,
      trainDays, testDays, paramGrid,
      optimizeMetric, maxPositions, initialCapital, execution,
    } = req.body;
    if (!strategy || !startDate || !endDate) {
      return res.status(400).json({ error: 'strategy, startDate, and endDate required' });
    }
    if (!paramGrid || typeof paramGrid !== 'object') {
      return res.status(400).json({ error: 'paramGrid object required (e.g. { minRS: [70,80,90] })' });
    }
    const result = runWalkForward({
      strategy, startDate, endDate,
      trainDays: trainDays || 120,
      testDays: testDays || 60,
      paramGrid,
      optimizeMetric: optimizeMetric || 'sharpeRatio',
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
      execution: execution || {},
    });
    // Persist WF result
    try {
      result.config = { ...result.config, startDate, endDate };
      const wfId = saveWFResult(result);
      result.id = wfId;
    } catch (_) { /* non-critical */ }
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Monte Carlo simulation ───────────────────────────────────────────────
router.post('/replay/monte-carlo', (req, res) => {
  try {
    const { replayId, trades, iterations, method, positionFraction, initialCapital } = req.body;
    if (replayId == null && (!trades || !trades.length)) {
      return res.status(400).json({ error: 'replayId or trades[] required' });
    }
    const result = runMonteCarlo({
      replayId: replayId != null ? +replayId : null,
      trades: trades || null,
      iterations: iterations || 1000,
      method: method || 'permutation',
      positionFraction: positionFraction != null ? +positionFraction : 0.10,
      initialCapital: initialCapital || 100000,
    });
    // Persist MC result
    try {
      const mcId = saveMCResult(replayId, result);
      result.id = mcId;
    } catch (_) { /* non-critical */ }
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Historical snapshot backfill ─────────────────────────────────────────
// Walks the past N trading days using each universe symbol's 1-year OHLCV
// from the provider layer, recomputes the full signal stack, and persists
// to rs_snapshots so the replay/walk-forward/monte-carlo engines can run on
// real historical data instead of just today's tail.
router.post('/replay/backfill', async (req, res) => {
  try {
    const { lookbackDays = 365, symbols, concurrency = 5 } = req.body || {};
    const useSymbols = Array.isArray(symbols) && symbols.length
      ? symbols
      : Object.keys(FULL_UNIVERSE);
    if (!useSymbols.length) {
      return res.status(400).json({ error: 'no symbols available — provide symbols[] or populate universe' });
    }
    if (lookbackDays < 1 || lookbackDays > 2500) {
      return res.status(400).json({ error: 'lookbackDays must be between 1 and 2500 (Alpaca: ~9 years / Yahoo: 2 years)' });
    }
    const summary = await runBackfill({
      symbols: useSymbols,
      lookbackDays: +lookbackDays,
      concurrency: +concurrency || 5,
    });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── institutional_flow backfill ─────────────────────────────────────────
// Same shape as /replay/backfill but targets the institutional_flow table.
// Runs detectUnusualVolume + detectDarkPoolProxy on truncated bar slices so
// every (symbol, date) in the lookback window gets a flow score the deep_scan
// replay strategy can JOIN against.
router.post('/replay/backfill-institutional', async (req, res) => {
  try {
    const { lookbackDays = 252, symbols, concurrency = 5 } = req.body || {};
    const useSymbols = Array.isArray(symbols) && symbols.length
      ? symbols
      : Object.keys(FULL_UNIVERSE);
    if (!useSymbols.length) {
      return res.status(400).json({ error: 'no symbols available — provide symbols[] or populate universe' });
    }
    if (lookbackDays < 1 || lookbackDays > 2500) {
      return res.status(400).json({ error: 'lookbackDays must be between 1 and 2500' });
    }
    const summary = await runInstitutionalBackfill({
      symbols: useSymbols,
      lookbackDays: +lookbackDays,
      concurrency: +concurrency || 5,
    });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Replay history ───────────────────────────────────────────────────────
router.get('/replay/history', (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const history = getReplayHistory(+limit);
    res.json({ history, count: history.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Monte Carlo history & view (before :id catch-all) ──────────────────
router.get('/replay/mc/history', (req, res) => {
  try {
    const { limit = 10 } = req.query;
    res.json({ history: getMCHistory(+limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/replay/mc/:id', (req, res) => {
  try {
    const result = getMCResult(+req.params.id);
    if (!result) return res.status(404).json({ error: 'MC result not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Walk-Forward history & view ─────────────────────────────────────────
router.get('/replay/wf/history', (req, res) => {
  try {
    const { limit = 10 } = req.query;
    res.json({ history: getWFHistory(+limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/replay/wf/:id', (req, res) => {
  try {
    const result = getWFResult(+req.params.id);
    if (!result) return res.status(404).json({ error: 'WF result not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get specific replay result ───────────────────────────────────────────
router.get('/replay/:id', (req, res) => {
  try {
    const result = getReplayResult(+req.params.id);
    if (!result) return res.status(404).json({ error: 'Replay not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Delete replay result ─────────────────────────────────────────────────
router.delete('/replay/:id', (req, res) => {
  try {
    deleteReplayResult(+req.params.id);
    res.json({ ok: true, deleted: +req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
