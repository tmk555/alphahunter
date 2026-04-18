// ─── Tests: 50 SMA Pullback Monitor (src/signals/pullback-monitor.js) ──────
//
// The two bands are mutually exclusive:
//   kissing:  price ≤ ma50 + 0.3*atr
//   in_zone:  price ≤ ma50 * 1.02  (but above kissing band)
//   null:     price > ma50 * 1.02
//
// Tests are hand-computed so every assertion is verifiable with a calculator.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPullbackState,
  computeMA50,
  isLeadershipCandidate,
  ensurePullbackStatesTable,
  readLastState,
  writeLastState,
  clearLastState,
} = require('../../src/signals/pullback-monitor');

const { flat } = require('../helpers');

// ─── computeMA50 ────────────────────────────────────────────────────────────

test('computeMA50: null on short input', () => {
  assert.equal(computeMA50(null), null);
  assert.equal(computeMA50([]), null);
  assert.equal(computeMA50(flat(49, 100)), null);
});

test('computeMA50: flat 100 series → 100', () => {
  assert.equal(computeMA50(flat(50, 100)), 100);
  assert.equal(computeMA50(flat(200, 50.5)), 50.5);
});

test('computeMA50: uses only the last 50 bars', () => {
  const series = flat(40, 200).concat(flat(50, 100));  // 40 old @ 200, 50 recent @ 100
  assert.equal(computeMA50(series), 100);
});

// ─── getPullbackState: threshold logic ──────────────────────────────────────

test('getPullbackState: null/invalid inputs return null', () => {
  assert.equal(getPullbackState({ price: null, ma50: 100, atr: 1 }), null);
  assert.equal(getPullbackState({ price: 100, ma50: null, atr: 1 }), null);
  assert.equal(getPullbackState({ price: 100, ma50: 0, atr: 1 }), null);
  assert.equal(getPullbackState({ price: 100, ma50: -5, atr: 1 }), null);
});

test('getPullbackState: price way above MA50 → null (not a pullback)', () => {
  // 20% above: 120 > 102 (1.02 * 100) → null
  assert.equal(getPullbackState({ price: 120, ma50: 100, atr: 2 }), null);
  // 2.01% above: just outside in_zone → null
  assert.equal(getPullbackState({ price: 102.01, ma50: 100, atr: 2 }), null);
  // Anything above 2% is noise now — the old "approaching" band was removed.
  assert.equal(getPullbackState({ price: 105, ma50: 100, atr: 2 }), null);
  assert.equal(getPullbackState({ price: 107, ma50: 100, atr: 2 }), null);
});

test('getPullbackState: in_zone band (kissingUpper < d ≤ 2%)', () => {
  // 1% above with ATR=2 → kissingUpper = 100.6, so 101 > 100.6 and 101 ≤ 102 → in_zone
  assert.equal(getPullbackState({ price: 101, ma50: 100, atr: 2 }), 'in_zone');
  // 2% above with ATR=2 → 102 > 100.6 and 102 ≤ 102 → in_zone
  assert.equal(getPullbackState({ price: 102, ma50: 100, atr: 2 }), 'in_zone');
});

test('getPullbackState: kissing band (price ≤ ma50 + 0.3*ATR)', () => {
  // At MA50 exactly → kissing
  assert.equal(getPullbackState({ price: 100, ma50: 100, atr: 2 }), 'kissing');
  // Just above: 100.5 with ATR=2 → kissingUpper = 100.6, 100.5 ≤ 100.6 → kissing
  assert.equal(getPullbackState({ price: 100.5, ma50: 100, atr: 2 }), 'kissing');
  // Below MA50: 99 (undercut) → kissing (primary use case for reversal setups)
  assert.equal(getPullbackState({ price: 99, ma50: 100, atr: 2 }), 'kissing');
});

test('getPullbackState: wide-ATR stock gets proportional kissing band', () => {
  // ATR=10 → kissingUpper = 103. At 101.5 → kissing (inside wide ATR band).
  assert.equal(getPullbackState({ price: 101.5, ma50: 100, atr: 10 }), 'kissing');
  // Same price with tight ATR=1 → kissingUpper = 100.3, so 101.5 > 100.3, falls to in_zone.
  assert.equal(getPullbackState({ price: 101.5, ma50: 100, atr: 1 }), 'in_zone');
});

