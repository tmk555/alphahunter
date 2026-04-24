// ─── Dedup duplicate open trade rows ────────────────────────────────────────
// Symptom: the same symbol appears multiple times in the Morning Brief with
// IDENTICAL P&L% and $ (e.g. DELL × 3 at +12.2% / +$140.85 on 2026-04-24).
// Identical dollar P&L means identical (entry_price, shares) across rows —
// these are the same fill recorded multiple times, not legitimate pyramid
// tranches.
//
// Root causes (now mitigated in src/broker/fills-sync.js):
//   • Ghost-loop in reconcileOrphanPositions() before the 15-min cooldown
//     was added — Alpaca briefly still reported a just-closed position, so
//     reconcile recreated it; the next fills-sync's sell window closed it
//     again; repeat. DELL accumulated 16 rows before detection (April 2026).
//   • No UNIQUE index on trades.alpaca_order_id — so a dedup-set miss (e.g.
//     concurrent job run) could slip a second row through.
//
// This script repairs EXISTING rows. Prevention is now handled by:
//   1. The reconcile cooldown (fills-sync.js:472-489)
//   2. A partial UNIQUE index on alpaca_order_id (data/database.js)
//
// Dedup strategy:
//   A. alpaca_order_id duplicates — any group of rows sharing a non-NULL
//      alpaca_order_id. Canonical row = the one with the most complete
//      bracket (stop + T1 + T2 + strategy); tie-break by lowest id.
//      Non-canonical rows are DELETED.
//
//   B. Signature duplicates — rows with NULL alpaca_order_id but identical
//      (symbol, entry_date, entry_price, shares). Same canonical rule.
//
// Safety rails:
//   • Only OPEN trades (exit_date IS NULL) — historical closes are left
//     alone; fixing them would rewrite realized P&L.
//   • Any row with partial_exits JSON data (scale-outs already recorded) is
//     KEPT as canonical even if another row looks more complete — those
//     represent real activity we must not lose.
//   • --dry by default for this script. Pass --apply to actually delete.
//
// Usage:
//   node scripts/dedup-trade-rows.js            # preview (default)
//   node scripts/dedup-trade-rows.js --apply    # actually delete duplicates

const Database = require('better-sqlite3');
const path     = require('path');

const APPLY = process.argv.includes('--apply');
const db    = new Database(path.join(__dirname, '..', 'data', 'alphahunter.db'));
db.pragma('journal_mode = WAL');

// Score a row for "canonical-ness" — higher = better keep. Tie-breaks use
// lower id (oldest).
function bracketScore(r) {
  let s = 0;
  if (r.stop_price != null)  s += 2;
  if (r.target1 != null)     s += 2;
  if (r.target2 != null)     s += 2;
  if (r.strategy)            s += 1;
  if (r.initial_stop_price)  s += 1;
  // partial_exits is the trump card — it proves real scale-out activity
  // that would be destroyed if the row were deleted.
  if (r.partial_exits && r.partial_exits !== 'null' && r.partial_exits !== '[]') s += 100;
  return s;
}

function pickCanonical(rows) {
  return rows
    .slice()
    .sort((a, b) => bracketScore(b) - bracketScore(a) || a.id - b.id)[0];
}

function fmtRow(r) {
  return `#${String(r.id).padStart(4)} entry=$${(+r.entry_price).toFixed(2)} ` +
         `sh=${r.shares} stop=${r.stop_price ? '$'+(+r.stop_price).toFixed(2) : '—'} ` +
         `T1=${r.target1 ? '$'+(+r.target1).toFixed(2) : '—'} ` +
         `T2=${r.target2 ? '$'+(+r.target2).toFixed(2) : '—'} ` +
         `${r.strategy || 'no-strategy'} ` +
         `${r.partial_exits && r.partial_exits !== 'null' && r.partial_exits !== '[]' ? '[HAS_EXITS]' : ''}`;
}

const openRows = db.prepare(`
  SELECT id, symbol, side, entry_date, entry_price, stop_price, initial_stop_price,
         target1, target2, shares, alpaca_order_id, strategy, partial_exits, notes
    FROM trades
   WHERE exit_date IS NULL
   ORDER BY symbol, id
`).all();

// ─── Group A: same alpaca_order_id ──────────────────────────────────────
const byOrderId = {};
for (const r of openRows) {
  if (!r.alpaca_order_id) continue;
  (byOrderId[r.alpaca_order_id] ||= []).push(r);
}
const dupGroupsA = Object.entries(byOrderId).filter(([, g]) => g.length > 1);

// ─── Group B: same (symbol, entry_date, entry_price, shares), NULL order_id ─
const bySignature = {};
for (const r of openRows) {
  if (r.alpaca_order_id) continue;  // order_id group handles these
  const key = `${r.symbol}|${r.entry_date}|${r.entry_price}|${r.shares}`;
  (bySignature[key] ||= []).push(r);
}
const dupGroupsB = Object.entries(bySignature).filter(([, g]) => g.length > 1);

const totalDupRows = [...dupGroupsA, ...dupGroupsB]
  .reduce((n, [, g]) => n + (g.length - 1), 0);

if (!dupGroupsA.length && !dupGroupsB.length) {
  console.log('No duplicate open trade rows found. ✓');
  process.exit(0);
}

console.log(
  `Found ${dupGroupsA.length} order_id-dup group(s) + ${dupGroupsB.length} signature-dup group(s) = ` +
  `${totalDupRows} row(s) to delete.\n`
);

const del = db.prepare('DELETE FROM trades WHERE id = ?');
const delHist = db.prepare('DELETE FROM decision_log WHERE trade_id = ?');
const delExec = db.prepare('UPDATE execution_log SET trade_id = NULL WHERE trade_id = ?');

function reportAndDelete(label, groups) {
  for (const [key, rows] of groups) {
    const canonical = pickCanonical(rows);
    const toDelete  = rows.filter(r => r.id !== canonical.id);
    console.log(`${label}: ${key}`);
    console.log(`  KEEP   ${fmtRow(canonical)}`);
    for (const r of toDelete) {
      console.log(`  DELETE ${fmtRow(r)}`);
      if (APPLY) {
        // Null-out any execution_log rows pointing at the deleted trade so
        // slippage history is preserved (just unlinked). decision_log rows
        // are per-trade-id only so those go.
        try { delExec.run(r.id); } catch (_) {}
        try { delHist.run(r.id); } catch (_) {}
        del.run(r.id);
      }
    }
    console.log();
  }
}

reportAndDelete('Group A (alpaca_order_id)', dupGroupsA);
reportAndDelete('Group B (symbol+date+price+shares)', dupGroupsB);

if (APPLY) {
  console.log(`✓ Deleted ${totalDupRows} duplicate row(s).`);
  console.log('Restart the server so the partial UNIQUE index can be created on the now-clean table.');
} else {
  console.log(`[DRY RUN] Would delete ${totalDupRows} row(s).`);
  console.log('Re-run with --apply to actually delete.');
}
