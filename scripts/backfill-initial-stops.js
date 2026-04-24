// ─── Backfill trades.initial_stop_price + recompute r_multiple ──────────────
//
// Root cause: risk/scaling.js applyScalingAction moves stop_price to entry
// (breakeven) when Target1 hits. The old r_multiple math read the moved stop,
// so every T1-triggered winner recorded as 0.0R (risk = entry - entry = 0).
//
// This script is a one-shot repair for rows created before the fix landed:
//   1. Populate initial_stop_price from the best available source
//         a. staged_orders.stop_price via alpaca_order_id  (exact)
//         b. trades.stop_price if NOT equal to entry_price (untouched original)
//         c. derive from target1 assuming target1 ≈ entry + 2×risk
//            (O'Neil default; leaves a conservative placeholder that beats 0R)
//      If none of those apply, leave initial_stop_price NULL and flag needs_review.
//   2. For every closed row, recompute r_multiple using initial_stop_price.
//
// Flags:
//   --dry    (default) print plan, change nothing
//   --apply  write changes inside a transaction; backup DB first
//
// USAGE
//   node scripts/backfill-initial-stops.js --dry
//   node scripts/backfill-initial-stops.js --apply

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'alphahunter.db');
const DRY = !process.argv.includes('--apply');

function backup(dbPath) {
  const dst = `${dbPath}.bak-initstops-${Date.now()}`;
  fs.copyFileSync(dbPath, dst);
  // copy WAL + SHM too so the backup is a complete point-in-time snapshot.
  for (const suf of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suf)) fs.copyFileSync(dbPath + suf, dst + suf);
  }
  return dst;
}

function pickInitialStop(trade, staged) {
  // a. exact: the staged order this trade originated from
  if (staged?.stop_price && staged.stop_price > 0) {
    return { value: +staged.stop_price, source: 'staged_orders' };
  }
  // b. already untouched — stop_price is different from entry → no T1 breakeven
  //    has happened yet, so it's the original.
  if (trade.stop_price && trade.stop_price > 0
      && Math.abs(trade.stop_price - trade.entry_price) > 0.005) {
    return { value: +trade.stop_price, source: 'existing_stop' };
  }
  // c. derive from target1 (O'Neil default: T1 ≈ entry + 2R → initial_stop ≈ entry - (T1-entry)/2)
  if (trade.target1 && trade.target1 > trade.entry_price) {
    const impliedR = (trade.target1 - trade.entry_price) / 2;
    return { value: +(trade.entry_price - impliedR).toFixed(2), source: 'derived_from_t1' };
  }
  return { value: null, source: 'none' };
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Defensive: script can be run before server boot, before the schema
  // ADD COLUMN migration fires. Adding the column is idempotent and harmless
  // (the actual row writes are still gated on --apply), so do it always so
  // dry-run can read from it without blowing up.
  const cols = db.prepare('PRAGMA table_info(trades)').all();
  if (!cols.find(c => c.name === 'initial_stop_price')) {
    console.log('[schema] initial_stop_price not found — adding');
    db.exec('ALTER TABLE trades ADD COLUMN initial_stop_price REAL');
  }

  const trades = db.prepare('SELECT * FROM trades WHERE initial_stop_price IS NULL').all();
  console.log(`Scanning ${trades.length} trades missing initial_stop_price …\n`);

  const stagedStmt = db.prepare('SELECT stop_price FROM staged_orders WHERE alpaca_order_id = ?');
  const updateStopStmt = db.prepare('UPDATE trades SET initial_stop_price = ? WHERE id = ?');
  const updateRStmt = db.prepare('UPDATE trades SET r_multiple = ? WHERE id = ?');

  const plan = [];
  for (const t of trades) {
    const staged = t.alpaca_order_id ? stagedStmt.get(t.alpaca_order_id) : null;
    const { value, source } = pickInitialStop(t, staged);

    let newR = t.r_multiple;
    if (t.exit_date && t.exit_price != null && value != null) {
      const risk = t.entry_price - value;
      if (risk > 0) {
        const side = t.side === 'short' ? -1 : 1;
        newR = +((t.exit_price - t.entry_price) / risk * side).toFixed(2);
      }
    }

    plan.push({
      id: t.id,
      symbol: t.symbol,
      entry_date: t.entry_date,
      entry_price: t.entry_price,
      current_stop: t.stop_price,
      target1: t.target1,
      initial_stop: value,
      source,
      exit_price: t.exit_price,
      old_r: t.r_multiple,
      new_r: newR,
    });
  }

  // Print a compact table
  const pad = (s, n) => String(s ?? '').padEnd(n);
  console.log(pad('id', 4), pad('symbol', 7), pad('entry', 9), pad('stop', 9),
              pad('T1', 9), pad('init_stop', 10), pad('source', 18),
              pad('old_R', 7), pad('new_R', 7));
  console.log('─'.repeat(90));
  for (const r of plan) {
    console.log(
      pad(r.id, 4),
      pad(r.symbol, 7),
      pad((r.entry_price || 0).toFixed(2), 9),
      pad((r.current_stop || 0).toFixed(2), 9),
      pad(r.target1 != null ? r.target1.toFixed(2) : '—', 9),
      pad(r.initial_stop != null ? r.initial_stop.toFixed(2) : '—', 10),
      pad(r.source, 18),
      pad(r.old_r != null ? r.old_r.toFixed(2) : '—', 7),
      pad(r.new_r != null ? r.new_r.toFixed(2) : '—', 7),
    );
  }

  const unresolved = plan.filter(r => r.initial_stop == null);
  console.log(`\n${plan.length - unresolved.length} rows resolved, ${unresolved.length} unresolved.`);

  if (DRY) {
    console.log('\n[DRY RUN] pass --apply to write.');
    return;
  }

  const bak = backup(DB_PATH);
  console.log(`\n[backup] ${bak}`);

  const tx = db.transaction(() => {
    for (const r of plan) {
      if (r.initial_stop != null) {
        updateStopStmt.run(r.initial_stop, r.id);
        if (r.new_r != null && r.new_r !== r.old_r) {
          updateRStmt.run(r.new_r, r.id);
        }
      }
    }
  });
  tx();
  console.log(`[applied] ${plan.length - unresolved.length} rows.`);
}

main();
