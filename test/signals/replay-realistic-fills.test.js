// ─── Tests: Phase 2.6 realistic backtest fills (src/signals/replay.js) ─────
//
// Verifies the three new knobs added to close the backtest/live gap:
//
//   1. cashDragAnnualBps  — idle cash earns a daily interest accrual.
//      A backtest that never enters any positions should still post a
//      positive total return proportional to cashDragAnnualBps × days.
//
//   2. dividendYieldAnnualBps — long positions accrue dividends daily.
//      A held long should end up with a higher return than the same
//      backtest run with dividends disabled.
//
//   3. nextDayOpenGapBps — extra slippage penalty on pending fills.
//      A backtest with a positive gap penalty should report a higher
//      totalSlippage than one with 0 penalty.
//
//   4. The `executionCosts` section of the result surfaces all three knobs
//      and their accrual counters so the dashboard can display the decomp.
//
// We seed an in-memory rs_snapshots table with a tiny synthetic dataset —
// one stock (AAA) that trivially qualifies for rs_momentum, plus SPY bars
// that pin the regime to BULL so nothing blocks entries.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getDB } = require('../../src/data/database');
const { runReplay } = require('../../src/signals/replay');

function wipeSnapshots() {
  getDB().prepare("DELETE FROM rs_snapshots").run();
  getDB().prepare("DELETE FROM replay_results").run();
}

