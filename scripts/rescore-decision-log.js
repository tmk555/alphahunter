// ─── Re-score decision_log after regime_at_entry backfill ───────────────────
// logDecisionQuality uses INSERT OR REPLACE so this is idempotent and safe to
// re-run. Run after scripts/backfill-regime-at-entry.js.
const Database = require('better-sqlite3');
const path = require('path');
const { scoreTrade, logDecisionQuality } = require('../src/signals/decision-quality');

const db = new Database(path.join(__dirname, '..', 'data', 'alphahunter.db'));
db.pragma('journal_mode = WAL');

const trades = db.prepare(`SELECT * FROM trades WHERE exit_date IS NOT NULL`).all();
console.log(`Re-scoring ${trades.length} closed trades…`);

let done = 0, skipped = 0;
for (const t of trades) {
  const ctx = {
    regimeAtEntry: t.regime_at_entry || t.entry_regime,
    rsAtEntry: t.entry_rs,
    sepaAtEntry: t.entry_sepa,
  };
  try {
    const scored = scoreTrade(t, ctx);
    logDecisionQuality(t.id, scored);
    done++;
  } catch (e) {
    skipped++;
    console.warn(`  skip id=${t.id}: ${e.message}`);
  }
}
console.log(`Done: ${done}  Skipped: ${skipped}`);

const rows = db.prepare('SELECT regime_score, COUNT(*) c FROM decision_log GROUP BY regime_score ORDER BY regime_score').all();
console.log('\nregime_score distribution:');
for (const r of rows) console.log(`  ${r.regime_score}  →  ${r.c}`);
