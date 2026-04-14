// ─── Tests: Minervini SEPA Trend Template (src/signals/sepa.js) ─────────────
// Eight trend-template rules:
//   1. Price > 200MA
//   2. Price > 150MA
//   3. 150MA > 200MA
//   4. 200MA rising (4+ weeks)
//   5. 50MA > 150MA AND 50MA > 200MA
//   6. Price > 50MA
//   7. Within 30% of 52-week low  (caller-set, always null here)
//   8. Within 25% of 52-week high (priceNearHigh)
//
// sepaScore = count of TRUE values. null values do NOT count.
// Note: rule 7 is always null inside this function, so the maximum achievable
// score from calcSEPA() alone is 7. The caller patches low30pctBelow later.

const test = require('node:test');
const assert = require('node:assert/strict');

const { calcSEPA } = require('../../src/signals/sepa');
const { flat } = require('../helpers');

// ─── Perfect / worst-case structures ────────────────────────────────────────

test('calcSEPA: perfect uptrend structure scores 7 of 7 applicable rules', () => {
  // Aligned MAs, rising 200MA (ramp so oldest-24 avg < today's ma200),
  // priceNearHigh (distFromHigh < 0.25)
  const closes = Array.from({ length: 252 }, (_, i) => 50 + i);
  // ma200 = avg of last 200 closes in the ramp; oldest 24 avg is much lower.
  const ma200 = 200;   // > oldest 24 avg (~62) * 1.001
  const ma150 = 210;   // > ma200
  const ma50  = 250;   // > ma150 > ma200
  const price = 280;   // > ma50
  const distFromHigh = 0.05;

  const r = calcSEPA(price, ma50, ma150, ma200, closes, distFromHigh, 90);

  assert.equal(r.sepa.aboveMA200, true);
  assert.equal(r.sepa.aboveMA150, true);
  assert.equal(r.sepa.ma150AboveMA200, true);
  assert.equal(r.sepa.ma200Rising, true);
  assert.equal(r.sepa.ma50AboveAll, true);
  assert.equal(r.sepa.aboveMA50, true);
  assert.equal(r.sepa.priceNearHigh, true);
  assert.equal(r.sepa.low30pctBelow, null); // caller-supplied
  assert.equal(r.sepaScore, 7);
  assert.equal(r.ma50AboveAll, true);
});

test('calcSEPA: broken downtrend structure scores 0', () => {
  // Falling ramp so oldest-24 bars (HIGH) > today's ma200 (LOW)
  const closes = Array.from({ length: 252 }, (_, i) => 300 - i);
  const ma200 = 100;
  const ma150 = 90;
  const ma50  = 70;
  const price = 60;
  const distFromHigh = 0.50;

  const r = calcSEPA(price, ma50, ma150, ma200, closes, distFromHigh, 10);

  assert.equal(r.sepa.aboveMA200, false);
  assert.equal(r.sepa.aboveMA150, false);
  assert.equal(r.sepa.ma150AboveMA200, false);
  assert.equal(r.sepa.ma200Rising, false);
  assert.equal(r.sepa.ma50AboveAll, false);
  assert.equal(r.sepa.aboveMA50, false);
  assert.equal(r.sepa.priceNearHigh, false);
  assert.equal(r.sepaScore, 0);
});

// ─── Individual rules ───────────────────────────────────────────────────────

test('calcSEPA: aboveMA200 — strict inequality (equal → false)', () => {
  const closes = flat(252, 100);
  const r = calcSEPA(100, 100, 100, 100, closes, 0.0, 50);
  // price == ma200 → not strictly above → false
  assert.equal(r.sepa.aboveMA200, false);
});

test('calcSEPA: ma150AboveMA200 — strict inequality (equal → false)', () => {
  const closes = flat(252, 100);
  const r = calcSEPA(110, 105, 100, 100, closes, 0.0, 50);
  assert.equal(r.sepa.ma150AboveMA200, false);
});

test('calcSEPA: ma50AboveAll — requires strict > over BOTH 150 and 200', () => {
  const closes = flat(252, 100);
  // ma50 > ma150 but not > ma200
  const r1 = calcSEPA(110, 105, 100, 110, closes, 0.0, 50);
  assert.equal(r1.sepa.ma50AboveAll, false);
  assert.equal(r1.ma50AboveAll, false);
  // ma50 > both
  const r2 = calcSEPA(120, 110, 100, 95, closes, 0.0, 50);
  assert.equal(r2.sepa.ma50AboveAll, true);
});

