// ─── Tests: Phase 2.7 statistical significance layer ──────────────────────
//
// Covers src/signals/statistics.js — the math that gates whether a backtest
// result gets a "statistically significant" badge in the UI. These tests
// deliberately go heavy on well-known closed-form cases (IID normals,
// degenerate inputs, extreme samples) so a future refactor that breaks the
// formulas gets caught here before it ships to the dashboard.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mean, stddev, maxDrawdown,
  sharpeRatio, sharpeTStat, sharpePValue,
  calmarRatio, bootstrapCI,
  assessSignificance,
  MIN_TRADES_FOR_SIGNIFICANCE,
} = require('../../src/signals/statistics');

// ─── Basic utilities ───────────────────────────────────────────────────────

test('mean: handles empty, single, and normal inputs', () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([5]), 5);
  assert.equal(mean([1, 2, 3, 4, 5]), 3);
  assert.equal(mean([-2, -1, 0, 1, 2]), 0);
});

test('stddev: sample vs population, degenerate cases', () => {
  // Sample std of [1,2,3,4,5] is sqrt(10/4) = sqrt(2.5) ≈ 1.5811
  assert.ok(Math.abs(stddev([1, 2, 3, 4, 5]) - 1.5811388) < 1e-6);
  // Population std of same input is sqrt(10/5) = sqrt(2) ≈ 1.4142
  assert.ok(Math.abs(stddev([1, 2, 3, 4, 5], { ddof: 0 }) - Math.SQRT2) < 1e-6);
  // Constant array → 0
  assert.equal(stddev([7, 7, 7, 7]), 0);
  // Single element can't have sample std → 0 (not NaN)
  assert.equal(stddev([42]), 0);
  assert.equal(stddev([]), 0);
});

// ─── Sharpe ratio ──────────────────────────────────────────────────────────

test('sharpeRatio: zero variance → 0 (not NaN/Infinity)', () => {
  // Every return equal → stddev = 0 → sharpe = 0 (not NaN)
  assert.equal(sharpeRatio([0.01, 0.01, 0.01, 0.01, 0.01]), 0);
  assert.equal(sharpeRatio([]), 0);
  assert.equal(sharpeRatio([0.01]), 0);
});

test('sharpeRatio: sign matches mean direction', () => {
  // Positive mean → positive Sharpe
  const winners = [0.02, 0.01, 0.03, -0.01, 0.02, 0.01, 0.02];
  assert.ok(sharpeRatio(winners) > 0);
  // Negative mean → negative Sharpe
  const losers  = [-0.02, -0.01, -0.03, 0.01, -0.02, -0.01, -0.02];
  assert.ok(sharpeRatio(losers) < 0);
});

test('sharpeRatio: annualization scales with sqrt(periodsPerYear)', () => {
  const rets = [0.01, 0.015, -0.005, 0.008, 0.012, 0.02, -0.003, 0.007];
  const daily = sharpeRatio(rets, 252);
  const weekly = sharpeRatio(rets, 52);
  // Daily annualization multiplier sqrt(252) ≈ 15.87, weekly sqrt(52) ≈ 7.21
  // so daily / weekly ≈ 2.20
  assert.ok(Math.abs(daily / weekly - Math.sqrt(252 / 52)) < 1e-10);
});

test('sharpeRatio: risk-free rate lowers Sharpe', () => {
  const rets = new Array(100).fill(0.001);  // 0.1%/day ≈ 25% annual
  // With stddev=0 this is actually degenerate — use slight variance instead.
  const rets2 = rets.map((r, i) => r + (i % 2 === 0 ? 0.0001 : -0.0001));
  const zeroRf = sharpeRatio(rets2, 252, 0);
  const highRf = sharpeRatio(rets2, 252, 0.05);  // 5% annual RFR
  assert.ok(highRf < zeroRf, 'higher risk-free rate must reduce Sharpe');
});

