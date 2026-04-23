// ─── Tests: submitStagedOrder claim-the-row race guard ────────────────────
//
// Bug this pins:
//
//   Before fix, submitStagedOrder had no mutual exclusion between the
//   status-check (SELECT staged) and the final status-write (UPDATE
//   submitted). Two concurrent callers (rapid double-click, UI retry on a
//   slow broker) could both pass the guard and both submit brackets to
//   Alpaca. Result: two identical bracket orders for the same setup, which
//   Alpaca happily accepts.
//
//   Fix: flip status 'staged'→'submitting' in a single UPDATE ... WHERE
//   status='staged' (SQLite single-writer atomicity). Only one caller wins.
//   On broker error, we release the claim back to 'staged' so the user can
//   retry — any other failure path would leave the row stuck in 'submitting'.
//
// These tests use BROKER=mock so submissions are real adapter calls against
// the in-memory mock.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// Silence notification channel so parallel calls don't emit real alerts.
require.cache[require.resolve('../../src/notifications/channels')] = {
  exports: {
    notifyTradeEvent: async () => {},
    deliverAlert:     async () => [],
  },
};

const { stageOrder, submitStagedOrder, getStagedOrder } = require('../../src/broker/staging');
const { getDB } = require('../../src/data/database');
const { getBroker, resetBroker } = require('../../src/broker');

function primeMock(symbol, price) {
  const b = getBroker();
  b.reset();
  b._setMark(symbol, price);
  return b;
}

function wipe() {
  getDB().prepare('DELETE FROM staged_orders').run();
  getDB().prepare('DELETE FROM trades').run();
}

function stageSample({ symbol = 'AAPL', qty = 10, entry = 200, stop = 190,
                        target1 = 220, target2 = 240, exitStrategy = 'full_in_full_out' } = {}) {
  return stageOrder({
    symbol, side: 'buy', order_type: 'limit', qty,
    entry_price: entry, stop_price: stop,
    target1_price: target1, target2_price: target2,
    exit_strategy: exitStrategy,
    source: 'test',
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('claim: two concurrent submits — only ONE wins, the other throws', async () => {
  wipe();
  resetBroker();
  primeMock('AAPL', 200);

  const staged = stageSample({ symbol: 'AAPL' });

  // Fire two submissions at exactly the same tick. Promise.allSettled so we
  // can inspect both outcomes — one must succeed, one must reject.
  const results = await Promise.allSettled([
    submitStagedOrder(staged.id),
    submitStagedOrder(staged.id),
  ]);

  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected  = results.filter(r => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'exactly one submit must win the claim');
  assert.equal(rejected.length, 1,  'exactly one submit must lose and throw');
  assert.match(rejected[0].reason.message, /not staged|already submitted|race/i,
    'losing caller gets a clear race-loser error message');

  // The row ends up as 'submitted' (winner's terminal state).
  const final = getStagedOrder(staged.id);
  assert.equal(final.status, 'submitted');
  assert.ok(final.alpaca_order_id, 'broker order id is persisted');

  // And the broker saw exactly ONE bracket (not two). This is the real
  // regression test — the bug is a duplicate broker submission.
  const b = getBroker();
  const parents = (await b.listOrders({ status: 'all', symbol: 'AAPL' }))
    .filter(o => !o.parentOrderId);
  assert.equal(parents.length, 1,
    'broker must have exactly one bracket — the race guard prevented the duplicate');
});

test('claim: broker error ROLLS BACK to staged so the user can retry', async () => {
  wipe();
  resetBroker();
  const b = primeMock('NVDA', 500);

  const staged = stageSample({ symbol: 'NVDA', entry: 500, stop: 480, target1: 550, target2: 600 });

  // Monkey-patch the adapter's bracket submit to throw. submitStagedOrder's
  // try/catch must invoke releaseClaim and flip 'submitting' back to 'staged'.
  const origSubmit = b.submitBracketOrder.bind(b);
  b.submitBracketOrder = async () => { throw new Error('broker is having a bad day'); };

  try {
    await assert.rejects(
      () => submitStagedOrder(staged.id),
      /broker is having a bad day/,
    );
    const row = getStagedOrder(staged.id);
    assert.equal(row.status, 'staged',
      'on broker error the claim must release — row goes back to staged for retry');
    assert.equal(row.alpaca_order_id, null);

    // Now that the row is back to staged, a retry should succeed cleanly.
    b.submitBracketOrder = origSubmit;
    await submitStagedOrder(staged.id);
    const row2 = getStagedOrder(staged.id);
    assert.equal(row2.status, 'submitted', 'retry after rollback must succeed');
  } finally {
    b.submitBracketOrder = origSubmit;
  }
});

test('claim: re-submitting an already-submitted row is rejected (no broker call)', async () => {
  wipe();
  resetBroker();
  const b = primeMock('MSFT', 400);

  const staged = stageSample({ symbol: 'MSFT', entry: 400, stop: 380, target1: 440, target2: 480 });
  await submitStagedOrder(staged.id);
  const brokerOrderCountAfterFirst = (await b.listOrders({ status: 'all', symbol: 'MSFT' }))
    .filter(o => !o.parentOrderId).length;

  await assert.rejects(
    () => submitStagedOrder(staged.id),
    /not staged/,
    'attempting to submit a row in status=submitted must throw',
  );

  // Broker must NOT have received a second submission.
  const brokerOrderCountAfterSecond = (await b.listOrders({ status: 'all', symbol: 'MSFT' }))
    .filter(o => !o.parentOrderId).length;
  assert.equal(brokerOrderCountAfterSecond, brokerOrderCountAfterFirst,
    'no broker orders added on rejected resubmit');
});

test('claim: nonexistent staged id throws "not found"', async () => {
  wipe();
  resetBroker();
  primeMock('AAPL', 200);

  await assert.rejects(
    () => submitStagedOrder(999999),
    /not found/,
    'submitStagedOrder on missing id must fail with not-found',
  );
});

test('claim: pre-trade risk failure releases the claim (not just broker errors)', async () => {
  // Rationale: releaseClaim sits inside the try/catch, so any throw between
  // the claim and the final UPDATE must roll the row back — not just the
  // literal broker.submit* call. A pre-trade risk rejection throws inside
  // the try block, which is exactly the path this test covers.
  wipe();
  resetBroker();
  primeMock('AAPL', 200);

  // Force the risk check to fail by injecting an impossibly-oversized order.
  // Mock broker reports equity=100k / buyingPower=200k by default, so a
  // 10,000-share AAPL order at $200 = $2M is guaranteed to fail sizing.
  const staged = stageSample({ symbol: 'AAPL', qty: 10000, entry: 200, stop: 190 });

  let threw = false;
  try {
    await submitStagedOrder(staged.id);
  } catch (e) {
    threw = true;
    // Either pre-trade check failed, or broker rejected. Either way the
    // row must have rolled back.
  }
  assert.ok(threw, 'oversized order must throw somewhere in the submit pipeline');

  const row = getStagedOrder(staged.id);
  assert.equal(row.status, 'staged',
    'any throw inside submitStagedOrder must release the claim (not leave row in submitting)');
});
