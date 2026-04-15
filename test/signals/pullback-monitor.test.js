// ─── Tests: 50 SMA Pullback Monitor (src/signals/pullback-monitor.js) ──────
//
// The three bands are mutually exclusive:
//   kissing:     price ≤ ma50 + 0.3*atr
//   in_zone:     price ≤ ma50 * 1.03  (but above kissing band)
//   approaching: price ≤ ma50 * 1.08  (but above in_zone band)
//   null:        price > ma50 * 1.08
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
  // 20% above: 120 > 108 (1.08 * 100) → null
  assert.equal(getPullbackState({ price: 120, ma50: 100, atr: 2 }), null);
  // 8.01% above: just outside approaching → null
  assert.equal(getPullbackState({ price: 108.01, ma50: 100, atr: 2 }), null);
});

test('getPullbackState: approaching band (3% < d ≤ 8%)', () => {
  // 7% above: 107 ≤ 108 but > 103 → approaching
  assert.equal(getPullbackState({ price: 107, ma50: 100, atr: 2 }), 'approaching');
  // 5% above: 105 ≤ 108 but > 103 → approaching
  assert.equal(getPullbackState({ price: 105, ma50: 100, atr: 2 }), 'approaching');
  // Edge: exactly 108 → approaching (≤ boundary)
  assert.equal(getPullbackState({ price: 108, ma50: 100, atr: 2 }), 'approaching');
});

test('getPullbackState: in_zone band (kissingUpper < d ≤ 3%)', () => {
  // 2% above with ATR=2 → kissingUpper = 100.6, so 102 > 100.6 and 102 ≤ 103 → in_zone
  assert.equal(getPullbackState({ price: 102, ma50: 100, atr: 2 }), 'in_zone');
  // 3% above with ATR=2 → 103 > 100.6 and 103 ≤ 103 → in_zone
  assert.equal(getPullbackState({ price: 103, ma50: 100, atr: 2 }), 'in_zone');
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
  // ATR=10 → kissingUpper = 103. At 102.5 → kissing, not in_zone.
  assert.equal(getPullbackState({ price: 102.5, ma50: 100, atr: 10 }), 'kissing');
  // Same price with tight ATR=1 → kissingUpper = 100.3, so 102.5 > 100.3, falls to in_zone.
  assert.equal(getPullbackState({ price: 102.5, ma50: 100, atr: 1 }), 'in_zone');
});

test('getPullbackState: missing ATR falls back to 1% of ma50', () => {
  // No ATR → kissingUpper = ma50 + 0.3 * (ma50 * 0.01) = 100.3
  assert.equal(getPullbackState({ price: 100, ma50: 100 }), 'kissing');
  assert.equal(getPullbackState({ price: 100.3, ma50: 100 }), 'kissing');
  assert.equal(getPullbackState({ price: 100.4, ma50: 100 }), 'in_zone');
});

// ─── isLeadershipCandidate: gate filters ────────────────────────────────────

test('isLeadershipCandidate: rejects weak RS', () => {
  assert.equal(isLeadershipCandidate({ rs_rank: 69, vs_ma200: 5, stage: 2 }), false);
});

test('isLeadershipCandidate: rejects below 200MA', () => {
  assert.equal(isLeadershipCandidate({ rs_rank: 85, vs_ma200: -1, stage: 2 }), false);
});

test('isLeadershipCandidate: rejects no qualifying structure', () => {
  // RS + 200MA OK but stage≠2, no VCP, SEPA low
  assert.equal(isLeadershipCandidate({
    rs_rank: 85, vs_ma200: 5, stage: 1, vcp_forming: 0, sepa_score: 3
  }), false);
});

test('isLeadershipCandidate: accepts stage 2 leader', () => {
  assert.equal(isLeadershipCandidate({
    rs_rank: 85, vs_ma200: 5, stage: 2, vcp_forming: 0, sepa_score: 0
  }), true);
});

test('isLeadershipCandidate: accepts VCP forming leader', () => {
  assert.equal(isLeadershipCandidate({
    rs_rank: 75, vs_ma200: 5, stage: 1, vcp_forming: 1, sepa_score: 0
  }), true);
});

test('isLeadershipCandidate: accepts strong-SEPA leader', () => {
  assert.equal(isLeadershipCandidate({
    rs_rank: 80, vs_ma200: 10, stage: 1, vcp_forming: 0, sepa_score: 4
  }), true);
  assert.equal(isLeadershipCandidate({
    rs_rank: 80, vs_ma200: 10, stage: 1, vcp_forming: 0, sepa_score: 8
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