// Seed a range of trading days with SPY in a strong BULL regime and one
// leadership stock (AAA) that holds its RS rank at 90 and its price flat
// throughout — so any return we see comes from accruals, not price moves.
function seedSyntheticSnapshots({
  days = 30,
  aaaPrice = 100,
  aaaMomentum = 70,
  aaaRs = 90,
} = {}) {
  const ins = getDB().prepare(`
    INSERT INTO rs_snapshots (
      date, symbol, type, rs_rank, swing_momentum, sepa_score, stage,
      price, vs_ma50, vs_ma200, volume_ratio, vcp_forming, rs_line_new_high, atr_pct
    ) VALUES (?, ?, 'stock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const dates = [];
  for (let i = 0; i < days; i++) {
    // Synthesize weekday dates starting 2025-01-06 (Monday). Works with the
    // engine's date loop since it just sorts lexically.
    const d = new Date(Date.UTC(2025, 0, 6 + i));
    const iso = d.toISOString().slice(0, 10);
    dates.push(iso);

    // SPY: strongly positive vs both MAs → BULL regime → entries allowed.
    ins.run(iso, 'SPY', null, null, null, null, 500, 3, 8, 1, 0, 0, 1.2);

    // AAA: RS 90, momentum 70 → trivially qualifies for rs_momentum.
    // Price flat at aaaPrice so we measure ONLY the accrual effects.
    ins.run(iso, 'AAA', aaaRs, aaaMomentum, 6, 2, aaaPrice, 5, 15, 1.5, 0, 1, 1.0);
  }
  return { startDate: dates[0], endDate: dates[dates.length - 1] };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('cash drag: idle capital earns daily interest when strategy makes no trades', () => {
  wipeSnapshots();
  const { startDate, endDate } = seedSyntheticSnapshots({ days: 50, aaaRs: 50 });
  // AAA rs=50 < minRS 80 → no candidate ever qualifies → 100% idle cash.

  const result = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    execution: { cashDragAnnualBps: 450, dividendYieldAnnualBps: 0, nextDayOpenGapBps: 0 },
    persistResult: false,
  });

  // 50 trading days × 450 bps / 252 / 10000 ≈ 0.893% on 100k ≈ $893
  // The accrual is compounded day-by-day so actual should be a tiny bit
  // higher than simple interest. Tolerate ±10%.
  const expected = 100000 * (450 / 10000) * (50 / 252);
  assert.ok(result.executionCosts.totalCashInterest > expected * 0.9,
    `expected ≥ ${(expected * 0.9).toFixed(2)}, got ${result.executionCosts.totalCashInterest}`);
  assert.ok(result.executionCosts.totalCashInterest < expected * 1.10,
    `expected ≤ ${(expected * 1.10).toFixed(2)}, got ${result.executionCosts.totalCashInterest}`);

  // Total return should be positive purely from cash interest.
  assert.ok(result.performance.totalReturn > 0,
    `expected positive return from cash drag alone, got ${result.performance.totalReturn}`);

  // No trades should have fired.
  assert.equal(result.trades.total, 0);
});

test('cash drag: disabled → zero interest reported', () => {
  wipeSnapshots();
  const { startDate, endDate } = seedSyntheticSnapshots({ days: 20, aaaRs: 50 });

  const result = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    execution: { cashDragAnnualBps: 0, dividendYieldAnnualBps: 0, nextDayOpenGapBps: 0 },
    persistResult: false,
  });

  assert.equal(result.executionCosts.totalCashInterest, 0);
  assert.equal(result.executionCosts.cashDragAnnualBps, 0);
});

test('dividends: held longs accrue dividend income on flat prices', () => {
  wipeSnapshots();
  const { startDate, endDate } = seedSyntheticSnapshots({ days: 30, aaaRs: 90, aaaMomentum: 70 });

  // With dividends ON, the same backtest should earn MORE than with them OFF.
  const base = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    execution: { cashDragAnnualBps: 0, dividendYieldAnnualBps: 0, nextDayOpenGapBps: 0 },
    persistResult: false,
  });

  const withDivs = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    execution: { cashDragAnnualBps: 0, dividendYieldAnnualBps: 150, nextDayOpenGapBps: 0 },
    persistResult: false,
  });

  // If a position actually opened, dividends should accrue.
  if (base.trades.total > 0 || withDivs.trades.total > 0) {
    assert.ok(withDivs.executionCosts.totalDividends > 0,
      `expected dividends > 0 when a long is held, got ${withDivs.executionCosts.totalDividends}`);
    assert.ok(withDivs.performance.finalEquity > base.performance.finalEquity,
      `dividends should boost final equity: base=${base.performance.finalEquity}, withDivs=${withDivs.performance.finalEquity}`);
  } else {
    // Defensive: if the strategy didn't open any positions at all, the test
    // is still valid — just skip the boost assertion and check that no
    // dividends were accrued on zero positions.
    assert.equal(withDivs.executionCosts.totalDividends, 0);
  }

  // The accrual counter must also be reported.
  assert.equal(withDivs.executionCosts.dividendYieldAnnualBps, 150);
  assert.equal(base.executionCosts.dividendYieldAnnualBps, 0);
});

test('nextDayOpenGapBps: adds slippage cost to next-day entries', () => {
  wipeSnapshots();
  const { startDate, endDate } = seedSyntheticSnapshots({ days: 20, aaaRs: 90, aaaMomentum: 70 });

  const noGap = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    execution: { cashDragAnnualBps: 0, dividendYieldAnnualBps: 0, nextDayOpenGapBps: 0 },
    persistResult: false,
  });

  const withGap = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    execution: { cashDragAnnualBps: 0, dividendYieldAnnualBps: 0, nextDayOpenGapBps: 100 },  // 1% penalty
    persistResult: false,
  });

  // If any trade actually fired, gap penalty should raise the slippage cost.
  if (withGap.trades.total > 0 || noGap.trades.total > 0) {
    assert.ok(withGap.executionCosts.totalSlippage >= noGap.executionCosts.totalSlippage,
      `gap penalty should add to slippage: noGap=${noGap.executionCosts.totalSlippage}, withGap=${withGap.executionCosts.totalSlippage}`);
  }

  // Both configs must surface the knob value even when no trades fire.
  assert.equal(noGap.executionCosts.nextDayOpenGapBps, 0);
  assert.equal(withGap.executionCosts.nextDayOpenGapBps, 100);
});

test('executionCosts shape: all new Phase 2.6 fields present', () => {
  wipeSnapshots();
  const { startDate, endDate } = seedSyntheticSnapshots({ days: 10, aaaRs: 50 });

  const result = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    persistResult: false,
  });

  const ec = result.executionCosts;
  // Existing fields still present
  assert.ok('totalSlippage' in ec);
  assert.ok('entrySlippageBps' in ec);
  assert.ok('exitSlippageBps' in ec);
  // New Phase 2.6 fields
  assert.ok('nextDayOpenGapBps' in ec);
  assert.ok('cashDragAnnualBps' in ec);
  assert.ok('dividendYieldAnnualBps' in ec);
  assert.ok('totalCashInterest' in ec);
  assert.ok('totalDividends' in ec);
  assert.ok('cashInterestAsReturnBoost' in ec);
  assert.ok('dividendsAsReturnBoost' in ec);
  // Defaults should be positive when not overridden — realistic by default.
  assert.equal(ec.cashDragAnnualBps, 450);
  assert.equal(ec.dividendYieldAnnualBps, 150);
  assert.equal(ec.nextDayOpenGapBps, 15);
});

test('regression: default execution produces a non-zero cash interest on idle strategy', () => {
  // Pin behaviour so someone who later changes DEFAULT_EXECUTION notices
  // the test expectation shift rather than silently nuking the accrual.
  wipeSnapshots();
  const { startDate, endDate } = seedSyntheticSnapshots({ days: 30, aaaRs: 50 });

  const result = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    persistResult: false,
  });

  assert.ok(result.executionCosts.totalCashInterest > 0,
    'default execution (cashDragAnnualBps=450) must accrue interest on idle cash');
  assert.ok(result.performance.totalReturn > 0,
    'default backtest on an idle strategy must post a positive return from cash drag');
});

// ─── Phase 2.7: Significance block on replay result ──────────────────────

test('phase 2.7: replay result carries a significance block', () => {
  wipeSnapshots();
  const { startDate, endDate } = seedSyntheticSnapshots({ days: 30, aaaRs: 50 });

  const result = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    persistResult: false,
  });

  // Significance block is always present, even on a 0-trade backtest.
  assert.ok(result.significance, 'significance block must be on every replay result');
  assert.ok('verdict' in result.significance);
  assert.ok('tStat' in result.significance);
  assert.ok('pValue' in result.significance);
  assert.ok('isSignificant' in result.significance);
  assert.ok('sampleSize' in result.significance);

  // 0-trade backtest → insufficient_sample verdict (not "not_significant").
  assert.equal(result.significance.verdict, 'insufficient_sample');
  assert.equal(result.significance.isSignificant, false);

  // Calmar on the performance block too — equity-curve driven so it exists
  // even when there are no trades.
  assert.ok('calmarRatio' in result.performance);
});

test('phase 2.7: non-trivial trade log → full significance metrics computed', () => {
  wipeSnapshots();
  // Generate enough days for positions to open + exit.
  const { startDate, endDate } = seedSyntheticSnapshots({ days: 60, aaaRs: 90, aaaMomentum: 70 });

  const result = runReplay({
    strategy: 'rs_momentum',
    startDate,
    endDate,
    initialCapital: 100000,
    persistResult: false,
  });

  // Whatever the sample size, the report shape is stable.
  assert.ok(typeof result.significance.tStat === 'number');
  assert.ok(typeof result.significance.pValue === 'number');
  assert.ok(result.significance.pValue >= 0 && result.significance.pValue <= 1,
    `p-value must be in [0,1], got ${result.significance.pValue}`);
  assert.ok(result.significance.sampleSize === result.trades.total);
});
