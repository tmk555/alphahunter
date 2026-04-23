#!/usr/bin/env node
// ─── repair-dell-dal-ghost-rows.js ────────────────────────────────────────
//
// One-time cleanup script that undoes the damage caused by the fills-sync
// ghost-row bug (fixed in commit "order-management idempotency", see
// src/broker/fills-sync.js).
//
// BACKGROUND
//   Before the fix, the 7-day sells loop had no idempotency key. Every sync
//   re-applied every filled Alpaca sell order to whatever open journal row
//   looked closest by entry_date. Since reconcileOrphanPositions also kept
//   creating fresh open rows for lingering Alpaca positions, the same real
//   sell kept "closing" new ghost rows each pass.
//
//   On 2026-04-22 the production DB ended up with:
//     DELL: 16 journal rows (should be 3 — 2 open, 1 legitimately closed).
//       ids 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52 were the ghost
//       closed rows (each 18sh, each "closed" at $216.12, each inflating
//       realized P&L by $423.58 — 12 × $423.58 = $5,082 phantom gains).
//       id 54 was the ghost OPEN row (18sh) made by a late reconcile.
//     DAL: row 5 had been closed at $68.33 "manual" but Alpaca actually
//       still held all 88 shares across the 3 tranches — the close was a
//       mis-routed manual-exit that never hit the broker.
//
//   Post-repair matches live Alpaca:
//     DELL open  = 18sh across rows 23+24  (Alpaca: 18sh @ $192.59 avg)
//     DELL closed= 1 row (id 25, 9sh @ $216.12, +$211.79 legit)
//     DAL open   = 88sh across rows 5+8+10 (Alpaca: 88sh @ $71.37 avg)
//
// USAGE
//   node scripts/repair-dell-dal-ghost-rows.js          # executes
//   node scripts/repair-dell-dal-ghost-rows.js --dry    # prints plan only
//
// SAFETY
//   • Wraps all writes in one DB transaction. All-or-nothing.
//   • Idempotent: re-running after a successful repair is a no-op that
//     prints "already clean" and exits 0. Safe to re-run.
//   • Before running, auto-backs up the DB file to
//     data/alphahunter.db.bak-<unix-timestamp>.
//   • Deletes 12 execution_log rows tied to the DELL ghost trades (FK
//     parent rows must be deleted first — trades.id is referenced with
//     ON DELETE NO ACTION, so orphaned children would block the DELETE).
//
// This script is the source-of-truth record of what was done to the
// production DB on 2026-04-22. Re-running on a DB that was NOT affected
// by the ghost-row bug is safe (idempotent no-op).

const fs   = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');

// DELL ghost row ids (12 closed + 1 open) — the full set to delete.
const DELL_GHOST_IDS = [30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54];

// Rows to reopen (clear exit fields so they show as open again).
const DELL_REOPEN_IDS = [23, 24];   // leave row 25 as the one legit close
const DAL_REOPEN_IDS  = [5];        // entire DAL position is still live

function main() {
  // Lazy-require so `--help`-style flags don't pay the DB cost.
  const { getDB } = require('../src/data/database');
  const db = getDB();

  // ─── Diagnostic pre-check ─────────────────────────────────────────────
  const placeholders = DELL_GHOST_IDS.map(() => '?').join(',');
  const ghostPresent = db.prepare(
    `SELECT COUNT(*) c FROM trades WHERE id IN (${placeholders}) AND symbol = 'DELL'`
  ).get(...DELL_GHOST_IDS).c;

  const dellClosedLegit = db.prepare(
    "SELECT COUNT(*) c FROM trades WHERE id IN (23,24) AND exit_date IS NOT NULL"
  ).get().c;

  const dalClosed5 = db.prepare(
    "SELECT exit_date FROM trades WHERE id = 5"
  ).get();

  const needsRepair = (ghostPresent > 0) || (dellClosedLegit > 0) || (dalClosed5 && dalClosed5.exit_date);
  if (!needsRepair) {
    console.log('[clean] DB already repaired — no ghost rows, DELL 23/24 open, DAL 5 open.');
    console.log('Exiting 0 (no-op).');
    process.exit(0);
  }

  console.log('─── REPAIR PLAN ──────────────────────────────────────');
  console.log(`  Delete ${ghostPresent} DELL ghost rows (ids: ${DELL_GHOST_IDS.join(',')})`);
  console.log(`  Delete execution_log rows tied to ghost trade_ids`);
  console.log(`  Reopen DELL rows: ${DELL_REOPEN_IDS.join(',')} (clear exit_*)`);
  console.log(`  Reopen DAL rows:  ${DAL_REOPEN_IDS.join(',')}  (clear exit_*)`);
  console.log('──────────────────────────────────────────────────────');

  if (DRY) {
    console.log('[dry-run] no writes. Re-run without --dry to apply.');
    process.exit(0);
  }

  // ─── Auto-backup ──────────────────────────────────────────────────────
  const dbPath = process.env.ALPHAHUNTER_DB || path.resolve(__dirname, '..', 'data', 'alphahunter.db');
  if (fs.existsSync(dbPath)) {
    const backup = `${dbPath}.bak-${Math.floor(Date.now() / 1000)}`;
    fs.copyFileSync(dbPath, backup);
    console.log(`[backup] ${backup}`);
  }

  // ─── Repair transaction ───────────────────────────────────────────────
  const reopenSql = `
    UPDATE trades SET exit_date=NULL, exit_price=NULL, exit_reason=NULL,
                      pnl_dollars=NULL, pnl_percent=NULL, r_multiple=NULL
    WHERE id = ?
  `;
  const reopen   = db.prepare(reopenSql);
  const execDel  = db.prepare(`DELETE FROM execution_log WHERE trade_id IN (${placeholders})`);
  const tradeDel = db.prepare(`DELETE FROM trades        WHERE id       IN (${placeholders})`);

  const tx = db.transaction(() => {
    const execRes  = execDel.run(...DELL_GHOST_IDS);
    const tradeRes = tradeDel.run(...DELL_GHOST_IDS);
    let reopened = 0;
    for (const id of [...DELL_REOPEN_IDS, ...DAL_REOPEN_IDS]) {
      reopened += reopen.run(id).changes;
    }
    return {
      executionLogDeleted: execRes.changes,
      ghostTradesDeleted:  tradeRes.changes,
      rowsReopened:        reopened,
    };
  });

  const result = tx();
  console.log('[repair-result]', JSON.stringify(result));

  // ─── Post-repair verification ─────────────────────────────────────────
  console.log('\n─── POST-REPAIR ──────────────────────────────────────');
  for (const sym of ['DELL', 'DAL']) {
    const open = db.prepare(
      "SELECT id, shares, entry_price FROM trades WHERE symbol = ? AND exit_date IS NULL ORDER BY id"
    ).all(sym);
    const totalSh = open.reduce((s, r) => s + r.shares, 0);
    console.log(`  ${sym} open: ${open.length} rows, ${totalSh} shares`);
    for (const r of open) console.log(`    id=${r.id} sh=${r.shares} entry=${r.entry_price}`);
  }
  console.log('──────────────────────────────────────────────────────');
  console.log('Done. Compare output against live Alpaca positions via:');
  console.log('  node scripts/verify-journal-vs-alpaca.js');
}

try { main(); }
catch (e) { console.error('[repair-failed]', e.message); process.exit(1); }
