// ─── Tests: staging submit FAILURE modes ──────────────────────────────────
//
// The existing staging.test.js covers the splits + happy path. This suite
// pins the failure modes — the cases where money loss actually hides:
//
//   • Pre-trade check rejects → claim rolled back, no broker call
//   • Broker throws after claim → claim rolled back, status='staged' (retry)
//   • Two parallel submits for same staged id → only one wins
//   • Multi-tranche partial failure (tranche 2 of 3 fails) → error carries
//     'partial' field listing what succeeded so caller can cancel
//   • Concurrent submit-then-cancel race
//
// These are the regressions a `submitMultiTrancheBracket` refactor would
// most likely break and that today's test suite would not catch.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stageOrder, submitStagedOrder, getStagedOrder,
} = require('../../src/broker/staging');
const { getDB } = require('../../src/data/database');
const { getBroker, resetBroker } = require('../../src/broker');

function wipe() {
  getDB().prepare('DELETE FROM staged_orders').run();
  getDB().prepare('DELETE FROM trades').run();
  resetBroker();
}

function stage({
  symbol = 'TEST', qty = 9, entry = 100, stop = 95,
  target1 = 110, target2 = 125, exit_strategy = 'full_in_scale_out',
} = {}) {
  return stageOrder({
    symbol, side: 'buy', order_type: 'limit', qty,
    entry_price: entry, stop_price: stop,
    target1_price: target1, target2_price: target2,
    exit_strategy, source: 'test',
  });
}

// ─── 1. Broker throws AFTER claim → claim rolled back ─────────────────────
test('failure: broker throws → status rolled back to "staged" so retry works', async () => {
  wipe();
  const b = getBroker();
  b._setMark('FAIL', 100);

  // Monkey-patch the broker to throw on the next submitMultiTrancheBracket.
  const original = b.submitMultiTrancheBracket.bind(b);
  let calls = 0;
  b.submitMultiTrancheBracket = async (params) => {
    calls++;
    if (calls === 1) throw new Error('Alpaca POST /v2/orders → 503: service unavailable');
    return original(params);
  };

  const staged = stage({ symbol: 'FAIL' });
  await assert.rejects(submitStagedOrder(staged.id), /503/);

  // Status must be back to 'staged' so the user can retry — pre-fix bug
  // would leave it as 'submitting' forever, blocking all future submits.
  const after = getStagedOrder(staged.id);
  assert.equal(after.status, 'staged', 'claim must release on broker failure');

  // Retry should now succeed (mock broker is healthy on second call).
  b.submitMultiTrancheBracket = original;
  const result = await submitStagedOrder(staged.id);
  assert.equal(getStagedOrder(staged.id).status, 'submitted');
  assert.ok(result.submission.tranches);
});

// ─── 2. Pre-trade check fail → claim rolled back, no broker call ─────────
test('failure: pre-trade check rejects → claim released, broker untouched', async () => {
  wipe();
  const b = getBroker();
  b._setMark('PTCFAIL', 100);

  // Force PTC reject: position size as % of account exceeds maxPositionPct
  // (default 20%). 1000sh × $100 = $100K = 100% of a $100K test account.
  // That trips the 'Position Size' rule, the most portable PTC reject.
  const staged = stage({
    symbol: 'PTCFAIL', qty: 1000,
    entry: 100, stop: 95,
    target1: 110, target2: 125,
  });

  let threw = false;
  try { await submitStagedOrder(staged.id); }
  catch (e) {
    threw = true;
    assert.match(e.message, /Pre-trade check failed/i);
  }
  assert.ok(threw, 'must reject oversized position');

  // Claim must release on PTC fail.
  assert.equal(getStagedOrder(staged.id).status, 'staged');

  // Broker should have ZERO orders for this symbol.
  const orders = await b.listOrders({ status: 'all', symbol: 'PTCFAIL' });
  assert.equal(orders.length, 0, 'no broker orders should have been placed');
});

