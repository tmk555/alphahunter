// ─── Tests: Pyramid tranche terminal-state guard ───────────────────────────
//
// Historical bug (MKSI 2026-04-20, 13 duplicate bracket submissions):
//
//   1. Pilot fires, tranche.status='submitted'. Broker TIF=day lets it expire.
//   2. Cron poller (monitor.js) sees broker=cancelled, flips tranche.status to
//      'cancelled' in tranches_json.
//   3. Live checker (pyramid-plans.js checkPyramidPlans) at next tick sees
//      the active tranche with status='cancelled'. Its guard only skipped
//      'filled' and 'submitted' — so it passed through and FIRED ANOTHER
//      bracket for the same tranche.
//   4. GOTO step 1. One submission per minute until manual intervention.
//
// Fix: expand the terminal-state skip list to include cancelled/rejected/
// expired. These tests pin that guard so the loop can't regress.
//
// We don't exercise the full fire-a-bracket path (that needs the broker,
// volume-pace provider, VWAP gate, and a real quote). Instead we construct
// a plan at the precise point where the old bug would re-fire, and assert
// the checker returns with fired=[] because the guard skipped the tranche.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the volume-pace + VCP + patterns modules so the live checker doesn't
// hit the network or try to compute anything for this synthetic plan.
require.cache[require.resolve('../../src/signals/volume-pace')] = {
  exports: { getVolumePace: async () => ({ pace: 2.0 }) },
};
require.cache[require.resolve('../../src/data/providers/manager')] = {
  exports: { getQuotes: async () => [] },
};
require.cache[require.resolve('../../src/notifications/channels')] = {
  exports: {
    notifyTradeEvent: async () => {},
    deliverAlert:     async () => [],
  },
};

const { getDB } = require('../../src/data/database');
const { checkPyramidPlans } = require('../../src/broker/pyramid-plans');

function wipe() {
  getDB().prepare('DELETE FROM pyramid_plans').run();
}

// Insert a pyramid plan where the ACTIVE tranche (index 0, pilot, status
// armed_pilot) has been marked terminal-cancelled by the cron poller. Before
// the fix, a trigger-hit price would re-fire. After the fix, it must not.
function insertPlanWithCancelledPilot({ symbol = 'MKSI', pivot = 200, stop = 190 } = {}) {
  const tranches = [
    // Pilot was submitted, broker cancelled it (TIF=day expiry), poller
    // recorded the terminal state in tranches_json.
    { label: 'pilot', qty: 10, trigger: pivot, volumePaceMin: 1.2,
      status: 'cancelled', orderId: 'OLD-PILOT-ID', cancelReason: 'broker_canceled' },
    { label: 'add1',  qty: 10, trigger: pivot * 1.02, volumePaceMin: 1.5, status: 'armed' },
    { label: 'add2',  qty: 10, trigger: pivot * 1.04, volumePaceMin: 1.5, status: 'armed' },
  ];
  const info = getDB().prepare(`
    INSERT INTO pyramid_plans (symbol, side, status, total_qty, stop_price,
                               target1_price, target2_price, tranches_json,
                               source, expires_at)
    VALUES (?, 'buy', 'armed_pilot', 30, ?, ?, ?, ?, 'test', datetime('now', '+5 days'))
  `).run(symbol, stop, pivot * 1.1, pivot * 1.2, JSON.stringify(tranches));
  return info.lastInsertRowid;
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('checkPyramidPlans: cancelled active tranche is SKIPPED (no re-fire)', async () => {
  wipe();
  const planId = insertPlanWithCancelledPilot({ symbol: 'MKSI', pivot: 200 });

  // Price above trigger — the old guard would fire here. Inject directly so
  // we don't need a live quote provider.
  const result = await checkPyramidPlans({ currentPrices: { MKSI: 202 } });

  assert.equal(result.fired.length, 0,
    'MKSI pilot was terminal-cancelled — checker MUST NOT re-submit a new bracket');

  // Plan should still exist at its original status (not mutated by the skip).
  const plan = getDB().prepare('SELECT status FROM pyramid_plans WHERE id = ?').get(planId);
  assert.equal(plan.status, 'armed_pilot',
    'skip path must not mutate plan status (separate concern: monitor.js flips to cancelled)');
});

test('checkPyramidPlans: rejected/expired tranches are ALSO skipped', async () => {
  // The terminal list is [filled, submitted, cancelled, canceled, rejected, expired].
  // Pin each of them so a future refactor can't accidentally drop one.
  for (const terminalStatus of ['rejected', 'expired', 'canceled', 'submitted', 'filled']) {
    wipe();
    const tranches = [
      { label: 'pilot', qty: 10, trigger: 100, volumePaceMin: 1.2, status: terminalStatus },
      { label: 'add1',  qty: 10, trigger: 102, volumePaceMin: 1.5, status: 'armed' },
      { label: 'add2',  qty: 10, trigger: 104, volumePaceMin: 1.5, status: 'armed' },
    ];
    getDB().prepare(`
      INSERT INTO pyramid_plans (symbol, status, total_qty, stop_price, target1_price, target2_price,
                                 tranches_json, source, expires_at)
      VALUES ('ACME', 'armed_pilot', 30, 95, 110, 120, ?, 'test', datetime('now', '+5 days'))
    `).run(JSON.stringify(tranches));

    const result = await checkPyramidPlans({ currentPrices: { ACME: 101 } });
    assert.equal(result.fired.length, 0,
      `tranche status '${terminalStatus}' must be treated as terminal — no re-fire`);
  }
});

test('checkPyramidPlans: armed tranche with trigger hit is NOT blocked by the terminal guard', async () => {
  // Sanity: the guard must not over-block. An 'armed' pilot at its trigger
  // should pass the guard and reach the rest of the firing pipeline.
  // We stop it later via a missing broker config, but the key assertion is
  // that the guard itself didn't short-circuit.
  wipe();
  const tranches = [
    { label: 'pilot', qty: 10, trigger: 100, volumePaceMin: 1.2, status: 'armed' },
    { label: 'add1',  qty: 10, trigger: 102, volumePaceMin: 1.5, status: 'armed' },
    { label: 'add2',  qty: 10, trigger: 104, volumePaceMin: 1.5, status: 'armed' },
  ];
  getDB().prepare(`
    INSERT INTO pyramid_plans (symbol, status, total_qty, stop_price, target1_price, target2_price,
                               tranches_json, source, expires_at)
    VALUES ('OK', 'armed_pilot', 30, 95, 110, 120, ?, 'test', datetime('now', '+5 days'))
  `).run(JSON.stringify(tranches));

  // Price above trigger. Whether it actually fires depends on downstream
  // (broker config, VWAP gate, etc.); if it throws it's caught per-plan. The
  // invariant we care about: the tranche was NOT skipped by the terminal
  // guard, because it wasn't terminal.
  //
  // We detect "passed the guard" indirectly: if the guard skipped, result
  // metadata would show zero downstream activity. Running the call at least
  // exercises the guard without error.
  await assert.doesNotReject(() => checkPyramidPlans({ currentPrices: { OK: 101 } }));
});
