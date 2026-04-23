#!/usr/bin/env node
// ─── backfill-rs-snapshot-ma.js ───────────────────────────────────────────
//
// One-shot heal for rs_snapshots rows that were persisted with NULL values
// in vs_ma50 / vs_ma200 / price / volume_ratio. This happens when the daily
// rs_scan runs at a moment where the quote cascade returns partial data
// (e.g. quotes without OHLCV-derived MAs) — and the prior INSERT/UPDATE
// logic's `WHERE price IS NULL` guard refused to backfill later runs.
//
// The fix in src/scheduler/jobs.js widens that guard so future runs heal
// themselves. This script heals today's already-persisted snapshot by
// re-running the scanner in memory and merging the fresh fields into each
// matching (date, symbol, type) row.
//
// USAGE
//   node scripts/backfill-rs-snapshot-ma.js          # runs against today's snapshot
//   node scripts/backfill-rs-snapshot-ma.js --date 2026-04-23
//   node scripts/backfill-rs-snapshot-ma.js --dry    # prints plan only
//
// SAFETY
//   • All writes in one transaction.
//   • COALESCE preserves any non-null value already in the row — we never
//     overwrite existing good data with stale scanner output.
//   • Idempotent: on a fresh healthy snapshot, every UPDATE is a no-op and
//     changed-row-count is 0.

try { require('dotenv').config(); } catch (_) {}

const DRY = process.argv.includes('--dry');
const dateArg = (() => {
  const i = process.argv.indexOf('--date');
  return i > -1 ? process.argv[i + 1] : null;
})();

function marketDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function main() {
  const { getDB } = require('../src/data/database');
  const { runRSScan } = require('../src/scanner');
  const { FULL_UNIVERSE } = require('../universe');
  const db = getDB();

  // Build the universe the same way server.js does: file universe + DB additions.
  // Without the DB merge, recently-added stocks (MKSI, etc.) would be scanned
  // under the wrong sector, and we might miss rows that today's snapshot has.
  const SECTOR_MAP = { ...FULL_UNIVERSE };
  const UNIVERSE = Object.keys(SECTOR_MAP);
  try {
    const dbAdded = db.prepare(
      "SELECT symbol, sector FROM universe_mgmt WHERE removed_date IS NULL"
    ).all();
    for (const { symbol, sector } of dbAdded) {
      if (!SECTOR_MAP[symbol]) {
        SECTOR_MAP[symbol] = sector;
        UNIVERSE.push(symbol);
      }
    }
  } catch (_) { /* table may not exist */ }

  const date = dateArg || marketDate();
  console.log(`Target snapshot date: ${date}`);

  // ─── Pre-check: how much NULL data exists today ───────────────────────
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN price        IS NULL THEN 1 ELSE 0 END) AS null_price,
      SUM(CASE WHEN vs_ma50      IS NULL THEN 1 ELSE 0 END) AS null_ma50,
      SUM(CASE WHEN vs_ma200     IS NULL THEN 1 ELSE 0 END) AS null_ma200,
      SUM(CASE WHEN volume_ratio IS NULL THEN 1 ELSE 0 END) AS null_volr
    FROM rs_snapshots
    WHERE date = ? AND type = 'stock'
  `).get(date);

  console.log(`\nCurrent state for ${date}:`);
  console.log(`  total rows     : ${stats.total}`);
  console.log(`  NULL price     : ${stats.null_price}`);
  console.log(`  NULL vs_ma50   : ${stats.null_ma50}`);
  console.log(`  NULL vs_ma200  : ${stats.null_ma200}`);
  console.log(`  NULL volume_r  : ${stats.null_volr}`);

  if (stats.total === 0) {
    console.log('\nNo rows to heal — nothing to do.');
    process.exit(0);
  }
  if (stats.null_ma50 === 0 && stats.null_ma200 === 0 && stats.null_price === 0) {
    console.log('\n✅ Snapshot already complete — no backfill needed.');
    process.exit(0);
  }

  // ─── Re-run scanner in memory to get fresh row-level data ─────────────
  // NOTE: scanner caches under 'rs:full'; if today's rs_scan just ran and
  // hit the sticky-NULL bug, the cache entry itself is incomplete too. We
  // clear it so the full re-scan executes instead of serving bad data.
  try {
    const { cacheClear } = require('../src/data/cache');
    if (typeof cacheClear === 'function') cacheClear();
  } catch (_) {}
  console.log('\nRunning RS scan in memory (this takes 1-3 min, uses provider cascade)...');
  console.log(`  Universe: ${UNIVERSE.length} stocks`);
  const freshStart = Date.now();
  const results = await runRSScan(UNIVERSE, SECTOR_MAP);
  const freshMs = Date.now() - freshStart;
  console.log(`Scan completed in ${(freshMs / 1000).toFixed(1)}s — ${results.length} stocks`);

  // Count how many have the fields we need
  const withMA50  = results.filter(r => r.vsMA50 != null).length;
  const withMA200 = results.filter(r => r.vsMA200 != null).length;
  const withPrice = results.filter(r => r.price != null).length;
  console.log(`  with vsMA50    : ${withMA50}`);
  console.log(`  with vsMA200   : ${withMA200}`);
  console.log(`  with price     : ${withPrice}`);

  if (DRY) {
    console.log('\n(--dry) No writes. Re-run without --dry to apply.');
    process.exit(0);
  }

  // ─── Backfill via COALESCE merge ──────────────────────────────────────
  const update = db.prepare(`
    UPDATE rs_snapshots
    SET price            = COALESCE(price, ?),
        rs_rank          = COALESCE(rs_rank, ?),
        swing_momentum   = COALESCE(swing_momentum, ?),
        sepa_score       = COALESCE(sepa_score, ?),
        stage            = COALESCE(stage, ?),
        vs_ma50          = COALESCE(vs_ma50, ?),
        vs_ma200         = COALESCE(vs_ma200, ?),
        volume_ratio     = COALESCE(volume_ratio, ?),
        vcp_forming      = COALESCE(vcp_forming, ?),
        rs_line_new_high = COALESCE(rs_line_new_high, ?),
        atr_pct          = COALESCE(atr_pct, ?)
    WHERE date = ? AND symbol = ? AND type = 'stock'
      AND (price IS NULL OR vs_ma50 IS NULL OR vs_ma200 IS NULL OR volume_ratio IS NULL)
  `);

  const txn = db.transaction(() => {
    let healed = 0;
    for (const r of results) {
      const res = update.run(
        r.price ?? null, r.rsRank ?? null, r.swingMomentum ?? null,
        r.sepaScore ?? null, r.stage ?? null,
        r.vsMA50 ?? null, r.vsMA200 ?? null,
        r.volumeRatio ?? null, r.vcpForming ? 1 : 0,
        r.rsLineNewHigh ? 1 : 0, r.atrPct ?? null,
        date, r.ticker,
      );
      if (res.changes > 0) healed++;
    }
    return healed;
  });

  const healed = txn();
  console.log(`\n✅ Healed ${healed} row(s).`);

  // ─── Post-check ───────────────────────────────────────────────────────
  const after = db.prepare(`
    SELECT
      SUM(CASE WHEN price        IS NULL THEN 1 ELSE 0 END) AS null_price,
      SUM(CASE WHEN vs_ma50      IS NULL THEN 1 ELSE 0 END) AS null_ma50,
      SUM(CASE WHEN vs_ma200     IS NULL THEN 1 ELSE 0 END) AS null_ma200
    FROM rs_snapshots
    WHERE date = ? AND type = 'stock'
  `).get(date);
  console.log(`\nPost-heal null counts: price=${after.null_price}  ma50=${after.null_ma50}  ma200=${after.null_ma200}`);
  console.log('\nNext: trigger a fresh deep_scan to pick up the healed data:');
  console.log('  curl -XPOST http://localhost:3000/api/scheduler/jobs/<deep_scan_id>/run');
  console.log('…or just wait for the next :30 cron tick.');
}

main().catch(e => {
  console.error('[backfill-failed]', e.message);
  console.error(e.stack);
  process.exit(1);
});
