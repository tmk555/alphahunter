#!/usr/bin/env node
// ─── repair-avgo-dell-orphans.js ──────────────────────────────────────────
//
// One-time reconciliation for AVGO and DELL journal rows after the
// 2026-04-23 scale-out divergence.
//
// BACKGROUND
//   Two systemic bugs collided on these positions:
//
//   1) ORPHAN SCALE-IN ROWS
//      When a scale-in writes a new trades row, the first row gets a full
//      bracket (stop + T1 + T2). The 2nd and 3rd rows sometimes land with
//      only (symbol, shares, entry_price, alpaca_order_id) and NULL
//      stop_price / target1 / target2 / initial_shares / remaining_shares.
//      Symptom: the scale-out tracker ignores them at T1, so when a broker
//      target leg fires, the orphan row's pro-rata share of the sell never
//      gets recorded as a partial_exit → journal silently drifts from
//      broker.
//
//      Affected rows:
//        AVGO #27 (alpaca_order_id b87960bc) — 6 shares, stop/T1/T2 NULL
//        DELL #24 (alpaca_order_id 23209c6c) — 9 shares, stop/T1/T2 NULL
//
//   2) OVER-AGGRESSIVE auto_sync CLOSE
//      When the broker shows N shares sold today but journal has no matching
//      partial_exit for N, the auto_sync reconciler closes the oldest
//      matching-symbol open row wholesale. Result: DELL row #23 shows
//      exit_date=2026-04-22 exit_reason=auto_sync exit_price=$216.12 — but
//      broker never closed that specific row; it sold 9sh that belong
//      3/3/3 across #23, #24, #25.
//
// THIS SCRIPT
//   Reconciles journal to match broker truth:
//
//   AVGO (broker: 14sh open; sold 6 @ $428.16 on 4/23):
//     #3:  already has partial_exit 2sh @ $428.16, remaining=6 — no change
//     #4:  already has partial_exit 2sh @ $428.16, remaining=4 — no change
//     #27: backfill stop=393.225 (buy fill), T1=428.16, T2=447.49;
//          initial_shares=6, remaining=4; add partial_exit 2sh @ $428.16
//
//   DELL (broker: 18sh open; sold 9 @ avg $216.12 on 4/22):
//     #23: reopen (clear exit_*), backfill stop=192.59, T1=215.79, T2=229.68;
//          initial_shares=9, remaining=6; add partial_exit 3sh @ $216.12
//     #24: backfill stop=192.59, T1=215.79, T2=229.68;
//          initial_shares=9, remaining=6; add partial_exit 3sh @ $216.12
//     #25: already has partial_exit 3sh @ $215.79; UPDATE price → $216.12
//          (match broker fill), remaining=6
//
// SAFETY
//   • --dry prints the full plan and exits without writing.
//   • Wraps all writes in one transaction.
//   • Auto-backs up the DB file before applying.
//   • Idempotent post-apply: re-running prints "already clean" and exits 0.

const fs   = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');

// ─── Canonical broker truth (from /v2/account/activities FILL entries) ───
const AVGO_SELL_PRICE = 428.16;
const AVGO_SELL_TS    = '2026-04-23T15:11:36.589Z';
const DELL_SELL_PRICE = 216.12;   // (1*215.90 + 1*216.15 + 7*216.15) / 9
const DELL_SELL_TS    = '2026-04-22T13:35:47.744Z';

