// ─── Tests: per-regime breakdown aggregation in runReplay ───────────────────
//
// We don't run the full engine — we exercise the aggregation by stubbing a
// trades array with known entryRegime + pnl values and re-deriving the
// reducer inline. This keeps the test focused on the math (win rate,
// expectancy, PF per regime) without fixturing snapshots/prices.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

// Copy of the aggregation in runReplay (kept in sync manually — if this
// diverges, the replay.js block needs to be refactored into a shared helper).
function buildRegimeBreakdown(trades) {
  const buckets = { BULL: [], NEUTRAL: [], CAUTION: [], CORRECTION: [], UNKNOWN: [] };
  for (const t of trades) {
    const key = (t.entryRegime || 'UNKNOWN').toUpperCase();
    (buckets[key] || buckets.UNKNOWN).push(t);
  }
  const out = {};
  for (const [regime, group] of Object.entries(buckets)) {
    if (!group.length) { out[regime] = { n: 0, winRate: 0, avgR: 0, expectancy: 0, profitFactor: 0, totalPnl: 0 }; continue; }
    const wins    = group.filter(t => t.pnl > 0);
    const losses  = group.filter(t => t.pnl <= 0);
    const winSum  = wins.reduce((a, t) => a + t.pnl, 0);
    const lossSum = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const pfVal   = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? Infinity : 0);
    const avgWin  = wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;
    const wr      = group.length ? wins.length / group.length : 0;
    const expct   = wr * avgWin + (1 - wr) * avgLoss;
    const rSum    = group.reduce((a, t) => a + ((t.pnlPct || 0) / (t.atrPct || 2.5)), 0);
    out[regime] = {
      n: group.length,
      winRate: +(wr * 100).toFixed(1),
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      expectancy: +expct.toFixed(2),
      profitFactor: Number.isFinite(pfVal) ? +pfVal.toFixed(2) : pfVal,
      avgR: +(rSum / group.length).toFixed(2),
      totalPnl: +group.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2),
    };
  }
  return out;
}

test('regime breakdown: empty trades → all buckets zero', () => {
  const r = buildRegimeBreakdown([]);
  for (const key of ['BULL','NEUTRAL','CAUTION','CORRECTION','UNKNOWN']) {
    assert.equal(r[key].n, 0);
    assert.equal(r[key].winRate, 0);
  }
});

test('regime breakdown: segments trades by entryRegime', () => {
  const trades = [
    { entryRegime: 'BULL',    pnl: 500,  pnlPct: 5, atrPct: 2.5 },
    { entryRegime: 'BULL',    pnl: 300,  pnlPct: 3, atrPct: 2.5 },
    { entryRegime: 'BULL',    pnl: -100, pnlPct: -1, atrPct: 2.5 },
    { entryRegime: 'CAUTION', pnl: -200, pnlPct: -2, atrPct: 2.5 },
    { entryRegime: 'CAUTION', pnl: -300, pnlPct: -3, atrPct: 2.5 },
  ];
  const r = buildRegimeBreakdown(trades);
  // BULL: 2W/1L → 66.7% win rate, expectancy = 0.667*4 + 0.333*(-1) = 2.33
  assert.equal(r.BULL.n, 3);
  assert.equal(r.BULL.winRate, 66.7);
  assert.ok(r.BULL.expectancy > 2 && r.BULL.expectancy < 3,
    `BULL expectancy ${r.BULL.expectancy} out of range`);
  assert.equal(r.BULL.totalPnl, 700);
  // CAUTION: 0W/2L → 0% win, expectancy = -2.5
  assert.equal(r.CAUTION.n, 2);
  assert.equal(r.CAUTION.winRate, 0);
  assert.equal(r.CAUTION.expectancy, -2.5);
  // NEUTRAL: no trades
  assert.equal(r.NEUTRAL.n, 0);
});

test('regime breakdown: profit factor is Infinity on all-wins', () => {
  const trades = [
    { entryRegime: 'BULL', pnl: 100, pnlPct: 1, atrPct: 2.5 },
    { entryRegime: 'BULL', pnl: 200, pnlPct: 2, atrPct: 2.5 },
  ];
  const r = buildRegimeBreakdown(trades);
  assert.equal(r.BULL.profitFactor, Infinity);
});

test('regime breakdown: missing entryRegime bucketed as UNKNOWN', () => {
  const trades = [
    { pnl: 100, pnlPct: 1, atrPct: 2.5 },
    { entryRegime: null, pnl: -50, pnlPct: -0.5, atrPct: 2.5 },
  ];
  const r = buildRegimeBreakdown(trades);
  assert.equal(r.UNKNOWN.n, 2);
  assert.equal(r.BULL.n, 0);
});
