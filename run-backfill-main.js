require('dotenv').config();
const fs = require('fs');
const { runBackfill } = require('./src/signals/backfill');
const { FULL_UNIVERSE } = require('./universe');
const alp = require('./src/data/providers/alpaca');

console.log(`[${new Date().toISOString()}] Provider check — alpaca: ${alp.isConfigured?.()}`);
const symbols = Object.keys(FULL_UNIVERSE);
console.log(`[${new Date().toISOString()}] Starting full backfill: ${symbols.length} symbols, lookbackDays=2500`);

fs.writeFileSync('/tmp/backfill-progress.log', '');
runBackfill({
  symbols,
  lookbackDays: 2500,
  concurrency: 5,
  onProgress: ({ stage, current, total, message }) => {
    const line = `[${new Date().toISOString()}] ${stage} ${current}/${total} — ${message}`;
    console.log(line);
    fs.appendFileSync('/tmp/backfill-progress.log', line + '\n');
  }
}).then(s => {
  console.log('\n=== BACKFILL DONE ===');
  console.log(JSON.stringify({
    dates: s.dates, firstDate: s.firstDate, lastDate: s.lastDate,
    symbolsRequested: s.symbolsRequested, symbolsWithData: s.symbolsWithData,
    rowsWritten: s.rowsWritten, durationMin: (s.durationMs/60000).toFixed(1),
    errorCount: s.errorCount, firstErrors: s.errors?.slice(0,5),
  }, null, 2));
  fs.writeFileSync('/tmp/backfill-summary.json', JSON.stringify(s, null, 2));
  process.exit(0);
}).catch(e => { console.error('BACKFILL FAILED:', e.message, e.stack); process.exit(1); });
