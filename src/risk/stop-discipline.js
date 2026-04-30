// ─── Stop Discipline — unified stop-tightening service ───────────────────
//
// Pre-consolidation: three modules independently mutated trades.stop_price:
//
//   • position-deterioration.applyDeteriorationTighten — RS-collapse / rotation
//   • position-deterioration.tightenOnRegimeDowngrade — bulk on regime flip
//   • breadth-warning.applyStopAdjustments         — composite-breadth deterioration
//   • stops-sync.syncJournalStopsToBroker           — reconcile journal → broker
//
// Each had its own decision logic, its own broker call, its own race
// window. The 'trailing_stop_active' gate bug we fixed earlier was hiding
// in this fragmentation. Different modules could simultaneously decide a
// trade's stop should be tighter / unchanged / wider, and the last write
// won.
//
// Now: ONE evaluateAllOpenStops(marketState) function that:
//   1. Reads every open journal trade.
//   2. Asks each contributing signal source for its RECOMMENDED stop.
//   3. Picks the TIGHTEST recommendation per trade (never loosens — once
//      you've raised a stop, even a healthier signal can't widen it).
//   4. Returns a unified plan: [{ tradeId, currentStop, recommendedStop,
//                                 reasons[], sources[] }].
// applyStopAdjustments(plan) is the single execution path that writes
// the journal AND patches the broker via stops-sync's existing
// syncJournalStopsToBroker (which already handles 404s, 422s,
// pending_cancel, etc. — tested at 11/11 in stops-sync.test.js).
//
// The two original modules (position-deterioration / breadth-warning)
// stay as SIGNAL CONTRIBUTORS — they expose their stop-tighten logic as
// pure recommendation functions, no longer doing the broker call
// themselves. That removes the race entirely.

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Compose recommendations from all signal sources ──────────────────────
//
// Each source returns { recommendedStop, reason } | null. Null = "no
// opinion." Composition rule: MAX (tightest for long; we'll generalize to
// short later). Reasons accumulate so the audit trail explains why.
async function evaluateAllOpenStops(marketState = null) {
  const trades = db().prepare(
    `SELECT * FROM trades WHERE exit_date IS NULL
       AND COALESCE(remaining_shares, shares, 0) > 0`
  ).all();
  if (!trades.length) return { plans: [], skipped: [] };

  // Lazy-load market state if not passed.
  if (!marketState) {
    try {
      const { getMarketRegime } = require('./regime');
      const regime = await getMarketRegime();
      const { evaluateBreadthWarning } = require('../signals/breadth-warning');
      const breadthWarning = evaluateBreadthWarning();
      marketState = { regime, breadthWarning };
    } catch (_) { marketState = {}; }
  }

  // Live prices (one fetch for all symbols — feeds trail-stop math).
  const symbols = [...new Set(trades.map(t => t.symbol))];
  let priceBy = {};
  try {
    const { getQuotes } = require('../data/providers/manager');
    const quotes = await getQuotes(symbols);
    for (const q of (quotes || [])) {
      if (q?.symbol && q?.regularMarketPrice != null) priceBy[q.symbol] = q.regularMarketPrice;
    }
  } catch (_) { /* signals that need price will skip */ }

  const plans = [];
  const skipped = [];

  for (const trade of trades) {
    const cur = trade.stop_price;
    const isShort = trade.side === 'short';
    const price = priceBy[trade.symbol];
    const recs = [];

    // ── Source 1: chandelier trail (ATR-based) ──────────────────────────
    // Preferred path: trail = price ∓ (trail_atr_mult × entry_atr). This
    // is the chandelier exit Minervini/Le Beau use — distance scales with
    // the stock's volatility instead of an arbitrary 8% flat. With
    // entry_atr fixed and trail_atr_mult tightened by deterioration
    // signals (see position-deterioration.js), the trail compresses by
    // shrinking the multiplier (2.5 → 1.5 → 1.0) rather than by halving
    // a percentage.
    //
    // Legacy fallback: rows that pre-date the entry_atr capture (or
    // symbols without an rs_snapshot at entry time) still use the flat
    // trail_pct × current_price path so existing positions don't lose
    // their trail.
    if (price) {
      const useAtr = trade.entry_atr > 0 && (trade.trail_atr_mult ?? 0) > 0;
      let trail = null, label = null;
      if (useAtr) {
        const dist = trade.trail_atr_mult * trade.entry_atr;
        trail = isShort ? +(price + dist).toFixed(2) : +(price - dist).toFixed(2);
        label = `chandelier ${trade.trail_atr_mult}× ATR ($${trade.entry_atr.toFixed(2)}) from $${price.toFixed(2)}`;
      } else if (trade.trail_pct > 0) {
        trail = isShort ? +(price * (1 + trade.trail_pct)).toFixed(2)
                        : +(price * (1 - trade.trail_pct)).toFixed(2);
        label = `trail ${(trade.trail_pct*100).toFixed(0)}% from $${price.toFixed(2)} (legacy — no entry_atr)`;
      }
      if (trail != null) {
        const tightens = isShort ? trail < cur : trail > cur;
        if (tightens) recs.push({ source: 'trail', recommendedStop: trail, reason: label });
      }
    }

    // ── Source 2: regime-tier ramp downshift floor ──────────────────────
    // When exposure ramp is in REDUCED / HALF tier, hold-through-noise
    // tolerance shrinks. Move stop to entry × (1 − tier_pct) where
    // FULL=8%, THREE_QUARTER=6%, HALF=4%, REDUCED=3%, PILOT=2%.
    const tier = marketState.regime?.exposureRamp?.exposureLevel;
    const TIER_TOL = { FULL: 0.08, THREE_QUARTER: 0.06, HALF: 0.04, REDUCED: 0.03, PILOT: 0.02 };
    const tol = tier && TIER_TOL[tier];
    if (tol && trade.entry_price) {
      const tierStop = isShort ? +(trade.entry_price * (1 + tol)).toFixed(2)
                               : +(trade.entry_price * (1 - tol)).toFixed(2);
      const tightens = isShort ? tierStop < cur : tierStop > cur;
      if (tightens) recs.push({ source: 'tier', recommendedStop: tierStop, reason: `${tier} tier — ${(tol*100).toFixed(0)}% from entry` });
    }

    // ── Source 3: breadth-warning tighten (CAUTION/WARNING/CRITICAL) ────
    const bwLevel = marketState.breadthWarning?.level || 0;
    if (bwLevel >= 2 && trade.entry_price) {
      // Same tightness curve as breadth-warning.computeStopAdjustments.
      // Both reads now use the same numbers so the user sees one stop
      // adjusted once — not two competing ones.
      const tighten = bwLevel === 3 ? 0.025 : 0.04;  // CRITICAL=2.5%, WARNING=4%
      const bwStop = isShort ? +(trade.entry_price * (1 + tighten)).toFixed(2)
                             : +(trade.entry_price * (1 - tighten)).toFixed(2);
      const tightens = isShort ? bwStop < cur : bwStop > cur;
      if (tightens) recs.push({ source: 'breadth', recommendedStop: bwStop, reason: `breadth ${marketState.breadthWarning.label} — ${(tighten*100).toFixed(1)}% from entry` });
    }

    // No recommendations? skip (no change).
    if (!recs.length) { skipped.push({ tradeId: trade.id, symbol: trade.symbol, reason: 'no signal' }); continue; }

    // Compose: pick the TIGHTEST. For long that's MAX; for short MIN.
    const tightest = recs.reduce((best, r) => {
      if (best == null) return r;
      const better = isShort ? r.recommendedStop < best.recommendedStop
                             : r.recommendedStop > best.recommendedStop;
      return better ? r : best;
    }, null);

    plans.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      currentStop: cur,
      recommendedStop: tightest.recommendedStop,
      reasons: recs.map(r => r.reason),
      sources: recs.map(r => r.source),
      winner: tightest.source,
    });
  }

  return { plans, skipped, asOf: new Date().toISOString() };
}

