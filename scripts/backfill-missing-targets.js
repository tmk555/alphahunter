// ─── Backfill T1/T2 on open trades that have a stop but no targets ─────────
// Symptom: positions like ANET / MKSI show up in the Morning Brief with a
// stop set but target1/target2 = NULL. Root cause (now fixed in the live
// path — see src/broker/fills-sync.js): scale-in tranches and orphan
// reconciles used to INSERT stop_price only, leaving T1/T2 permanently
// NULL. The scale-out tracker then IGNORES those rows at T1/T2 time, so
// profit-takes never fire and the row silently drifts.
//
// This script patches EXISTING rows. Fill-sync going forward now calls
// computeTargetsFromStop() on every insert path that knows the stop.
//
// Formula: R = entry − stop; target1 = entry + 2R, target2 = entry + 4R.
// Classic Minervini / O'Neil 2R/4R. Rounded to 2dp.
//
// Usage:
//   node scripts/backfill-missing-targets.js            # live update
//   node scripts/backfill-missing-targets.js --dry      # preview only

const Database = require('better-sqlite3');
const path     = require('path');
const { computeTargetsFromStop } = require('../src/broker/fills-sync');

const DRY = process.argv.includes('--dry');
const db  = new Database(path.join(__dirname, '..', 'data', 'alphahunter.db'));
db.pragma('journal_mode = WAL');

// Target only OPEN trades with a stop but missing at least one target leg.
// Closed trades are historical — rewriting their targets doesn't help.
const candidates = db.prepare(`
  SELECT id, symbol, entry_price, stop_price, target1, target2
    FROM trades
   WHERE exit_date IS NULL
     AND stop_price IS NOT NULL
     AND (target1 IS NULL OR target2 IS NULL)
   ORDER BY symbol, entry_date
`).all();

if (!candidates.length) {
  console.log('No open trades need target backfill. ✓');
  process.exit(0);
}

console.log(`Found ${candidates.length} open trade(s) with stop but missing T1/T2.\n`);

const upd = db.prepare(`
  UPDATE trades SET
    target1 = COALESCE(target1, ?),
    target2 = COALESCE(target2, ?)
  WHERE id = ?
`);

let patched = 0;
let skipped = 0;
for (const t of candidates) {
  const t1t2 = computeTargetsFromStop(t.entry_price, t.stop_price);
  if (!t1t2) {
    console.log(`  skip #${t.id} ${t.symbol}: invalid (entry=${t.entry_price}, stop=${t.stop_price})`);
    skipped++;
    continue;
  }
  const newT1 = t.target1 ?? t1t2.target1;
  const newT2 = t.target2 ?? t1t2.target2;
  const mark1 = t.target1 == null ? '→' : ' ';
  const mark2 = t.target2 == null ? '→' : ' ';
  console.log(
    `  #${t.id} ${t.symbol.padEnd(6)} entry=$${t.entry_price.toFixed(2)} stop=$${t.stop_price.toFixed(2)}` +
    ` ${mark1} T1 $${newT1.toFixed(2)} ${mark2} T2 $${newT2.toFixed(2)}`
  );
  if (!DRY) upd.run(t1t2.target1, t1t2.target2, t.id);
  patched++;
}

console.log(`\n${DRY ? '[DRY RUN] ' : ''}Patched: ${patched}   Skipped: ${skipped}`);
if (DRY) console.log('Re-run without --dry to apply.');
