#!/usr/bin/env node
// ─── verify-journal-vs-alpaca.js ──────────────────────────────────────────
//
// Prints a side-by-side reconciliation of the journal (`trades` table,
// exit_date IS NULL) against live Alpaca positions. Any drift between
// open journal shares and Alpaca shares flags a symbol in red with an
// explanatory hint about the likely cause.
//
// Use this:
//   • After running scripts/repair-dell-dal-ghost-rows.js to confirm the
//     repair landed.
//   • As part of nightly ops to catch new drift early (before it accrues
//     more ghost rows).
//   • Ad-hoc when the dashboard P&L looks wrong and you want to know
//     whether the journal or the broker is lying.
//
// USAGE
//   node scripts/verify-journal-vs-alpaca.js
//
// OUTPUT
//   One row per symbol that appears in EITHER the journal-open set or
//   Alpaca positions. Columns:
//     STATUS  symbol  journal_sh  alpaca_sh  journal_avg  alpaca_avg  note
//
//   Exit code 0 when all rows reconcile. Exit code 2 when any row drifts.
//   Non-zero exit makes this suitable for a cron/CI gate.
//
// ENV
//   Reads ALPACA_KEY / ALPACA_SECRET via src/broker/alpaca. If Alpaca is
//   unconfigured the script prints only the journal side and exits 1.

// Load .env so ALPACA_API_KEY / ALPACA_API_SECRET are available when this
// script is invoked directly (app.js loads dotenv for the server path, but
// standalone scripts don't go through that entry point).
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const path = require('path');

async function main() {
  const { getDB }       = require('../src/data/database');
  const alpaca          = require('../src/broker/alpaca');
  const db = getDB();

  // ─── Journal side ─────────────────────────────────────────────────────
  const openRows = db.prepare(`
    SELECT symbol, side, SUM(shares) AS sh,
           SUM(shares * entry_price) / NULLIF(SUM(shares), 0) AS avg_entry,
           COUNT(*) AS rows
    FROM trades
    WHERE exit_date IS NULL AND shares > 0
    GROUP BY symbol, side
    ORDER BY symbol
  `).all();
  const journalMap = new Map(openRows.map(r => [r.symbol, r]));

  // ─── Alpaca side ──────────────────────────────────────────────────────
  let positions = [];
  let alpacaOK = true;
  try {
    positions = await alpaca.getPositions();
  } catch (e) {
    console.error('[alpaca-error]', e.message);
    console.error('Showing journal-only view. Set ALPACA_KEY/ALPACA_SECRET to reconcile.');
    alpacaOK = false;
  }
  const alpacaMap = new Map(
    (positions || []).map(p => [p.symbol, {
      sh: Math.abs(+p.qty),
      avg: +p.avg_entry_price,
      side: +p.qty > 0 ? 'long' : 'short',
    }])
  );

  // Union of symbols across both sides so we catch journal-only ghosts
  // AND alpaca-only orphans (broker holds shares with no journal row).
  const allSymbols = new Set([...journalMap.keys(), ...alpacaMap.keys()]);
  if (allSymbols.size === 0) {
    console.log('Nothing to reconcile — journal has no open rows and Alpaca has no positions.');
    process.exit(0);
  }

  // ─── Print table ──────────────────────────────────────────────────────
  const header = ['STATUS', 'SYMBOL', 'J_SH', 'A_SH', 'J_AVG', 'A_AVG', 'ROWS', 'NOTE'];
  const rows = [];
  let drift = 0;

  for (const sym of [...allSymbols].sort()) {
    const j = journalMap.get(sym);
    const a = alpacaMap.get(sym);
    const jSh = j ? j.sh : 0;
    const aSh = a ? a.sh : 0;
    const jAvg = j && j.avg_entry != null ? +j.avg_entry.toFixed(2) : null;
    const aAvg = a ? +a.avg.toFixed(2) : null;
    const rowsCount = j ? j.rows : 0;

    let status = 'OK';
    let note = '';
    if (!alpacaOK) {
      // Alpaca unreachable — we can't diagnose drift, just list journal state.
      status = 'J-ONLY';
      note = '(Alpaca unreachable — journal-only view)';
    } else if (!a && j) {
      status = 'DRIFT'; drift++;
      note = 'journal open, Alpaca flat — stale journal row (manual close that never submitted?)';
    } else if (a && !j) {
      status = 'DRIFT'; drift++;
      note = 'Alpaca has position, no journal row — reconciler will create one on next fills-sync';
    } else if (jSh !== aSh) {
      status = 'DRIFT'; drift++;
      const delta = jSh - aSh;
      note = delta > 0
        ? `journal has ${delta} extra sh — likely ghost row(s) or partial close not synced`
        : `Alpaca has ${-delta} extra sh — partial bracket fill not reconciled yet`;
    } else if (jAvg != null && aAvg != null && Math.abs(jAvg - aAvg) > 0.01) {
      // shares match but avg drifted — minor, just flag it
      note = `avg drift $${(jAvg - aAvg).toFixed(4)} — tranche entry history may be stale`;
    }

    rows.push([status, sym, jSh, aSh, jAvg ?? '—', aAvg ?? '—', rowsCount, note]);
  }

  // ─── Format output ────────────────────────────────────────────────────
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(fmt(widths.map(w => '-'.repeat(w))));
  for (const r of rows) console.log(fmt(r));

  console.log('');
  if (drift > 0) {
    console.log(`RESULT: ${drift} symbol(s) drift — journal and Alpaca disagree`);
    process.exit(2);
  } else if (!alpacaOK) {
    console.log('RESULT: journal-only (Alpaca not reachable)');
    process.exit(1);
  } else {
    console.log('RESULT: all symbols reconcile');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('[verify-failed]', e.message);
  process.exit(1);
});