// ─── Apply: write journal AND patch broker (single execution path) ────────
async function applyStopAdjustments(plans) {
  if (!plans?.length) return { applied: 0, brokerPatched: 0, brokerFailed: 0 };
  const updateStmt = db().prepare(
    'UPDATE trades SET stop_price = ?, trail_tightened_at = datetime(\'now\'), trail_tightened_reason = ? WHERE id = ?'
  );
  let applied = 0;
  for (const p of plans) {
    updateStmt.run(p.recommendedStop, p.reasons.join(' | '), p.tradeId);
    applied++;
  }
  // After the journal updates, hand off to stops-sync for the broker
  // patch. That module is the single place that talks to Alpaca for
  // stops — it handles every quirk we hit (held-leg PATCH 404, 422-when-
  // breached, pending_cancel polling, dedupe). 11 tests pin its
  // contract; rebuilding that here would just duplicate (and re-bug)
  // those code paths.
  let brokerResult = { plans: [] };
  try {
    const { syncJournalStopsToBroker } = require('../broker/stops-sync');
    brokerResult = await syncJournalStopsToBroker();
  } catch (e) {
    return { applied, brokerError: e.message };
  }
  const brokerPatched = brokerResult.plans?.filter(p => p.patched).length || 0;
  const brokerFailed  = brokerResult.plans?.filter(p => p.patchFailed || p.createError).length || 0;
  return { applied, brokerPatched, brokerFailed, brokerDetail: brokerResult.plans };
}

module.exports = { evaluateAllOpenStops, applyStopAdjustments };
