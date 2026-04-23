// ─── Tests: Scaling lifecycle notifications (src/broker/monitor.js) ────────
//
// Verifies Phase 1.3 wiring:
//   1. scale_out notifications fire when target1 is hit
//   2. adjustment notifications fire AFTER the stop moves to breakeven
//   3. auto_stop notifications are rate-limited (cooldown) to prevent spam
//   4. checkOpenTradeScaling picks up open trades from the DB and runs
//      scaling evaluation against fetched prices — the cron fallback path
//
// We stub notifyTradeEvent with a spy so tests are isolated from network.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the notifications channel BEFORE requiring monitor.js so the monitor
// imports our spy instead of the real sendTelegram/sendSlack pipeline.
const notifySpy = [];
require.cache[require.resolve('../../src/notifications/channels')] = {
  exports: {
    notifyTradeEvent: async (event) => {
      notifySpy.push(event);
      return event;
    },
    // Other exports stubbed as no-ops so transitive requires don't break.
    deliverAlert: async () => [],
    getEnabledChannels: () => [],
    getNotificationChannels: () => [],
    createNotificationChannel: () => ({}),
    updateNotificationChannel: () => ({}),
    deleteNotificationChannel: () => {},
    testChannel: () => [],
    getDeliveryLog: () => [],
    getDeliveryStats: () => [],
    getAvailableChannels: () => [],
    sendSlack: async () => ({}),
    sendTelegram: async () => ({}),
    sendWebhook: async () => ({}),
    sendPushover: async () => ({}),
  },
};

// Stub the yahoo provider so `checkOpenTradeScaling` doesn't hit real-world
// prices when it falls back past the (unconfigured) Alpaca API. Test prices
// are injected via the `_stubPrices` map.
const _stubPrices = new Map();
require.cache[require.resolve('../../src/data/providers/yahoo')] = {
  exports: {
    yahooQuote: async (symbols) => symbols.map(s => {
      const price = _stubPrices.get(s);
      return price != null ? { symbol: s, regularMarketPrice: price } : { symbol: s };
    }),
    yahooHistory: async () => [],
    yahooHistoryFull: async () => [],
    yahooIntradayBars: async () => [],
    getYahooCrumb: async () => ({ crumb: '', cookie: '' }),
    getYahooFundamentals: async () => null,
    pLimit: async (fns) => Promise.all(fns.map(fn => fn())),
  },
};

const { getDB } = require('../../src/data/database');
const { getBroker, resetBroker } = require('../../src/broker');

// Defer monitor.js require until AFTER the stub is installed
let monitor;

function clearNotifySpy() { notifySpy.length = 0; }
function wipeState() {
  getDB().prepare('DELETE FROM trades').run();
  clearNotifySpy();
  _stubPrices.clear();
  // Also reset the cooldown cache by requiring a fresh copy of the monitor
  // module. The cache is module-scoped; flushing the require cache is the
  // cleanest way to get a clean slate between tests.
  delete require.cache[require.resolve('../../src/broker/monitor')];
  monitor = require('../../src/broker/monitor');
  if (getBroker().reset) getBroker().reset();
}

