// ─── ATR-Context Capture ─────────────────────────────────────────────────
// Look up entry_atr (in dollars) from rs_snapshots and trail_atr_mult from
// the trade's strategy. Called from the three trade-creation paths
// (fills-sync orders loop, fills-sync orphan reconcile, manual /api/trades
// POST) so every new trade row carries the ATR context the trail consumers
// (stop-discipline, scaling) need.
//
// Why a separate helper: the data is a multi-step lookup (rs_snapshots ←
// strategies.exit_rules JSON ← strategy id) and we want the same fallback
// chain in all three call sites. Inlining would have re-implemented the
// "what if there's no rs_snapshot?" logic in three places.

const DEFAULT_TRAIL_ATR_MULT = 2.5;

// Look up the most-recent rs_snapshot at or before entry_date and convert
// the percentage ATR to a dollar ATR.
//
// Returns null when:
//   • symbol has no rs_snapshot row at or before the entry date
//   • atr_pct is null/0 (some early backfilled rows lack ATR)
//   • entryPrice <= 0 (defensive — caller should have caught this)
function _atrFromSnapshot(db, symbol, entryDate, entryPrice) {
  if (!(entryPrice > 0)) return null;
  const row = db.prepare(`
    SELECT atr_pct FROM rs_snapshots
    WHERE symbol = ? AND date <= ? AND type = 'stock'
    ORDER BY date DESC LIMIT 1
  `).get(symbol, entryDate);
  if (!row || !(row.atr_pct > 0)) return null;
  return +(entryPrice * (row.atr_pct / 100)).toFixed(4);
}

// Pull trail_atr_mult from strategies.exit_rules JSON. Defaults to 2.5
// (the swing-strategy default) when the strategy id is unknown or the
// JSON doesn't carry the field.
function _trailMultFromStrategy(db, strategyId) {
  if (!strategyId) return DEFAULT_TRAIL_ATR_MULT;
  const row = db.prepare('SELECT exit_rules FROM strategies WHERE id = ?').get(strategyId);
  if (!row?.exit_rules) return DEFAULT_TRAIL_ATR_MULT;
  try {
    const rules = JSON.parse(row.exit_rules);
    if (rules?.trail_atr_mult > 0) return +rules.trail_atr_mult;
  } catch (_) {}
  return DEFAULT_TRAIL_ATR_MULT;
}

// Apply entry_atr + trail_atr_mult onto an existing trade row. Idempotent:
// uses COALESCE so re-running on a row that already has these set is a
// no-op. The capture sites all call this AFTER the trade row exists and
// AFTER strategy assignment has run, so we know which strategy's mult to
// pull.
function applyAtrContext(db, tradeId, { symbol, entryDate, entryPrice, strategy } = {}) {
  if (!tradeId) return { wrote: false, reason: 'no_trade_id' };

  const entryAtr = _atrFromSnapshot(db, symbol, entryDate, entryPrice);
  const trailMult = _trailMultFromStrategy(db, strategy);

  // Even when entryAtr is null we still write the multiplier — legacy
  // trail_pct path stays as fallback in stop-discipline / scaling, but
  // having the mult lets the user see what would have been used and lets
  // a later backfill close the loop.
  db.prepare(`
    UPDATE trades
       SET entry_atr      = COALESCE(entry_atr, ?),
           trail_atr_mult = COALESCE(trail_atr_mult, ?)
     WHERE id = ?
  `).run(entryAtr, trailMult, tradeId);

  return {
    wrote: true,
    entryAtr,
    trailAtrMult: trailMult,
    fallback: entryAtr == null ? 'no_rs_snapshot — trail_pct path will be used' : null,
  };
}

module.exports = { applyAtrContext, DEFAULT_TRAIL_ATR_MULT };
