// ─── /api/alerts/* routes ───────────────────────────────────────────────────
// Alert subscriptions, fired alerts, manual trigger
const express = require('express');
const router  = express.Router();

const {
  createAlert, createPriceAlert, createVCPPivotAlert,
  getActiveAlerts, deactivateAlert,
  checkAlerts, getRecentAlerts, acknowledgeAlert,
} = require('../broker/alerts');
const { yahooQuote } = require('../data/providers/yahoo');

module.exports = function(db) {
  // ─── Fired alerts log ─────────────────────────────────────────────────────
  router.get('/alerts', (req, res) => {
    try {
      const { limit = 50 } = req.query;
      const alerts = getRecentAlerts(+limit);
      res.json({ alerts, count: alerts.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Active subscriptions ─────────────────────────────────────────────────
  router.get('/alerts/subscriptions', (req, res) => {
    try {
      const { symbol } = req.query;
      const subs = getActiveAlerts(symbol);
      res.json({ subscriptions: subs, count: subs.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Create alert subscription ────────────────────────────────────────────
  router.post('/alerts/subscriptions', (req, res) => {
    try {
      const { symbol, alert_type, trigger_price, direction, webhook_url, message } = req.body;
      if (!symbol || !trigger_price || !direction) {
        return res.status(400).json({ error: 'symbol, trigger_price, and direction required' });
      }

      let alert;
      if (alert_type === 'vcp_pivot') {
        alert = createVCPPivotAlert(symbol, trigger_price);
      } else {
        alert = createPriceAlert(symbol, trigger_price, direction, message);
      }
      res.json(alert);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Deactivate subscription ──────────────────────────────────────────────
  router.delete('/alerts/subscriptions/:id', (req, res) => {
    try {
      deactivateAlert(+req.params.id);
      res.json({ ok: true, deactivated: +req.params.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Manual alert check (for testing) ─────────────────────────────────────
  router.post('/alerts/check', async (req, res) => {
    try {
      const active = getActiveAlerts();
      if (!active.length) return res.json({ message: 'No active alert subscriptions', fired: [] });

      const symbols = [...new Set(active.map(a => a.symbol))];
      const quotes = await yahooQuote(symbols);
      const currentPrices = {};
      for (const q of quotes) {
        if (q.regularMarketPrice) currentPrices[q.symbol] = q.regularMarketPrice;
      }

      const fired = await checkAlerts(currentPrices);
      res.json({
        checked: active.length,
        symbolsChecked: symbols.length,
        fired: fired.length,
        firedAlerts: fired,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Acknowledge fired alert ──────────────────────────────────────────────
  router.put('/alerts/:id/acknowledge', (req, res) => {
    try {
      acknowledgeAlert(+req.params.id);
      res.json({ ok: true, acknowledged: +req.params.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
