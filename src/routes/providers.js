// ─── /api/providers/* routes ────────────────────────────────────────────────
// Data provider health, status, and management
const express = require('express');
const router  = express.Router();

const {
  getProviderHealth, resetProviderHealth, setProviderPriority, getProviderLog,
} = require('../data/providers/manager');

// ─── Provider health status ───────────────────────────────────────────────
router.get('/providers', (req, res) => {
  try {
    const providers = getProviderHealth();
    const primary = providers.find(p => p.available);
    res.json({
      providers,
      primary: primary?.key || 'none',
      configured: providers.filter(p => p.configured).length,
      available: providers.filter(p => p.available).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reset provider health (clear circuit breaker) ────────────────────────
router.post('/providers/:key/reset', (req, res) => {
  try {
    resetProviderHealth(req.params.key);
    res.json({ ok: true, reset: req.params.key });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Change provider priority ─────────────────────────────────────────────
router.post('/providers/:key/priority', (req, res) => {
  try {
    const { index } = req.body;
    if (index === undefined) return res.status(400).json({ error: 'index required' });
    const order = setProviderPriority(req.params.key, index);
    res.json({ ok: true, order });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Provider event log ───────────────────────────────────────────────────
router.get('/providers/log', (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const log = getProviderLog(+limit);
    res.json({ log, count: log.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
