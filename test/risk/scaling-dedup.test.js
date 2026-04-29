// ─── Tests: scaling-engine target-hit dedup (src/risk/scaling.js) ──────────
//
// Pre-fix the scaling engine's tookT1 / tookT2 check was:
//   const tookT1 = partials.some(p => p.level === 'target1');
// ...so when fills-sync (or a legacy row) recorded a target-priced fill
// labeled 'auto_sync_prorata', the scaling engine ran AGAIN at the next
// tick and pushed its own partial_exit for the same fill. AVGO surfaced
// this: journal sum drifted to 8 shares while Alpaca held 14 because
// every TP fill was being counted twice. This test pins the new
// label-OR-price-match logic so the regression can't reappear.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateScalingAction } = require('../../src/risk/scaling');

function mkTrade({ remaining = 8, target1 = 428.16, target2 = 447.49,
                   stop = 380, entry = 393.81, partials = [] } = {}) {
  return {
    side: 'long',
    initial_shares: 8,
    shares: 8,
    remaining_shares: remaining,
    target1, target2, stop_price: stop, entry_price: entry,
    partial_exits: JSON.stringify(partials),
    trailing_stop_active: 0,
    trail_pct: 0.08,
    exit_strategy: 'full_in_scale_out',
  };
}

test('dedup: explicit target1 label → tookT1=true, no re-fire', () => {
  const trade = mkTrade({
    remaining: 6,
    partials: [{ level: 'target1', shares: 2, price: 428.16 }],
  });
  const action = evaluateScalingAction(trade, 428.20);
  assert.equal(action, null, 'should NOT propose another target1 partial');
});

test('dedup: auto_sync_prorata at target1 price → tookT1=true (label-or-price match)', () => {
  const trade = mkTrade({
    remaining: 6,
    partials: [{ level: 'auto_sync_prorata', shares: 2, price: 428.16,
                 order_id: 'broker-fill-abc' }],
  });
  const action = evaluateScalingAction(trade, 428.20);
  // Pre-fix this returned a partial_exit action for target1 — the bug.
  assert.equal(action, null,
    'price-proximity must recognize the target hit even with mislabeled level');
});

test('dedup: auto_sync_prorata at NON-target price → does NOT block target1', () => {
  // A market sell unrelated to target1 (e.g. user manually trimmed) should
  // not suppress a real future target1 hit. Verify the price-proximity
  // check is bounded by the penny tolerance.
  const trade = mkTrade({
    remaining: 6,
    partials: [{ level: 'auto_sync_prorata', shares: 2, price: 410.00 }],
  });
  const action = evaluateScalingAction(trade, 428.20);
  assert.ok(action, 'should propose target1 partial');
  assert.equal(action.level, 'target1');
});

test('dedup: target2 label OR price match → tookT2=true', () => {
  // target2 path — same logic.
  const trade = mkTrade({
    remaining: 4,
    partials: [
      { level: 'target1', shares: 2, price: 428.16 },
      { level: 'auto_sync', shares: 2, price: 447.49 },  // mislabeled t2
    ],
  });
  const action = evaluateScalingAction(trade, 447.55);
  assert.equal(action, null, 'price-proximity must catch mislabeled target2 too');
});

test('penny tolerance: 0.005 below target1 still counts (PENNY=0.01)', () => {
  const trade = mkTrade({
    remaining: 6,
    partials: [{ level: 'auto_sync_prorata', shares: 2, price: 428.155,
                 order_id: 'fill' }],  // half a cent below target1=428.16
  });
  const action = evaluateScalingAction(trade, 428.20);
  assert.equal(action, null, '0.5c below target1 must count as hit');
});

test('penny tolerance: 0.02 below target1 does NOT count', () => {
  const trade = mkTrade({
    remaining: 6,
    partials: [{ level: 'auto_sync_prorata', shares: 2, price: 428.14 }],  // 2c below
  });
  const action = evaluateScalingAction(trade, 428.20);
  assert.ok(action, 'fill 2c below target should not suppress a future target1');
  assert.equal(action.level, 'target1');
});
