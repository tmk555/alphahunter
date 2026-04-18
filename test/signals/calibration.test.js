// ─── Tests: calibration analytics ───────────────────────────────────────────
//
// Hand-computable cases for Brier, tier-level reliability, strategy metrics,
// and the degradation multiplier. Populates an in-memory DB with a mix of
// winners, losers, and neutrals covering all three confidence tiers.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getDB } = require('../../src/data/database');
getDB();

const { logSignal, resolveOutcome } = require('../../src/signals/edge-telemetry');
const {
  brierScore,
  calibrationByConfidenceTier,
  metricsOverRows,
  strategyMetrics,
  degradationMultipliers,
  loadResolved,
  fullReport,
} = require('../../src/signals/calibration');

// Helper: insert N signals with a specific tier/strategy, resolve them with
// the given outcome label and ret_20d value.
function seed({ source = 'trade_setup', strategy, confidence, count, label, ret20, entry = 100 }) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = logSignal({
      source,
      symbol: `T${i}${strategy}${confidence}`,
      strategy,
      verdict: 'BUY',
      confidence,
      entry_price: entry,
      stop_price: entry * 0.95,
      target1_price: entry * 1.10,
      emission_date: '2024-01-01',
    });
    resolveOutcome(id, {
      status: 'resolved',
      close_price_5d: entry * (1 + ret20 * 0.25),
      close_price_10d: entry * (1 + ret20 * 0.5),
      close_price_20d: entry * (1 + ret20),
      ret_5d: ret20 * 0.25,
      ret_10d: ret20 * 0.5,
      ret_20d: ret20,
      max_favorable: Math.max(0, ret20),
      max_adverse: Math.min(0, ret20),
      hit_stop: label === 'loser',
      hit_target1: label === 'winner',
      hit_target2: false,
      realized_r: ret20 / 0.05,                         // stop is 5% → R = ret/5%
      outcome_label: label,
    });
    ids.push(id);
  }
  return ids;
}

// ─── Brier score ───────────────────────────────────────────────────────────

test('brierScore: perfect calibration gives score matching theoretical value', () => {
  // Fresh DB state via seed — 4 "high" winners, tier predicted 0.75.
  // Brier = mean((0.75-1)^2) = 0.0625
  seed({ strategy: 'perfect', confidence: 'high', count: 4, label: 'winner', ret20: 0.08 });

  const rows = loadResolved({ strategy: 'perfect' });
  const b = brierScore(rows);
  assert.equal(b.sampleSize, 4);
  assert.ok(Math.abs(b.score - 0.0625) < 1e-9);
});

test('brierScore: mixed tiers produce weighted average', () => {
  // 2 "high" winners (0.75, outcome 1): (0.25)^2 = 0.0625 each
  // 2 "low"  losers  (0.25, outcome 0): (0.25)^2 = 0.0625 each
  // mean = 0.0625
  seed({ strategy: 'mixed', confidence: 'high', count: 2, label: 'winner', ret20: 0.08 });
  seed({ strategy: 'mixed', confidence: 'low',  count: 2, label: 'loser',  ret20: -0.05 });

  const rows = loadResolved({ strategy: 'mixed' });
  const b = brierScore(rows);
  assert.equal(b.sampleSize, 4);
  assert.ok(Math.abs(b.score - 0.0625) < 1e-9);
});

test('brierScore: ignores rows without confidence', () => {
  seed({ strategy: 'noConf', confidence: null, count: 3, label: 'winner', ret20: 0.08 });
  const rows = loadResolved({ strategy: 'noConf' });
  const b = brierScore(rows);
  assert.equal(b.sampleSize, 0);
  assert.equal(b.score, null);
});

// ─── Reliability curve ─────────────────────────────────────────────────────

test('calibrationByConfidenceTier: exposes predicted vs realized gap', () => {
  // Tier 'high' (predicted 0.75): 1 winner, 3 losers => realized 0.25 → gap 0.50
  seed({ strategy: 'reliab', confidence: 'high', count: 1, label: 'winner', ret20: 0.08 });
  seed({ strategy: 'reliab', confidence: 'high', count: 3, label: 'loser',  ret20: -0.05 });

  const rows = loadResolved({ strategy: 'reliab' });
  const tiers = calibrationByConfidenceTier(rows);
  assert.equal(tiers.high.n, 4);
  assert.equal(tiers.high.winners, 1);
  assert.equal(tiers.high.realized, 0.25);
  assert.equal(+tiers.high.gap.toFixed(2), 0.5);
});

