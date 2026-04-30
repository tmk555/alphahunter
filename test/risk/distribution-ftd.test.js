// ─── Tests for Phase 3.11 (Distribution Days) & Phase 3.12 (FTD) ────────────
// Unit-tests the extracted helper functions on regime.js: _countDistributionDays,
// _detectFTD, _confirmFTD. These are pure-computation cores — no network or DB.
//
// Helpers are attached to autoDetectCycleState as static properties for
// testing (see end of src/risk/regime.js).
//
// Converted from Jest to node:test on 2026-04-30.

const test = require('node:test');
const assert = require('node:assert/strict');

const { autoDetectCycleState } = require('../../src/risk/regime');
const { _countDistributionDays, _detectFTD, _confirmFTD, FTD_GAIN_THRESHOLD } =
  autoDetectCycleState;

// ─── Bar factory ──────────────────────────────────────────────────────────
function makeBars(specs) {
  const bars = [{ date: '2025-01-02', open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 }];
  let price = 100;
  for (let i = 0; i < specs.length; i++) {
    const { chg = 0, vol = 1_000_000 } = specs[i];
    const newPrice = +(price * (1 + chg)).toFixed(4);
    const d = new Date(2025, 0, 3 + i);
    bars.push({
      date: d.toISOString().split('T')[0],
      open: price,
      high: Math.max(price, newPrice) * 1.002,
      low: Math.min(price, newPrice) * 0.998,
      close: newPrice,
      volume: vol,
    });
    price = newPrice;
  }
  return bars;
}

function buildBarsWithHistory(customSpecs) {
  const history = [];
  for (let i = 0; i < 55; i++) {
    history.push({ chg: 0.001, vol: 1_000_000 });
  }
  return makeBars([...history, ...customSpecs]);
}

// ─── 3.11: Distribution Day Tests ────────────────────────────────────────

test('dist: counts a dist day when close drops ≥0.2% on above-avg volume', () => {
  const bars = buildBarsWithHistory([{ chg: -0.005, vol: 1_500_000 }]);
  const result = _countDistributionDays(bars, 'SPY');
  assert.equal(result.count, 1);
  assert.equal(result.active.length, 1);
  assert.ok(result.all.length >= 1);
  assert.equal(result.all[result.all.length - 1].index, 'SPY');
});

test('dist: does NOT count a down day on below-avg volume', () => {
  const bars = buildBarsWithHistory([{ chg: -0.005, vol: 500_000 }]);
  const result = _countDistributionDays(bars, 'SPY');
  const lastDate = bars[bars.length - 1].date;
  assert.equal(result.active.includes(lastDate), false);
});

test('dist: does NOT count an up day on high volume', () => {
  const bars = buildBarsWithHistory([{ chg: 0.005, vol: 2_000_000 }]);
  const result = _countDistributionDays(bars, 'QQQ');
  const lastDate = bars[bars.length - 1].date;
  assert.equal(result.active.includes(lastDate), false);
});

test('dist: does NOT count a tiny decline (-0.1%) even on high volume', () => {
  const bars = buildBarsWithHistory([{ chg: -0.001, vol: 2_000_000 }]);
  const result = _countDistributionDays(bars, 'SPY');
  const lastDate = bars[bars.length - 1].date;
  assert.equal(result.active.includes(lastDate), false);
});

test('dist: counts multiple distribution days correctly', () => {
  const specs = [];
  for (let i = 0; i < 20; i++) {
    if (i % 4 === 0) specs.push({ chg: -0.003, vol: 1_500_000 });
    else specs.push({ chg: 0.002, vol: 900_000 });
  }
  const bars = buildBarsWithHistory(specs);
  const result = _countDistributionDays(bars, 'SPY');
  assert.equal(result.count, 5);
});

