// ─── Notification Delivery Channels ─────────────────────────────────────────
// Slack, Telegram, and webhook delivery for alerts
const fetch = require('node-fetch');
const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Channel Configuration ─────────────────────────────────────────────────

const CHANNELS = {
  slack: {
    name: 'Slack',
    envKey: 'SLACK_WEBHOOK_URL',
    configKeys: ['webhook_url'],
    icon: '💬',
  },
  telegram: {
    name: 'Telegram',
    envKey: 'TELEGRAM_BOT_TOKEN',
    configKeys: ['bot_token', 'chat_id'],
    icon: '📨',
  },
  webhook: {
    name: 'Webhook',
    envKey: 'ALERT_WEBHOOK_URL',
    configKeys: ['url'],
    icon: '🔗',
  },
  pushover: {
    name: 'Pushover',
    envKey: 'PUSHOVER_USER_KEY',
    configKeys: ['user_key', 'app_token'],
    icon: '📱',
  },
};

// ─── Slack Delivery ────────────────────────────────────────────────────────

function formatSlackPayload(alert) {
  const emoji = alert.type === 'stop_violation' ? '🔴'
    : alert.type === 'vcp_pivot' ? '🟢'
    : alert.type === 'price_above' ? '📈'
    : alert.type === 'price_below' ? '📉'
    : '🔔';

  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji} ${alert.symbol} Alert`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Type:*\n${alert.type.replace(/_/g, ' ')}` },
          { type: 'mrkdwn', text: `*Price:*\n$${alert.current_price}` },
          { type: 'mrkdwn', text: `*Trigger:*\n$${alert.trigger_price}` },
          { type: 'mrkdwn', text: `*Time:*\n${new Date(alert.timestamp).toLocaleString()}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: alert.message },
      },
    ],
  };
}

async function sendSlack(alert, config) {
  const webhookUrl = config.webhook_url || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('Slack webhook URL not configured');

  const payload = formatSlackPayload(alert);
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack API error (${res.status}): ${text}`);
  }
  return { delivered: true, channel: 'slack' };
}

// ─── Telegram Delivery ─────────────────────────────────────────────────────

function formatTelegramMessage(alert, { priority = 0 } = {}) {
  const emoji = alert.type === 'stop_violation' ? '🔴'
    : alert.type === 'vcp_pivot' ? '🟢'
    : alert.type === 'price_above' ? '📈'
    : alert.type === 'price_below' ? '📉'
    : alert.type === 'trade_regime_change' ? '🌊'
    : alert.type === 'trade_conditional_triggered' ? '🎯'
    : alert.type === 'trade_tranche_filled' ? '📊'
    : alert.type === 'trade_scale_in' ? '➕'
    : '🔔';

  // Urgent alerts (priority ≥ 1 — stops, regime changes, rejections) get a
  // banner line at the top so the user sees at a glance that this one
  // bypasses normal chatter. Telegram itself doesn't have priority lanes
  // like Pushover does — the audible/silent split is controlled via the
  // `disable_notification` flag on the send call, handled in sendTelegram.
  const header = priority >= 1
    ? `🚨 <b>URGENT — ${alert.symbol} Alert</b> 🚨`
    : `${emoji} <b>${alert.symbol} Alert</b>`;

  return [
    header,
    ``,
    `<b>Type:</b> ${alert.type.replace(/_/g, ' ')}`,
    `<b>Price:</b> $${alert.current_price}`,
    `<b>Trigger:</b> $${alert.trigger_price}`,
    `<b>Message:</b> ${alert.message}`,
    ``,
    `<i>${new Date(alert.timestamp).toLocaleString()}</i>`,
  ].join('\n');
}

