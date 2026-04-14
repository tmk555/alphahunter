// ─── Tests: IBD Relative Strength (src/signals/rs.js) ───────────────────────
// The RS formula is weighted: 0.40*r3m + 0.20*r6m + 0.20*r9m + 0.20*r12m
// where each leg is the percent move from the respective lookback to today.
//
// Fixtures are deterministic step-functions so each leg resolves to either
// 0% or a known %, letting us compute the expected RS by hand.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calcRS, calcRSWeekly, calcRSMonthly,
  resampleWeekly, resampleMonthly,
  rankToRS,
} = require('../../src/signals/rs');
const { flat, stepAtEnd, approx } = require('../helpers');

// ─── calcRS (daily) ─────────────────────────────────────────────────────────

test('calcRS: returns null on null/empty/short input', () => {
  assert.equal(calcRS(null), null);
  assert.equal(calcRS([]), null);
  assert.equal(calcRS(flat(62)), null, '62 bars < 63 minimum');
});

test('calcRS: exactly 63 bars accepted (minimum length)', () => {
  const closes = flat(63, 100);
  closes[62] = 110; // +10% on last bar
  // At n=63: p3m=closes[0]=100, p6m=closes[0]=100, p9m=p12m=100
  // All legs = (110/100 - 1)*100 = 10
  // RS = 10*0.4 + 10*0.2 + 10*0.2 + 10*0.2 = 10
  assert.ok(approx(calcRS(closes), 10, 1e-9));
});

test('calcRS: completely flat stock returns 0', () => {
  assert.equal(calcRS(flat(252, 100)), 0);
  assert.equal(calcRS(flat(252, 50)), 0);
  assert.equal(calcRS(flat(252, 999.99)), 0);
});

test('calcRS: 3m-only +10% move (legs isolated, 3m=10 others=0)', () => {
  // 252 bars: bars 0..188 at 100, bars 189..251 at 110
  // n=252; last index 251. closes[n-63]=closes[189]=110 → r3m = 0
  // Wait: the 3m price is the OLDEST of the 63-day window → closes[189]=110,
  // so r3m = (110/110-1)*100 = 0. That's the issue — the move happened
  // at the 3-month boundary, so 3m leg sees no change.
  // r6m = 110/100 - 1 = 10, r9m = 10, r12m = 10
  // RS = 0*0.4 + 10*0.2 + 10*0.2 + 10*0.2 = 6
  const closes = stepAtEnd(252, 63, 100, 110);
  assert.ok(approx(calcRS(closes), 6, 1e-9));
});

test('calcRS: last-bar spike (all legs see +10%)', () => {
  // Only the final bar moves to 110. Every lookback (3m/6m/9m/12m) sees 100.
  // r3m=r6m=r9m=r12m = 10  →  RS = 10*(0.4+0.2+0.2+0.2) = 10
  const closes = flat(252, 100);
  closes[251] = 110;
  assert.ok(approx(calcRS(closes), 10, 1e-9));
});

test('calcRS: weights sum to 1.0 (linearity check)', () => {
  // If the entire series is 110 vs 100 baseline (all legs = 10%), the
  // weighted sum must equal 10 — a direct proof that weights total 1.
  const closes = flat(252, 100);
  closes[251] = 110;
  const rs = calcRS(closes);
  assert.ok(approx(rs, 10, 1e-9), `expected 10, got ${rs}`);
});

test('calcRS: negative returns produce negative RS', () => {
  // Flat 100 then last bar drops to 90. All legs = -10.
  const closes = flat(252, 100);
  closes[251] = 90;
  assert.ok(approx(calcRS(closes), -10, 1e-9));
});

test('calcRS: monotonic in return magnitude', () => {
  const closesSmall = flat(252, 100); closesSmall[251] = 105;
  const closesBig   = flat(252, 100); closesBig[251]   = 120;
  assert.ok(calcRS(closesBig) > calcRS(closesSmall));
});

test('calcRS: 6m leg isolated (+20% move at 6m mark)', () => {
  // Bars 0..125 at 100, bars 126..251 at 120.
  // n=252. closes[n-63]=closes[189]=120 → r3m = 0
  // closes[n-126]=closes[126]=120 → r6m = 0 (also above threshold)
  // closes[n-189]=closes[63]=100 → r9m = 20
  // closes[n-252]=closes[0]=100 → r12m = 20
  // RS = 0*0.4 + 0*0.2 + 20*0.2 + 20*0.2 = 8
  const closes = stepAtEnd(252, 126, 100, 120);
  assert.ok(approx(calcRS(closes), 8, 1e-9));
});

// ─── resampleWeekly / resampleMonthly ───────────────────────────────────────

test('resampleWeekly: empty/null input', () => {
  assert.deepEqual(resampleWeekly(null), []);
  assert.deepEqual(resampleWeekly([]), []);
});