test('dist: expires dist days outside 25-session window', () => {
  const oldDist = [];
  for (let i = 0; i < 30; i++) oldDist.push({ chg: -0.005, vol: 1_500_000 });
  const clean = [];
  for (let i = 0; i < 25; i++) clean.push({ chg: 0.001, vol: 900_000 });
  const bars = makeBars([...new Array(5).fill({ chg: 0.001, vol: 1_000_000 }), ...oldDist, ...clean]);
  const result = _countDistributionDays(bars, 'SPY');
  assert.equal(result.count, 0);
  assert.ok(result.all.length > 0);
});

test('dist: returns 0 for insufficient data', () => {
  const bars = makeBars([{ chg: 0.001, vol: 1_000_000 }]);
  const result = _countDistributionDays(bars, 'SPY');
  assert.equal(result.count, 0);
});

// ── O'Neil +5% recovery-scrub rule ──────────────────────────────────────

test('scrub: dist day scrubbed when index closes ≥+5% above that close', () => {
  const specs = [
    { chg: -0.01,  vol: 1_500_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
  ];
  const bars = buildBarsWithHistory(specs);
  const result = _countDistributionDays(bars, 'SPY');
  assert.equal(result.rawCount, 1);
  assert.equal(result.count, 0);
  assert.equal(result.scrubbedCount, 1);
  assert.equal(result.scrubbed.length, 1);
});

test('scrub: does NOT scrub when subsequent recovery < +5%', () => {
  const specs = [
    { chg: -0.01,  vol: 1_500_000 },
    { chg: 0.005, vol: 900_000 },
    { chg: 0.005, vol: 900_000 },
    { chg: 0.005, vol: 900_000 },
    { chg: 0.005, vol: 900_000 },
  ];
  const bars = buildBarsWithHistory(specs);
  const result = _countDistributionDays(bars, 'SPY');
  assert.equal(result.rawCount, 1);
  assert.equal(result.count, 1);
  assert.equal(result.scrubbedCount, 0);
});

test('scrub: scrubs old, keeps fresh (mixed case)', () => {
  const specs = [
    { chg: -0.01,  vol: 1_500_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: -0.005, vol: 1_500_000 },
  ];
  const bars = buildBarsWithHistory(specs);
  const result = _countDistributionDays(bars, 'SPY');
  assert.equal(result.rawCount, 2);
  assert.equal(result.count, 1);
  assert.equal(result.scrubbedCount, 1);
});

test('recent10Count counts only active dist days in last 10 sessions', () => {
  const specs = [
    { chg: -0.01,  vol: 1_500_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.015, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: 0.001, vol: 900_000 },
    { chg: -0.005, vol: 1_500_000 },
  ];
  const bars = buildBarsWithHistory(specs);
  const result = _countDistributionDays(bars, 'SPY');
  assert.equal(result.count, 1);
  assert.equal(result.recent10Count, 1);
});

test('recent10Count is 0 when all active dist days are older than 10 sessions', () => {
  const specs = [];
  specs.push({ chg: -0.005, vol: 1_500_000 });
  for (let i = 0; i < 15; i++) specs.push({ chg: 0.001, vol: 900_000 });

  const bars = buildBarsWithHistory(specs);
  const result = _countDistributionDays(bars, 'SPY');
  assert.equal(result.count, 1);
  assert.equal(result.scrubbedCount, 0);
  assert.equal(result.recent10Count, 0);
});

// ─── 3.12: Follow-Through Day Tests ───────────────────────────────────────

test('FTD_GAIN_THRESHOLD is 1.5%', () => {
  assert.equal(FTD_GAIN_THRESHOLD, 0.015);
});

test('FTD: detects on day 4 with ≥1.5% gain and higher volume', () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.020, vol: 1_500_000 });

  const bars = buildBarsWithHistory(specs);
  const result = _detectFTD(bars, 'SPY');
  assert.equal(result.fired, true);
  assert.equal(result.index, 'SPY');
  assert.ok(result.date);
});

