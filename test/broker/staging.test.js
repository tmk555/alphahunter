// ─── Tests: Order Staging (multi-tranche bracket submission) ───────────────
//
// Two groups:
//
//   1. Pure `splitTranchesForScaleOut` unit tests — pin the qty-split
//      algorithm. No DB, no broker, no async.
//
//   2. End-to-end `submitStagedOrder` tests — use BROKER=mock and an
//      in-memory SQLite DB so we can assert the staging pipeline actually
//      places the right bracket orders on the broker and persists the
//      tranche metadata back to the DB.

// CRITICAL: these env vars must be set BEFORE any require() that touches
// the database or broker factory, because both modules cache at first call.
process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stageOrder, submitStagedOrder, getStagedOrder,
  splitTranchesForScaleOut, isScaleOutStrategy,
} = require('../../src/broker/staging');
const { getDB } = require('../../src/data/database');
const { getBroker, resetBroker } = require('../../src/broker');

// Set a generous starting mark on the mock broker so market orders fill
// and the pre-trade risk check sees realistic prices.
function primeMock(symbol, price) {
  const b = getBroker();
  b.reset();             // mock-only: wipe all orders/positions between tests
  b._setMark(symbol, price);
  return b;
}

// Wipe staged_orders between tests so IDs don't collide across test cases.
function wipeStagedOrders() {
  getDB().prepare('DELETE FROM staged_orders').run();
  // Also wipe any lingering open trades so preTradeCheck sees a clean slate.
  getDB().prepare('DELETE FROM trades').run();
}

// ─── Pure split-function tests ─────────────────────────────────────────────

test('split: qty=10 splits 3/3/4 with runner taking the remainder', () => {
  const out = splitTranchesForScaleOut({
    qty: 10, entry: 100, stop: 90, target1: 120, target2: 150,
  });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(t => t.qty), [3, 3, 4]);
  assert.deepEqual(out.map(t => t.label), ['target1', 'target2', 'runner']);
  assert.equal(out[0].takeProfitLimitPrice, 120);
  assert.equal(out[1].takeProfitLimitPrice, 150);
  // Runner TP = entry + 2 × (target2 - entry) = 100 + 100 = 200
  assert.equal(out[2].takeProfitLimitPrice, 200);
});

test('split: qty=9 splits 3/3/3 (exact divisor, runner still labelled)', () => {
  const out = splitTranchesForScaleOut({
    qty: 9, entry: 100, stop: 95, target1: 110, target2: 125,
  });
  assert.deepEqual(out.map(t => t.qty), [3, 3, 3]);
  assert.deepEqual(out.map(t => t.label), ['target1', 'target2', 'runner']);
});

test('split: qty=11 splits 3/3/5 (runner absorbs both remainders)', () => {
  const out = splitTranchesForScaleOut({
    qty: 11, entry: 100, stop: 90, target1: 120, target2: 150,
  });
  assert.deepEqual(out.map(t => t.qty), [3, 3, 5]);
});

test('split: qty=2 splits 1/1 using target1 + target2', () => {
  const out = splitTranchesForScaleOut({
    qty: 2, entry: 100, stop: 90, target1: 120, target2: 150,
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(t => t.qty), [1, 1]);
  assert.deepEqual(out.map(t => t.label), ['target1', 'target2']);
});

test('split: qty=1 collapses to a single bracket at target1', () => {
  const out = splitTranchesForScaleOut({
    qty: 1, entry: 100, stop: 90, target1: 120, target2: 150,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].qty, 1);
  assert.equal(out[0].takeProfitLimitPrice, 120);
});

test('split: missing target2 with qty>=3 falls back to 2 tranches', () => {
  const out = splitTranchesForScaleOut({
    qty: 6, entry: 100, stop: 90, target1: 120, target2: null,
  });
  // Without target2 we can only place two tranches: target1 + runner.
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(t => t.qty), [3, 3]);
  assert.equal(out[0].label, 'target1');
  assert.equal(out[1].label, 'runner');
});

test('split: rejects qty=0 and missing target1', () => {
  assert.throws(() => splitTranchesForScaleOut({ qty: 0, entry: 100, stop: 90, target1: 120, target2: 150 }), /qty/);
  assert.throws(() => splitTranchesForScaleOut({ qty: 5, entry: 100, stop: 90, target1: null, target2: 150 }), /target1/);
});