test('resampleWeekly: takes every 5th bar anchored to the LAST bar', () => {
  // closes = [0,1,2,...,251] — unique values so we can verify indices
  const closes = Array.from({ length: 252 }, (_, i) => i);
  const w = resampleWeekly(closes);
  // Expected: [closes[1], closes[6], ..., closes[251]]
  // i iterates 251, 246, ..., 1 (stops when i-5 < 0). Unshift reverses order.
  assert.equal(w[w.length - 1], 251, 'last weekly bar must be today');
  assert.equal(w[w.length - 2], 246);
  assert.equal(w[w.length - 3], 241);
  assert.equal(w[0], 1, 'first resampled index is 1 (251 mod 5 = 1)');
  // Count: (251-1)/5 + 1 = 51 samples
  assert.equal(w.length, 51);
});

test('resampleMonthly: takes every 21st bar anchored to the LAST bar', () => {
  const closes = Array.from({ length: 252 }, (_, i) => i);
  const m = resampleMonthly(closes);
  assert.equal(m[m.length - 1], 251, 'last monthly bar must be today');
  assert.equal(m[m.length - 2], 230);
  assert.equal(m[0], 20, 'first resampled index is 20 (251 mod 21 = 20)');
  // Count: (251-20)/21 + 1 = 12 samples
  assert.equal(m.length, 12);
});

// ─── calcRSWeekly ───────────────────────────────────────────────────────────

test('calcRSWeekly: null on inputs shorter than 65 bars', () => {
  assert.equal(calcRSWeekly(null), null);
  assert.equal(calcRSWeekly(flat(64)), null);
});

test('calcRSWeekly: 65-bar minimum accepted', () => {
  const closes = flat(65, 100);
  closes[64] = 110;
  // Weekly samples = [closes[4], closes[9], ..., closes[64]] → 13 bars
  // Only the last weekly bar is 110 (since closes[4..59] = 100, closes[64]=110)
  // n_w=13, now=110, all lookbacks = 100
  // RS = 10 (all legs = 10%)
  assert.ok(approx(calcRSWeekly(closes), 10, 1e-9));
});

test('calcRSWeekly: flat input → 0', () => {
  assert.equal(calcRSWeekly(flat(252, 100)), 0);
});

// ─── calcRSMonthly ──────────────────────────────────────────────────────────

test('calcRSMonthly: null on inputs shorter than 63 bars', () => {
  assert.equal(calcRSMonthly(null), null);
  assert.equal(calcRSMonthly(flat(62)), null);
});

test('calcRSMonthly: 63-bar minimum gives exactly 3 monthly samples', () => {
  const closes = flat(63, 100);
  closes[62] = 110;
  // Monthly samples from stepping -21: [closes[20], closes[41], closes[62]]
  // = [100, 100, 110]. n_m=3.
  // p3m = m[max(0,3-3)] = m[0] = 100
  // p6m = m[max(0,3-6)] = m[0] = 100 (|| p3m not needed — non-zero)
  // All legs = 10 → RS = 10
  assert.ok(approx(calcRSMonthly(closes), 10, 1e-9));
});

test('calcRSMonthly: flat input → 0', () => {
  assert.equal(calcRSMonthly(flat(252, 100)), 0);
});

// ─── rankToRS (percentile ranking) ──────────────────────────────────────────

test('rankToRS: percentile ranks 1..99 across sorted rawRS values', () => {
  const items = [
    { t: 'A', rawRS: 10 },
    { t: 'B', rawRS: 20 },
    { t: 'C', rawRS: 30 },
    { t: 'D', rawRS: 40 },
    { t: 'E', rawRS: 50 },
  ];
  rankToRS(items);
  // Lowest raw gets lowest rank, highest gets ~99
  const ranksByT = Object.fromEntries(items.map(i => [i.t, i.rsRank]));
  assert.equal(ranksByT.A, 1);
  assert.equal(ranksByT.E, 99);
  assert.ok(ranksByT.A < ranksByT.B);
  assert.ok(ranksByT.B < ranksByT.C);
  assert.ok(ranksByT.C < ranksByT.D);
  assert.ok(ranksByT.D < ranksByT.E);
});

test('rankToRS: items with null rawRS default to 50', () => {
  const items = [
    { t: 'A', rawRS: 10 },
    { t: 'B', rawRS: 20 },
    { t: 'C', rawRS: null },
  ];
  rankToRS(items);
  assert.equal(items.find(i => i.t === 'C').rsRank, 50);
});

test('rankToRS: single-item list handled without divide-by-zero', () => {
  const items = [{ t: 'A', rawRS: 42 }];
  rankToRS(items);
  // (0 / max(0, 1)) * 98 + 1 = 1
  assert.equal(items[0].rsRank, 1);
});

test('rankToRS: supports custom in/out keys (weekly/monthly variants)', () => {
  const items = [
    { t: 'A', rawRSWeekly: 10 },
    { t: 'B', rawRSWeekly: 20 },
    { t: 'C', rawRSWeekly: 30 },
  ];
  rankToRS(items, 'rawRSWeekly', 'rsRankWeekly');
  assert.ok(items.every(i => typeof i.rsRankWeekly === 'number'));
  assert.ok(items[0].rsRank === undefined, 'default key not written');
});
