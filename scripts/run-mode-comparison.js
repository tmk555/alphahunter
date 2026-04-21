// Three-way execution-mode comparison for deep_scan, run across 4 time windows
// for BOTH position-trader (holdDays=40) and swing-trader (holdDays=10) cadence.
//
// Modes compared:
//   A. FULL → FULL OUT      : one-shot entry, one-shot exit at target
//   B. FULL → SCALE OUT     : one-shot entry, 3-tier ladder exit (1/3 @ t1, 1/2 of remainder @ t2, last 1/3 trails)
//   C. PYRAMID (scale IN)   : staggered entry (1/3 now, +1/3 at +2%, +1/3 at +4%), one-shot exit
//   D. PYRAMID + SCALE OUT  : staggered entry AND 3-tier ladder exit (gives us the full picture)
//
// All four modes use the SAME base risk (stopATR=2.5 position / 1.2 swing) and
// the ladder parameters (target1ATR, target2ATR) are tuned from the prior sweep.
// This is the definitive answer to "which execution mode wins for our universe?"

require('dotenv').config();
const { runReplay } = require('../src/signals/replay');

const windows = [
  { name: 'Full 2016→2026',     startDate: '2016-10-01', endDate: '2026-04-20' },
  { name: 'Bull 2016→2019',     startDate: '2016-10-01', endDate: '2019-12-31' },
  { name: 'COVID 2020→2022',    startDate: '2020-01-02', endDate: '2022-12-31' },
  { name: 'Recovery 2023→2026', startDate: '2023-01-03', endDate: '2026-04-20' },
];

// ---- cadence presets (the two things we're studying) ---------------------
const POSITION = { label: 'POSITION', holdDays: 40, stopATR: 2.5, targetATR: 7.0, target1ATR: 3.5, target2ATR: 7.0 };
const SWING    = { label: 'SWING',    holdDays: 12, stopATR: 1.2, targetATR: 3.0, target1ATR: 1.5, target2ATR: 3.0 };

// ---- execution-mode variants -----------------------------------------------
function modeParams(cadence, mode) {
  const base = {
    holdDays: cadence.holdDays,
    stopATR:  cadence.stopATR,
    targetATR: cadence.targetATR,
    strictRegime: false,
  };
  switch (mode) {
    case 'A_FULL_FULL':  return { ...base };
    case 'B_FULL_SCALE': return { ...base, scaleOut: true, target1ATR: cadence.target1ATR, target2ATR: cadence.target2ATR };
    case 'C_PYRAMID':    return { ...base, pyramidEntry: true };
    case 'D_PYR_SCALE':  return { ...base, pyramidEntry: true, scaleOut: true, target1ATR: cadence.target1ATR, target2ATR: cadence.target2ATR };
    default: throw new Error(`unknown mode ${mode}`);
  }
}

const MODES = ['A_FULL_FULL', 'B_FULL_SCALE', 'C_PYRAMID', 'D_PYR_SCALE'];

const fmt = (n, d = 2) => (n == null || Number.isNaN(n)) ? '-' : Number(n).toFixed(d);
const pct = n => n == null ? '-' : `${fmt(n)}%`;

function runOne(cadence, mode, w) {
  const params = modeParams(cadence, mode);
  try {
    const r = runReplay({
      strategy: 'deep_scan',
      startDate: w.startDate,
      endDate:   w.endDate,
      maxPositions: 10,
      initialCapital: 100000,
      params,
      indexName: 'SP500',
    });
    if (r.error) return null;
    const p = r.performance || {};
    const t = r.trades || {};
    const b = r.benchmark || {};
    return {
      trades: t.total, winRate: t.winRate,
      ret: p.totalReturn, mdd: p.maxDrawdown,
      sharpe: p.sharpeRatio, alpha: p.alpha, pf: p.profitFactor,
      spy: b.spyReturn, beat: b.outperformed,
    };
  } catch (e) {
    return { err: e.message };
  }
}

(async () => {
  for (const cadence of [POSITION, SWING]) {
    console.log(`\n\n█████  ${cadence.label} TRADER  (holdDays=${cadence.holdDays}, stopATR=${cadence.stopATR}, targetATR=${cadence.targetATR})  █████`);

    for (const w of windows) {
      console.log(`\n─── ${w.name} (${w.startDate} → ${w.endDate}) ───`);
      const header = 'mode                 trades  win%    ret%    MDD%    Sharpe  alpha%   SPY%    beat';
      console.log(header);
      for (const mode of MODES) {
        const r = runOne(cadence, mode, w);
        if (!r) { console.log(`${mode.padEnd(18)}  FAIL`); continue; }
        if (r.err) { console.log(`${mode.padEnd(18)}  ERR: ${r.err}`); continue; }
        console.log(
          `${mode.padEnd(18)}  ` +
          `${String(r.trades ?? '-').padStart(6)}  ` +
          `${fmt(r.winRate).padStart(5)}  ` +
          `${fmt(r.ret).padStart(6)}  ` +
          `${fmt(r.mdd).padStart(5)}  ` +
          `${fmt(r.sharpe).padStart(6)}  ` +
          `${fmt(r.alpha).padStart(6)}  ` +
          `${fmt(r.spy).padStart(6)}   ` +
          `${r.beat ? 'YES' : 'no'}`
        );
      }
    }
  }
})().catch(e => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