test('getPullbackState: missing ATR falls back to 1% of ma50', () => {
  // No ATR → kissingUpper = ma50 + 0.3 * (ma50 * 0.01) = 100.3
  assert.equal(getPullbackState({ price: 100, ma50: 100 }), 'kissing');
  assert.equal(getPullbackState({ price: 100.3, ma50: 100 }), 'kissing');
  assert.equal(getPullbackState({ price: 100.4, ma50: 100 }), 'in_zone');
});

// ─── isLeadershipCandidate: gate filters ────────────────────────────────────

test('isLeadershipCandidate: rejects weak RS (< 80)', () => {
  assert.equal(isLeadershipCandidate({ rs_rank: 79, vs_ma200: 5, stage: 2, volume_ratio: 0.8 }), false);
  assert.equal(isLeadershipCandidate({ rs_rank: 69, vs_ma200: 5, stage: 2, volume_ratio: 0.8 }), false);
});

test('isLeadershipCandidate: rejects below 200MA', () => {
  assert.equal(isLeadershipCandidate({ rs_rank: 85, vs_ma200: -1, stage: 2, volume_ratio: 0.8 }), false);
});

test('isLeadershipCandidate: rejects non-stage-2 (VCP/SEPA no longer substitute)', () => {
  assert.equal(isLeadershipCandidate({
    rs_rank: 85, vs_ma200: 5, stage: 1, vcp_forming: 1, sepa_score: 6, volume_ratio: 0.8,
  }), false);
  assert.equal(isLeadershipCandidate({
    rs_rank: 85, vs_ma200: 5, stage: 3, vcp_forming: 1, sepa_score: 8, volume_ratio: 0.8,
  }), false);
});

test('isLeadershipCandidate: rejects heavy-volume pullback (volume_ratio ≥ 1.0)', () => {
  // Healthy pullbacks are dry — volume spike on a pullback = distribution.
  assert.equal(isLeadershipCandidate({
    rs_rank: 90, vs_ma200: 10, stage: 2, volume_ratio: 1.2,
  }), false);
  assert.equal(isLeadershipCandidate({
    rs_rank: 90, vs_ma200: 10, stage: 2, volume_ratio: 1.0,
  }), false);
});

test('isLeadershipCandidate: accepts stage 2 + RS 80 + dry volume', () => {
  assert.equal(isLeadershipCandidate({
    rs_rank: 80, vs_ma200: 5, stage: 2, volume_ratio: 0.8,
  }), true);
  assert.equal(isLeadershipCandidate({
    rs_rank: 95, vs_ma200: 15, stage: 2, volume_ratio: 0.5,
  }), true);
});

test('isLeadershipCandidate: accepts when volume_ratio is missing (fail-open)', () => {
  // Missing volume data shouldn't block an otherwise-qualifying candidate.
  assert.equal(isLeadershipCandidate({
    rs_rank: 85, vs_ma200: 5, stage: 2,
  }), true);
});

test('isLeadershipCandidate: null input', () => {
  assert.equal(isLeadershipCandidate(null), false);
});

// ─── Pullback state table (idempotency) ────────────────────────────────────

test('pullback_states: read empty, write, read back, clear', () => {
  ensurePullbackStatesTable();

  // Fresh table for this symbol
  clearLastState('TSLA');
  assert.equal(readLastState('TSLA'), null);

  // Write and read back
  writeLastState({ symbol: 'TSLA', state: 'approaching', ma50: 250.5, atr: 8.2, priceAtFire: 267 });
  const row = readLastState('TSLA');
  assert.ok(row);
  assert.equal(row.symbol, 'TSLA');
  assert.equal(row.state, 'approaching');
  assert.equal(row.ma50, 250.5);
  assert.equal(row.atr, 8.2);
  assert.equal(row.price_at_fire, 267);

  // Transition: writing a new state updates the same row (UPSERT)
  writeLastState({ symbol: 'TSLA', state: 'in_zone', ma50: 250.5, atr: 8.2, priceAtFire: 258 });
  const row2 = readLastState('TSLA');
  assert.equal(row2.state, 'in_zone');
  assert.equal(row2.price_at_fire, 258);

  // Clear
  clearLastState('TSLA');
  assert.equal(readLastState('TSLA'), null);
});
