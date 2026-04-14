// ─── Tests: Momentum + ATR + Period Returns (src/signals/momentum.js) ──────
//
// calcSwingMomentum: base 50 + multi-period ROC-weighted sum + trend
//   consistency bonus + volume confirmation + price-vs-10MA bonus, clamped
//   to [1, 99].
//
// calcATR: 14-period ATR. Accepts OHLCV bars (true range using prior close)
//   or a close-only array (|close[i] - close[i-1]| fallback).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calcSwingMomentum,
  calcPeriodReturns,
  calcATR,
  calcVolumeProfile,
} = require('../../src/signals/momentum');
const { flat, bar, approx } = require('../helpers');

// ─── calcSwingMomentum ──────────────────────────────────────────────────────

test('calcSwingMomentum: fewer than 21 bars → returns base 50', () => {
  assert.equal(calcSwingMomentum(flat(20, 100)), 50);
  assert.equal(calcSwingMomentum([]), 50);
  assert.equal(calcSwingMomentum(null), 50);
});

test('calcSwingMomentum: 21 bars flat → base 50 (no contributions)', () => {
  // ROC legs all 0, upDays 0, no q, ma10 = 100, now == ma10 (strict > fails)
  assert.equal(calcSwingMomentum(flat(21, 100)), 50);
});

test('calcSwingMomentum: 22-bar +0.5% final-bar move — hand-computed', () => {
  // 21 bars at 100, last bar at 100.5
  // n=22, now=100.5
  //   roc5  = (100.5/100 - 1)*100 = 0.5 → contribution 1.0
  //   roc10 = 0.5 → contribution 0.75
  //   roc21 = 0.5 → contribution 0.5
  // upDays in last 10 sessions (i = 12..21): only i=21 is strictly up → 1
  //   upDays bonus = 1/10 * 8 = 0.8
  // volume: no q → no bonus
  // ma10 = avg(closes[12..21]) = (100*9 + 100.5)/10 = 100.05
  // now (100.5) > 100.05 → +5
  // total = 50 + (1 + 0.75 + 0.5) + 0.8 + 0 + 5 = 58.05 → round → 58
  const closes = [...flat(21, 100), 100.5];
  assert.equal(calcSwingMomentum(closes), 58);
});

test('calcSwingMomentum: strong uptrend clamps to 99', () => {
  // +1 per day for 22 bars → very large ROC contribution → clamped
  const closes = Array.from({ length: 22 }, (_, i) => 100 + i);
  assert.equal(calcSwingMomentum(closes), 99);
});

test('calcSwingMomentum: extreme downtrend clamps to 1', () => {
  // 21 flat bars at 100, then final bar crashes to 10 (-90% single-day move).
  // roc5/10/21 all = -90 → bonus = -90*(2+1.5+1) = -405
  // Total base + bonus ≈ -355 → clamped to 1.
  const closes = [...flat(21, 100), 10];
  assert.equal(calcSwingMomentum(closes), 1);
});

test('calcSwingMomentum: +6 volume bonus when volRatio ≥ 2.0', () => {
  const closes = flat(22, 100); // flat → would score 50 baseline
  const q = { averageDailyVolume3Month: 1000, regularMarketVolume: 2000 };
  // Flat base=50, +6 volume, everything else 0, ma10=100=now (no bonus)
  // = 56
  assert.equal(calcSwingMomentum(closes, q), 56);
});

test('calcSwingMomentum: +3 volume bonus when 1.5 ≤ volRatio < 2.0', () => {
  const closes = flat(22, 100);
  const q = { averageDailyVolume3Month: 1000, regularMarketVolume: 1500 };
  assert.equal(calcSwingMomentum(closes, q), 53);
});

test('calcSwingMomentum: no volume bonus when volRatio < 1.5', () => {
  const closes = flat(22, 100);
  const q = { averageDailyVolume3Month: 1000, regularMarketVolume: 1499 };
  assert.equal(calcSwingMomentum(closes, q), 50);
});