// ─── Per-row patch plan ───────────────────────────────────────────────────
const PATCHES = [
  // AVGO #27 — orphan scale-in, never participated in 6sh sell distribution
  {
    id: 27, symbol: 'AVGO',
    backfill: {
      stop_price: 393.225,
      target1:    428.16,
      target2:    447.49,
      initial_shares: 6,
      remaining_shares: 4,
    },
    addPartialExit: {
      level: 'target1', shares: 2, price: AVGO_SELL_PRICE,
      pnl: +((AVGO_SELL_PRICE - 393.225) * 2).toFixed(2),
      timestamp: AVGO_SELL_TS,
    },
    mode: 'backfill',   // set fields only if currently NULL
  },

  // DELL #23 — ghost-closed by auto_sync; reopen with 3sh partial_exit
  {
    id: 23, symbol: 'DELL',
    reopen: true,       // clear exit_date/price/reason/pnl_dollars/pnl_percent/r_multiple
    backfill: {
      stop_price: 192.59,
      target1:    215.79,
      target2:    229.68,
      initial_shares: 9,
      remaining_shares: 6,
    },
    addPartialExit: {
      level: 'target1', shares: 3, price: DELL_SELL_PRICE,
      pnl: +((DELL_SELL_PRICE - 192.59) * 3).toFixed(2),
      timestamp: DELL_SELL_TS,
    },
    mode: 'reopen+backfill',
  },

  // DELL #24 — orphan scale-in, never participated in 9sh sell distribution
  {
    id: 24, symbol: 'DELL',
    backfill: {
      stop_price: 192.59,
      target1:    215.79,
      target2:    229.68,
      initial_shares: 9,
      remaining_shares: 6,
    },
    addPartialExit: {
      level: 'target1', shares: 3, price: DELL_SELL_PRICE,
      pnl: +((DELL_SELL_PRICE - 192.59) * 3).toFixed(2),
      timestamp: DELL_SELL_TS,
    },
    mode: 'backfill',
  },

  // DELL #25 — has correct partial_exit logic but price was the T1 TRIGGER
  // ($215.79), not the broker FILL ($216.12). Update price to match broker.
  {
    id: 25, symbol: 'DELL',
    backfill: { remaining_shares: 6, initial_shares: 9 },
    updatePartialExit: {
      match: { level: 'target1' },
      set:   { price: DELL_SELL_PRICE, pnl: +((DELL_SELL_PRICE - 192.59) * 3).toFixed(2) },
    },
    mode: 'patch',
  },
];