async function sendTelegram(alert, config) {
  const botToken = config.bot_token || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = config.chat_id || process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) throw new Error('Telegram bot_token and chat_id required');

  // Mirror Pushover priority into Telegram behavior:
  //   priority ≥ 1 → urgent banner + audible (bypasses muted chat preview)
  //   priority  0 → normal audible notification (default)
  //   priority ≤ -1 → `disable_notification: true` (silent — no sound/vibrate)
  // Lookup via NOTIFICATION_PRIORITY_MAP so a single map drives both channels,
  // and strips the `trade_` prefix so notifyTradeEvent('auto_stop') still
  // resolves to the `auto_stop: 1` entry. (Previously this was a silent bug:
  // every lifecycle event dropped to priority 0 because the map had
  // `auto_stop` but the code looked up `trade_auto_stop`.)
  const priority = lookupPriority(alert.type);

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: Number(chatId) || chatId,
      text: formatTelegramMessage(alert, { priority }),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: priority <= -1,
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return { delivered: true, channel: 'telegram', message_id: data.result?.message_id, priority };
}

// ─── Webhook Delivery ──────────────────────────────────────────────────────

async function sendWebhook(alert, config) {
  const url = config.url || process.env.ALERT_WEBHOOK_URL;
  if (!url) throw new Error('Webhook URL not configured');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.headers || {}),
    },
    body: JSON.stringify(alert),
  });

  if (!res.ok) throw new Error(`Webhook error (${res.status})`);
  return { delivered: true, channel: 'webhook' };
}

// ─── Unified Priority Map (shared by Pushover + Telegram) ──────────────────
//
// Single source of truth for alert urgency. Each channel interprets it
// differently:
//
//   • Pushover  →  priority = N                     (API accepts -2..2)
//                   priority ≥ 1 adds retry/expire    (emergency-level alert)
//   • Telegram  →  priority ≤ -1 sets disable_notification: true (silent)
//                   priority ≥  1 adds an "URGENT" banner to the message body
//
// The map contains BOTH the direct alert types (stop_violation, vcp_pivot)
// AND the shorter lifecycle event names (auto_stop, filled, staged). The
// `lookupPriority` helper below strips the `trade_` prefix so
// notifyTradeEvent('auto_stop')'s final type 'trade_auto_stop' still
// resolves to `auto_stop: 1`. This replaces a latent bug where every
// lifecycle event silently fell through to priority 0.
//
// gap_cancel is treated as priority-1: the staged order just died because
// the overnight gap broke the setup thesis, and the user needs to know
// immediately so they can decide whether to re-enter at a new level.

const NOTIFICATION_PRIORITY_MAP = {
  // Direct alerts (deliverAlert callers)
  stop_violation:      1,
  regime_change:       1,
  vcp_pivot:           0,
  price_above:         0,
  price_below:         0,
  strategy_exit:       0,
  test:               -1,

  // Lifecycle event short names (notifyTradeEvent + trade_ prefix stripping)
  auto_stop:           1,
  force_stop:          1,
  stop_hit:            1,
  gap_cancel:          1,   // pre-open gap guard killed the staged order
  correlation_drift:   1,   // Phase 2.8 — pair drifted into lockstep, trim one
  rejected:            1,   // broker rejected — needs investigation
  trade_rejected:      1,   // legacy verbose form
  pullback_entry:      0,
  filled:              0,
  buy:                 0,
  sell:                0,
  exit:                0,
  scale_in:            0,
  scale_out:           0,
  partial_exit:        0,
  adjustment:          0,
  conditional_triggered: 0,
  tranche_filled:      0,
  plan_completed:      0,
  conditional_expired: 0,
  staged:             -1,
  submitted:          -1,
  cancelled:          -1,
  expired:            -1,
};

// Backwards-compat alias — external callers (routes, older tests) may import
// PUSHOVER_PRIORITY_MAP by name. Point it at the unified map so nothing
// diverges.
const PUSHOVER_PRIORITY_MAP = NOTIFICATION_PRIORITY_MAP;

// Resolve the priority for any alert type, supporting both direct alerts
// ('auto_stop') and trade-prefixed forms ('trade_auto_stop'). Falls through
// to 0 (default/normal) on unknown types.
function lookupPriority(type, fallback = 0) {
  if (type == null) return fallback;
  if (NOTIFICATION_PRIORITY_MAP[type] != null) return NOTIFICATION_PRIORITY_MAP[type];
  if (type.startsWith('trade_')) {
    const stripped = type.slice(6);
    if (NOTIFICATION_PRIORITY_MAP[stripped] != null) return NOTIFICATION_PRIORITY_MAP[stripped];
  }
  return fallback;
}

