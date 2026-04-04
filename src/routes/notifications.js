// ─── /api/notifications/* routes ────────────────────────────────────────────
// Notification channel management, delivery log, test
const express = require('express');
const router  = express.Router();

const {
  getNotificationChannels, getEnabledChannels,
  createNotificationChannel, updateNotificationChannel, deleteNotificationChannel,
  testChannel,
  getDeliveryLog, getDeliveryStats,
  getAvailableChannels,
} = require('../notifications/channels');

// ─── Available channel types ──────────────────────────────────────────────
router.get('/notifications/channels/available', (req, res) => {
  try {
    res.json({ channels: getAvailableChannels() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Configured channels ──────────────────────────────────────────────────
router.get('/notifications/channels', (req, res) => {
  try {
    const channels = getNotificationChannels();
    res.json({ channels, count: channels.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Create channel ───────────────────────────────────────────────────────
router.post('/notifications/channels', (req, res) => {
  try {
    const channel = createNotificationChannel(req.body);
    res.json(channel);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Update channel ───────────────────────────────────────────────────────
router.put('/notifications/channels/:id', (req, res) => {
  try {
    const channel = updateNotificationChannel(+req.params.id, req.body);
    res.json(channel);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Delete channel ───────────────────────────────────────────────────────
router.delete('/notifications/channels/:id', (req, res) => {
  try {
    deleteNotificationChannel(+req.params.id);
    res.json({ ok: true, deleted: +req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Test channel ─────────────────────────────────────────────────────────
router.post('/notifications/channels/:id/test', async (req, res) => {
  try {
    const results = await testChannel(+req.params.id);
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Delivery log ─────────────────────────────────────────────────────────
router.get('/notifications/log', (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const log = getDeliveryLog(+limit);
    res.json({ log, count: log.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Delivery stats ───────────────────────────────────────────────────────
router.get('/notifications/stats', (req, res) => {
  try {
    res.json({ stats: getDeliveryStats() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