// ─── Sharpe t-stat ─────────────────────────────────────────────────────────

test('sharpeTStat: zero edge → zero t-stat', () => {
  // Symmetric around zero → mean ≈ 0 → Sharpe ≈ 0 → t-stat ≈ 0
  const rets = [];
  for (let i = 0; i < 100; i++) rets.push(i % 2 === 0 ? 0.01 : -0.01);
  assert.ok(Math.abs(sharpeTStat(rets)) < 0.01);
});

test('sharpeTStat: longer samples yield higher |t| for the same Sharpe', () => {
  // Same distribution, different sample sizes. |t| should scale with sqrt(N).
  const short = [];
  const long  = [];
  // Deterministic pseudo-random: fixed pattern so we don't depend on seed.
  const pattern = [0.015, -0.005, 0.02, 0.008, -0.002, 0.012];
  for (let i = 0; i < 30; i++)  short.push(pattern[i % pattern.length]);
  for (let i = 0; i < 300; i++) long.push(pattern[i % pattern.length]);

  const tShort = sharpeTStat(short);
  const tLong  = sharpeTStat(long);
  assert.ok(Math.abs(tLong) > Math.abs(tShort),
    `|t_long| should exceed |t_short|: long=${tLong}, short=${tShort}`);
});

test('sharpePValue: t=0 → p=0.5, large t → p→0, negative t → p→1', () => {
  // One-sided test
  assert.ok(Math.abs(sharpePValue(0) - 0.5) < 1e-6);
  // t = 1.96 → p ≈ 0.025 (one-sided 97.5%)
  assert.ok(Math.abs(sharpePValue(1.96) - 0.025) < 0.001);
  // t = 2.576 → p ≈ 0.005 (one-sided 99.5%)
  assert.ok(Math.abs(sharpePValue(2.576) - 0.005) < 0.001);
  // Strongly negative t → p close to 1
  assert.ok(sharpePValue(-3) > 0.99);
  // Non-finite input → safe default (1)
  assert.equal(sharpePValue(NaN), 1);
  assert.equal(sharpePValue(Infinity), 0);  // 1 - 1 = 0 on +Inf
});

// ─── Max drawdown ──────────────────────────────────────────────────────────

test('maxDrawdown: monotone up → 0', () => {
  assert.equal(maxDrawdown([100, 110, 120, 130, 140]), 0);
  assert.equal(maxDrawdown([{ equity: 100 }, { equity: 110 }, { equity: 120 }]), 0);
});

test('maxDrawdown: V-shape', () => {
  // Peak 100 → trough 80 → recover 100 → drawdown = 20%
  const dd = maxDrawdown([100, 90, 80, 90, 100]);
  assert.ok(Math.abs(dd - 0.20) < 1e-10, `expected 0.20, got ${dd}`);
});

test('maxDrawdown: captures worst drawdown, not last', () => {
  // Peak 100 → 50 (50% DD) → recover 200 → small dip to 190 (5%).
  // Must report 50%, not 5%.
  // Note: after recovery to 200, new peak is 200. Dip to 190 is 5% DD.
  // Worst ever is 50%.
  const dd = maxDrawdown([100, 50, 200, 190]);
  assert.ok(Math.abs(dd - 0.50) < 1e-10, `expected 0.50, got ${dd}`);
});

test('maxDrawdown: empty input → 0', () => {
  assert.equal(maxDrawdown([]), 0);
  assert.equal(maxDrawdown(null), 0);
});

// ─── Calmar ratio ──────────────────────────────────────────────────────────

test('calmarRatio: positive return with drawdown → positive Calmar', () => {
  // 50% return over 365 days with 10% max drawdown → CAGR=50% → Calmar=5.0
  const c = calmarRatio(50, 10, 365.25);
  assert.ok(Math.abs(c - 5.0) < 1e-6, `expected ~5.0, got ${c}`);
});

