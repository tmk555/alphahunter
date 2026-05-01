#!/usr/bin/env node
// ─── run-universe-backfill.js ────────────────────────────────────────────
//
// Backfill rs_snapshots for the FULL runtime universe (1620 symbols after
// the SP1500 expansion). Defaults to 504 days of history — Yahoo's
// practical max per symbol — which gives the new SP400/SP600 names enough
// closes for stage classification (150-day MA), VCP/pattern detection
// (75-bar windows), and 252-day RS rank.
//
// USAGE
//   node scripts/run-universe-backfill.js              # defaults: 504 days, all 1620
//   node scripts/run-universe-backfill.js 2500         # deep history (where Alpaca / FMP can serve it)
//   node scripts/run-universe-backfill.js 504 SPHR,MKSI,WULF   # subset
//
// Logs progress to stdout. For a multi-hour run, redirect to a file:
//   node scripts/run-universe-backfill.js 504 > /tmp/ah-backfill.log 2>&1 &

require('dotenv').config();

const { runBackfill } = require('../src/signals/backfill');
const { FULL_UNIVERSE, SECTOR_ETFS, INDUSTRY_ETFS } = require('../universe');
const { getDB } = require('../src/data/database');

function buildRuntimeUniverse() {
  const db = getDB();
  const map = { ...FULL_UNIVERSE };

  // DB-managed user adds
  try {
    for (const r of db.prepare("SELECT symbol, sector FROM universe_mgmt WHERE removed_date IS NULL").all()) {
      if (!map[r.symbol]) map[r.symbol] = r.sector || 'Unknown';
    }
  } catch (_) {}

  // SP500 + SP400 + SP600 active
  try {
    for (const r of db.prepare("SELECT DISTINCT symbol, sector FROM universe_membership WHERE index_name IN ('SP500','SP400','SP600') AND end_date IS NULL").all()) {
      if (!map[r.symbol]) map[r.symbol] = r.sector || 'Unknown';
    }
  } catch (_) {}

  // ETFs
  for (const e of SECTOR_ETFS)   if (!map[e.t]) map[e.t] = e.n;
  for (const e of INDUSTRY_ETFS) if (!map[e.t]) map[e.t] = e.sec;

  return Object.keys(map);
}

async function main() {
  const lookbackDays = +(process.argv[2] || 504);
  const symbolFilter = process.argv[3] ? process.argv[3].split(',').map(s => s.trim().toUpperCase()) : null;

  const allSymbols = buildRuntimeUniverse();
  const symbols = symbolFilter ? allSymbols.filter(s => symbolFilter.includes(s)) : allSymbols;

  console.log(`╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  Universe backfill                                              ║`);
  console.log(`║    Symbols:       ${String(symbols.length).padEnd(48)}║`);
  console.log(`║    Lookback days: ${String(lookbackDays).padEnd(48)}║`);
  console.log(`║    Started:       ${new Date().toISOString().slice(0, 19).padEnd(48)}║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝`);

  const t0 = Date.now();
  let lastProgress = 0;
  const summary = await runBackfill({
    symbols, lookbackDays, concurrency: 5,
    onProgress: (p) => {
      if (!p || p.total == null) return;
      // Print every ~5% of progress to avoid log spam.
      const pct = Math.floor((p.current / p.total) * 100);
      if (pct >= lastProgress + 5 || p.current === p.total) {
        lastProgress = pct;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`  [${p.stage || '?'}] ${p.current}/${p.total} (${pct}%) — ${elapsed}s elapsed — ${p.message || ''}`);
      }
    },
  });

  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n✓ Done in ${elapsedMin} min`);
  console.log(`  Persisted: ${summary.persisted ?? '?'} (date,symbol) snapshots`);
  console.log(`  Errors:    ${summary.errors?.length ?? 0}`);
  if (summary.errors?.length && summary.errors.length <= 20) {
    for (const e of summary.errors) console.log(`    ${e.symbol}: ${e.error}`);
  } else if (summary.errors?.length) {
    console.log(`    (showing first 10) ${summary.errors.slice(0, 10).map(e => e.symbol + ':' + e.error).join('; ')}`);
  }
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
