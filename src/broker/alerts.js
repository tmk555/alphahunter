// ─── Alert Engine ────────────────────────────────────────────────────────────
// Price alert subscriptions, stop violation detection, webhook notifications
const fetch = require('node-fetch');
const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── CRUD ───────────────────────────────────────────────────────────────────

function createAlert({ symbol, alert_type, trigger_price, direction, trade_id, webhook_url, message }) {
  const stmt = db().prepare(`
    INSERT INTO alert_subscriptions (symbol, alert_type, trigger_price, direction, trade_id, webhook_url, message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(symbol.toUpperCase(), alert_type, trigger_price, direction, trade_id || null, webhook_url || null, message || null);
  return { id: result.lastInsertRowid, symbol, alert_type, trigger_price, direction };
}

function getActiveAlerts(symbol) {
  if (symbol) {
    return db().prepare('SELECT * FROM alert_subscriptions WHERE active = 1 AND symbol = ? ORDER BY created_at DESC').all(symbol.toUpperCase());
  }
  return db().prepare('SELECT * FROM alert_subscriptions WHERE active = 1 ORDER BY created_at DESC').all();
}

function deactivateAlert(id) {
  db().prepare('UPDATE alert_subscriptions SET active = 0 WHERE id = ?').run(id);
}

function deactivateAlertsForTrade(tradeId) {
  db().prepare('UPDATE alert_subscriptions SET active = 0 WHERE trade_id = ?').run(tradeId);
}

// ─── Convenience Creators ───────────────────────────────────────────────────

function createStopAlert(tradeId) {
  const trade = db().prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade || !trade.stop_price) return null;

  return createAlert({
    symbol: trade.symbol,
    alert_type: 'stop_violation',
    trigger_price: trade.stop_price,
    direction: trade.side === 'short' ? 'above' : 'below',
    trade_id: tradeId,
    message: `${trade.symbol} hit stop at $${trade.stop_price}`,
  });
}

function createVCPPivotAlert(symbol, pivotPrice) {
  return createAlert({
    symbol,
    alert_type: 'vcp_pivot',
    trigger_price: pivotPrice,
    direction: 'above',
    message: `${symbol} broke VCP pivot at $${pivotPrice}`,
  });
}

function createPriceAlert(symbol, price, direction, message) {
  return createAlert({
    symbol,
    alert_type: direction === 'above' ? 'price_above' : 'price_below',
    trigger_price: price,
    direction,
    message: message || `${symbol} crossed $${price} (${direction})`,
  });
}

// ─── Alert Checker ──────────────────────────────────────────────────────────

async function checkAlerts(currentPrices) {
  const active = getActiveAlerts();
  if (!active.length) return [];

  const fired = [];
  const now = new Date().toISOString();
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;

  const fireStmt = db().prepare('UPDATE alert_subscriptions SET triggered_at = ?, active = 0 WHERE id = ?');
  const logStmt = db().prepare(`
    INSERT INTO alerts (type, symbol, message, data)
    VALUES (?, ?, ?, ?)
  `);

  for (const sub of active) {
    const price = currentPrices[sub.symbol];
    if (price == null) continue;

    let triggered = false;
    if (sub.direction === 'below' && price <= sub.trigger_price) triggered = true;
    if (sub.direction === 'above' && price >= sub.trigger_price) triggered = true;

    if (triggered) {
      // Mark subscription as fired
      fireStmt.run(now, sub.id);

      const payload = {
        type: sub.alert_type,
        symbol: sub.symbol,
        trigger_price: sub.trigger_price,
        current_price: price,
        message: sub.message || `${sub.symbol} alert triggered at $${price}`,
        trade_id: sub.trade_id,
        timestamp: now,
      };

      // Log to alerts table
      logStmt.run(sub.alert_type, sub.symbol, payload.message, JSON.stringify(payload));

      // Fire webhook (per-subscription URL takes precedence over global)
      const url = sub.webhook_url || webhookUrl;
      if (url) {
        fireWebhook(url, payload).catch(e =>
          console.error(`  Alert webhook failed for ${sub.symbol}: ${e.message}`)
        );
      }

      fired.push(payload);
      console.log(`  🔔 Alert fired: ${payload.message} (price: $${price})`);
    }
  }

  return fired;
}

async function fireWebhook(url, payload) {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ─── Query Fired Alerts ─────────────────────────────────────────────────────

function getRecentAlerts(limit = 50) {
  return db().prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').all(limit);
}

function acknowledgeAlert(id) {
  db().prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
}

module.exports = {
  createAlert, getActiveAlerts, deactivateAlert, deactivateAlertsForTrade,
  createStopAlert, createVCPPivotAlert, createPriceAlert,
  checkAlerts,
  getRecentAlerts, acknowledgeAlert,
};
