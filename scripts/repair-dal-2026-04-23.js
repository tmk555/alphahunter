#!/usr/bin/env node
// ─── repair-dal-2026-04-23.js ─────────────────────────────────────────────
//
// DAL journal reconcile for 2026-04-23.
//
// BROKER GROUND TRUTH (Alpaca activities + orders):
//   18:13:02Z  9f946d4e  SELL 88sh market → 81sh filled @ $68.43, canceled (7sh)
//   18:13:04Z  b1771b9e  SELL  7sh market →  7sh filled @ $68.43 (cover)
//   Position after: 0 shares.
//
// JOURNAL STATE BEFORE (3 long rows for DAL):
//   #5   29sh  exit_date=2026-04-23 18:13:02  exit_reason='manual'  exit=$71.46 (!)
//              pnl_dollars=0.0  — synthetic pending-close placeholder that was
//              never reconciled to a real fill because fills-sync's sells
//              filter required status='filled' (missing canceled-partial).
//   #8   30sh  remaining=27  partial_exits=[3sh @$68.43] — only the 7sh cover
//              order got pro-rated across #8 and #10 (3+4=7).
//   #10  29sh  remaining=25  partial_exits=[4sh @$68.43]
//
// The 81sh fill from order 9f946d4e was never reconciled to any journal row.
// Total journal thinks: 0 + 27 + 25 = 52 open. Broker says 0.
//
// CORRECT FINAL STATE:
//   All three rows closed. 29+30+29 = 88 sh sold @ $68.43 exactly matches
//   the broker's 88sh total. No shares go missing.
//
//   #5   exit_price $68.43  (was 71.46)  pnl = (68.43 − 71.46) × 29 = −$87.87
//        exit_reason: 'market_close'     r_multiple recalculated vs stop=$67.17
//   #8   append partial_exit 27sh @$68.43  remaining=0  exit_date set
//        total pnl across both partial_exits = 3×(68.43−71.255667) + 27×(68.43−71.255667)
//   #10  append partial_exit 25sh @$68.43  remaining=0  exit_date set
//        total pnl across both partial_exits = 4×(68.43−71.388276) + 25×(68.43−71.388276)
//
// USAGE
//   node scripts/repair-dal-2026-04-23.js --dry    # preview only
//   node scripts/repair-dal-2026-04-23.js          # apply
//
// SAFETY
//   • All writes in one transaction.
//   • Auto-backup DB to data/alphahunter.db.bak-<unix-ts> before any write.
//   • Idempotent: re-run after applying is a no-op (detects clean state).

try { require('dotenv').config(); } catch (_) {}

const DRY = process.argv.includes('--dry');
const fs = require('fs');
const path = require('path');

const EXPECTED_FILL_PRICE = 68.43;
const EXPECTED_TOTAL_SOLD = 88;
const SELL_ORDER_1 = '9f946d4e-1dc3-459e-9d8f-6ce1a09eedec'; // TBC — use prefix match below
const SELL_ORDER_1_PREFIX = '9f946d4e';
const SELL_ORDER_2_PREFIX = 'b1771b9e';
const EXIT_DATE = '2026-04-23';

