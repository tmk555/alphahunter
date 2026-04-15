// ─── Tests: Pre-open Gap Guard (src/broker/staging.js) ─────────────────────
//
// Verifies Phase 1.4 wiring:
//   1. BUY order gapping UP past entry × (1 + gapUpLimitPct) → CANCELLED,
//      and fires a 'gap_cancel' event (NOT a generic 'cancelled').
//   2. BUY order where current price has already violated stop_price →
//      CANCELLED + 'gap_cancel'.
//   3. BUY order with price inside the allowed band → left alone.
//   4. Already-submitted (broker-side) orders are cancelled through the
//      broker adapter, not just the DB row.
//   5. No quotes available for a symbol → leave it untouched (next cron
//      tick will retry).
//
// We stub notifyTradeEvent AND the provider manager's getQuotes so tests
// run offline and deterministic.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Stub notifications BEFORE requiring staging.js ─────────────────────────
const notifySpy = [];
require.cache[require.resolve('../../src/notifications/channels')] = {
  exports: {
    notifyTradeEvent: async (event) => { notifySpy.push(event); return event; },
    // Transitive no-ops so unrelated requires don't blow up.
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

// ── Stub the provider manager so getQuotes returns controlled test prices ──
const _stubPrices = new Map();
require.cache[require.resolve('../../src/data/providers/manager')] = {
  exports: {
    getQuotes: async (symbols) => symbols.map(s => {
      const price = _stubPrices.get(s);
      return price != null ? { symbol: s, regularMarketPrice: price } : { symbol: s };
    }),
    // Other exports the app uses — stubbed as no-ops so transitive imports
    // don't crash in case staging.js (or callers) reach for them.
    getHistory: async () => [],
    getHistoryFull: async () => [],
    getFundamentals: async () => null,
    getIntradayBars: async () => [],
    getProviderHealth: () => [],
  },
};

const {
  stageOrder, getStagedOrder, checkPreOpenGaps, submitStagedOrder,
} = require('../../src/broker/staging');
const { getDB } = require('../../src/data/database');
const { getBroker, resetBroker } = require('../../src/broker');

function clearNotifySpy() { notifySpy.length = 0; }

function wipeState() {
  getDB().prepare('DELETE FROM staged_orders').run();
  getDB().prepare('DELETE FROM trades').run();
  clearNotifySpy();
  _stubPrices.clear();
  resetBroker();
  if (getBroker().reset) getBroker().reset();
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('gap guard: BUY gapping +3% past entry → cancelled with gap_cancel event', async () => {
  wipeState();
  const staged = stageOrder({
    symbol: 'AAPL', side: 'buy', order_type: 'limit', qty: 10,
    entry_price: 200, stop_price: 190,
    target1_price: 220, target2_price: 240,
    exit_strategy: 'full_in_scale_out',
    source: 'test',
  });

  // Price at $206 = +3% above entry $200 (limit is +2% = $204).
  _stubPrices.set('AAPL', 206);

  const result = await checkPreOpenGaps();

  assert.equal(result.cancelled.length, 1);
  assert.equal(result.cancelled[0].symbol, 'AAPL');
  assert.match(result.cancelled[0].reason, /Gap up/);

  // Event must be 'gap_cancel' (NOT 'cancelled'), priority-1 specific
  // so the user sees *why* the order died, not a generic ping.
  const events = notifySpy.map(e => e.event);
  assert.ok(events.includes('gap_cancel'),
    `expected gap_cancel in events, got: ${events.join(',')}`);
  assert.ok(!events.includes('cancelled'),
    `expected NO generic cancelled event (suppressed), got: ${events.join(',')}`);

  // DB row flipped to 'cancelled'.
  const row = getStagedOrder(staged.id);
  assert.equal(row.status, 'cancelled');
});

test('gap guard: BUY where price has already violated stop → gap_cancel', async () => {
  wipeState();
  const staged = stageOrder({
    symbol: 'MSFT', side: 'buy', order_type: 'limit', qty: 5,
    entry_price: 400, stop_price: 380,
    target1_price: 420, target2_price: 450,
    exit_strategy: 'full_in_scale_out',
    source: 'test',
  });

  _stubPrices.set('MSFT', 378);  // below stop at 380

  const result = await checkPreOpenGaps();

  assert.equal(result.cancelled.length, 1);
  assert.equal(result.cancelled[0].symbol, 'MSFT');
  assert.match(result.cancelled[0].reason, /stop/);

  assert.ok(notifySpy.some(e => e.event === 'gap_cancel'));
  assert.equal(getStagedOrder(staged.id).status, 'cancelled');
});

test('gap guard: BUY inside band → left alone', async () => {
  wipeState();
  const staged = stageOrder({
    symbol: 'NVDA', side: 'buy', order_type: 'limit', qty: 5,
    entry_price: 500, stop_price: 480,
    target1_price: 550, target2_price: 600,
    exit_strategy: 'full_in_scale_out',
    source: 'test',
  });

  // $505 = +1%, within the 2% gap-up band → no action.
  _stubPrices.set('NVDA', 505);

  const result = await checkPreOpenGaps();
  assert.equal(result.cancelled.length, 0);
  assert.equal(notifySpy.length, 0);
  assert.equal(getStagedOrder(staged.id).status, 'staged');
});

test('gap guard: no quote for symbol → leave order alone (retry next tick)', async () => {
  wipeState();
  const staged = stageOrder({
    symbol: 'TSLA', side: 'buy', order_type: 'limit', qty: 10,
    entry_price: 250, stop_price: 240,
    target1_price: 275, target2_price: 300,
    exit_strategy: 'full_in_scale_out',
    source: 'test',
  });

  // No _stubPrices.set for TSLA — the stub returns { symbol } with no price.
  const result = await checkPreOpenGaps();
  assert.equal(result.cancelled.length, 0);
  assert.equal(notifySpy.length, 0);
  assert.equal(getStagedOrder(staged.id).status, 'staged');
});

test('gap guard: already-submitted order is cancelled through broker', async () => {
  wipeState();
  const broker = getBroker();
  broker._setMark('GOOG', 150);

  const staged = stageOrder({
    symbol: 'GOOG', side: 'buy', order_type: 'limit', qty: 9,
    entry_price: 150, stop_price: 142,
    target1_price: 165, target2_price: 180,
    exit_strategy: 'full_in_scale_out',
    source: 'test',
  });

  // Push the order to the broker first — this flips status to 'submitted'
  // and populates tranches_json so cancel has broker IDs to target.
  await submitStagedOrder(staged.id);
  assert.equal(getStagedOrder(staged.id).status, 'submitted');

  // Now simulate an overnight gap up: 4% past our entry.
  _stubPrices.set('GOOG', 156);  // +4% from entry

  // Clear pre-gap notifications (the 'submitted' event).
  clearNotifySpy();

  const result = await checkPreOpenGaps();

  assert.equal(result.cancelled.length, 1);
  assert.ok(notifySpy.some(e => e.event === 'gap_cancel'));

  // Order is flipped locally AND the broker's parent orders are cancelled.
  const row = getStagedOrder(staged.id);
  assert.equal(row.status, 'cancelled');

  // Broker-side: all GOOG parent orders should now be in cancelled/expired state.
  const allGoog = await broker.listOrders({ status: 'all', symbol: 'GOOG' });
  const parents = allGoog.filter(o => !o.parentOrderId);
  assert.ok(parents.length > 0, 'should have at least 1 parent on the broker');
  // Mock broker exposes cancelled status via the order object's `status` field.
  assert.ok(
    parents.every(p => p.status === 'cancelled' || p.status === 'canceled'),
    `expected all parents cancelled, got statuses: ${parents.map(p => p.status).join(',')}`,
  );
});

test('gap guard: multiple orders in one pass — mix of cancel + leave-alone', async () => {
  wipeState();
  const a = stageOrder({
    symbol: 'AMD', side: 'buy', order_type: 'limit', qty: 10,
    entry_price: 100, stop_price: 95,
    target1_price: 110, target2_price: 125,
    source: 'test',
  });
  const b = stageOrder({
    symbol: 'INTC', side: 'buy', order_type: 'limit', qty: 10,
    entry_price: 30, stop_price: 28,
    target1_price: 33, target2_price: 36,
    source: 'test',
  });

  _stubPrices.set('AMD', 105);   // +5% — should cancel
  _stubPrices.set('INTC', 30.3); // +1% — should leave alone

  const result = await checkPreOpenGaps();

  assert.equal(result.cancelled.length, 1);
  assert.equal(result.cancelled[0].symbol, 'AMD');

  // AMD cancelled
  assert.equal(getStagedOrder(a.id).status, 'cancelled');
  // INTC untouched
  assert.equal(getStagedOrder(b.id).status, 'staged');
});

test('gap guard: no staged orders → no-op', async () => {
  wipeState();
  const result = await checkPreOpenGaps();
  assert.equal(result.checked, 0);
  assert.equal(result.cancelled.length, 0);
  assert.equal(notifySpy.length, 0);
});
