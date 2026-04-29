// ─── Tests: runSweep checkpoint + resume (src/signals/replay-sweep.js) ─────
//
// Pins the resume protocol so a future refactor can't silently break the
// behavior the user explicitly asked for: server crash mid-sweep should
// resume from the last checkpoint, NOT restart from combo 0.
//
// We stub runReplay so each "evaluate combo" call is instant and returns
// deterministic synthetic stats. That way the test focuses on the sweep
// orchestrator's loop control, checkpoint cadence, and resume math —
// not on the underlying engine. With ~50 combos per strategy × multiple
// flavors a real call would take 30+ seconds; stubbed it's milliseconds.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Stubs installed BEFORE requiring sweep ─────────────────────────────────
// runReplay returns a deterministic result keyed off the strategy + first
// param so we can predict outperforming counts. runWalkForward / runMC are
// stubbed to never fire (deep-dive paths aren't exercised by these tests).
let _replayCallCount = 0;
require.cache[require.resolve('../../src/signals/replay')] = {
  exports: {
    runReplay: ({ strategy, params, startDate, endDate }) => {
      _replayCallCount++;
      // Synthetic stats: every other combo "beats SPY" so outperforming
      // is exactly half of done. Keeps assertions trivial.
      const beatsSpy = _replayCallCount % 2 === 0;
      return {
        performance: {
          totalReturn: beatsSpy ? 25 : 5,
          maxDrawdown: 10,
          sharpeRatio: 1.0,
          profitFactor: 1.5,
          alpha: beatsSpy ? 10 : -5,
        },
        benchmark: { spyReturn: 15 },
        trades: { total: 10, winRate: 60 },
        tradeLog: [],
      };
    },
    runWalkForward: async () => { throw new Error('runWalkForward should not be called in these tests'); },
    runMonteCarlo: () => { throw new Error('runMonteCarlo should not be called in these tests'); },
    compareStrategies: () => { throw new Error('compareStrategies should not be called in these tests'); },
    BUILT_IN_STRATEGIES: {
      rs_momentum:  { name: 'RS Momentum',  side: 'long' },
      sepa_trend:   { name: 'SEPA Trend',   side: 'long' },
    },
  },
};

const { runSweep } = require('../../src/signals/replay-sweep');

function resetStub() { _replayCallCount = 0; }

// Capture every onCheckpoint blob the sweep emits. Test asserts cadence
// + content from this array.
function captureCheckpoints() {
  const out = [];
  return { fn: (cp) => out.push(cp), get: () => out };
}

// Same for onProgress.
function captureProgress() {
  const out = [];
  return { fn: (p) => out.push(p), get: () => out };
}

// ─── 1. Initial checkpoint fires BEFORE any combo runs ─────────────────────
test('checkpoint: initial checkpoint emits with done=0 before first combo', async () => {
  resetStub();
  const cp = captureCheckpoints();
  await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    onCheckpoint: cp.fn, checkpointEveryN: 25,
  });
  const checkpoints = cp.get();
  assert.ok(checkpoints.length >= 1, 'should emit at least one checkpoint');
  // First checkpoint has empty results (the pre-loop one).
  assert.equal(checkpoints[0].results.length, 0, 'initial checkpoint must have empty results');
  assert.ok(checkpoints[0].queue.length > 0, 'initial checkpoint must have the queue persisted');
  assert.equal(checkpoints[0].outperforming, 0);
});

// ─── 2. Checkpoints fire every checkpointEveryN combos ─────────────────────
test('checkpoint: cadence honors checkpointEveryN parameter', async () => {
  resetStub();
  const cp = captureCheckpoints();
  await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    onCheckpoint: cp.fn, checkpointEveryN: 10,
  });
  const checkpoints = cp.get();
  // Initial + every 10 combos + final. With ~324 combos for rs_momentum
  // (3 minRS × 2 minMomentum × 3 holdDays × 3 stopATR × 3 targetATR
  // × 3 exits × 2 regimes = 972 ... actually times 3 trade modes,
  // minus modeOverridden, etc.) — exact count varies; just assert
  // cadence between successive non-final checkpoints.
  assert.ok(checkpoints.length >= 3, `should emit several checkpoints, got ${checkpoints.length}`);
  // Skip the initial (results=0) and the final (results=total). The middle
  // ones should be at multiples of checkpointEveryN.
  const middle = checkpoints.slice(1, -1);
  for (const c of middle) {
    assert.equal(c.results.length % 10, 0,
      `checkpoint at results.length=${c.results.length} should be multiple of 10`);
  }
});

