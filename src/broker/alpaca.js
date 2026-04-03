// ─── Alpaca Broker Client ────────────────────────────────────────────────────
// Thin wrapper around Alpaca REST API v2 for paper + live trading
const fetch = require('node-fetch');
const { cacheGet, cacheSet } = require('../data/cache');

const TTL_ACCOUNT = 30 * 1000; // 30 seconds

function getConfig() {
  const key    = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  // Strip trailing /v2 if user included it — we add /v2/ in our paths
  const raw    = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
  const base   = raw.replace(/\/v2\/?$/, '');
  return { key, secret, base, configured: !!(key && secret) };
}

function headers() {
  const { key, secret } = getConfig();
  return {
    'APCA-API-KEY-ID':     key,
    'APCA-API-SECRET-KEY': secret,
    'Content-Type':        'application/json',
  };
}

async function request(method, path, body = null) {
  const { base, configured } = getConfig();
  if (!configured) throw new Error('Alpaca API keys not configured. Set ALPACA_API_KEY and ALPACA_API_SECRET in .env');

  const url = `${base}${path}`;
  const opts = { method, headers: headers() };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetch(url, opts);
  const text = await r.text();

  if (!r.ok) {
    let msg;
    try { msg = JSON.parse(text).message; } catch (_) { msg = text; }
    throw new Error(`Alpaca ${method} ${path} → ${r.status}: ${msg}`);
  }

  return text ? JSON.parse(text) : null;
}

// ─── Account ────────────────────────────────────────────────────────────────

async function getAccount() {
  const cached = cacheGet('alpaca:account', TTL_ACCOUNT);
  if (cached) return cached;
  const data = await request('GET', '/v2/account');
  cacheSet('alpaca:account', data);
  return data;
}

// ─── Positions ──────────────────────────────────────────────────────────────

async function getPositions() {
  return request('GET', '/v2/positions');
}

async function getPosition(symbol) {
  return request('GET', `/v2/positions/${encodeURIComponent(symbol)}`);
}

async function closePosition(symbol) {
  return request('DELETE', `/v2/positions/${encodeURIComponent(symbol)}`);
}

// ─── Orders ─────────────────────────────────────────────────────────────────

/**
 * Submit an order to Alpaca.
 * For bracket orders, use order_class: 'bracket' with take_profit and stop_loss.
 *
 * @param {Object} params
 * @param {string} params.symbol
 * @param {number} params.qty
 * @param {string} params.side - 'buy' or 'sell'
 * @param {string} params.type - 'market', 'limit', 'stop', 'stop_limit'
 * @param {string} params.time_in_force - 'day', 'gtc', 'ioc', 'fok'
 * @param {number} [params.limit_price]
 * @param {number} [params.stop_price]
 * @param {string} [params.order_class] - 'bracket', 'oco', 'oto'
 * @param {Object} [params.take_profit] - { limit_price }
 * @param {Object} [params.stop_loss] - { stop_price, limit_price }
 */
async function submitOrder(params) {
  return request('POST', '/v2/orders', params);
}

async function getOrder(orderId) {
  return request('GET', `/v2/orders/${orderId}`);
}

async function getOrders(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.limit)  qs.set('limit', String(params.limit));
  if (params.after)  qs.set('after', params.after);
  if (params.until)  qs.set('until', params.until);
  if (params.direction) qs.set('direction', params.direction);
  const query = qs.toString();
  return request('GET', `/v2/orders${query ? '?' + query : ''}`);
}

async function cancelOrder(orderId) {
  return request('DELETE', `/v2/orders/${orderId}`);
}

async function cancelAllOrders() {
  return request('DELETE', '/v2/orders');
}

// ─── Market Clock ───────────────────────────────────────────────────────────

async function getClock() {
  return request('GET', '/v2/clock');
}

async function isMarketOpen() {
  const clock = await getClock();
  return { open: clock.is_open, next_open: clock.next_open, next_close: clock.next_close };
}

// ─── Health Check ───────────────────────────────────────────────────────────

async function validateConnection() {
  const { configured } = getConfig();
  if (!configured) return { connected: false, reason: 'API keys not set' };
  try {
    const account = await getAccount();
    return {
      connected: true,
      status: account.status,
      equity: +account.equity,
      buyingPower: +account.buying_power,
      cash: +account.cash,
      patternDayTrader: account.pattern_day_trader,
      tradingBlocked: account.trading_blocked,
      paper: getConfig().base.includes('paper'),
    };
  } catch (e) {
    return { connected: false, reason: e.message };
  }
}

module.exports = {
  getConfig,
  getAccount,
  getPositions, getPosition, closePosition,
  submitOrder, getOrder, getOrders, cancelOrder, cancelAllOrders,
  getClock, isMarketOpen,
  validateConnection,
};