// ─── Pushover Delivery (Mobile Push Notifications) ────────────────────────

const PUSHOVER_SOUND_MAP = {
  // Direct alerts
  stop_violation:      'siren',
  regime_change:       'cosmic',
  strategy_exit:       'intermission',
  vcp_pivot:           'cashregister',

  // Lifecycle short names — resolved via lookupSound which strips trade_
  // prefix, same approach as lookupPriority.
  force_stop:          'siren',
  auto_stop:           'falling',
  gap_cancel:          'falling',
  correlation_drift:   'intermission',  // Phase 2.8 — not urgent enough for siren
  rejected:            'falling',
  pullback_entry:      'pushover',
  filled:              'cashregister',
  buy:                 'cashregister',
  scale_in:            'pushover',
  scale_out:           'pushover',
  conditional_triggered: 'magic',
};

function lookupSound(type, fallback = 'pushover') {
  if (type == null) return fallback;
  if (PUSHOVER_SOUND_MAP[type]) return PUSHOVER_SOUND_MAP[type];
  if (type.startsWith('trade_')) {
    const stripped = type.slice(6);
    if (PUSHOVER_SOUND_MAP[stripped]) return PUSHOVER_SOUND_MAP[stripped];
  }
  return fallback;
}

function formatPushoverMessage(alert) {
  const emoji = alert.type === 'stop_violation' ? '🔴'
    : alert.type === 'regime_change' || alert.type === 'trade_regime_change' ? '⚠️'
    : alert.type === 'vcp_pivot' ? '🟢'
    : alert.type === 'price_above' ? '📈'
    : alert.type === 'price_below' ? '📉'
    : alert.type === 'pullback_entry' ? '🎯'
    : alert.type === 'conditional_triggered' ? '⚡'
    : alert.type === 'scale_in' ? '➕'
    : '🔔';

  const title = `${emoji} ${alert.symbol || 'Alpha Hunter'} — ${(alert.type || 'alert').replace(/_/g, ' ').toUpperCase()}`;

  const lines = [];
  if (alert.message) lines.push(alert.message);
  if (alert.current_price) lines.push(`Price: $${alert.current_price}`);
  if (alert.trigger_price) lines.push(`Trigger: $${alert.trigger_price}`);

  return { title, message: lines.join('\n') || 'Alert triggered' };
}

async function sendPushover(alert, config) {
  const userKey = config.user_key || process.env.PUSHOVER_USER_KEY;
  const appToken = config.app_token || process.env.PUSHOVER_APP_TOKEN;
  if (!userKey || !appToken) throw new Error('Pushover user_key and app_token required');

  const { title, message } = formatPushoverMessage(alert);
  // Use the shared lookup helper so trade_ prefixed alert types (from
  // notifyTradeEvent) resolve to their short-name entries like
  // auto_stop: 1, stop_hit: 1, etc. Previously this was a silent fall-
  // through to priority 0 for every trade lifecycle event.
  const priority = lookupPriority(alert.type);

  const body = {
    token: appToken,
    user: userKey,
    title,
    message,
    priority,
    sound: lookupSound(alert.type),
    url: `http://localhost:${process.env.PORT || 3000}`,
    url_title: 'Open Alpha Hunter',
    timestamp: Math.floor(new Date(alert.timestamp || Date.now()).getTime() / 1000),
  };

  // Priority 1 requires retry/expire params (Pushover requirement)
  if (priority >= 1) {
    body.retry = 60;     // retry every 60 seconds
    body.expire = 600;   // stop retrying after 10 minutes
  }

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pushover API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return { delivered: true, channel: 'pushover', request: data.request };
}

// ─── Delivery Router ───────────────────────────────────────────────────────

const senders = {
  slack: sendSlack,
  telegram: sendTelegram,
  webhook: sendWebhook,
  pushover: sendPushover,
};

async function deliverAlert(alert, channels) {
  const results = [];

  for (const ch of channels) {
    const sender = senders[ch.channel];
    if (!sender) {
      results.push({ channel: ch.channel, error: 'Unknown channel', delivered: false });
      continue;
    }
    try {
      const result = await sender(alert, ch.config || {});
      logDelivery(alert, ch.channel, 'delivered', null);
      results.push(result);
    } catch (e) {
      logDelivery(alert, ch.channel, 'failed', e.message);
      results.push({ channel: ch.channel, error: e.message, delivered: false });
    }
  }

  return results;
}

