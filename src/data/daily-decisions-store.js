// ─── Daily decisions store ─────────────────────────────────────────────
//
// The action loop's commitment ledger. Every tier-1 watchlist name on a
// trading day must result in a decision row — submitted, waiting, skipped,
// or auto-skipped (10:30 AM ET cutoff hit). Adherence rate (decisions made
// vs total) is the primary process metric.
//
// Caller pattern:
//   1. ensureTodayPlan() — call on app open / Daily Plan tab mount. Reads
//      tier-1 from watchlist + creates 'pending' rows for any new names.
//   2. recordDecision(symbol, decision, opts) — user clicks SUBMIT / WAIT /
//      SKIP. Updates row to terminal state.
//   3. autoSkipExpiredPending() — called by the cutoff cron at 10:30 AM ET.
//      Flips lingering 'pending' rows to 'auto_skip'.
//   4. getTodayPlan() / getYesterdaysOutcomes() — UI read paths.

const { getDB } = require('./database');

// ET 'YYYY-MM-DD' for "today" — uses America/New_York to avoid the late-night
// UTC drift that put the trading-day boundary at 8 PM ET.
function _today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function _yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Tier-1 cap. Hard limit prevents the list from sprawling. If the user
// has more than 8 tier-1 in their watchlist (rare — the watchlist UI
// tier dropdown allows it), only the top 8 by conviction make today's plan.
const TIER1_HARD_CAP = 8;

// 10:30 AM ET cutoff. Stored as a function so testing can stub.
function _isPastCutoff() {
  // Use ET wall clock. If we're past 10:30 AM ET, decisions for today are
  // locked. Pending rows get auto-skipped on next call.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const hour   = +parts.find(p => p.type === 'hour').value;
  const minute = +parts.find(p => p.type === 'minute').value;
  return (hour > 10) || (hour === 10 && minute >= 30);
}

// Insert pending rows for any tier-1 name not yet in today's plan.
// Tier-1 source is the localStorage Watchlist — but we don't have that
// server-side. So this function takes the tier-1 names as argument
// (passed by the route from the UI's watchlist on mount).
function ensureTodayPlan(tier1Items) {
  if (!Array.isArray(tier1Items) || !tier1Items.length) return { added: 0, total: 0 };
  const date = _today();
  const db = getDB();

  // Cap to 8 by conviction (descending) — caller can pre-sort, but we
  // enforce defensively.
  const ranked = tier1Items.slice().sort((a, b) =>
    (b.convictionAtDecision || 0) - (a.convictionAtDecision || 0)
  ).slice(0, TIER1_HARD_CAP);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO daily_decisions
      (date, symbol, decision, conviction_at_decision, price_at_decision, pivot_price, thesis, tier)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction((rows) => {
    let added = 0;
    for (const r of rows) {
      const result = insert.run(
        date, r.symbol,
        r.convictionAtDecision || null,
        r.priceAtDecision || null,
        r.pivotPrice || null,
        r.thesis || null,
        r.tier || 1
      );
      if (result.changes > 0) added++;
    }
    return added;
  });

  const added = txn(ranked);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM daily_decisions WHERE date = ?`).get(date).n;
  return { added, total, date };
}

// Record a user decision. Idempotent on (date, symbol). After cutoff,
// pending → submit/wait/skip is still allowed but flagged late_decision.
function recordDecision(symbol, decision, { skipReason = null, pivotPrice = null, priceAtDecision = null } = {}) {
  if (!['submit', 'wait', 'skip'].includes(decision)) {
    throw new Error(`Invalid decision: ${decision}`);
  }
  const date = _today();
  const decidedAt = new Date().toISOString();
  const db = getDB();

  // Use UPDATE (not REPLACE) so we don't clobber the conviction snapshot
  // captured when the row was inserted as 'pending'.
  const result = db.prepare(`
    UPDATE daily_decisions
       SET decision        = ?,
           decided_at      = ?,
           skip_reason     = ?,
           pivot_price     = COALESCE(?, pivot_price),
           price_at_decision = COALESCE(?, price_at_decision)
     WHERE date = ? AND symbol = ?
  `).run(decision, decidedAt, skipReason, pivotPrice, priceAtDecision, date, symbol);

  if (result.changes === 0) {
    // Row didn't exist — caller may not have called ensureTodayPlan.
    // Insert directly so the user isn't blocked.
    db.prepare(`
      INSERT INTO daily_decisions (date, symbol, decision, decided_at, skip_reason, pivot_price, price_at_decision, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(date, symbol, decision, decidedAt, skipReason, pivotPrice, priceAtDecision);
  }
  return { date, symbol, decision, decidedAt };
}

// Cutoff handler — flips 'pending' to 'auto_skip' for any row past 10:30 AM ET.
// Returns count of rows flipped. Idempotent.
function autoSkipExpiredPending() {
  if (!_isPastCutoff()) return { flipped: 0, atCutoff: false };
  const date = _today();
  const result = getDB().prepare(`
    UPDATE daily_decisions
       SET decision  = 'auto_skip',
           decided_at = ?,
           skip_reason = '10:30 AM ET cutoff hit before decision made'
     WHERE date = ? AND decision = 'pending'
  `).run(new Date().toISOString(), date);
  return { flipped: result.changes, atCutoff: true };
}

