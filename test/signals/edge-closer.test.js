// ─── Tests: edge-closer (outcome computation + orchestration) ───────────────
//
// Hand-computable cases verify the 5/10/20d return math, MFE/MAE tracking,
// stop/target detection, and the winner/loser/neutral labelling. A synthetic
// bar-fetcher is injected so nothing touches the network.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../../src/data/database').getDB();

const { logSignal, getSignal } = require('../../src/signals/edge-telemetry');
const {
  computeOutcome,
  runOutcomeCloser,
  setBarFetcher,
  WIN_THRESHOLD,
  LOSE_THRESHOLD,
} = require('../../src/signals/edge-closer');

// Helper: build a bar series starting AFTER the given emission date. Close
// values follow `closes`; high/low are close±1% by default so we can test
// hit detection independently.
function makeBars(emissionDate, closes, hlOffset = 0.01) {
  const bars = [];
  const start = new Date(emissionDate + 'T00:00:00Z');
  for (let i = 0; i < closes.length; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i + 1);            // day after emission
    const close = closes[i];
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: close,
      high: close * (1 + hlOffset),
      low: close * (1 - hlOffset),
      close,
      volume: 1_000_000,
    });
  }
  return bars;
}

// ─── computeOutcome: pure math ─────────────────────────────────────────────

test('computeOutcome: long signal with clean 5% gain over 20 bars', () => {
  const sig = {
    emission_date: '2025-01-01',
    side: 'long',
    entry_price: 100,
    stop_price: 95,
    target1_price: 110,
    target2_price: 120,
  };
  // 20 bars: linear ramp from 101 to 106 (+6% at day 20)
  const closes = Array.from({ length: 20 }, (_, i) => 101 + (i * 0.25));
  const bars = makeBars('2025-01-01', closes, 0);   // H=L=C for this test

  const out = computeOutcome(sig, bars);
  assert.equal(out.status, 'resolved');
  // ret_5d = (closes[4] - 100)/100 = (102 - 100)/100 = 0.02
  assert.equal(+out.ret_5d.toFixed(4), 0.02);
  assert.equal(+out.ret_10d.toFixed(4), 0.0325);
  // ret_20d = (closes[19] - 100)/100 = (105.75 - 100)/100 = 0.0575
  assert.equal(+out.ret_20d.toFixed(4), 0.0575);
  assert.equal(out.outcome_label, 'winner');       // ≥ 5% threshold
  assert.equal(out.hit_stop, false);               // never touched 95
  assert.equal(out.hit_target1, false);            // never reached 110
  assert.ok(out.max_favorable >= 0.0575);
  assert.equal(out.max_adverse, 0);                // monotonic up, MAE=0
});

test('computeOutcome: stop hit triggers loser label even if later recovers', () => {
  const sig = {
    emission_date: '2025-02-01',
    side: 'long',
    entry_price: 100,
    stop_price: 92,
    target1_price: 115,
  };
  // Dip to 90 on day 2 (low = 89.1), then recover to 101 at day 20
  const closes = [99, 90, 95, 97, 98, 99, 100, 100, 100, 100,
                  100, 100, 100, 100, 100, 101, 101, 101, 101, 101];
  const bars = makeBars('2025-02-01', closes, 0.01);

  const out = computeOutcome(sig, bars);
  assert.equal(out.hit_stop, true);                    // low 89.1 ≤ 92
  assert.equal(out.outcome_label, 'loser');
  // Return at day 20 = +1% — but hit_stop still dominates
  assert.equal(+out.ret_20d.toFixed(4), 0.01);
});

test('computeOutcome: target1 hit => winner even when ret_20d would be neutral', () => {
  const sig = {
    emission_date: '2025-03-01',
    side: 'long',
    entry_price: 100,
    stop_price: 95,
    target1_price: 108,
  };
  // Pop to 109 on day 3 (high 110.09), then fade to 101 by day 20
  const closes = [102, 105, 109, 107, 106, 105, 104, 103, 102, 102,
                  102, 102, 101, 101, 101, 101, 101, 101, 101, 101];
  const bars = makeBars('2025-03-01', closes, 0.01);

  const out = computeOutcome(sig, bars);
  assert.equal(out.hit_target1, true);
  assert.equal(out.outcome_label, 'winner');
  // ret_20d = +1% (neutral in isolation) but target hit promoted to winner
  assert.equal(+out.ret_20d.toFixed(4), 0.01);
});

