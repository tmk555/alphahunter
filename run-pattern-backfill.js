// One-shot runner for historical pattern_detections backfill.
// Loads dotenv (for Alpaca/Polygon creds), then calls runPatternBackfill over the universe.
require('dotenv').config();
const { runPatternBackfill } = require('./src/signals/backfillPatterns');
const { getDB } = require('./src/data/database');
const { FULL_UNIVERSE } = require('./universe');

(async () => {
  // Prefer FULL_UNIVERSE if available; fall back to distinct symbols from rs_snapshots.
  let symbols = Array.isArray(FULL_UNIVERSE) ? FULL_UNIVERSE : null;
  if (!symbols || !symbols.length) {
    const db = getDB();
    symbols = db.prepare(`SELECT DISTINCT symbol FROM rs_snapshots WHERE type='stock'`).all().map(r => r.symbol);
  }
  console.log(`Pattern backfill: ${symbols.length} symbols, lookbackDays=2500`);

  const lastPct = { v: -1 };
  const onProgress = (p) => {
    const pct = Math.floor(((p.current || 0) / (p.total || 1)) * 100);
    if (pct !== lastPct.v) { lastPct.v = pct; console.log(`[${p.stage}] ${pct}% — ${p.message}`); }
  };

  const t0 = Date.now();
  const res = await runPatternBackfill({ symbols, lookbackDays: 2500, concurrency: 5, onProgress });
  console.log('---done---');
  console.log(res);
  console.log(`Elapsed: ${((Date.now()-t0)/60000).toFixed(1)} min`);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