test('calcSEPA: priceNearHigh boundary — distFromHigh = 0.25 is TRUE', () => {
  const closes = flat(252, 100);
  const r = calcSEPA(100, 100, 100, 100, closes, 0.25, 50);
  assert.equal(r.sepa.priceNearHigh, true);
});

test('calcSEPA: priceNearHigh boundary — distFromHigh = 0.251 is FALSE', () => {
  const closes = flat(252, 100);
  const r = calcSEPA(100, 100, 100, 100, closes, 0.251, 50);
  assert.equal(r.sepa.priceNearHigh, false);
});

test('calcSEPA: priceNearHigh — null distFromHigh → false (not counted)', () => {
  const closes = flat(252, 100);
  const r = calcSEPA(100, 100, 100, 100, closes, null, 50);
  assert.equal(r.sepa.priceNearHigh, false);
});

// ─── ma200Rising behavior ───────────────────────────────────────────────────

test('calcSEPA: ma200Rising = null when fewer than 220 bars of history', () => {
  // Minimum is 220 bars: 200 for the MA + 20 for the 4-week lag.
  const closes = flat(219, 100);
  const r = calcSEPA(100, 100, 100, 100, closes, 0, 50);
  assert.equal(r.sepa.ma200Rising, null);
});

test('calcSEPA: ma200Rising = false for a strictly declining series', () => {
  // Descending ramp: closes[i] = 300 - i over 252 bars.
  //   closes.slice(-220, -20) = closes[32..231] = 268 down to 69
  //   mean of that slice = (268 + 69)/2 = 168.5
  // Caller-supplied ma200 = 100 → 100 > 168.5*1.001? NO → false.
  const closes = Array.from({ length: 252 }, (_, i) => 300 - i);
  const r = calcSEPA(60, 70, 90, 100, closes, null, 50);
  assert.equal(r.sepa.ma200Rising, false);
});

test('calcSEPA: ma200Rising averages the TRUE 200-bar window (closes[n-220..n-20])', () => {
  // Build a series where today's 200MA is strictly greater than the 200MA
  // from 20 trading days ago, so the rule should fire TRUE.
  //
  //   closes[0..31]    = 50   (ignored — outside the slice)
  //   closes[32..231]  = 60   (→ ma200_4wAgo = 60.0)
  //   closes[232..251] = 100  (recent strength — not in the lagged window)
  //
  // closes.slice(-220, -20) = closes[32..231] = 200 bars of 60 → avg 60.
  // Caller-supplied ma200 = 64 → 64 > 60*1.001 = 60.06? YES → true.
  //
  // Bug #3 fix verified: previously the function averaged only closes[0..23]
  // (the 24 OLDEST bars = 50), which is a ~6-month-old floor rather than
  // the 200MA from 4 weeks ago.
  const closes = [
    ...flat(32, 50),
    ...flat(200, 60),
    ...flat(20, 100),
  ];
  assert.equal(closes.length, 252);
  const r = calcSEPA(100, 80, 70, 64, closes, null, 50);
  assert.equal(r.sepa.ma200Rising, true);
});

// ─── Null input handling ────────────────────────────────────────────────────

test('calcSEPA: null MAs produce null rule flags (not false)', () => {
  const closes = flat(252, 100);
  const r = calcSEPA(100, null, null, null, closes, 0, 50);
  // The code does `vsMA200 != null && vsMA200 > 0` — when ma200 is null,
  // vsMA200 is null, so the rule evaluates to FALSE (short-circuit).
  // Note: it's `false`, not `null`. That's a real behavior lock.
  assert.equal(r.sepa.aboveMA200, false);
  assert.equal(r.sepa.aboveMA150, false);
  assert.equal(r.sepa.aboveMA50,  false);
  // ma150AboveMA200 guards the ternary and returns null for missing inputs
  assert.equal(r.sepa.ma150AboveMA200, null);
  // ma50AboveAll similarly
  assert.equal(r.sepa.ma50AboveAll, null);
});

test('calcSEPA: sepaScore counts only === true values (nulls ignored)', () => {
  // Short closes → ma200Rising null. Pass null distFromHigh → priceNearHigh false.
  // Only ma50AboveAll true (ma50 > ma150 > ma200), plus price > all MAs.
  const closes = flat(200, 100);
  const r = calcSEPA(120, 110, 105, 100, closes, null, 50);
  // TRUE: aboveMA200, aboveMA150, aboveMA50, ma150AboveMA200, ma50AboveAll (5)
  // NULL: ma200Rising, low30pctBelow
  // FALSE: priceNearHigh
  assert.equal(r.sepaScore, 5);
});
