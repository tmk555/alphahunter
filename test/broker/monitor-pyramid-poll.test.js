// ─── Tests: Pyramid tranche cron poller (src/broker/monitor.js) ───────────
//
// Companion to pyramid-terminal.test.js. That test pins the live checker's
// guard; this test pins the POLLER that populates tranche.status in the
// first place AND kills the plan when the cancelled tranche was the active
// one.
//
// Historical bug recap: cron poller flipped tranche.status='cancelled' on a
// broker expiry but left plan.status='armed_pilot'. Live checker ran the
// next tick, the old guard didn't catch 'cancelled', so a new bracket fired.
// Fix: if the cancelled tranche's index matches the plan's active idx (via
// ACTIVE_IDX_BY_STATUS), flip plan.status='cancelled' in the same DB write.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub alpaca BEFORE requiring monitor (both importers — monitor directly,
// and pyramid-plans via handleTrancheFill transitively).
const alpacaStub = {
  _ordersById: new Map(),
  getOrder: async (id) => alpacaStub._ordersById.get(id) || null,
  // Stubbed so pyramid-plans' handleTrancheFill (invoked on 'filled' branch)
  // doesn't blow up. Return something that looks like an Alpaca order.
  getConfig: () => ({ configured: false }),
};
require.cache[require.resolve('../../src/broker/alpaca')] = { exports: alpacaStub };

// Stub handleTrancheFill so the 'filled' branch doesn't drag in the whole
// bracket-submit pipeline. For these tests we only care about:
//   • tranche.status transitions on cancel
//   • plan.status flip when active tranche is cancelled
let _handleFillSpy = [];
require.cache[require.resolve('../../src/broker/pyramid-plans')] = {
  exports: {
    handleTrancheFill: async (orderId, info) => { _handleFillSpy.push({ orderId, info }); },
    checkPyramidPlans: async () => ({ checked: 0, fired: [], cancelled: [] }),
  },
};

const { getDB } = require('../../src/data/database');
const { pollPyramidTrancheStatus } = require('../../src/broker/monitor');

function wipe() {
  getDB().prepare('DELETE FROM pyramid_plans').run();
  alpacaStub._ordersById.clear();
  _handleFillSpy = [];
}

// Insert a plan at a given status with tranches_json. Pilot has a submitted
// orderId the poller will look up against alpacaStub.
function insertPlan({ status = 'armed_pilot', pilotOrderId = 'P1', pilotStatus = 'submitted',
                      add1OrderId = null, add1Status = 'armed' } = {}) {
  const tranches = [
    { label: 'pilot', qty: 10, trigger: 100, volumePaceMin: 1.2,
      status: pilotStatus, orderId: pilotOrderId },
    { label: 'add1',  qty: 10, trigger: 102, volumePaceMin: 1.5,
      status: add1Status, orderId: add1OrderId },
    { label: 'add2',  qty: 10, trigger: 104, volumePaceMin: 1.5, status: 'armed' },
  ];
  const info = getDB().prepare(`
    INSERT INTO pyramid_plans (symbol, side, status, total_qty, stop_price,
                               target1_price, target2_price, tranches_json, source)
    VALUES ('TEST', 'buy', ?, 30, 95, 110, 120, ?, 'test')
  `).run(status, JSON.stringify(tranches));
  return info.lastInsertRowid;
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('poll: broker cancels ACTIVE pilot → tranche AND plan flip to cancelled', async () => {
  wipe();
  const planId = insertPlan({ status: 'armed_pilot', pilotOrderId: 'P1', pilotStatus: 'submitted' });
  alpacaStub._ordersById.set('P1', { id: 'P1', status: 'canceled' });

  await pollPyramidTrancheStatus();

  const plan = getDB().prepare('SELECT status, tranches_json, notes FROM pyramid_plans WHERE id = ?').get(planId);
  assert.equal(plan.status, 'cancelled',
    'active tranche cancelled by broker → plan MUST be killed (prevents retry loop)');

  const tranches = JSON.parse(plan.tranches_json);
  assert.equal(tranches[0].status, 'cancelled');
  assert.equal(tranches[0].cancelReason, 'broker_canceled');
  assert.match(plan.notes || '', /active tranche cancelled by broker/);
});

test('poll: rejected pilot → tranche.status=rejected, plan killed', async () => {
  wipe();
  const planId = insertPlan({ status: 'armed_pilot', pilotOrderId: 'P1', pilotStatus: 'submitted' });
  alpacaStub._ordersById.set('P1', { id: 'P1', status: 'rejected' });

  await pollPyramidTrancheStatus();

  const plan = getDB().prepare('SELECT status, tranches_json FROM pyramid_plans WHERE id = ?').get(planId);
  const tranches = JSON.parse(plan.tranches_json);
  assert.equal(tranches[0].status, 'rejected',
    'rejected tranches preserve the distinct status (not rewritten to cancelled)');
  assert.equal(plan.status, 'cancelled', 'plan still dies');
});

test('poll: broker cancels NON-ACTIVE tranche → plan stays alive', async () => {
  // Plan is at 'pilot_filled' (activeIdx=1 → add1). A cancelled tranche at
  // index 0 (old pilot, already filled) should NOT kill the plan.
  wipe();
  const planId = insertPlan({
    status: 'pilot_filled',
    pilotOrderId: 'P-OLD',
    pilotStatus: 'submitted',   // Stale 'submitted' — will be looked up
    add1OrderId: null, add1Status: 'armed',
  });
  // Hypothetically stale pilot order at broker returned cancelled long ago.
  alpacaStub._ordersById.set('P-OLD', { id: 'P-OLD', status: 'canceled' });

  await pollPyramidTrancheStatus();

  const plan = getDB().prepare('SELECT status FROM pyramid_plans WHERE id = ?').get(planId);
  assert.equal(plan.status, 'pilot_filled',
    'cancelled tranche at idx 0 when active is idx 1 → plan must stay alive');
});

test('poll: pilot filled → handleTrancheFill called with broker data', async () => {
  wipe();
  insertPlan({ status: 'armed_pilot', pilotOrderId: 'P1', pilotStatus: 'submitted' });
  alpacaStub._ordersById.set('P1', {
    id: 'P1', status: 'filled', filledAvgPrice: 101.25, filledQty: 10,
  });

  await pollPyramidTrancheStatus();

  assert.equal(_handleFillSpy.length, 1);
  assert.equal(_handleFillSpy[0].orderId, 'P1');
  assert.deepEqual(_handleFillSpy[0].info, { avgFillPrice: 101.25, filledQty: 10 });
});

test('poll: tranche without orderId or not-submitted is skipped cleanly', async () => {
  wipe();
  // Pilot has no orderId yet (not submitted) — poller must not crash.
  const planId = insertPlan({ status: 'armed_pilot', pilotOrderId: null, pilotStatus: 'armed' });

  await assert.doesNotReject(() => pollPyramidTrancheStatus());

  const plan = getDB().prepare('SELECT status FROM pyramid_plans WHERE id = ?').get(planId);
  assert.equal(plan.status, 'armed_pilot', 'plan unchanged when nothing to poll');
});