test('FTD: does NOT fire before day 4', () => {
  const specs = [];
  for (let i = 0; i < 10; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
  specs.push({ chg: 0.005, vol: 1_000_000 });
  specs.push({ chg: 0.025, vol: 1_500_000 });
  specs.push({ chg: 0.005, vol: 1_000_000 });

  const bars = buildBarsWithHistory(specs);
  const result = _detectFTD(bars, 'QQQ');
  assert.ok(result.rallyDay < 4);
});

test('FTD: does NOT fire after day 7', () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ chg: -0.02, vol: 1_000_000 });
  for (let i = 0; i < 8; i++) specs.push({ chg: 0.003, vol: 900_000 });
  const bars = buildBarsWithHistory(specs);
  const result = _detectFTD(bars, 'SPY');
  assert.equal(result.fired, false);
});

test('FTD: does NOT fire if gain is below 1.5% threshold', () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.010, vol: 1_500_000 });

  const bars = buildBarsWithHistory(specs);
  const result = _detectFTD(bars, 'SPY');
  assert.equal(result.fired, false);
});

test('FTD: does NOT fire if volume is lower than prior day', () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 2_000_000 });
  specs.push({ chg: 0.003, vol: 2_000_000 });
  specs.push({ chg: 0.003, vol: 2_000_000 });
  specs.push({ chg: 0.020, vol: 1_500_000 });

  const bars = buildBarsWithHistory(specs);
  const result = _detectFTD(bars, 'SPY');
  assert.equal(result.fired, false);
});

test('FTD: fires on QQQ index label', () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.020, vol: 1_500_000 });

  const bars = buildBarsWithHistory(specs);
  const result = _detectFTD(bars, 'QQQ');
  assert.equal(result.fired, true);
  assert.equal(result.index, 'QQQ');
});

// ─── 3.12: FTD Confirmation Tests ────────────────────────────────────────

test('confirm: FTD confirmed when ≤1 dist day follows in 3-5 sessions', () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.020, vol: 1_500_000 });
  for (let i = 0; i < 5; i++) specs.push({ chg: 0.005, vol: 900_000 });

  const bars = buildBarsWithHistory(specs);
  const ftdResult = _detectFTD(bars, 'SPY');
  assert.equal(ftdResult.fired, true);

  const vol50Avg = bars.slice(-50).reduce((s, b) => s + b.volume, 0) / 50;
  const confirm = _confirmFTD(bars, ftdResult.date, vol50Avg);
  assert.equal(confirm.confirmed, true);
  assert.equal(confirm.failed, false);
});

test('confirm: FTD fails when 2+ dist days follow', () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.020, vol: 1_500_000 });
  for (let i = 0; i < 5; i++) specs.push({ chg: -0.005, vol: 1_500_000 });

  const bars = buildBarsWithHistory(specs);
  const ftdResult = _detectFTD(bars, 'SPY');
  assert.equal(ftdResult.fired, true);

  const vol50Avg = bars.slice(-50).reduce((s, b) => s + b.volume, 0) / 50;
  const confirm = _confirmFTD(bars, ftdResult.date, vol50Avg);
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.failed, true);
  assert.ok(confirm.postFTDDistDays >= 2);
});

test('confirm: returns pending when fewer than 3 sessions after FTD', () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.003, vol: 1_000_000 });
  specs.push({ chg: 0.020, vol: 1_500_000 });
  specs.push({ chg: 0.005, vol: 900_000 });

  const bars = buildBarsWithHistory(specs);
  const ftdResult = _detectFTD(bars, 'SPY');
  assert.equal(ftdResult.fired, true);

  const vol50Avg = bars.slice(-50).reduce((s, b) => s + b.volume, 0) / 50;
  const confirm = _confirmFTD(bars, ftdResult.date, vol50Avg);
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.failed, false);
  assert.equal(confirm.pending, true);
});

test('confirm: returns no-op for null ftdDate', () => {
  const bars = buildBarsWithHistory([]);
  const confirm = _confirmFTD(bars, null, 1_000_000);
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.failed, false);
});