test('computeOutcome: short signal uses entry-close inverted', () => {
  const sig = {
    emission_date: '2025-04-01',
    side: 'short',
    entry_price: 100,
    stop_price: 105,
    target1_price: 90,
  };
  // Price falls steadily — good for a short
  const closes = Array.from({ length: 20 }, (_, i) => 99 - i * 0.5);
  const bars = makeBars('2025-04-01', closes, 0.01);

  const out = computeOutcome(sig, bars);
  // Short ret = (entry - close) / entry. At day 20: close=89.5, ret = 0.105
  assert.ok(out.ret_20d > 0.10);
  assert.equal(out.outcome_label, 'winner');
  // Short target1 (price falls to 90) — low 88.605 < 90 at day 19
  assert.equal(out.hit_target1, true);
});

test('computeOutcome: partial-horizon bars leave status=open', () => {
  const sig = {
    emission_date: '2025-05-01', side: 'long',
    entry_price: 100, stop_price: 95, target1_price: 110,
  };
  // Only 12 bars available — ret_5d and ret_10d resolve, ret_20d = null
  const closes = Array.from({ length: 12 }, (_, i) => 100 + i * 0.3);
  const bars = makeBars('2025-05-01', closes, 0);

  const out = computeOutcome(sig, bars);
  assert.equal(out.status, 'open');               // horizon not yet complete
  assert.ok(out.ret_5d != null);
  assert.ok(out.ret_10d != null);
  assert.equal(out.ret_20d, null);
  assert.equal(out.outcome_label, null);          // labels gated on 20d completion
});

test('computeOutcome: null entry_price short-circuits to null', () => {
  assert.equal(computeOutcome({ emission_date: '2025-06-01' }, makeBars('2025-06-01', [100, 101])), null);
});

test('computeOutcome: realized_r reflects stop-distance risk', () => {
  const sig = {
    emission_date: '2025-07-01', side: 'long',
    entry_price: 100, stop_price: 98,             // 2-point risk
    target1_price: 110,
  };
  // Day 20 close = 106 → gain 6 / risk 2 = 3R
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 0.3);
  const bars = makeBars('2025-07-01', closes, 0);
  const out = computeOutcome(sig, bars);
  assert.equal(+out.realized_r.toFixed(2), 2.85);   // (105.7-100)/2
});

// ─── runOutcomeCloser: end-to-end with injected fetcher ────────────────────

test('runOutcomeCloser: resolves an old signal with synthetic bars', async () => {
  const id = logSignal({
    source: 'trade_setup', symbol: 'FAKE',
    verdict: 'BUY', confidence: 'high',
    entry_price: 100, stop_price: 95, target1_price: 108,
    emission_date: '2024-12-01',                    // well outside minAgeDays
  });

  // Inject fetcher returning ≥20 forward bars that make FAKE a winner
  const closes = Array.from({ length: 22 }, (_, i) => 100 + i * 0.4);
  const bars = makeBars('2024-12-01', closes, 0);
  setBarFetcher(async (sym) => sym === 'FAKE' ? bars : null);

  const result = await runOutcomeCloser({ minAgeDays: 1, limit: 100 });
  assert.ok(result.examined >= 1);
  assert.ok(result.resolved >= 1);

  const row = getSignal(id);
  assert.equal(row.status, 'resolved');
  assert.ok(row.ret_20d > 0.05);
  assert.equal(row.outcome_label, 'winner');

  // Reset fetcher so later tests don't inherit this stub
  setBarFetcher(null);
});

test('runOutcomeCloser: provider failure is logged but does not throw', async () => {
  logSignal({
    source: 'trade_setup', symbol: 'BROKEN',
    entry_price: 100, emission_date: '2024-11-01',
  });
  setBarFetcher(async () => { throw new Error('provider down'); });

  const result = await runOutcomeCloser({ minAgeDays: 1, limit: 100 });
  assert.ok(result.errors.find(e => e.symbol === 'BROKEN'));
  setBarFetcher(null);
});

// Sanity: the thresholds exported match the documentation
test('winner/loser thresholds match constants', () => {
  assert.equal(WIN_THRESHOLD, 0.05);
  assert.equal(LOSE_THRESHOLD, -0.03);
});