function insertOpenTrade({
  symbol = 'AAPL',
  side = 'long',
  shares = 30,
  entryPrice = 100,
  stopPrice = 95,
  target1 = 110,
  target2 = 125,
} = {}) {
  // Note: `trades` table has no exit_strategy column — evaluateScalingAction
  // defaults to 'full_in_scale_out' when trade.exit_strategy is undefined,
  // which is exactly what we want for these tests.
  const result = getDB().prepare(`
    INSERT INTO trades (
      symbol, side, shares, entry_price, entry_date, stop_price,
      target1, target2, remaining_shares, initial_shares
    ) VALUES (?, ?, ?, ?, date('now'), ?, ?, ?, ?, ?)
  `).run(symbol, side, shares, entryPrice, stopPrice, target1, target2, shares, shares);
  return result.lastInsertRowid;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('checkOpenTradeScaling: target1 hit → scale_out + adjustment notifications fire', async () => {
  wipeState();
  const broker = getBroker();
  broker._setMark('AAPL', 112);       // above target1 = 110

  const tradeId = insertOpenTrade({ symbol: 'AAPL', target1: 110, target2: 125 });

  // Inject the price into the Yahoo stub — since BROKER=mock leaves Alpaca
  // unconfigured, checkOpenTradeScaling falls through to the yahoo fallback
  // path for price discovery.
  _stubPrices.set('AAPL', 112);

  // Also register a mock position so the broker's getPositions() has state
  // to return when replaceStopsForSymbol queries it downstream.
  broker._positions.set('AAPL', {
    symbol: 'AAPL',
    qty: 30,
    avg_entry_price: 100,
    current_price: 112,
    market_value: 30 * 112,
    unrealized_pl: 30 * 12,
  });

  // Give the broker a real stop leg so replaceStopsForSymbol has something
  // to patch. Without this the new adjustment_failed path (from the stop_moves
  // audit refactor) fires instead of `adjustment`, because zero-leg patches
  // are treated as "bracket is missing — warn the user."
  await broker.submitBracketOrder({
    symbol: 'AAPL', qty: 30, side: 'buy', entryType: 'market',
    stopPrice: 95, takeProfitLimitPrice: 110,
  });

  await monitor.checkOpenTradeScaling();

  // Expect at least one scale_out + one adjustment
  const events = notifySpy.map(e => e.event);
  assert.ok(events.includes('scale_out'),
    `expected scale_out to fire, got: ${events.join(',')}`);
  assert.ok(events.includes('adjustment'),
    `expected adjustment (stop-to-breakeven) to fire, got: ${events.join(',')}`);

  // Verify trade was updated: partial_exits recorded and stop moved
  const updated = getDB().prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const partials = JSON.parse(updated.partial_exits || '[]');
  assert.ok(partials.some(p => p.level === 'target1'),
    'partial_exits must record target1');
  assert.equal(updated.stop_price, 100, 'stop_price must move to breakeven (entry)');
});

test('checkOpenTradeScaling: stop violation fires auto_stop exactly once (cooldown)', async () => {
  wipeState();
  const broker = getBroker();

  insertOpenTrade({
    symbol: 'MSFT',
    stopPrice: 380,
    target1: 420,
    target2: 450,
    shares: 20,
  });

  // Price below stop (380) — should trigger auto_stop via full_exit action.
  _stubPrices.set('MSFT', 375);

  broker._positions.set('MSFT', {
    symbol: 'MSFT',
    qty: 20,
    avg_entry_price: 400,
    current_price: 375,   // below stop at 380
    market_value: 20 * 375,
    unrealized_pl: 20 * -25,
  });

  // First run — fires auto_stop
  await monitor.checkOpenTradeScaling();
  let autoStops = notifySpy.filter(e => e.event === 'auto_stop');
  assert.equal(autoStops.length, 1, 'first run must fire auto_stop');

  // Second run immediately — cooldown should suppress
  clearNotifySpy();
  await monitor.checkOpenTradeScaling();
  autoStops = notifySpy.filter(e => e.event === 'auto_stop');
  assert.equal(autoStops.length, 0,
    'second run within cooldown must NOT fire auto_stop again');
});

test('checkOpenTradeScaling: no-op when no open trades', async () => {
  wipeState();
  await monitor.checkOpenTradeScaling();
  assert.equal(notifySpy.length, 0);
});

test('checkOpenTradeScaling: price not in range → no action', async () => {
  wipeState();
  const broker = getBroker();
  // Note: MUST override entryPrice + target2 — the insertOpenTrade helper
  // defaults them to 100/125, which would put price 1050 way above target2
  // and fire a scale_out instead of a no-op.
  insertOpenTrade({
    symbol: 'NVDA',
    entryPrice: 1000,
    stopPrice: 900,
    target1: 1100,
    target2: 1250,
  });

  // 1050 is above stop (900) and below target1 (1100) — neither scale nor exit.
  _stubPrices.set('NVDA', 1050);

  broker._positions.set('NVDA', {
    symbol: 'NVDA',
    qty: 10,
    avg_entry_price: 1000,
    current_price: 1050,   // above stop, below target1 → no action
    market_value: 10 * 1050,
    unrealized_pl: 10 * 50,
  });
  await monitor.checkOpenTradeScaling();
  assert.equal(notifySpy.length, 0,
    'no notifications should fire when price is between stop and target1');
});
