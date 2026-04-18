// ─── /api/telemetry/* — Edge Telemetry (Layer 1) ───────────────────────────
// Read-only views over signal_outcomes plus a manual-trigger for the closer.

const express = require('express');
const router = express.Router();

const { listSignals, summary, getSignal } = require('../signals/edge-telemetry');
const {
  fullReport,
  strategyMetrics,
  sourceMetrics,
  calibrationByConfidenceTier,
  brierScore,
  degradationMultipliers,
  loadResolved,
} = require('../signals/calibration');
const { runOutcomeCloser } = require('../signals/edge-closer');

// GET /api/telemetry/summary — headline numbers for dashboard card
router.get('/telemetry/summary', (req, res) => {
  try {
    const since = req.query.since || null;
    res.json({ summary: summary({ since }), since });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/telemetry/signals — paged list with filters
router.get('/telemetry/signals', (req, res) => {
  try {
    const rows = listSignals({
      source: req.query.source || null,
      strategy: req.query.strategy || null,
      symbol: req.query.symbol || null,
      status: req.query.status || null,
      since: req.query.since || null,
      limit: Math.min(+req.query.limit || 200, 1000),
      offset: +req.query.offset || 0,
    });
    res.json({ rows, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/telemetry/signals/:id — single row detail
router.get('/telemetry/signals/:id', (req, res) => {
  try {
    const row = getSignal(+req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/telemetry/calibration — Brier + reliability curve
router.get('/telemetry/calibration', (req, res) => {
  try {
    const since = req.query.since || null;
    const source = req.query.source || null;
    const strategy = req.query.strategy || null;
    const rows = loadResolved({ since, source, strategy });
    res.json({
      brier: brierScore(rows),
      byTier: calibrationByConfidenceTier(rows),
      sampleSize: rows.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/telemetry/strategies — per-strategy metrics table
router.get('/telemetry/strategies', (req, res) => {
  try {
    res.json({
      strategies: strategyMetrics({
        since: req.query.since || null,
        source: req.query.source || null,
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/telemetry/sources — per-source metrics (trade_setup vs staged_order)
router.get('/telemetry/sources', (req, res) => {
  try {
    res.json({ sources: sourceMetrics({ since: req.query.since || null }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/telemetry/degradation — auto-degradation multipliers (advisory)
router.get('/telemetry/degradation', (req, res) => {
  try {
    res.json({
      multipliers: degradationMultipliers({
        rolling: +req.query.rolling || 50,
        since: req.query.since || null,
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/telemetry/report — consolidated dashboard payload
router.get('/telemetry/report', (req, res) => {
  try {
    res.json(fullReport({
      since: req.query.since || null,
      source: req.query.source || null,
      rolling: +req.query.rolling || 50,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/telemetry/close-now — run the outcome closer immediately
router.post('/telemetry/close-now', async (req, res) => {
  try {
    const result = await runOutcomeCloser({
      minAgeDays: +req.body?.minAgeDays || 5,
      limit: Math.min(+req.body?.limit || 500, 5000),
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
