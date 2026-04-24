// ─── Re-score decision_log with full context enrichment ────────────────────
// Mirrors src/routes/edge.js /decisions/score-all so the CLI path produces
// identical scores to hitting the API. Earlier versions of this script passed
// a thin context (regime + entry_rs + entry_sepa only) and trades where those
// columns are NULL scored 0 on entry even when rs_snapshots had the real data.
//
// Enrichment sources, in order of preference:
//   1. trades.entry_rs / entry_sepa / regime_at_entry   (what was captured live)
//   2. rs_snapshots row with date <= entry_date         (historical fallback)
//   3. Derived fields (wasSystemSignal from staged_orders.conviction_score,
//      followedSizingRules from risk-engine recommendation, portfolio heat at entry)
//
// logDecisionQuality uses INSERT OR REPLACE so this is idempotent and safe to
// re-run. Run after scripts/backfill-regime-at-entry.js.

const Database = require('better-sqlite3');
const path = require('path');
const { scoreTrade, logDecisionQuality } = require('../src/signals/decision-quality');

const db = new Database(path.join(__dirname, '..', 'data', 'alphahunter.db'));
db.pragma('journal_mode = WAL');

const snapStmt = db.prepare(`
  SELECT swing_momentum, sepa_score, rs_rank, stage
  FROM rs_snapshots
  WHERE symbol = ? AND date <= ? AND type = 'stock'
  ORDER BY date DESC LIMIT 1
`);
const stagedStmt = db.prepare('SELECT conviction_score, strategy FROM staged_orders WHERE alpaca_order_id = ?');

// Pull portfolio config once — account value drives heat + size-rule checks.
let accountValue = 100000, maxRiskPerTrade = 0.01;
try {
  const { getConfig } = require('../src/risk/portfolio');
  const cfg = getConfig();
  if (cfg.accountValue) accountValue = cfg.accountValue;
  if (cfg.maxRiskPerTrade) maxRiskPerTrade = cfg.maxRiskPerTrade;
} catch (_) { /* use defaults */ }

function computeHeatAtEntry(entryDate) {
  try {
    const openAtEntry = db.prepare(`
      SELECT entry_price, stop_price, shares FROM trades
      WHERE entry_date <= ? AND (exit_date IS NULL OR exit_date > ?)
    `).all(entryDate, entryDate);
    let totalRisk = 0;
    for (const t of openAtEntry) {
      const risk = Math.abs(t.entry_price - (t.stop_price || t.entry_price * 0.95)) * (t.shares || 0);
      totalRisk += risk;
    }
    return +(totalRisk / accountValue * 100).toFixed(1);
  } catch (_) { return null; }
}

const trades = db.prepare(`SELECT * FROM trades WHERE exit_date IS NOT NULL`).all();
console.log(`Re-scoring ${trades.length} closed trades with full context…`);

let done = 0, skipped = 0;
for (const t of trades) {
  const snapshot = snapStmt.get(t.symbol, t.entry_date);
  const staged   = t.alpaca_order_id ? stagedStmt.get(t.alpaca_order_id) : null;
  const wasSystemSignal =
    (staged?.conviction_score > 0) || t.was_system_signal === 1 || t.strategy != null;

  // Sizing rule check: within 50-150% of the risk-engine recommendation.
  let followedSizingRules = null;
  if (t.stop_price && t.entry_price && t.shares) {
    const riskPerShare = Math.abs(t.entry_price - t.stop_price);
    const maxRiskDollars = accountValue * maxRiskPerTrade;
    const recommended = riskPerShare > 0 ? Math.floor(maxRiskDollars / riskPerShare) : 0;
    if (recommended > 0) {
      const ratio = t.shares / recommended;
      followedSizingRules = ratio >= 0.5 && ratio <= 1.5;
    }
  }

  const ctx = {
    regimeAtEntry:        t.regime_at_entry || t.entry_regime,
    rsAtEntry:            t.entry_rs    || snapshot?.rs_rank,
    momentumAtEntry:      snapshot?.swing_momentum || null,
    sepaAtEntry:          t.entry_sepa  || snapshot?.sepa_score,
    portfolioHeatAtEntry: computeHeatAtEntry(t.entry_date),
    exitReason:           t.exit_reason,
    rMultiple:            t.r_multiple,
    wasSystemSignal,
    followedSizingRules,
    plannedStop:          t.stop_price,
    actualExit:           t.exit_price,
  };

  try {
    const scored = scoreTrade(t, ctx);
    logDecisionQuality(t.id, scored);
    done++;
  } catch (e) {
    skipped++;
    console.warn(`  skip id=${t.id} ${t.symbol}: ${e.message}`);
  }
}
console.log(`Done: ${done}  Skipped: ${skipped}`);

// Sanity snapshots
console.log('\nComponent averages after rescore:');
for (const col of ['entry_score','regime_score','sizing_score','exit_score','risk_score','process_score']) {
  const r = db.prepare(`SELECT AVG(${col}) a, MIN(${col}) mn, MAX(${col}) mx FROM decision_log`).get();
  console.log(`  ${col.padEnd(16)} avg=${(+r.a).toFixed(1)}  min=${r.mn}  max=${r.mx}`);
}
console.log('\nOutcome alignment distribution:');
for (const r of db.prepare('SELECT outcome_alignment, COUNT(*) c FROM decision_log GROUP BY outcome_alignment').all()) {
  console.log(`  ${(r.outcome_alignment || '—').padEnd(18)} ${r.c}`);
}
console.log('\nGrade distribution:');
for (const r of db.prepare('SELECT grade, COUNT(*) c FROM decision_log GROUP BY grade ORDER BY grade').all()) {
  console.log(`  ${r.grade}  ${r.c}`);
}