function main() {
  const { getDB } = require('../src/data/database');
  const db = getDB();

  // ─── Diagnostic pre-check ─────────────────────────────────────────────
  console.log('─── CURRENT JOURNAL STATE ──────────────────────────');
  const currentRows = new Map();
  const ids = PATCHES.map(p => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, symbol, side, shares, initial_shares, remaining_shares,
            entry_price, stop_price, target1, target2,
            exit_date, exit_price, exit_reason, partial_exits, alpaca_order_id
       FROM trades WHERE id IN (${placeholders}) ORDER BY id`
  ).all(...ids);
  for (const r of rows) {
    currentRows.set(r.id, r);
    console.log(`  #${r.id} ${r.symbol}  sh=${r.shares} init=${r.initial_shares} rem=${r.remaining_shares}`);
    console.log(`       stop=${r.stop_price} T1=${r.target1} T2=${r.target2}`);
    console.log(`       exit_date=${r.exit_date} exit_price=${r.exit_price} exit_reason=${r.exit_reason}`);
    console.log(`       partial_exits=${r.partial_exits || 'null'}`);
  }

  console.log('\n─── REPAIR PLAN ────────────────────────────────────');
  let planCount = 0;
  for (const p of PATCHES) {
    const row = currentRows.get(p.id);
    if (!row) {
      console.log(`  #${p.id} ${p.symbol}: ROW NOT FOUND — skipping`);
      continue;
    }
    console.log(`\n  #${p.id} ${p.symbol} [${p.mode}]`);

    if (p.reopen) {
      if (row.exit_date) {
        console.log(`    - REOPEN: clear exit_date (was ${row.exit_date}), exit_price (was ${row.exit_price}), exit_reason (was ${row.exit_reason})`);
        planCount++;
      } else {
        console.log(`    - REOPEN: already open, no-op`);
      }
    }

    if (p.backfill) {
      for (const [k, v] of Object.entries(p.backfill)) {
        const cur = row[k];
        const needsUpdate =
          p.mode === 'patch' ? (cur !== v) :
          (cur === null || cur === undefined);
        if (needsUpdate) {
          console.log(`    - SET ${k}: ${cur} → ${v}`);
          planCount++;
        } else {
          console.log(`    - ${k}=${cur} (unchanged, skip)`);
        }
      }
    }

    if (p.addPartialExit) {
      const existing = row.partial_exits ? JSON.parse(row.partial_exits) : [];
      const alreadyHas = existing.some(e => e.level === p.addPartialExit.level && Math.abs(e.price - p.addPartialExit.price) < 0.01 && e.shares === p.addPartialExit.shares);
      if (!alreadyHas) {
        console.log(`    - APPEND partial_exit: ${JSON.stringify(p.addPartialExit)}`);
        planCount++;
      } else {
        console.log(`    - partial_exit already present, skip`);
      }
    }

    if (p.updatePartialExit) {
      const existing = row.partial_exits ? JSON.parse(row.partial_exits) : [];
      const target = existing.find(e => e.level === p.updatePartialExit.match.level);
      if (target) {
        const delta = Object.entries(p.updatePartialExit.set).filter(([k, v]) => target[k] !== v);
        if (delta.length) {
          console.log(`    - UPDATE partial_exit[${target.level}]: ${delta.map(([k, v]) => `${k}: ${target[k]} → ${v}`).join(', ')}`);
          planCount++;
        } else {
          console.log(`    - partial_exit[${target.level}] already matches, skip`);
        }
      } else {
        console.log(`    - partial_exit[${p.updatePartialExit.match.level}] not found, skip`);
      }
    }
  }

  console.log(`\n  Total changes planned: ${planCount}`);
  console.log('────────────────────────────────────────────────────');

  if (planCount === 0) {
    console.log('\n[clean] Journal already matches broker. Exiting 0 (no-op).');
    process.exit(0);
  }

  if (DRY) {
    console.log('\n[dry-run] No writes. Re-run without --dry to apply.');
    process.exit(0);
  }

  // ─── Auto-backup ──────────────────────────────────────────────────────
  const dbPath = process.env.ALPHAHUNTER_DB || path.resolve(__dirname, '..', 'data', 'alphahunter.db');
  if (fs.existsSync(dbPath)) {
    const backup = `${dbPath}.bak-${Math.floor(Date.now() / 1000)}`;
    fs.copyFileSync(dbPath, backup);
    console.log(`\n[backup] ${backup}`);
  }

  // ─── Apply ─────────────────────────────────────────────────────────────
  const updateRow = (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return 0;
    const sql = `UPDATE trades SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
    return db.prepare(sql).run(...keys.map(k => fields[k]), id).changes;
  };

  const tx = db.transaction(() => {
    let applied = 0;
    for (const p of PATCHES) {
      const row = currentRows.get(p.id);
      if (!row) continue;

      const update = {};

      if (p.reopen && row.exit_date) {
        Object.assign(update, { exit_date: null, exit_price: null, exit_reason: null, pnl_dollars: null, pnl_percent: null, r_multiple: null });
      }

      if (p.backfill) {
        for (const [k, v] of Object.entries(p.backfill)) {
          const cur = row[k];
          const needsUpdate = p.mode === 'patch' ? (cur !== v) : (cur === null || cur === undefined);
          if (needsUpdate) update[k] = v;
        }
      }

      // partial_exits mutation
      let existing = row.partial_exits ? JSON.parse(row.partial_exits) : [];
      let touchedExits = false;

      if (p.addPartialExit) {
        const alreadyHas = existing.some(e => e.level === p.addPartialExit.level && Math.abs(e.price - p.addPartialExit.price) < 0.01 && e.shares === p.addPartialExit.shares);
        if (!alreadyHas) { existing.push(p.addPartialExit); touchedExits = true; }
      }

      if (p.updatePartialExit) {
        const target = existing.find(e => e.level === p.updatePartialExit.match.level);
        if (target) {
          for (const [k, v] of Object.entries(p.updatePartialExit.set)) {
            if (target[k] !== v) { target[k] = v; touchedExits = true; }
          }
        }
      }

      if (touchedExits) update.partial_exits = JSON.stringify(existing);

      applied += updateRow(p.id, update);
    }
    return applied;
  });

  const changes = tx();
  console.log(`\n[repair-result] rows_updated=${changes}`);

  // ─── Post-check ───────────────────────────────────────────────────────
  console.log('\n─── POST-REPAIR STATE ──────────────────────────────');
  for (const sym of ['AVGO', 'DELL']) {
    const open = db.prepare(
      "SELECT id, shares, remaining_shares, entry_price, stop_price, target1 FROM trades WHERE symbol=? AND exit_date IS NULL ORDER BY id"
    ).all(sym);
    const totalRem = open.reduce((s, r) => s + (r.remaining_shares || r.shares || 0), 0);
    console.log(`  ${sym}: ${open.length} open rows, remaining=${totalRem}`);
    for (const r of open) console.log(`    id=${r.id} sh=${r.shares} rem=${r.remaining_shares} entry=${r.entry_price} stop=${r.stop_price} T1=${r.target1}`);
  }
  console.log('────────────────────────────────────────────────────');
  console.log('\nCompare against live Alpaca via:');
  console.log('  node scripts/verify-journal-vs-alpaca.js');
}

try { main(); } catch (e) { console.error('[repair-failed]', e.message); console.error(e.stack); process.exit(1); }