async function main() {
  const { getDB } = require('../src/data/database');
  const db = getDB();

  // ── Load DAL state ────────────────────────────────────────────────────
  const rows = db.prepare(`
    SELECT id, entry_date, exit_date, exit_reason, side, shares, initial_shares,
           remaining_shares, entry_price, exit_price, stop_price, pnl_dollars,
           pnl_percent, r_multiple, alpaca_order_id, exit_order_id, partial_exits,
           pending_close_order_id, notes
      FROM trades
     WHERE symbol = 'DAL' AND side = 'long'
     ORDER BY id ASC
  `).all();

  console.log('─── DAL journal state (pre-repair) ────────────────────────────');
  for (const r of rows) {
    const peRaw = r.partial_exits;
    let peSum = 0;
    try { (JSON.parse(peRaw || '[]') || []).forEach(p => peSum += (p.shares || 0)); } catch (_) {}
    const rem = r.remaining_shares != null ? r.remaining_shares : (r.shares || 0);
    console.log(`  #${r.id}  ${r.shares}sh  remaining=${rem}  partial_exits_sum=${peSum}  exit_date=${r.exit_date || '-'}  exit=${r.exit_price || '-'}  reason=${r.exit_reason || '-'}`);
  }

  // ── Identify target rows ──────────────────────────────────────────────
  // #5: the bogus "manual" close at exit_price = entry_price
  const row5 = rows.find(r =>
    r.exit_reason === 'manual' &&
    r.entry_price === r.exit_price &&
    (r.pnl_dollars === 0 || r.pnl_dollars == null)
  );
  const openRows = rows.filter(r => !r.exit_date).sort((a, b) => a.id - b.id);

  if (!row5 && openRows.length === 0) {
    console.log('\n✅ No repair target detected — DAL journal already clean. Exit.');
    process.exit(0);
  }

  // ── Plan ──────────────────────────────────────────────────────────────
  console.log('\n─── Repair plan ───────────────────────────────────────────────');
  const plan = [];

  if (row5) {
    const newExit = EXPECTED_FILL_PRICE;
    const newPnlDollars = +((newExit - row5.entry_price) * row5.shares).toFixed(2);
    const newPnlPct = +((newExit / row5.entry_price - 1) * 100).toFixed(2);
    const risk = row5.entry_price - (row5.stop_price || row5.entry_price * 0.95);
    const newR = risk > 0 ? +((newExit - row5.entry_price) / risk).toFixed(2) : 0;
    plan.push({
      kind: 'rewrite-exit',
      id: row5.id,
      shares: row5.shares,
      from: { exit_price: row5.exit_price, pnl_dollars: row5.pnl_dollars, reason: row5.exit_reason },
      to:   { exit_price: newExit, pnl_dollars: newPnlDollars, pnl_percent: newPnlPct, r_multiple: newR, reason: 'market_close' },
    });
    console.log(`  #${row5.id}: rewrite exit $${row5.exit_price} → $${newExit}  pnl $${row5.pnl_dollars} → $${newPnlDollars}  reason '${row5.exit_reason}' → 'market_close'`);
  }

  for (const r of openRows) {
    const rem = r.remaining_shares != null ? r.remaining_shares : (r.shares || 0);
    if (rem <= 0) continue;
    const fillPnl = +((EXPECTED_FILL_PRICE - r.entry_price) * rem).toFixed(2);
    plan.push({
      kind: 'close-open',
      id: r.id,
      shares: rem,
      entry_price: r.entry_price,
      stop_price: r.stop_price,
      fillPnl,
    });
    console.log(`  #${r.id}: append partial_exit ${rem}sh @$${EXPECTED_FILL_PRICE} (pnl $${fillPnl}), remaining → 0, exit_date set, exit_reason 'market_close'`);
  }

  if (!plan.length) {
    console.log('  (nothing to do)');
    process.exit(0);
  }

  // Sanity: plan shares + already-reconciled partial_exits shares must equal
  // broker's total sold. The 7sh cover order (b1771b9e) was already pro-rated
  // into #8 (3sh) and #10 (4sh) by the previous fills-sync run; this repair
  // only places the 81sh from the canceled-partial order 9f946d4e.
  const planShares = plan.reduce((s, p) => s + (p.shares || 0), 0);
  let alreadyReconciled = 0;
  for (const r of rows) {
    try {
      const pe = JSON.parse(r.partial_exits || '[]') || [];
      for (const e of pe) alreadyReconciled += (e.shares || 0);
    } catch (_) {}
  }
  const covered = planShares + alreadyReconciled;
  console.log(`\n  Plan shares: ${planShares}  +  already-reconciled partial_exits: ${alreadyReconciled}  =  ${covered}  (broker ground-truth: ${EXPECTED_TOTAL_SOLD})`);
  if (covered !== EXPECTED_TOTAL_SOLD) {
    console.error(`\n⚠️  Share mismatch — plan + existing covers ${covered}, broker sold ${EXPECTED_TOTAL_SOLD}. Aborting.`);
    process.exit(2);
  }

  if (DRY) {
    console.log('\n(--dry) No writes. Re-run without --dry to apply.');
    process.exit(0);
  }

  // ── Backup DB ─────────────────────────────────────────────────────────
  const dbPath = db.name || path.join(process.cwd(), 'data', 'alphahunter.db');
  const bak = `${dbPath}.bak-${Math.floor(Date.now() / 1000)}`;
  try {
    fs.copyFileSync(dbPath, bak);
    console.log(`\nBackup: ${bak}`);
  } catch (e) {
    console.error('⚠️  Backup failed:', e.message, '— aborting to avoid data loss.');
    process.exit(3);
  }

  // ── Apply in one transaction ──────────────────────────────────────────
  const txn = db.transaction(() => {
    let changes = 0;
    for (const p of plan) {
      if (p.kind === 'rewrite-exit') {
        db.prepare(`
          UPDATE trades
             SET exit_price    = ?,
                 pnl_dollars   = ?,
                 pnl_percent   = ?,
                 r_multiple    = ?,
                 exit_reason   = ?,
                 notes         = COALESCE(notes,'') || ?,
                 needs_review  = 1
           WHERE id = ?
        `).run(
          p.to.exit_price, p.to.pnl_dollars, p.to.pnl_percent, p.to.r_multiple,
          p.to.reason,
          `\n[REPAIR 2026-04-23] Synthetic manual-close rewritten to real fill $${p.to.exit_price} (order ${SELL_ORDER_1_PREFIX}/${SELL_ORDER_2_PREFIX}). Prev exit $${p.from.exit_price} pnl $${p.from.pnl_dollars}.`,
          p.id,
        );
        changes++;
      } else if (p.kind === 'close-open') {
        // Load existing partial_exits and append the new closing fill.
        const row = db.prepare('SELECT partial_exits, realized_pnl_dollars FROM trades WHERE id = ?').get(p.id);
        const existing = JSON.parse(row.partial_exits || '[]') || [];
        existing.push({
          level: 'repair_2026_04_23_market_close',
          shares: p.shares,
          price: EXPECTED_FILL_PRICE,
          pnl: p.fillPnl,
          timestamp: new Date().toISOString(),
          order_id: null, // multi-order fill; journal doesn't need to pin to one id
          note: `Repair: previously-unreconciled 81sh canceled-partial-fill from order ${SELL_ORDER_1_PREFIX}`,
        });
        const totalPnl = (existing || []).reduce((s, e) => s + (e.pnl || 0), 0);
        const pnlPct = +((EXPECTED_FILL_PRICE / p.entry_price - 1) * 100).toFixed(2);
        const risk = p.entry_price - (p.stop_price || p.entry_price * 0.95);
        const rMult = risk > 0 ? +((EXPECTED_FILL_PRICE - p.entry_price) / risk).toFixed(2) : 0;

        db.prepare(`
          UPDATE trades
             SET exit_date             = ?,
                 exit_price            = ?,
                 exit_reason           = 'market_close',
                 partial_exits         = ?,
                 realized_pnl_dollars  = ?,
                 pnl_dollars           = ?,
                 pnl_percent           = ?,
                 r_multiple            = ?,
                 remaining_shares      = 0,
                 needs_review          = 1,
                 notes                 = COALESCE(notes,'') || ?
           WHERE id = ?
        `).run(
          `${EXIT_DATE} 18:13:04`,
          EXPECTED_FILL_PRICE,
          JSON.stringify(existing),
          totalPnl,
          totalPnl,
          pnlPct,
          rMult,
          `\n[REPAIR 2026-04-23] Closed remaining ${p.shares}sh @ $${EXPECTED_FILL_PRICE} (previously-unreconciled 81sh market sell from order ${SELL_ORDER_1_PREFIX}).`,
          p.id,
        );
        changes++;
      }
    }
    return changes;
  });

  const changes = txn();
  console.log(`\n✅ Applied ${changes} row update(s).`);

  // ── Post-check ────────────────────────────────────────────────────────
  const after = db.prepare(`
    SELECT id, exit_date, exit_price, exit_reason, pnl_dollars, remaining_shares, partial_exits
      FROM trades WHERE symbol='DAL' AND side='long' ORDER BY id ASC
  `).all();
  console.log('\n─── DAL journal state (post-repair) ───────────────────────────');
  for (const r of after) {
    const rem = r.remaining_shares != null ? r.remaining_shares : '-';
    console.log(`  #${r.id}  exit_date=${r.exit_date || '-'}  exit=$${r.exit_price}  remaining=${rem}  reason=${r.exit_reason}  pnl=$${r.pnl_dollars}`);
  }

  console.log('\nNext steps:');
  console.log('  • Cancel stale broker-side stop orders protecting phantom DAL shares:');
  console.log('      curl -X DELETE .../v2/orders/{stop_id}   (see open-orders report)');
  console.log('  • Land fills-sync filter fix so canceled-with-partial-fill reconciles automatically.');
}

main().catch(e => {
  console.error('[repair-failed]', e.message);
  console.error(e.stack);
  process.exit(1);
});
