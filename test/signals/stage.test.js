// ─── Tests: Weinstein Stage Analysis (src/signals/stage.js) ─────────────────
// Stages:
//   Stage 1 — basing  (price < 150MA, MA flat/rising)
//   Stage 2 — uptrend (price > 150MA, MA rising)   ← buy zone
//   Stage 3 — topping (price > 150MA, MA flat/falling)
//   Stage 4 — decline (price < 150MA, MA strictly falling)
//
// "MA rising" is measured against the true 150MA from ~10 weeks (50 trading
// days) ago: `avg(closes.slice(-200, -50)) / 150`. Requires ≥200 bars of
// history; shorter series fall back to comparing the MA against itself
// (making maFlat always true, which correctly keeps them in Stage 1/3).
//
// The if-chain is ordered so Stage 4 requires `!maRising && !maFlat` —
// without this guard a flat MA with price below would wrongly fire Stage 4
// instead of Stage 1 (basing).

const test = require('node:test');
const assert = require('node:assert/strict');

const { calcStage } = require('../../src/signals/stage');
const { flat } = require('../helpers');

// ─── Short-input handling ───────────────────────────────────────────────────

test('calcStage: fewer than 160 bars → stage 0 Unknown', () => {
  const r = calcStage(flat(159, 100), 100);
  assert.equal(r.stage, 0);
  assert.equal(r.stageName, 'Unknown');
});

test('calcStage: missing ma150 → stage 0 Unknown', () => {
  const r = calcStage(flat(252, 100), null);
  assert.equal(r.stage, 0);
  assert.equal(r.stageName, 'Unknown');
});

// ─── Four clean stages on 252-bar fixtures ─────────────────────────────────

test('calcStage: Stage 2 uptrend (price>ma150, MA strictly rising)', () => {
  // Old 102 bars at 50, new 149 bars at 100, final spike to 110.
  // Today's ma150 = (149*100 + 110)/150 ≈ 100.067
  // ma150_10wkAgo = avg(closes[52..101]) = 50 → strongly rising.
  // price (110) > ma150 (100.067) and maRising → Stage 2.
  const closes = [
    ...flat(102, 50),
    ...flat(149, 100),
    110,
  ];
  assert.equal(closes.length, 252);
  const ma150 = 100.067;
  const r = calcStage(closes, ma150);
  assert.equal(r.stage, 2);
  assert.match(r.stageName, /Stage 2/);
});

test('calcStage: Stage 4 downtrend (price<ma150, MA falling)', () => {
  // Mirror of the Stage 2 fixture.
  const closes = [
    ...flat(102, 100),
    ...flat(149, 50),
    40,
  ];
  const ma150 = (149 * 50 + 40) / 150;
  const r = calcStage(closes, ma150);
  assert.equal(r.stage, 4);
  assert.match(r.stageName, /Stage 4/);
});

test('calcStage: Stage 3 topping (price>ma150, MA flat)', () => {
  // 251 bars at 100 then final bar at 110. The "old" 50-bar slice is all
  // 100, and today's ma150 ≈ 100.067 → maFlat true, maRising false.
  // price (110) > ma150 (100.067) and not rising → Stage 3.
  const closes = [
    ...flat(251, 100),
    110,
  ];
  const ma150 = (251 * 100 + 110) / 252; // approx — but not what we pass
  // Pass the true last-150 average so the test is internally consistent.
  const trueMA150 = (149 * 100 + 110) / 150;
  const r = calcStage(closes, trueMA150);
  assert.equal(r.stage, 3);
  assert.match(r.stageName, /Stage 3/);
});

test('calcStage: Stage 1 basing (price<ma150, MA rising)', () => {
  // Old 102 bars at 50, new 149 bars at 100, final bar down to 80.
  // Today's ma150 = (149*100 + 80)/150 ≈ 99.867
  // ma150_10wkAgo = avg(closes[52..201]) = (50*50 + 100*100)/150 ≈ 83.33
  //   → maRising TRUE (99.867 > 83.33 * 1.001)
  // price (80) < ma150 → falls through to Stage 1.
  const closes = [
    ...flat(102, 50),
    ...flat(149, 100),
    80,
  ];
  const ma150 = (149 * 100 + 80) / 150;
  const r = calcStage(closes, ma150);
  assert.equal(r.stage, 1);
  assert.match(r.stageName, /Stage 1/);
});

test('calcStage: Stage 1 basing (price<ma150, MA flat) — classical Weinstein', () => {
  // Flat 150MA with price below = classic basing zone. Bug #1 fix: Stage 4
  // now requires `!maRising && !maFlat`, so a flat MA no longer snaps the
  // classification to Stage 4 — it correctly falls through to Stage 1.
  //
  // 251 bars at 100 then final bar at 90.
  // ma150_10wkAgo = avg(closes[52..201]) = 100 → maFlat TRUE, maRising FALSE
  // price (90) < ma150 (99.933), but !maFlat is FALSE → Stage 4 gated off
  // → falls through → Stage 1.
  const closes = [...flat(251, 100), 90];
  const ma150 = (149 * 100 + 90) / 150;
  const r = calcStage(closes, ma150);
  assert.equal(r.stage, 1);
  assert.match(r.stageName, /Stage 1/);
});

// ─── Short-history fallback path (160–199 bars) ────────────────────────────

test('calcStage: n=160 — fewer than 200 bars → ma150_10wkAgo falls back to ma150', () => {
  // For 160 ≤ n < 200, the code falls back to ma150_10wkAgo = ma150. With
  // maRising=FALSE (strict >) and maFlat=TRUE (zero difference):
  //   - price > ma150 → Stage 3 (topping — can't confirm rising trend)
  //   - price < ma150 → Stage 1 (basing — flat MA blocks Stage 4 branch)
  const priceAbove = [...flat(159, 100), 110];
  const priceBelow = [...flat(159, 100), 90];

  assert.equal(calcStage(priceAbove, 100.067).stage, 3);
  assert.equal(calcStage(priceBelow, 99.933).stage, 1);
});

// ─── ma150_10wkAgo correctly averages the genuine 150-bar window ───────────

test('calcStage: ma150_10wkAgo averages the TRUE 150-bar window (closes[n-200..n-50])', () => {
  // Build a series where today's ma150 is CLEARLY above the actual 150MA
  // from 50 bars ago, so a correct implementation flags Stage 2.
  //
  //   closes[52..101]  = 80   (50 bars)
  //   closes[102..201] = 50   (100 bars)
  //   closes[202..251] = 100  (50 bars — recent strength)
  //
  // Today's ma150       = avg(closes[102..251]) = (50*100 + 100*50)/150 ≈ 66.67
  // True ma150 50d ago  = avg(closes[52..201])  = (80*50 + 50*100)/150  = 60.00
  // 66.67 > 60.00*1.001 → maRising TRUE → Stage 2 (genuine uptrend).
  //
  // Previously the code averaged only closes[52..101] (= 80), which wrongly
  // flagged maRising=false and returned Stage 3. Bug #2 fix verified here.
  const closes = [
    ...flat(52, 100),   // not inside the 150MA window
    ...flat(50, 80),    // [52..101]
    ...flat(100, 50),   // [102..201]
    ...flat(50, 100),   // [202..251]
  ];
  assert.equal(closes.length, 252);
  const ma150 = (50 * 100 + 100 * 50) / 150;  // 66.67
  const r = calcStage(closes, ma150);
  assert.equal(r.stage, 2);
  assert.match(r.stageName, /Stage 2/);
});