// ─── Strategy / source metrics ─────────────────────────────────────────────

test('metricsOverRows: computes hit rate, profit factor, sharpe sanity', () => {
  seed({ strategy: 'mx', confidence: 'high', count: 6, label: 'winner', ret20: 0.10 });
  seed({ strategy: 'mx', confidence: 'low',  count: 4, label: 'loser',  ret20: -0.05 });

  const rows = loadResolved({ strategy: 'mx' });
  const m = metricsOverRows(rows);
  assert.equal(m.n, 10);
  assert.equal(m.hitRate, 0.6);
  // Profit factor = sum(6 * 0.10) / |sum(4 * -0.05)| = 0.6 / 0.2 = 3
  assert.ok(Math.abs(m.profitFactor - 3) < 1e-9);
  // Expectancy = 0.6*0.10 + 0.4*(-0.05) = 0.04
  assert.ok(Math.abs(m.expectancy - 0.04) < 1e-9);
  assert.ok(m.sharpe != null);
  assert.equal(m.stopHitRate, 0.4);
  assert.equal(m.targetHitRate, 0.6);
});

test('metricsOverRows: empty rows produce null-safe response', () => {
  const m = metricsOverRows([]);
  assert.equal(m.n, 0);
  assert.equal(m.hitRate, null);
});

test('strategyMetrics: returns per-strategy breakdown', () => {
  seed({ strategy: 'alpha', confidence: 'high', count: 5, label: 'winner', ret20: 0.08 });
  seed({ strategy: 'beta',  confidence: 'low',  count: 5, label: 'loser',  ret20: -0.05 });

  const out = strategyMetrics();
  assert.ok(out.alpha);
  assert.ok(out.beta);
  assert.ok(out.alpha.hitRate > out.beta.hitRate);
});

// ─── Degradation multiplier ────────────────────────────────────────────────

test('degradationMultipliers: unproven strategy gets null multiplier with note', () => {
  seed({ strategy: 'tiny', confidence: 'high', count: 5, label: 'winner', ret20: 0.08 });
  const out = degradationMultipliers({ minSample: 30 });
  assert.equal(out.tiny.status, 'unproven');
  assert.equal(out.tiny.multiplier, null);
});

test('degradationMultipliers: stable strategy gets multiplier ≈ 1 and clamped', () => {
  // Build 50 "hot" resolutions at 60% hitRate baseline
  seed({ strategy: 'steady', confidence: 'high', count: 30, label: 'winner', ret20: 0.08 });
  seed({ strategy: 'steady', confidence: 'low',  count: 20, label: 'loser',  ret20: -0.05 });

  const out = degradationMultipliers({ rolling: 50, minSample: 30 });
  assert.ok(out.steady);
  // Recent 50 == all 50 rows, so recent hit rate == baseline → multiplier 1 → 'stable'
  assert.equal(out.steady.status, 'stable');
  assert.ok(out.steady.multiplier > 0.95 && out.steady.multiplier < 1.05);
});

test('degradationMultipliers: degraded strategy gets sub-0.75 multiplier', () => {
  // 30 winners first (baseline 100% hit rate), then 30 losers (recent slice)
  seed({ strategy: 'fading', confidence: 'high', count: 30, label: 'winner', ret20: 0.08 });
  seed({ strategy: 'fading', confidence: 'high', count: 30, label: 'loser',  ret20: -0.05 });

  const out = degradationMultipliers({ rolling: 30, minSample: 30 });
  assert.equal(out.fading.status, 'degraded');
  assert.ok(out.fading.multiplier <= 0.75);
  // Raw would be 0 (recent are all losers) → clamped to 0.25 floor
  assert.ok(out.fading.multiplier >= 0.25);
});

// ─── Full report ──────────────────────────────────────────────────────────

test('fullReport: returns all the pieces in a single payload', () => {
  const rep = fullReport({ rolling: 50 });
  assert.ok(rep.generatedAt);
  assert.ok(rep.overall);
  assert.ok(rep.calibration.byTier);
  assert.ok(rep.byStrategy);
  assert.ok(rep.bySource);
  assert.ok(rep.degradation);
  assert.ok(rep.sampleSize > 0);
});