test('calcSwingMomentum: missing q fields → volRatio defaults to 1 (no bonus)', () => {
  const closes = flat(22, 100);
  assert.equal(calcSwingMomentum(closes, {}), 50);
  assert.equal(calcSwingMomentum(closes, null), 50);
});

// ─── calcATR (close-only legacy path) ───────────────────────────────────────

test('calcATR: null / empty / short input → null', () => {
  assert.equal(calcATR(null), null);
  assert.equal(calcATR([]), null);
  assert.equal(calcATR(flat(14, 100)), null);  // 14 < 15 minimum
});

test('calcATR: 15 flat closes → 0', () => {
  assert.equal(calcATR(flat(15, 100)), 0);
});

test('calcATR: 15-bar linear ramp (+1/day) → ATR = 1.00', () => {
  // diffs = [1, 1, ..., 1] (14 values) → avg 1.00
  const closes = Array.from({ length: 15 }, (_, i) => 100 + i);
  assert.equal(calcATR(closes), 1);
});

test('calcATR: alternating +2/-2 swings → avg absolute diff = 2', () => {
  // 100, 102, 100, 102, ... → |diff| = 2 every step
  const closes = Array.from({ length: 20 }, (_, i) => 100 + (i % 2) * 2);
  assert.equal(calcATR(closes), 2);
});

test('calcATR: uses ONLY the last 14 diffs — older bars completely ignored', () => {
  // Build 25 bars: 10 wild (huge 100-point swings) + 15 calm (+1 per day).
  // The loop is `for (i = n-14; i < n; i++)` = `for (i = 11; i < 25; i++)`,
  // which touches data[11..24] and uses data[i-1] = data[10..23]. ALL of
  // those indices are inside the calm segment (calm occupies [10..24]).
  // Every diff is 1 → ATR = 1. The wild bars [0..9] contribute nothing,
  // proving older bars are fully excluded.
  const wild = [100, 200, 100, 200, 100, 200, 100, 200, 100, 200];
  const calm = Array.from({ length: 15 }, (_, i) => 300 + i);
  const closes = [...wild, ...calm];
  assert.equal(calcATR(closes), 1);
});

// ─── calcATR (OHLCV bars — true ATR path) ──────────────────────────────────

test('calcATR: OHLCV bars with zero volatility → 0', () => {
  const bars = Array.from({ length: 16 }, () => bar({ open: 100, high: 100, low: 100, close: 100 }));
  assert.equal(calcATR(bars), 0);
});

test('calcATR: OHLCV true range uses max of H-L, |H-prevC|, |L-prevC|', () => {
  // Bar 0: C=100 (the "prev close" for bar 1)
  // Bars 1..15: H=105, L=98, C=103
  //   For bar i>0: TR = max(H-L=7, |H-prevC|, |L-prevC|)
  //   At bar 1: prevC=100 → max(7, 5, 2) = 7
  //   At bar 2..15: prevC=103 → max(7, 2, 5) = 7
  // Sum of last 14 TRs = 98 → ATR = 7.00
  const bars = [bar({ open: 100, high: 100, low: 100, close: 100 })];
  for (let i = 0; i < 15; i++) {
    bars.push(bar({ open: 103, high: 105, low: 98, close: 103 }));
  }
  assert.equal(calcATR(bars), 7);
});

test('calcATR: OHLCV gap-up (high far above prev close) dominates TR', () => {
  // Bar 0: C=100
  // Bar 1: gap-up open, H=120, L=115, C=118 → prev close 100
  //   TR = max(120-115=5, |120-100|=20, |115-100|=15) = 20
  // Bars 2..15: tight at 118 (H=118, L=118, C=118) → TR = max(0, 0, 0) = 0
  // Sum of last 14 = 20 (from bar 1) + 0*13 = 20 → ATR = 20/14 ≈ 1.43
  const bars = [bar({ open: 100, high: 100, low: 100, close: 100 })];
  bars.push(bar({ open: 120, high: 120, low: 115, close: 118 }));
  for (let i = 0; i < 14; i++) {
    bars.push(bar({ open: 118, high: 118, low: 118, close: 118 }));
  }
  // The loop runs i=n-14..n-1. n=16 → i=2..15. Bar 1's TR is NOT in the sum!
  // Let me recompute:
  //   i=2: prevC=118 (bar 1's close), H=118, L=118 → TR = 0
  //   i=3..15: same → all 0
  //   sum = 0 → ATR = 0
  // This reveals an off-by-one subtlety: for n=16 bars, the loop uses bars
  // [2..15] only — 14 bars. Bar 1's TR is NOT included. So the ATR window
  // is actually the LAST 14 bars, which is standard.
  assert.equal(calcATR(bars), 0);
});