function logDelivery(alert, channel, status, error) {
  try {
    db().prepare(`
      INSERT INTO notification_log (alert_id, channel, status, error, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      alert.alert_id || null, channel, status, error,
      JSON.stringify({ symbol: alert.symbol, type: alert.type, message: alert.message })
    );
  } catch (_) {
    // Don't fail delivery on log errors
  }
}

// ─── Channel Config CRUD (persisted to SQLite) ────────────────────────────

function getNotificationChannels() {
  return db().prepare('SELECT * FROM notification_channels ORDER BY priority ASC').all()
    .map(c => ({ ...c, config: JSON.parse(c.config || '{}'), filters: JSON.parse(c.filters || '{}') }));
}

function getEnabledChannels(alertType) {
  const all = getNotificationChannels().filter(c => c.enabled);
  if (!alertType) return all;
  return all.filter(c => {
    const filters = c.filters || {};
    if (!filters.alert_types || filters.alert_types.length === 0) return true;
    return filters.alert_types.includes(alertType);
  });
}

function createNotificationChannel({ name, channel, config, filters = {}, enabled = true, priority = 10 }) {
  if (!name || !channel) throw new Error('name and channel required');
  if (!senders[channel]) throw new Error(`Unknown channel: ${channel}. Available: ${Object.keys(senders).join(', ')}`);

  const result = db().prepare(`
    INSERT INTO notification_channels (name, channel, config, filters, enabled, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, channel, JSON.stringify(config || {}), JSON.stringify(filters), enabled ? 1 : 0, priority);

  return { id: result.lastInsertRowid, name, channel, config, enabled, priority };
}

function updateNotificationChannel(id, updates) {
  const fields = [];
  const values = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.config !== undefined) { fields.push('config = ?'); values.push(JSON.stringify(updates.config)); }
  if (updates.filters !== undefined) { fields.push('filters = ?'); values.push(JSON.stringify(updates.filters)); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
  if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
  fields.push("updated_at = datetime('now')");

  values.push(id);
  db().prepare(`UPDATE notification_channels SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
}

function deleteNotificationChannel(id) {
  db().prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
}

function testChannel(id) {
  const ch = db().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
  if (!ch) throw new Error(`Channel ${id} not found`);
  ch.config = JSON.parse(ch.config || '{}');

  const testAlert = {
    type: 'test',
    symbol: 'TEST',
    trigger_price: 100.00,
    current_price: 101.50,
    message: 'Alpha Hunter test notification — delivery is working!',
    timestamp: new Date().toISOString(),
  };

  return deliverAlert(testAlert, [{ channel: ch.channel, config: ch.config }]);
}

// ─── Delivery Log Queries ──────────────────────────────────────────────────

function getDeliveryLog(limit = 50) {
  return db().prepare('SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

function getDeliveryStats() {
  const stats = db().prepare(`
    SELECT channel,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM notification_log
    GROUP BY channel
  `).all();
  return stats;
}

// ─── Trade Event Notifications ────────────────────────────────────────────
// Sends notifications for trade lifecycle events (stage, execute, scale, stop, exit)

const TRADE_EVENT_EMOJIS = {
  staged: '📋', submitted: '🚀', filled: '✅', buy: '✅',
  sell: '💰', exit: '💰', scale_in: '➕', scale_out: '➖',
  partial_exit: '➖', auto_stop: '🛑', force_stop: '🛑',
  stop_violation: '🛑', strategy_exit: '⚠️', adjustment: '🔧',
  pullback_entry: '🎯',
  // Phase 2 events
  regime_change: '🌊', conditional_triggered: '🎯', tranche_filled: '📊',
  conditional_expired: '⏰', plan_completed: '🏁',
  correlation_drift: '🔗',  // Phase 2.8 — pair of positions drifted into lockstep
  // Broker lifecycle terminal transitions — fired by the order-status
  // poller in broker/monitor.js + direct hooks in broker/staging.js.
  cancelled: '🚫', expired: '⏰', rejected: '⛔',
};

async function notifyTradeEvent({ event, symbol, details = {} }) {
  const emoji = TRADE_EVENT_EMOJIS[event] || '🔔';
  const label = event.replace(/_/g, ' ').toUpperCase();
  const lines = [`${emoji} ${symbol} — ${label}`];

  if (details.shares) lines.push(`Shares: ${details.shares}`);
  if (details.price) lines.push(`Price: $${details.price}`);
  if (details.stop) lines.push(`Stop: $${details.stop}`);
  if (details.pnl != null) lines.push(`P&L: ${details.pnl >= 0 ? '+' : ''}$${details.pnl.toFixed(2)}`);
  if (details.pnl_pct != null) lines.push(`Return: ${details.pnl_pct >= 0 ? '+' : ''}${details.pnl_pct.toFixed(1)}%`);
  // Phase 2 event details
  if (details.from_regime && details.to_regime) lines.push(`Regime: ${details.from_regime} → ${details.to_regime}`);
  if (details.vix != null) lines.push(`VIX: ${details.vix}`);
  if (details.size_multiplier != null) lines.push(`Size multiplier: ${details.size_multiplier}x`);
  if (details.tranche != null) lines.push(`Tranche: ${details.tranche}/3`);
  if (details.trigger_type) lines.push(`Trigger: ${details.trigger_type.replace(/_/g, ' ')}`);
  if (details.entry_type) lines.push(`Entry: ${details.entry_type}`);
  if (details.reason) lines.push(`Reason: ${details.reason}`);
  if (details.message) lines.push(details.message);

  const payload = {
    type: `trade_${event}`,
    symbol,
    message: lines.join('\n'),
    current_price: details.price || 0,
    trigger_price: details.stop || details.price || 0,
    timestamp: new Date().toISOString(),
    ...details,
  };

  // Log to alerts table
  try {
    db().prepare('INSERT INTO alerts (type, symbol, message, data) VALUES (?, ?, ?, ?)')
      .run(`trade_${event}`, symbol, lines[0], JSON.stringify(payload));
  } catch (_) {}

  // Deliver to all enabled channels (DB-configured)
  let channels = getEnabledChannels(`trade_${event}`);

  // Fallback: if no DB channels configured, use env-var channels directly
  if (!channels.length) {
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      channels.push({ channel: 'telegram', config: { bot_token: process.env.TELEGRAM_BOT_TOKEN, chat_id: process.env.TELEGRAM_CHAT_ID } });
    }
    if (process.env.SLACK_WEBHOOK_URL) {
      channels.push({ channel: 'slack', config: { webhook_url: process.env.SLACK_WEBHOOK_URL } });
    }
    if (process.env.ALERT_WEBHOOK_URL) {
      channels.push({ channel: 'webhook', config: { url: process.env.ALERT_WEBHOOK_URL } });
    }
    if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN) {
      channels.push({ channel: 'pushover', config: { user_key: process.env.PUSHOVER_USER_KEY, app_token: process.env.PUSHOVER_APP_TOKEN } });
    }
  }

  if (channels.length) {
    try {
      await deliverAlert(payload, channels);
    } catch (e) {
      console.error(`  Trade event notification failed (${event} ${symbol}): ${e.message}`);
    }
  }

  return payload;
}

// ─── Available Channels Info ───────────────────────────────────────────────

function getAvailableChannels() {
  return Object.entries(CHANNELS).map(([key, ch]) => ({
    key,
    ...ch,
    configured: ch.envKey ? !!process.env[ch.envKey] : false,
  }));
}

module.exports = {
  deliverAlert,
  getNotificationChannels, getEnabledChannels,
  createNotificationChannel, updateNotificationChannel, deleteNotificationChannel,
  testChannel,
  getDeliveryLog, getDeliveryStats,
  getAvailableChannels,
  // Individual senders for direct use
  sendSlack, sendTelegram, sendWebhook, sendPushover,
  // Priority resolution — exported for unit tests and any caller that
  // wants to inspect the urgency of an alert without actually sending it.
  NOTIFICATION_PRIORITY_MAP, PUSHOVER_PRIORITY_MAP,
  lookupPriority, lookupSound,
  // Trade event notifications
  notifyTradeEvent,
};
