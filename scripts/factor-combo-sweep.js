#!/usr/bin/env node
// ─── Factor-Combo Replay Sweep ─────────────────────────────────────────────
// Sweeps all 2-of-N, 3-of-N, 4-of-N, 5-of-N combinations of the supported
// factor signals and ranks by Sharpe. Uses the existing runReplay engine with
// strategy='factor_combo' so slippage, regime gates, survivorship, and
// position sizing all match the production backtest path.
//
// Usage:
//   node scripts/factor-combo-sweep.js                       # defaults
//   node scripts/factor-combo-sweep.js --start 2024-10-24 --end 2026-04-14
//   node scripts/factor-combo-sweep.js --signals rs_strong,stage_2,pattern
//   ALPHAHUNTER_DB=/path/to/alphahunter.db node scripts/factor-combo-sweep.js

const { runReplay } = require('../src/signals/replay');
const { getDB } = require('../src/data/database');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) args[k.slice(2)] = argv[i + 1], i++;
  }
  return args;
}

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const [head, ...rest] = arr;
  const withHead = combinations(rest, k - 1).map(c => [head, ...c]);
  const withoutHead = combinations(rest, k);
  return [...withHead, ...withoutHead];
}

function resolveWindow({ start, end }) {
  const db = getDB();
  // Default to the breadth-covered window — any combo that includes
  // breadth_ok will sit in cash for every pre-coverage date, which
  // silently inflates Sharpe comparisons.
  const breadth = db.prepare(`SELECT MIN(date) s, MAX(date) e FROM breadth_snapshots`).get();
  const snap = db.prepare(`SELECT MIN(date) s, MAX(date) e FROM rs_snapshots WHERE type='stock' AND date < date('now')`).get();
  return {
    startDate: start || breadth.s || snap.s,
    endDate:   end   || breadth.e || snap.e,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const ALL_SIGNALS = args.signals
    ? args.signals.split(',').map(s => s.trim()).filter(Boolean)
    : ['rs_strong', 'stage_2', 'pattern', 'breadth_ok'];

  const { startDate, endDate } = resolveWindow({ start: args.start, end: args.end });
  const minK = +(args.min || 2);
  const maxK = +(args.max || ALL_SIGNALS.length);
  const maxPositions = +(args.maxPositions || 10);
  const initialCapital = +(args.capital || 100000);

  const combos = [];
  for (let k = minK; k <= maxK; k++) combos.push(...combinations(ALL_SIGNALS, k));

  console.log(`\nFactor-combo sweep`);
  console.log(`  window:    ${startDate} → ${endDate}`);
  console.log(`  signals:   [${ALL_SIGNALS.join(', ')}]`);
  console.log(`  combos:    ${combos.length} (k=${minK}..${maxK})`);
  console.log(`  capital:   $${initialCapital.toLocaleString()}`);
  console.log(`  maxPos:    ${maxPositions}\n`);

  const results = [];
  for (const sigs of combos) {
    const t0 = Date.now();
    try {
      const r = runReplay({
        strategy: 'factor_combo',
        params: { signals: sigs, minRS: 85 },
        startDate, endDate,
        maxPositions, initialCapital,
        persistResult: false,
      });
      if (r.error) {
        results.push({ signals: sigs, error: r.error });
      } else {
        results.push({
          signals:      sigs,
          trades:       r.trades?.total || 0,
          winRate:      r.trades?.winRate || 0,
          totalReturn:  r.performance?.totalReturn || 0,
          sharpe:       r.performance?.sharpeRatio || 0,
          profitFactor: r.performance?.profitFactor || 0,
          maxDD:        r.performance?.maxDrawdown || 0,
          calmar:       r.performance?.calmarRatio || 0,
          avgR:         r.trades?.avgR || 0,
          avgWin:       r.trades?.avgWin || 0,
          avgLoss:      r.trades?.avgLoss || 0,
          spyReturn:    r.benchmark?.spyReturn || 0,
          alpha:        r.performance?.alpha || 0,
          durationMs:   Date.now() - t0,
        });
      }
    } catch (e) {
      results.push({ signals: sigs, error: e.message });
    }
    process.stdout.write('.');
  }
  console.log('');

  const ok = results.filter(r => !r.error).sort((a, b) => (b.sharpe || 0) - (a.sharpe || 0));
  const failed = results.filter(r => r.error);

  // ─── Report ────────────────────────────────────────────────────────────
  console.log(`\nRanked by Sharpe  (${ok.length} ok, ${failed.length} failed)\n`);
  const hdr = ['K', 'signals', 'trades', 'winRate', 'totalRet', 'vsSPY', 'sharpe', 'PF', 'maxDD', 'avgR'];
  const w = [2, 48, 6, 7, 8, 8, 6, 6, 6, 5];
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(hdr.map((h, i) => pad(h, w[i])).join(' '));
  console.log(w.map(n => '-'.repeat(n)).join(' '));
  for (const r of ok) {
    console.log([
      pad(r.signals.length, w[0]),
      pad(r.signals.join('+'), w[1]),
      pad(r.trades, w[2]),
      pad(`${r.winRate.toFixed(1)}%`, w[3]),
      pad(`${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn.toFixed(2)}%`, w[4]),
      pad(`${(r.totalReturn - r.spyReturn) >= 0 ? '+' : ''}${(r.totalReturn - r.spyReturn).toFixed(2)}%`, w[5]),
      pad(r.sharpe.toFixed(2), w[6]),
      pad(Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞', w[7]),
      pad(`${r.maxDD.toFixed(1)}%`, w[8]),
      pad(r.avgR.toFixed(2), w[9]),
    ].join(' '));
  }
  if (failed.length) {
    console.log('\nFailed combos:');
    for (const f of failed) console.log(`  ${f.signals.join('+')} → ${f.error}`);
  }

  const best = ok[0];
  if (best) {
    console.log(`\nBest by Sharpe: [${best.signals.join(' + ')}]`);
    console.log(`  sharpe=${best.sharpe.toFixed(2)}  return=${best.totalReturn.toFixed(2)}%  trades=${best.trades}  winRate=${best.winRate.toFixed(1)}%  PF=${Number.isFinite(best.profitFactor) ? best.profitFactor.toFixed(2) : '∞'}`);
  }
  console.log('');
}

if (require.main === module) main();