// ─── 3. Resume skips already-evaluated combos ──────────────────────────────
test('resume: resumeFrom with N pre-evaluated results skips first N combos', async () => {
  resetStub();
  // Run a small sweep to capture a real checkpoint we can resume from.
  const cp = captureCheckpoints();
  await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    onCheckpoint: cp.fn, checkpointEveryN: 50,
  });
  const fullRun = cp.get();
  // Pick a mid-run checkpoint with ~50% done.
  const midCheckpoint = fullRun.find(c => c.results.length > 50 && c.results.length < c.total);
  assert.ok(midCheckpoint, 'should find a mid-run checkpoint to resume from');

  // Reset call counter and resume.
  resetStub();
  const cp2 = captureCheckpoints();
  const prog2 = captureProgress();
  await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    resumeFrom: midCheckpoint,
    onCheckpoint: cp2.fn,
    onProgress: prog2.fn,
    checkpointEveryN: 50,
  });

  // The resumed run should have done EXACTLY (total - resumed.results.length)
  // engine calls — not the full total.
  const expectedRemaining = midCheckpoint.total - midCheckpoint.results.length;
  assert.equal(_replayCallCount, expectedRemaining,
    `resume should run only ${expectedRemaining} engine calls, got ${_replayCallCount}`);

  // First progress tick after resume should report done=resumed (not 0).
  const firstProgress = prog2.get()[0];
  assert.equal(firstProgress.done, midCheckpoint.results.length,
    `first progress tick on resume should report done=${midCheckpoint.results.length}`);
  assert.match(firstProgress.current, /resumed from/);

  // Last progress tick should reach total.
  const lastProgress = prog2.get()[prog2.get().length - 1];
  assert.equal(lastProgress.done, midCheckpoint.total);
});

// ─── 4. Resume preserves the outperforming count from the checkpoint ───────
test('resume: outperforming count is carried forward from checkpoint', async () => {
  resetStub();
  // Coherent fake: 5 queued combos, 3 already evaluated (results),
  // remaining 2 will be processed by the resume.
  const mkQ = (sr) => ({ strategy: 'rs_momentum', comboParams: { minRS: 80 },
    exit: 'full_in_full_out', strictRegime: sr, tradeMode: null });
  const fakeCp = {
    queue: [mkQ(true), mkQ(false), mkQ(true), mkQ(false), mkQ(true)],
    results: [
      { strategy: 'rs_momentum', afterTaxAlpha: 5, preTaxAlpha: 6, error: null },
      { strategy: 'rs_momentum', afterTaxAlpha: 3, preTaxAlpha: 4, error: null },
      { strategy: 'rs_momentum', afterTaxAlpha: 7, preTaxAlpha: 8, error: null },
    ],
    outperforming: 17,
    total: 5,
  };
  const prog = captureProgress();
  await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    resumeFrom: fakeCp,
    onProgress: prog.fn,
  });
  // First progress tick should reflect the resumed counters verbatim.
  const first = prog.get()[0];
  assert.equal(first.done, 3);
  assert.equal(first.total, 5);
  assert.equal(first.outperforming, 17);
});

// ─── 5. No resumeFrom → starts at zero (regression for resumeFrom=null) ────
test('regression: missing resumeFrom starts at combo 0', async () => {
  resetStub();
  const prog = captureProgress();
  await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    onProgress: prog.fn,
  });
  const first = prog.get()[0];
  assert.equal(first.done, 0);
  assert.match(first.current, /starting/);
});

// ─── 6. Final result shape: top-K + summary computed on merged results ────
test('resume: final result shape is identical to a fresh full run', async () => {
  resetStub();
  // Fresh full run.
  const full = await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    topK: 3,
  });
  resetStub();
  // Resume from a checkpoint at combo 30 of the same params.
  // Run again and capture a real mid-run checkpoint.
  const cp = captureCheckpoints();
  await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    onCheckpoint: cp.fn, checkpointEveryN: 30,
  });
  const mid = cp.get().find(c => c.results.length === 30);
  assert.ok(mid, 'sweep should emit checkpoint at exactly 30 combos');

  resetStub();
  const resumed = await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    topK: 3,
    resumeFrom: mid,
  });
  // Same total combos, same topK length.
  assert.equal(resumed.totalCombos, full.totalCombos);
  assert.equal(resumed.topK.length, full.topK.length);
  // Summary structure preserved.
  assert.ok(resumed.summary);
  assert.equal(resumed.summary.totalCombos, full.summary.totalCombos);
});

// ─── 7. Final checkpoint fires on the last combo ──────────────────────────
test('checkpoint: final tick fires on last combo regardless of cadence', async () => {
  resetStub();
  const cp = captureCheckpoints();
  await runSweep({
    strategies: ['rs_momentum'],
    startDate: '2024-01-01', endDate: '2024-12-31',
    onCheckpoint: cp.fn, checkpointEveryN: 1000,  // way larger than total
  });
  const last = cp.get()[cp.get().length - 1];
  assert.equal(last.results.length, last.total,
    'final checkpoint must have results.length === total');
});
