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

// ─── Morning Brief — on-demand trigger ────────────────────────────────────
// GET /api/notifications/morning-brief?deliver=true
// Returns the assembled brief. If deliver=true, also pushes to all channels.
router.get('/notifications/morning-brief', async (req, res) => {
  try {
    const { assembleMorningBrief } = require('../notifications/briefs');
    const brief = await assembleMorningBrief();

    if (req.query.deliver === 'true') {
      const { deliverAlert, getEnabledChannels } = require('../notifications/channels');
      let channels = getEnabledChannels('morning_brief');
      // Env fallback
      if (!channels.length) {
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
          channels.push({ channel: 'telegram', config: { bot_token: process.env.TELEGRAM_BOT_TOKEN, chat_id: process.env.TELEGRAM_CHAT_ID } });
        if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN)
          channels.push({ channel: 'pushover', config: { user_key: process.env.PUSHOVER_USER_KEY, app_token: process.env.PUSHOVER_APP_TOKEN } });
      }
      const alert = {
        type: 'morning_brief', symbol: 'PORTFOLIO', message: brief.text,
        html_message: brief.html, current_price: 0, trigger_price: 0,
        timestamp: new Date().toISOString(),
      };
      const results = channels.length ? await deliverAlert(alert, channels) : [];
      return res.json({ brief, delivery: { channels: results.length, delivered: results.filter(r => r.delivered).length } });
    }

    res.json({ brief });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Weekly Digest — on-demand trigger ────────────────────────────────────
// GET /api/notifications/weekly-digest?deliver=true
router.get('/notifications/weekly-digest', async (req, res) => {
  try {
    const { assembleWeeklyDigest } = require('../notifications/briefs');
    const digest = await assembleWeeklyDigest();

    if (req.query.deliver === 'true') {
      const { deliverAlert, getEnabledChannels } = require('../notifications/channels');
      let channels = getEnabledChannels('weekly_digest');
      if (!channels.length) {
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
          channels.push({ channel: 'telegram', config: { bot_token: process.env.TELEGRAM_BOT_TOKEN, chat_id: process.env.TELEGRAM_CHAT_ID } });
        if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN)
          channels.push({ channel: 'pushover', config: { user_key: process.env.PUSHOVER_USER_KEY, app_token: process.env.PUSHOVER_APP_TOKEN } });
      }
      const alert = {
        type: 'weekly_digest', symbol: 'PORTFOLIO', message: digest.text,
        html_message: digest.html, current_price: 0, trigger_price: 0,
        timestamp: new Date().toISOString(),
      };
      const results = channels.length ? await deliverAlert(alert, channels) : [];
      return res.json({ digest, delivery: { channels: results.length, delivered: results.filter(r => r.delivered).length } });
    }

    res.json({ digest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
