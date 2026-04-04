// ─── /api/replay/* routes ───────────────────────────────────────────────────
// Signal replay / backtest engine
const express = require('express');
const router  = express.Router();

const {
  BUILT_IN_STRATEGIES,
  getAvailableDateRange,
  runReplay,
  compareStrategies,
  getReplayHistory,
  getReplayResult,
  deleteReplayResult,
} = require('../signals/replay');

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
    const { strategy, params, startDate, endDate, maxPositions, initialCapital } = req.body;
    if (!strategy || !startDate || !endDate) {
      return res.status(400).json({ error: 'strategy, startDate, and endDate required' });
    }
    const result = runReplay({
      strategy, params, startDate, endDate,
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Compare strategies ───────────────────────────────────────────────────
router.post('/replay/compare', (req, res) => {
  try {
    const { strategies, startDate, endDate, maxPositions, initialCapital } = req.body;
    if (!strategies || !startDate || !endDate) {
      return res.status(400).json({ error: 'strategies[], startDate, and endDate required' });
    }
    const result = compareStrategies({
      strategies, startDate, endDate,
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Replay history ───────────────────────────────────────────────────────
router.get('/replay/history', (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const history = getReplayHistory(+limit);
    res.json({ history, count: history.length });
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
