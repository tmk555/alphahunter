// Run deep_scan Replay across 4 windows (full + 3 regime slices) against the
// backfilled 10-year history. Prints a side-by-side summary so we can see
// whether deep_scan's edge holds up through the 2018 correction, COVID crash,
// 2022 bear, and 2023-24 recovery.
//
// Result shape (from runReplay): top-level { performance, trades, benchmark,
// period, ... }. Performance carries totalReturn / maxDrawdown / sharpeRatio /
// alpha / profitFactor; trades carries total / winRate / avgWin / avgLoss /
// exitReasons; benchmark carries spyReturn / spyMaxDrawdown / outperformed.
// CAGR is derived here from finalEquity + trading-day span.
require('dotenv').config();
const { runReplay } = require('../src/signals/replay');

const windows = [
  { name: 'Full 2016→2026',     startDate: '2016-10-01', endDate: '2026-04-20' },
  { name: 'Bull 2016→2019',     startDate: '2016-10-01', endDate: '2019-12-31' },
  { name: 'COVID 2020→2022',    startDate: '2020-01-02', endDate: '2022-12-31' },
  { name: 'Recovery 2023→2026', startDate: '2023-01-03', endDate: '2026-04-20' },
];

const fmt = (n, digits = 2) => (n == null || Number.isNaN(n)) ? '-' : Number(n).toFixed(digits);
const pct = n => n == null ? '-' : `${fmt(n)}%`;

function deriveCagr(initial, final, startDate, endDate) {
  if (!initial || !final) return null;
  const years = (new Date(endDate) - new Date(startDate)) / (365.25 * 24 * 3600 * 1000);
  if (years <= 0) return null;
  return (Math.pow(final / initial, 1 / years) - 1) * 100;
}

const rows = [];

(async () => {
  for (const w of windows) {
    const t0 = Date.now();
    let r;
    try {
      r = runReplay({
        strategy: 'deep_scan',
        startDate: w.startDate,
        endDate:   w.endDate,
        maxPositions: 10,
        initialCapital: 100000,
        execution: { holdDays: 20, stopATR: 1.5, targetATR: 3.0 },
        indexName: 'SP500',
      });
    } catch (e) { console.log(`\n${w.name}: FAIL — ${e.message}`); continue; }
    if (r.error) { console.log(`\n${w.name}: ERROR — ${r.error}`); continue; }

    const p = r.performance || {};
    const t = r.trades || {};
    const b = r.benchmark || {};
    const cagr = deriveCagr(p.initialCapital, p.finalEquity, w.startDate, w.endDate);

    console.log(`\n=== ${w.name} (${w.startDate} → ${w.endDate}) — ${((Date.now()-t0)/1000).toFixed(1)}s ===`);
    console.log(`  trades:          ${t.total ?? '-'}  (W ${t.wins ?? '-'} / L ${t.losses ?? '-'})`);
    console.log(`  win-rate:        ${pct(t.winRate)}`);
    console.log(`  avg W / avg L:   ${pct(t.avgWin)} / ${pct(t.avgLoss)}   avg R: ${fmt(t.avgR)}`);
    console.log(`  final equity:    $${fmt(p.finalEquity)}`);
    console.log(`  total return:    ${pct(p.totalReturn)}`);
    console.log(`  CAGR:            ${pct(cagr)}`);
    console.log(`  max drawdown:    ${pct(p.maxDrawdown)}`);
    console.log(`  Sharpe:          ${fmt(p.sharpeRatio)}   Calmar: ${fmt(p.calmarRatio)}   PF: ${fmt(p.profitFactor)}`);
    console.log(`  alpha vs SPY:    ${pct(p.alpha)}`);
    console.log(`  SPY return:      ${pct(b.spyReturn)}   SPY MDD: ${pct(b.spyMaxDrawdown)}   beat SPY: ${b.outperformed ? 'YES' : 'no'}`);
    if (t.exitReasons) {
      const er = Object.entries(t.exitReasons).map(([k,v]) => `${k}=${v}`).join(', ');
      console.log(`  exit reasons:    ${er}`);
    }

    rows.push({
      window: w.name,
      trades: t.total,
      winRate: t.winRate,
      ret: p.totalReturn,
      cagr,
      mdd: p.maxDrawdown,
      sharpe: p.sharpeRatio,
      alpha: p.alpha,
      spy: b.spyReturn,
      beat: b.outperformed,
    });
  }

  // Side-by-side recap
  console.log('\n═══ RECAP ═══');
  console.log('Window                trades  win%    ret%    CAGR%   MDD%    Sharpe  alpha%   SPY%    beat');
  for (const x of rows) {
    console.log(
      `${x.window.padEnd(22)}` +
      `${String(x.trades ?? '-').padStart(6)}  ` +
      `${fmt(x.winRate).padStart(5)}  ` +
      `${fmt(x.ret).padStart(6)}  ` +
      `${fmt(x.cagr).padStart(6)}  ` +
      `${fmt(x.mdd).padStart(5)}  ` +
      `${fmt(x.sharpe).padStart(6)}  ` +
      `${fmt(x.alpha).padStart(6)}  ` +
      `${fmt(x.spy).padStart(6)}   ` +
      `${x.beat ? 'YES' : 'no'}`
    );
  }
})().catch(e => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