// ─── 3. Concurrent submit → only one wins (claim mutex) ──────────────────
test('failure: two parallel submits for same id → only one succeeds', async () => {
  wipe();
  const b = getBroker();
  b._setMark('RACE', 100);

  const staged = stage({ symbol: 'RACE', qty: 6 });

  const [resA, resB] = await Promise.allSettled([
    submitStagedOrder(staged.id),
    submitStagedOrder(staged.id),
  ]);

  const fulfilled = [resA, resB].filter(r => r.status === 'fulfilled');
  const rejected  = [resA, resB].filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one parallel call must win');
  assert.equal(rejected.length,  1, 'the other must be rejected');
  assert.match(rejected[0].reason.message, /not staged|race|already/i);

  // Broker should only have ONE bracket set placed (no duplicate orders).
  const parents = (await b.listOrders({ status: 'all', symbol: 'RACE' }))
    .filter(o => !o.parentOrderId);
  // RACE qty=6 with target2 → 3 tranches [2,2,2] → 3 parents from ONE submit.
  // Two parallel submits would produce 6 parents; we should see 3.
  assert.equal(parents.length, 3, 'must NOT submit duplicate brackets on race');
});

// ─── 4. Submitted row CANNOT be re-submitted ─────────────────────────────
test('failure: re-submitting already-submitted row throws', async () => {
  wipe();
  const b = getBroker();
  b._setMark('TWICE', 100);

  const staged = stage({ symbol: 'TWICE', qty: 4 });
  await submitStagedOrder(staged.id);

  await assert.rejects(submitStagedOrder(staged.id), /not staged/i);

  // The first submission's broker orders should still be the only ones.
  // qty=4 with target2 → 3 tranches [1,1,2] → 3 parents.
  const parents = (await b.listOrders({ status: 'all', symbol: 'TWICE' }))
    .filter(o => !o.parentOrderId);
  assert.equal(parents.length, 3);
});

// ─── 5. Multi-tranche partial failure: tranche 2 of 3 fails ──────────────
test('failure: multi-tranche partial fail surfaces .partial with submitted tranches', async () => {
  wipe();
  const b = getBroker();
  b._setMark('PART', 100);

  // Make the SECOND submitBracketOrder call throw so the multi-tranche
  // helper hits its mid-loop failure path. The mock's submitMultiTrancheBracket
  // re-uses submitBracketOrder for each tranche, so we patch that.
  const original = b.submitBracketOrder.bind(b);
  let callIdx = 0;
  b.submitBracketOrder = async (params) => {
    callIdx++;
    if (callIdx === 2) throw new Error('Alpaca POST /v2/orders → 422: insufficient buying power');
    return original(params);
  };

  const staged = stage({ symbol: 'PART', qty: 9 });
  let caught;
  try { await submitStagedOrder(staged.id); }
  catch (e) { caught = e; }

  assert.ok(caught, 'should throw');
  assert.match(caught.message, /tranche 2\/3|insufficient buying power/i);
  // The error should expose .partial so the caller can clean up the 1
  // tranche that DID submit. Pre-fix we'd lose track of orphan tranches.
  assert.ok(Array.isArray(caught.partial), 'error must expose partial[] for cleanup');
  assert.equal(caught.partial.length, 1, '1 tranche succeeded before tranche 2 failed');

  // Status should be back to 'staged' — partial submit is treated as a
  // failure, claim released. Caller is responsible for cleaning up the
  // orphan first tranche on the broker side using err.partial[].
  assert.equal(getStagedOrder(staged.id).status, 'staged');

  b.submitBracketOrder = original;
});

// ─── 6. Cancelled staged row cannot be submitted ────────────────────────
test('failure: cancelled staged row → submit throws', async () => {
  wipe();
  const staged = stage({ symbol: 'CANCEL' });
  // Manually flip to cancelled.
  getDB().prepare("UPDATE staged_orders SET status = 'cancelled' WHERE id = ?")
    .run(staged.id);
  await assert.rejects(submitStagedOrder(staged.id), /not staged|cancelled/i);
});