test('calcATR: OHLCV gap-up is included when it lands inside the last-14 window', () => {
  // Same gap-up but pushed to be the MOST RECENT bar.
  // Bar 0: C=100
  // Bars 1..14: flat at 100 (H=L=C=100)
  // Bar 15: gap-up, prev close 100, H=120, L=115, C=118 → TR = 20
  // Loop i=1..15 (n=16). TR values:
  //   i=1..14: 0 (flat, no prev-close gap since bar 0 also 100)
  //   i=15: TR = 20
  // Sum = 20 → ATR = 20/14 ≈ 1.43
  const bars = [bar({ open: 100, high: 100, low: 100, close: 100 })];
  for (let i = 0; i < 14; i++) {
    bars.push(bar({ open: 100, high: 100, low: 100, close: 100 }));
  }
  bars.push(bar({ open: 120, high: 120, low: 115, close: 118 }));
  const atr = calcATR(bars);
  assert.ok(approx(atr, +(20 / 14).toFixed(2), 0.01), `got ${atr}`);
});

// ─── calcPeriodReturns (bonus coverage) ─────────────────────────────────────

test('calcPeriodReturns: computes 1w/1m/3m/6m percent moves', () => {
  // Build 200 bars: exactly +10% over 5 bars, +20% over 21 bars, etc.
  // Simplest: step function that makes each lookback known.
  const closes = flat(200, 100);
  closes[199] = 110;
  const r = calcPeriodReturns(closes);
  assert.equal(r.chg1w, 10);   // closes[194]=100, now=110 → 10%
  assert.equal(r.chg1m, 10);
  assert.equal(r.chg3m, 10);
  assert.equal(r.chg6m, 10);
});

test('calcPeriodReturns: short series returns empty object', () => {
  assert.deepEqual(calcPeriodReturns(flat(4, 100)), {});
  assert.deepEqual(calcPeriodReturns(null), {});
});

// ─── calcVolumeProfile (bonus coverage) ────────────────────────────────────

test('calcVolumeProfile: null / short input → null', () => {
  assert.equal(calcVolumeProfile(null), null);
  assert.equal(calcVolumeProfile(Array(20).fill(bar())), null);
});

test('calcVolumeProfile: 51 flat bars → ratios clearly flagged (no direction)', () => {
  // All closes equal → no up days, no down days → both up and down vol = 0
  // → ratio returns { ratio: null, ... } (upVol=0 branch).
  const bars = Array.from({ length: 51 }, () => bar({ volume: 1000 }));
  const r = calcVolumeProfile(bars);
  // 20-day and 50-day ratios should both be null
  assert.equal(r.upDownRatio20, null);
  assert.equal(r.upDownRatio50, null);
  assert.equal(r.accumulating, false);
  assert.equal(r.distributing, false);
});

test('calcVolumeProfile: pure up-days produce ratio = 99 and accumulation=A', () => {
  // 51 bars, each closing higher than previous, with non-zero volume.
  const bars = [];
  for (let i = 0; i < 51; i++) {
    bars.push(bar({ open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1000 }));
  }
  const r = calcVolumeProfile(bars);
  // downVol = 0 → ratio short-circuits to 99
  assert.equal(r.upDownRatio50, 99);
  assert.equal(r.accumulation50, 'A');
  assert.equal(r.accumulating, true);
});