test('calmarRatio: zero drawdown with positive return → Infinity', () => {
  const c = calmarRatio(20, 0, 365);
  assert.equal(c, Infinity);
});

test('calmarRatio: zero drawdown with negative return → 0', () => {
  const c = calmarRatio(-10, 0, 365);
  assert.equal(c, 0);
});

test('calmarRatio: missing days → 0 (cannot annualize)', () => {
  assert.equal(calmarRatio(20, 5, 0), 0);
  assert.equal(calmarRatio(20, 5, null), 0);
});

test('calmarRatio: wipeout (return ≤ -100%) clamps to -1 CAGR', () => {
  // Losing 100% over 1 year: CAGR = -100%, |DD|=100% → Calmar = -1
  const c = calmarRatio(-100, 100, 365.25);
  assert.equal(c, -1);
});

// ─── Bootstrap CI ──────────────────────────────────────────────────────────

test('bootstrapCI: CI brackets the sample mean', () => {
  // Well-behaved sample — CI on the mean should include the true mean.
  const xs = [];
  for (let i = 0; i < 200; i++) xs.push(i % 2 === 0 ? 2 : -1);  // mean = 0.5
  const ci = bootstrapCI(xs, mean, { iterations: 500, confidence: 0.95 });
  assert.ok(ci.lower < 0.5 && ci.upper > 0.5,
    `95% CI [${ci.lower}, ${ci.upper}] should bracket sample mean 0.5`);
});

test('bootstrapCI: tighter CI for larger samples', () => {
  // Same distribution, different N → CI width should shrink.
  const small = [1, -1, 2, -1, 3, -2, 1, -1, 2, -1];
  const large = [];
  for (let i = 0; i < 1000; i++) large.push(small[i % small.length]);

  const ciSmall = bootstrapCI(small, mean, { iterations: 500 });
  const ciLarge = bootstrapCI(large, mean, { iterations: 500 });
  const widthSmall = ciSmall.upper - ciSmall.lower;
  const widthLarge = ciLarge.upper - ciLarge.lower;
  assert.ok(widthLarge < widthSmall,
    `expected large-N CI (${widthLarge.toFixed(3)}) to be tighter than small-N CI (${widthSmall.toFixed(3)})`);
});

test('bootstrapCI: reproducible with same seed', () => {
  const xs = [1, 2, 3, 4, 5, -1, -2, 3, 4, 2];
  const a = bootstrapCI(xs, mean, { iterations: 200, seed: 99 });
  const b = bootstrapCI(xs, mean, { iterations: 200, seed: 99 });
  assert.equal(a.lower, b.lower);
  assert.equal(a.upper, b.upper);
});

test('bootstrapCI: empty input → zeros, no crash', () => {
  const ci = bootstrapCI([], mean);
  assert.equal(ci.lower, 0);
  assert.equal(ci.upper, 0);
  assert.equal(ci.iterations, 0);
});

// ─── assessSignificance aggregator ─────────────────────────────────────────

test('assessSignificance: insufficient sample flags verdict correctly', () => {
  // Just 10 trades — well below MIN_TRADES_FOR_SIGNIFICANCE (30).
  const rets = [5, -2, 3, 1, -1, 4, 2, -3, 2, 1];
  const out = assessSignificance(rets);
  assert.equal(out.verdict, 'insufficient_sample');
  assert.equal(out.isSignificant, false);
  assert.equal(out.sampleSize, 10);
  assert.match(out.reason, /≥30 trades/);
});

test('assessSignificance: strong edge on big sample → significant', () => {
  // 100 trades, consistent edge: 60% winners at +3%, 40% losers at -2%.
  // Expected mean ≈ +1% per trade, very little noise.
  const rets = [];
  for (let i = 0; i < 100; i++) rets.push(i % 10 < 6 ? 3 : -2);
  const out = assessSignificance(rets, { tradesPerYear: 50 });
  assert.ok(out.sampleSize === 100);
  assert.ok(out.verdict === 'significant' || out.verdict === 'highly_significant',
    `expected significant verdict, got ${out.verdict} (t=${out.tStat}, p=${out.pValue})`);
  assert.ok(out.isSignificant);
  assert.ok(out.pValue < 0.05);
  assert.ok(out.sharpeRatio > 0);
});

