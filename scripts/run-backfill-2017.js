// One-shot 2017-forward backfill runner.
// Lives inside the repo so it can require('dotenv') from the shared
// node_modules. Runs against whatever DB the process finds via
// src/data/database.js (the main data/alphahunter.db).
//
// Invoke: node scripts/run-backfill-2017.js > /tmp/ah-backfill.log 2>&1 &

require('dotenv').config();

const { runBackfill } = require('../src/signals/backfill');
const { FULL_UNIVERSE } = require('../universe');

const symbols = Object.keys(FULL_UNIVERSE);
console.log('Backfill target:', symbols.length, 'symbols, lookback=2500 days (~10y via Yahoo)');

const t0 = Date.now();
runBackfill({
  symbols,
  lookbackDays: 2500,
  concurrency: 5,
  onProgress: (p) => {
    // Fetch phase is short-ish (~500 symbols); log every 25. Compute phase is
    // longer (~2500 dates); log every 50 so the log doesn't bloat.
    const step = p.stage === 'fetch' ? 25 : 50;
    if (p.current === 0 || p.current === p.total || p.current % step === 0) {
      const pct = ((p.current / p.total) * 100).toFixed(1);
      console.log(`[${p.stage}] ${p.current}/${p.total} (${pct}%) ${p.message || ''}`);
    }
  },
}).then(summary => {
  console.log('\n=== BACKFILL COMPLETE ===');
  console.log(JSON.stringify({
    ...summary,
    durationMin: (summary.durationMs / 60000).toFixed(1),
  }, null, 2));
  process.exit(0);
}).catch(e => {
  console.error('FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
