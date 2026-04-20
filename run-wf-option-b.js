// Walk-forward Option B: pattern-focused factor_combo sweep.
// Isolates each classical pattern against a pure rs_strong baseline so we can
// tell whether pattern filters actually add edge (vs. just reducing trade count).
require('dotenv').config();
const { runWalkForward } = require('./src/signals/replay');

const paramGrid = {
  signals: [
    ['rs_strong'],
    ['rs_strong', 'pattern_type:cupHandle'],
    ['rs_strong', 'pattern_type:ascendingBase'],
    ['rs_strong', 'pattern_type:powerPlay'],
    ['rs_strong', 'pattern_type:highTightFlag'],
    ['rs_strong', 'pattern_type:cupHandle|powerPlay'],
    ['rs_strong', 'pattern_type:cupHandle|ascendingBase|powerPlay|highTightFlag'],
  ],
  minRS: [80],
};

(async () => {
  const t0 = Date.now();
  const res = runWalkForward({
    strategy: 'factor_combo',
    startDate: '2020-10-22',   // first date with ≥50 symbol coverage
    endDate:   '2026-04-18',
    trainDays: 252,
    testDays:  126,
    paramGrid,
    optimizeMetric: 'sharpeRatio',
    maxPositions: 10,
    initialCapital: 100000,
  });

  console.log(`Elapsed: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Combos tested: ${res.config.combos}  ·  Windows: ${res.config.windowsTested}`);
  console.log(`OOS span: ${res.outOfSample.startDate} → ${res.outOfSample.endDate}`);
  console.log('\n─── OOS CONCATENATED ───');
  console.log(res.outOfSample);

  console.log('\n─── PARAM STABILITY (how often each combo won a window) ───');
  console.table(res.parameterStability.map(s => ({
    windowsWon: s.windows,
    share: `${s.share}%`,
    signals: (s.params.signals || []).join(' + '),
    minRS: s.params.minRS,
  })));

  console.log('\n─── WINNING COMBO PER WINDOW ───');
  console.table(res.windows.map((w, i) => ({
    n: i + 1,
    train: `${w.trainStart} → ${w.trainEnd}`,
    test:  `${w.testStart} → ${w.testEnd}`,
    signals: (w.bestParams.signals || []).join(' + '),
    trainSharpe: w.trainBest?.sharpeRatio,
    testReturn: w.testResult?.performance?.totalReturn,
    testTrades: w.testResult?.trades?.total,
  })));

  process.exit(0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
