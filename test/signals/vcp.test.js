// ─── Tests: Volatility Contraction Pattern (src/signals/vcp.js) ─────────────
// Minervini's core setup: 2+ successive price-range contractions (each new
// window's range < 80% of the prior window's range), typically with higher
// lows as the stock tightens into a pivot.
//
// Implementation details locked in here:
//   - Windows are non-overlapping, 15 bars each, going BACKWARDS from the
//     end. Up to 5 windows fit in a 75-bar series.
//   - `closes.length < 60` → short-circuit with vcpForming=false
//   - Contraction test: strict `<` vs 80% of prior window
//   - vcpPivot = max of last 15 bars; vcpStop = min of last 15 bars
//   - vcpHigherLows = (count of higher lows across windows) ≥ 2

const test = require('node:test');
const assert = require('node:assert/strict');

const { calcVCP } = require('../../src/signals/vcp');
const { flat } = require('../helpers');

// Build a 15-bar window that alternates between `lo` and `hi`, starting lo.
function window15(lo, hi) {
  const out = [];
  for (let i = 0; i < 15; i++) out.push(i % 2 === 0 ? lo : hi);
  return out;
}

// ─── Short-input handling ───────────────────────────────────────────────────

test('calcVCP: null input → default result', () => {
  const r = calcVCP(null);
  // Default shape includes textbook-mode fields added in v8: pivot, stop,
  // higherLows, volumeDrying, mode. The deep check pins the FULL shape so
  // accidental field renames are caught.
  assert.deepEqual(r, {
    vcpForming: false,
    vcpCount: 0,
    vcpTightness: null,
    vcpPivot: null,
    vcpStop: null,
    vcpHigherLows: false,
    vcpVolumeDrying: null,
    vcpMode: 'insufficient-data',
  });
});

test('calcVCP: fewer than 60 bars → default result (no patterns possible)', () => {
  const r = calcVCP(flat(59, 100));
  assert.equal(r.vcpForming, false);
  assert.equal(r.vcpCount, 0);
  assert.equal(r.vcpTightness, null);
});

// ─── Flat / trivial inputs ──────────────────────────────────────────────────

test('calcVCP: completely flat prices → no contractions', () => {
  // Every window has range 0; strict-less-than fails → 0 contractions
  const r = calcVCP(flat(100, 100));
  assert.equal(r.vcpForming, false);
  assert.equal(r.vcpCount, 0);
  assert.equal(r.vcpTightness, 0);
});

// ─── Clean contraction pattern (should fire vcpForming) ─────────────────────

test('calcVCP: clean 4-contraction pattern with higher lows', () => {
  // Built newest-first in the source order but the function reverses; these
  // fragments are written oldest → newest:
  //   w0 (oldest):  alternating 100/130 → range 30%, lo 100
  //   w1:            alternating 105/125 → range ~19.05%, lo 105
  //   w2:            alternating 110/120 → range ~9.09%, lo 110
  //   w3:            alternating 112/117 → range ~4.46%, lo 112
  //   w4 (newest):   alternating 113/115 → range ~1.77%, lo 113
  //
  // Each subsequent window is well under 80% of the prior → 4 contractions.
  // All lows are strictly rising → higherLows = 4, vcpHigherLows = true.
  const closes = [
    ...window15(100, 130),  // closes[0..14]
    ...window15(105, 125),  // closes[15..29]
    ...window15(110, 120),  // closes[30..44]
    ...window15(112, 117),  // closes[45..59]
    ...window15(113, 115),  // closes[60..74]
  ];
  assert.equal(closes.length, 75);

  const r = calcVCP(closes);

  assert.equal(r.vcpForming, true);
  assert.equal(r.vcpCount, 4);
  assert.equal(r.vcpHigherLows, true);

  // Tightness = range of the newest 15-bar window, rounded to 1 decimal.
  // (115 - 113) / 113 * 100 ≈ 1.77 → "1.8"
  assert.equal(r.vcpTightness, 1.8);

  // Pivot and stop derived from closes.slice(-15)
  assert.equal(r.vcpPivot, 115);
  assert.equal(r.vcpStop, 113);
});

// ─── Single contraction → not forming ──────────────────────────────────────

test('calcVCP: only 1 contraction → vcpForming false (needs ≥ 2)', () => {
  // Old window 30%, then four near-identical ~29% windows — only 1 transition
  // is below the 80% threshold (the first one), so contractions count = 1.
  const closes = [
    ...window15(100, 130),  // 30%
    ...window15(100, 120),  // 20%  < 30*0.8=24 ✓ (contraction 1)
    ...window15(100, 119),  // 19%  < 20*0.8=16 ✗
    ...window15(100, 118),  // 18%  < 19*0.8=15.2 ✗
    ...window15(100, 117),  // 17%  < 18*0.8=14.4 ✗
  ];
  const r = calcVCP(closes);
  assert.equal(r.vcpCount, 1);
  assert.equal(r.vcpForming, false);
});

// ─── Boundary at minimum bars (75 = 5 × WINDOW_SIZE) ──────────────────────

test('calcVCP: 60 bars (< 5×15 minimum) → default insufficient-data result', () => {
  // Production requires closes.length >= N_WINDOWS × WINDOW_SIZE = 5 × 15 = 75
  // bars before any pattern analysis runs (vcp.js:37). Earlier behavior
  // attempted partial-window analysis at lower counts which was unreliable;
  // the early-return is now strict. 60 bars hits the floor and returns
  // the empty default — vcpMode === 'insufficient-data'.
  const closes = [
    ...window15(100, 130),  // range 30
    ...window15(105, 125),  // range ~19
    ...window15(110, 120),  // range ~9
    ...window15(112, 117),  // range ~4.5
  ];
  assert.equal(closes.length, 60);

  const r = calcVCP(closes);
  assert.equal(r.vcpForming, false);
  assert.equal(r.vcpCount, 0);
  assert.equal(r.vcpMode, 'insufficient-data');
});

// ─── Expansion (not contraction) ───────────────────────────────────────────

test('calcVCP: expanding ranges → 0 contractions, not forming', () => {
  // Ranges oldest→newest: 2, 5, 10, 20, 30 — each window WIDER than prior.
  const closes = [
    ...window15(100, 102),
    ...window15(100, 105),
    ...window15(100, 110),
    ...window15(100, 120),
    ...window15(100, 130),
  ];
  const r = calcVCP(closes);
  assert.equal(r.vcpForming, false);
  assert.equal(r.vcpCount, 0);
});
