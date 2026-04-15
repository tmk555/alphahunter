// ─── Tests: Phase 2.9 slippage prediction + sizer integration ─────────────
//
// Covers src/risk/execution-quality.js's new predictSlippage() API and the
// integration hook in position-sizer.js. We seed the execution_log table
// with controlled fill histories and verify:
//
//   1. Tier A (symbol + side + order_type) match
//   2. Tier B fallback (symbol + side, any order_type)
//   3. Tier C fallback (global side bias)
//   4. Tier D fallback (hard-coded defaults when no history)
//   5. Recency decay (half-life of 30 days)
//   6. "No improvement" clamp (positive slippages silenced)
//   7. Sizer uses the predicted slippage to adjust effective entry
//
// No notifications/network — pure math + sqlite.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getDB } = require('../../src/data/database');
const {
  predictSlippage,
  applyPredictedSlippage,
  DEFAULT_SLIPPAGE_BPS,
  HALF_LIFE_DAYS,
} = require('../../src/risk/execution-quality');
const { calculatePositionSize } = require('../../src/risk/position-sizer');

function wipeExecLog() {
  getDB().prepare('DELETE FROM execution_log').run();
}

// Insert N synthetic fills for (symbol, side, orderType). `slippages` is an
// array of `slippage_pct` values (signed — buyer-paid-more = negative).
// `daysAgo` parallels slippages if you want to control age.
function seedFills(symbol, side, orderType, slippages, daysAgo = null) {
  const ins = getDB().prepare(`
    INSERT INTO execution_log
      (trade_id, symbol, side, intended_price, fill_price, shares, order_type,
       slippage, slippage_pct, fill_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < slippages.length; i++) {
    const pct = slippages[i];
    const age = daysAgo ? daysAgo[i] : 0;
    const fillDate = new Date(Date.now() - age * 86400000).toISOString().slice(0, 10);
    ins.run(null, symbol, side, 100, 100 * (1 + pct / 100), 10, orderType, pct, pct, fillDate);
  }
}

// ─── Tier A: exact match ──────────────────────────────────────────────────

test('predictSlippage: tier A match — exact symbol+side+orderType', () => {
  wipeExecLog();
  // Seed 6 AAPL buys with limit orders, slippage around -8bps to -12bps
  seedFills('AAPL', 'buy', 'limit',
    [-0.08, -0.10, -0.09, -0.11, -0.10, -0.12]);

  const result = predictSlippage({ symbol: 'AAPL', side: 'buy', orderType: 'limit' });
  assert.equal(result.tier, 'A');
  assert.equal(result.basedOn, 'symbol+orderType');
  assert.equal(result.sampleSize, 6);
  // Median is around -0.10 → 10bps
  assert.ok(result.predictedSlippageBps >= 9 && result.predictedSlippageBps <= 11,
    `expected ~10 bps, got ${result.predictedSlippageBps}`);
  // Stress is p90 (worst 10%) — should be worse than median.
  assert.ok(result.stressSlippageBps >= result.predictedSlippageBps);
});

// ─── Tier B: same symbol, any order type ──────────────────────────────────

test('predictSlippage: tier B fallback — mixed order types', () => {
  wipeExecLog();
  // 2 limit + 4 market → can't reach MIN_SAMPLE_TIER_A for limit alone,
  // but together should go to tier B.
  seedFills('MSFT', 'buy', 'limit',  [-0.05, -0.07]);
  seedFills('MSFT', 'buy', 'market', [-0.20, -0.25, -0.22, -0.18]);

  const result = predictSlippage({ symbol: 'MSFT', side: 'buy', orderType: 'limit' });
  assert.equal(result.tier, 'B');
  assert.equal(result.basedOn, 'symbol');
  assert.equal(result.sampleSize, 6);
  // Mix of limit(-5 to -7) and market(-18 to -25): median falls in between.
  assert.ok(result.predictedSlippageBps > 0);
});

// ─── Tier C: global side bias ─────────────────────────────────────────────

test('predictSlippage: tier C fallback — global side-level data', () => {
  wipeExecLog();
  // 0 rows for NVDA specifically. But enough global buy-side rows to
  // trigger tier C.
  for (let i = 0; i < 12; i++) {
    seedFills(`STOCK${i}`, 'buy', 'limit', [-0.15]);
  }

  const result = predictSlippage({ symbol: 'NVDA', side: 'buy', orderType: 'limit' });
  assert.equal(result.tier, 'C');
  assert.equal(result.basedOn, 'side');
  assert.equal(result.sampleSize, 12);
  assert.ok(result.predictedSlippageBps >= 14 && result.predictedSlippageBps <= 16,
    `expected ~15 bps, got ${result.predictedSlippageBps}`);
});

// ─── Tier D: no data → default table ─────────────────────────────────────

test('predictSlippage: tier D fallback — no history at all → default table', () => {
  wipeExecLog();
  const result = predictSlippage({ symbol: 'TSLA', side: 'buy', orderType: 'market' });
  assert.equal(result.tier, 'D');
  assert.equal(result.basedOn, 'default');
  assert.equal(result.predictedSlippageBps, DEFAULT_SLIPPAGE_BPS.market);
  // Stress is 2× the default.
  assert.equal(result.stressSlippageBps, DEFAULT_SLIPPAGE_BPS.market * 2);
});

test('predictSlippage: tier D — unknown order type falls back to default', () => {
  wipeExecLog();
  const result = predictSlippage({ symbol: 'TSLA', side: 'buy', orderType: 'bracketed_twap_v2' });
  assert.equal(result.tier, 'D');
  assert.equal(result.predictedSlippageBps, DEFAULT_SLIPPAGE_BPS.default);
});

// ─── Recency decay ────────────────────────────────────────────────────────

test('predictSlippage: recency decay — fresh fills weighted more than stale', () => {
  wipeExecLog();
  // Seed 5 old "bad" fills (-30 bps, 120 days ago) and 5 recent "good"
  // fills (-5 bps, today). With HALF_LIFE_DAYS=30, the 120d weight is
  // (0.5)^4 ≈ 0.0625 while today's weight is 1.0 → recent median should
  // dominate.
  seedFills('AAA', 'buy', 'limit', [-0.30, -0.30, -0.30, -0.30, -0.30], [120, 120, 120, 120, 120]);
  seedFills('AAA', 'buy', 'limit', [-0.05, -0.05, -0.05, -0.05, -0.05], [0, 0, 0, 0, 0]);

  const result = predictSlippage({ symbol: 'AAA', side: 'buy', orderType: 'limit' });
  assert.equal(result.tier, 'A');
  assert.ok(result.predictedSlippageBps < 15,
    `expected recent (small) slippage to dominate, got ${result.predictedSlippageBps} bps`);
});

// ─── "No improvement allowed" clamp ───────────────────────────────────────

test('predictSlippage: positive slippages (improvement) are clamped to zero', () => {
  wipeExecLog();
  // Trader "got better than intended" every time — either lucky or a
  // logging bug. Either way, do NOT reward the sizer with a negative cost.
  seedFills('LUCKY', 'buy', 'limit', [0.05, 0.08, 0.03, 0.10, 0.04, 0.07]);

  const result = predictSlippage({ symbol: 'LUCKY', side: 'buy', orderType: 'limit' });
  assert.equal(result.tier, 'A');
  assert.equal(result.predictedSlippageBps, 0);
  assert.equal(result.predictedSlippagePct, 0);
});

// ─── applyPredictedSlippage helper ────────────────────────────────────────

test('applyPredictedSlippage: buy → inflates entry, sell → deflates exit', () => {
  const pred = { predictedSlippageBps: 50 };  // 50 bps = 0.5%
  assert.equal(+applyPredictedSlippage(100, 'buy', pred).toFixed(4), 100.50);
  assert.equal(+applyPredictedSlippage(100, 'sell', pred).toFixed(4), 99.50);
});

test('applyPredictedSlippage: missing inputs → identity', () => {
  assert.equal(applyPredictedSlippage(100, 'buy', null), 100);
  assert.equal(applyPredictedSlippage(0, 'buy', { predictedSlippageBps: 50 }), 0);
});

// ─── Missing input guards ─────────────────────────────────────────────────

test('predictSlippage: missing symbol/side → default tier D, no crash', () => {
  const r = predictSlippage({});
  assert.equal(r.tier, 'D');
  assert.equal(r.basedOn, 'default');
  assert.ok(r.predictedSlippageBps > 0);
});

// ─── Position sizer integration ───────────────────────────────────────────

test('sizer integration: slippage prediction inflates effective entry on buys', () => {
  wipeExecLog();
  // Seed 7 AAPL buys at -20 bps each → predictedSlippageBps = 20.
  seedFills('AAPL', 'buy', 'limit', [-0.20, -0.20, -0.20, -0.20, -0.20, -0.20, -0.20]);

  const result = calculatePositionSize({
    accountSize: 100000,
    riskPerTrade: 1.0,
    entryPrice: 100,
    stopPrice: 95,
    candidateSymbol: 'AAPL',
    side: 'buy',
    orderType: 'limit',
  });

  assert.ok(result.slippagePrediction);
  assert.equal(result.intendedEntry, 100);
  // Effective entry ≈ 100 × (1 + 20/10000) = 100.20
  assert.ok(Math.abs(result.effectiveEntry - 100.20) < 0.01,
    `expected effectiveEntry ≈ 100.20, got ${result.effectiveEntry}`);
  assert.equal(result.slippagePrediction.tier, 'A');
});

test('sizer integration: skipSlippageAdjustment bypasses lookup', () => {
  wipeExecLog();
  // Even with seeded data, the skip flag should leave the effective
  // entry equal to the intended entry.
  seedFills('AAPL', 'buy', 'limit', [-0.50, -0.50, -0.50, -0.50, -0.50, -0.50]);

  const result = calculatePositionSize({
    accountSize: 100000,
    riskPerTrade: 1.0,
    entryPrice: 100,
    stopPrice: 95,
    candidateSymbol: 'AAPL',
    side: 'buy',
    orderType: 'limit',
    skipSlippageAdjustment: true,
  });

  assert.equal(result.slippagePrediction, null);
  assert.equal(result.effectiveEntry, 100);
});

test('sizer integration: slippagePrediction override bypasses DB lookup', () => {
  wipeExecLog();
  // No DB rows → normally falls to tier D. With an explicit override the
  // sizer trusts the passed-in value.
  const result = calculatePositionSize({
    accountSize: 100000,
    riskPerTrade: 1.0,
    entryPrice: 100,
    stopPrice: 95,
    candidateSymbol: 'AAPL',
    side: 'buy',
    orderType: 'limit',
    slippagePrediction: {
      predictedSlippageBps: 100,   // 1%
      tier: 'custom',
      tierLabel: 'test override',
    },
  });

  assert.equal(result.slippagePrediction.tier, 'custom');
  // 100 × (1 + 100/10000) = 101.0
  assert.ok(Math.abs(result.effectiveEntry - 101) < 0.01,
    `expected effectiveEntry ≈ 101, got ${result.effectiveEntry}`);
});

test('sizer integration: zero historical data → tier D default, sizer still works', () => {
  wipeExecLog();
  const result = calculatePositionSize({
    accountSize: 100000,
    riskPerTrade: 1.0,
    entryPrice: 100,
    stopPrice: 95,
    candidateSymbol: 'BRAND_NEW_TICKER',
    side: 'buy',
    orderType: 'limit',
  });

  assert.ok(result.slippagePrediction);
  assert.equal(result.slippagePrediction.tier, 'D');
  assert.ok(result.shares > 0);  // still produces a valid sizing
});

// ─── Constants pinned ─────────────────────────────────────────────────────

test('DEFAULT_SLIPPAGE_BPS: market > stop > limit (sanity check on defaults)', () => {
  // Market orders should be the most expensive by construction.
  assert.ok(DEFAULT_SLIPPAGE_BPS.market >= DEFAULT_SLIPPAGE_BPS.limit);
  assert.ok(DEFAULT_SLIPPAGE_BPS.stop   >= DEFAULT_SLIPPAGE_BPS.limit);
  // Half-life is plausible.
  assert.ok(HALF_LIFE_DAYS > 0 && HALF_LIFE_DAYS < 365);
});