test('isScaleOutStrategy: recognises scale-out variants', () => {
  assert.equal(isScaleOutStrategy('full_in_scale_out'),  true);
  assert.equal(isScaleOutStrategy('scale_in_scale_out'), true);
  assert.equal(isScaleOutStrategy('scale_in_out'),        true);   // legacy alias
  assert.equal(isScaleOutStrategy('full_in_full_out'),    false);
  assert.equal(isScaleOutStrategy('full_size'),           false);
  assert.equal(isScaleOutStrategy(''),                    false);
  assert.equal(isScaleOutStrategy(undefined),             false);
});

// ─── End-to-end submission via mock broker ─────────────────────────────────

test('submit: full_in_scale_out with qty=9 places 3 brackets on the broker', async () => {
  wipeStagedOrders();
  resetBroker();
  const b = primeMock('NVDA', 500);

  const staged = stageOrder({
    symbol: 'NVDA', side: 'buy', order_type: 'limit', qty: 9,
    entry_price: 500, stop_price: 480,
    target1_price: 550, target2_price: 600,
    exit_strategy: 'full_in_scale_out',
    source: 'test',
  });

  const result = await submitStagedOrder(staged.id);
  assert.ok(result.submission.tranches, 'should be a multi-tranche submission');
  assert.equal(result.submission.tranches.length, 3);
  assert.deepEqual(
    result.submission.tranches.map(t => t.label),
    ['target1', 'target2', 'runner'],
  );
  assert.deepEqual(
    result.submission.tranches.map(t => t.order.qty),
    [3, 3, 3],
  );

  // DB row should now be 'submitted' with tranches_json populated.
  const updated = getStagedOrder(staged.id);
  assert.equal(updated.status, 'submitted');
  assert.ok(updated.tranches_json);
  const meta = JSON.parse(updated.tranches_json);
  assert.equal(meta.length, 3);
  assert.ok(meta.every(t => t.orderId && t.qty > 0 && t.tp > 0));

  // The mock broker should actually have 3 bracket parents × 2 legs = 6 child
  // orders for NVDA, plus the parents themselves.
  const allNvda = (await b.listOrders({ status: 'all', symbol: 'NVDA' }));
  const parents  = allNvda.filter(o => !o.parentOrderId);
  const children = allNvda.filter(o =>  o.parentOrderId);
  assert.equal(parents.length, 3);
  assert.equal(children.length, 6);
});

test('submit: full_in_full_out places a single bracket at target1', async () => {
  wipeStagedOrders();
  resetBroker();
  const b = primeMock('AAPL', 200);

  const staged = stageOrder({
    symbol: 'AAPL', side: 'buy', order_type: 'limit', qty: 10,
    entry_price: 200, stop_price: 190,
    target1_price: 220, target2_price: 240,
    exit_strategy: 'full_in_full_out',
    source: 'test',
  });

  const result = await submitStagedOrder(staged.id);
  // Single-bracket path returns the BrokerOrder directly, no .tranches key.
  assert.equal(result.submission.tranches, undefined);
  assert.equal(result.submission.qty, 10);
  // Only one bracket parent placed, with 2 child legs.
  const all = await b.listOrders({ status: 'all', symbol: 'AAPL' });
  const parents  = all.filter(o => !o.parentOrderId);
  const children = all.filter(o =>  o.parentOrderId);
  assert.equal(parents.length, 1);
  assert.equal(children.length, 2);

  const updated = getStagedOrder(staged.id);
  assert.equal(updated.status, 'submitted');
  assert.equal(updated.tranches_json, null, 'single-bracket path should not populate tranches_json');
});

test('submit: scale_out with no target2 falls back to 2 tranches', async () => {
  wipeStagedOrders();
  resetBroker();
  const b = primeMock('MSFT', 400);

  const staged = stageOrder({
    symbol: 'MSFT', side: 'buy', order_type: 'limit', qty: 6,
    entry_price: 400, stop_price: 380,
    target1_price: 420, target2_price: null,
    exit_strategy: 'full_in_scale_out',
    source: 'test',
  });

  const result = await submitStagedOrder(staged.id);
  assert.equal(result.submission.tranches.length, 2);
  assert.deepEqual(result.submission.tranches.map(t => t.label), ['target1', 'runner']);
  const parents = (await b.listOrders({ status: 'all', symbol: 'MSFT' }))
    .filter(o => !o.parentOrderId);
  assert.equal(parents.length, 2);
});