test('assessSignificance: zero-edge coin flip → not significant', () => {
  // 100 trades, symmetric around 0 → no edge.
  const rets = [];
  for (let i = 0; i < 100; i++) rets.push(i % 2 === 0 ? 2 : -2);
  const out = assessSignificance(rets, { tradesPerYear: 50 });
  assert.equal(out.sampleSize, 100);
  assert.equal(out.verdict, 'not_significant');
  assert.equal(out.isSignificant, false);
  assert.ok(out.pValue > 0.05);
});

test('assessSignificance: bootstrap CIs included when iterations > 0', () => {
  const rets = [];
  for (let i = 0; i < 50; i++) rets.push(i % 3 === 0 ? -1 : 2);
  const out = assessSignificance(rets, { bootstrapIters: 200 });
  assert.ok(out.bootstrapMeanReturn);
  assert.ok(out.bootstrapWinRate);
  assert.equal(out.bootstrapMeanReturn.iterations, 200);
  assert.ok(out.bootstrapMeanReturn.lower < out.bootstrapMeanReturn.upper);
  // Win-rate CI should be in [0, 100] percent.
  assert.ok(out.bootstrapWinRate.lower >= 0 && out.bootstrapWinRate.upper <= 100);
});

test('assessSignificance: bootstrap skipped when iterations = 0 (fast path)', () => {
  const rets = new Array(50).fill(1);
  const out = assessSignificance(rets, { bootstrapIters: 0 });
  assert.equal(out.bootstrapMeanReturn, null);
  assert.equal(out.bootstrapWinRate, null);
});

test('assessSignificance: Calmar included when caller supplies MDD + days', () => {
  const rets = new Array(40).fill(0).map((_, i) => (i % 5 === 0 ? -1.5 : 1));
  const out = assessSignificance(rets, {
    totalReturnPct: 25,
    maxDrawdownPct: 8,
    days: 200,
  });
  assert.ok(out.calmarRatio != null);
  assert.ok(out.calmarRatio > 0, `expected positive Calmar, got ${out.calmarRatio}`);
});

test('assessSignificance: Calmar null when MDD missing', () => {
  const rets = new Array(40).fill(1);
  const out = assessSignificance(rets, { totalReturnPct: 10 });  // no MDD or days
  assert.equal(out.calmarRatio, null);
});

test('assessSignificance: zero-trade input → insufficient sample, no crash', () => {
  const out = assessSignificance([]);
  assert.equal(out.verdict, 'insufficient_sample');
  assert.equal(out.sampleSize, 0);
  assert.equal(out.sharpeRatio, 0);
  assert.equal(out.tStat, 0);
});

test('assessSignificance: verdict shape is stable (dashboard contract)', () => {
  // Pin the shape so dashboards can rely on these keys existing.
  const out = assessSignificance([1, 2, 3], { bootstrapIters: 100 });
  const required = [
    'sampleSize', 'minSampleForSignificance',
    'sharpeRatio', 'tStat', 'pValue', 'calmarRatio',
    'bootstrapMeanReturn', 'bootstrapWinRate',
    'confidenceLevel', 'verdict', 'isSignificant', 'reason',
  ];
  for (const key of required) {
    assert.ok(key in out, `missing required field "${key}"`);
  }
});

test('assessSignificance: MIN_TRADES_FOR_SIGNIFICANCE exported and equals 30', () => {
  // Pin the threshold so someone who lowers it has to update this test —
  // dropping below 30 would start greenlighting lucky-streak backtests.
  assert.equal(MIN_TRADES_FOR_SIGNIFICANCE, 30);
});