// Fetch today's plan with current decision states, sorted by conviction desc.
// `liveByTicker` is an optional Map<symbol, scannerRow> from the caller
// (UI passes rsData) so we can include current price + insider cluster
// flags + RS rank without a re-query.
function getTodayPlan(liveByTicker = null) {
  const date = _today();
  const rows = getDB().prepare(`
    SELECT symbol, decision, conviction_at_decision, price_at_decision,
           pivot_price, decided_at, thesis, skip_reason, tier
    FROM daily_decisions
    WHERE date = ?
    ORDER BY conviction_at_decision DESC, symbol ASC
  `).all(date);

  const decorated = rows.map(r => {
    const live = liveByTicker?.get?.(r.symbol);
    const currentPrice = live?.price ?? null;
    const gapFromPivot = (currentPrice && r.pivot_price)
      ? +(((currentPrice - r.pivot_price) / r.pivot_price) * 100).toFixed(2)
      : null;
    return {
      symbol: r.symbol,
      decision: r.decision,
      convictionAtDecision: r.conviction_at_decision,
      priceAtDecision: r.price_at_decision,
      pivotPrice: r.pivot_price,
      currentPrice,
      gapFromPivotPct: gapFromPivot,
      decidedAt: r.decided_at,
      thesis: r.thesis,
      skipReason: r.skip_reason,
      tier: r.tier,
      // Live decoration (only if scanner row was provided)
      sector: live?.sector,
      rsRank: live?.rsRank,
      currentConviction: live?.convictionScore,
      insiderClusterBuy: !!live?.insiderClusterBuy,
      insiderClusterSell: !!live?.insiderClusterSell,
      vcpForming: !!live?.vcpForming,
      bestPattern: live?.bestPattern,
      daysToEarnings: live?.daysToEarnings,
    };
  });

  // Adherence summary
  const total = decorated.length;
  const decided = decorated.filter(d => ['submit', 'wait', 'skip'].includes(d.decision)).length;
  const autoSkipped = decorated.filter(d => d.decision === 'auto_skip').length;
  const pending = decorated.filter(d => d.decision === 'pending').length;
  const adherenceRate = total > 0 ? +(decided / total * 100).toFixed(1) : null;

  return {
    date,
    cutoffPassed: _isPastCutoff(),
    items: decorated,
    summary: { total, decided, pending, autoSkipped, adherenceRate },
  };
}

// Fetch yesterday's plan for the review surface. `liveByTicker` is optional.
function getYesterdaysOutcomes(liveByTicker = null) {
  const date = _yesterday();
  const rows = getDB().prepare(`
    SELECT symbol, decision, conviction_at_decision, price_at_decision,
           pivot_price, decided_at, thesis, skip_reason, tier
    FROM daily_decisions
    WHERE date = ?
    ORDER BY decision ASC, symbol ASC
  `).all(date);

  const decorated = rows.map(r => {
    const live = liveByTicker?.get?.(r.symbol);
    const currentPrice = live?.price ?? null;
    // Move-since-decision: how far has the stock moved since the user
    // made (or auto-skipped) the decision? Positive = up, negative = down.
    const moveSinceDecision = (currentPrice && r.price_at_decision)
      ? +(((currentPrice - r.price_at_decision) / r.price_at_decision) * 100).toFixed(2)
      : null;
    return {
      symbol: r.symbol,
      decision: r.decision,
      convictionAtDecision: r.conviction_at_decision,
      priceAtDecision: r.price_at_decision,
      pivotPrice: r.pivot_price,
      currentPrice,
      moveSinceDecisionPct: moveSinceDecision,
      decidedAt: r.decided_at,
      thesis: r.thesis,
      skipReason: r.skip_reason,
      tier: r.tier,
      sector: live?.sector,
      rsRank: live?.rsRank,
    };
  });

  // Behavioral score: did SKIP / AUTO_SKIP decisions miss winners?
  // If a name we skipped is up >2% the next day, that's a missed signal.
  // We surface those for the review tab to highlight.
  const skipped = decorated.filter(d =>
    (d.decision === 'skip' || d.decision === 'auto_skip')
    && d.moveSinceDecisionPct != null
  );
  const missedWinners = skipped.filter(d => d.moveSinceDecisionPct > 2);
  const skippedLosers = skipped.filter(d => d.moveSinceDecisionPct < -2);

  return {
    date,
    items: decorated,
    behavioral: {
      missedWinners,    // skipped names that ran — regret events
      skippedLosers,    // skipped names that fell — good calls
    },
  };
}

module.exports = {
  ensureTodayPlan,
  recordDecision,
  autoSkipExpiredPending,
  getTodayPlan,
  getYesterdaysOutcomes,
  // Exposed for cron + tests
  _today,
  _yesterday,
  _isPastCutoff,
};
