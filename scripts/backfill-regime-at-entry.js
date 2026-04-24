// ─── Backfill trades.regime_at_entry ────────────────────────────────────────
//
// Root cause: src/broker/fills-sync.js called getMarketRegime() without await,
// so the UPDATE always saw `undefined` for regime.regime and silently skipped.
// Every trade from before the fix has regime_at_entry = NULL, which makes
// decision_quality.scoreTrade() assign regimeScore = 0 even on genuinely
// BULL days — so the "Weakest Area = Regime" alert was spurious.
//
// Repair strategy: look up regime_log (which IS populated correctly via
// getMarketRegime on the server) and assign each trade the latest regime
// whose log date is <= the trade's entry_date.
//
// regime_log is event-based (writes only on transition), so if a trade predates
// the earliest log row we fall back to the earliest available mode. That's the
// most reasonable guess — regime is sticky and the first recorded regime was
// already in effect just before its log row fired.
//
// Flags:
//   --dry    (default) print plan, change nothing
//   --apply  write changes inside a transaction; backup DB first

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'alphahunter.db');
const DRY = !process.argv.includes('--apply');

function backup(dbPath) {
  const dst = `${dbPath}.bak-regime-${Date.now()}`;
  fs.copyFileSync(dbPath, dst);
  for (const suf of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suf)) fs.copyFileSync(dbPath + suf, dst + suf);
  }
  return dst;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const trades = db.prepare(`
    SELECT id, symbol, entry_date, regime_at_entry
    FROM trades
    WHERE regime_at_entry IS NULL
    ORDER BY entry_date, id
  `).all();

  console.log(`Trades missing regime_at_entry: ${trades.length}\n`);

  // Load regime_log sorted ascending — use the "latest ≤ trade date" rule.
  const logRows = db.prepare('SELECT date, mode FROM regime_log ORDER BY date').all();
  if (!logRows.length) {
    console.error('regime_log is empty — nothing to backfill from. Aborting.');
    process.exit(1);
  }
  console.log(`regime_log rows: ${logRows.length}  (earliest=${logRows[0].date}  latest=${logRows[logRows.length - 1].date})\n`);

  function pickRegime(entryDate) {
    // entry_date is stored as YYYY-MM-DD (date-only in this DB).
    let match = null;
    for (const r of logRows) {
      if (r.date <= entryDate) match = r;
      else break;
    }
    if (match) return { mode: match.mode, source: `log ${match.date}` };
    // Fallback: trade predates regime_log — use earliest entry as best guess.
    return { mode: logRows[0].mode, source: `fallback (earliest=${logRows[0].date})` };
  }

  const plan = trades.map(t => {
    const { mode, source } = pickRegime(t.entry_date);
    return { id: t.id, symbol: t.symbol, entry_date: t.entry_date, regime: mode, source };
  });

  const pad = (s, n) => String(s ?? '').padEnd(n);
  console.log(pad('id', 4), pad('symbol', 7), pad('entry_date', 12), pad('regime', 18), 'source');
  console.log('─'.repeat(80));
  for (const r of plan) {
    console.log(pad(r.id, 4), pad(r.symbol, 7), pad(r.entry_date, 12), pad(r.regime, 18), r.source);
  }

  // Summary
  const byRegime = plan.reduce((acc, r) => ((acc[r.regime] = (acc[r.regime] || 0) + 1), acc), {});
  console.log('\nRegime distribution:');
  for (const [k, v] of Object.entries(byRegime)) console.log(`  ${k.padEnd(18)} ${v}`);

  if (DRY) {
    console.log('\n[DRY RUN] pass --apply to write.');
    return;
  }

  const bak = backup(DB_PATH);
  console.log(`\n[backup] ${bak}`);

  const upd = db.prepare('UPDATE trades SET regime_at_entry = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of plan) upd.run(r.regime, r.id);
  });
  tx();
  console.log(`[applied] ${plan.length} rows.`);
}

main();
