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

// ─── Weekly review with behavioral pattern detection ────────────────────
//
// Pre-fix the "Friday review" was manual — the user would scroll through
// 5 days of Yesterday-tab data eyeballing patterns. That's the kind of
// chore that doesn't get done. This function does the eyeballing
// algorithmically and surfaces the meaningful patterns as one-line
// callouts the user can act on.
//
// What we detect (each is an independent module so additions are easy):
//   - skip-reason clustering (keyword themes in user-written reasons)
//   - day-of-week adherence variance (Wednesday slump, etc.)
//   - sector skew (overcorrelated skips/submits in one sector)
//   - conviction-bucket outcomes (was your skip rate calibrated?)
//   - tier-1 conversion funnel (candidates → submitted → filled)
//   - missed-winners rollup (skipped names that ran)
//
// `liveByTicker` is optional — passed by the route from the latest
// scanner cache so we can compute current-vs-decision price moves.

function getWeeklyReview(liveByTicker = null, { lookbackDays = 7 } = {}) {
  const today = _today();
  const cutoff = new Date(Date.now() - lookbackDays * 86400_000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const db = getDB();

  // Pull the week's decisions WITH live decoration
  const rows = db.prepare(`
    SELECT date, symbol, decision, conviction_at_decision, price_at_decision,
           pivot_price, decided_at, thesis, skip_reason, tier
    FROM daily_decisions
    WHERE date >= ? AND date <= ?
    ORDER BY date DESC, symbol ASC
  `).all(cutoff, today);

  if (!rows.length) {
    return { window: { from: cutoff, to: today }, sampleSize: 0, patterns: [], summary: null, items: [] };
  }

  // Decorate with current price + move
  const items = rows.map(r => {
    const live = liveByTicker?.get?.(r.symbol);
    const currentPrice = live?.price ?? null;
    const moveSinceDecision = (currentPrice && r.price_at_decision)
      ? +(((currentPrice - r.price_at_decision) / r.price_at_decision) * 100).toFixed(2)
      : null;
    return {
      date: r.date,
      symbol: r.symbol,
      decision: r.decision,
      convictionAtDecision: r.conviction_at_decision,
      priceAtDecision: r.price_at_decision,
      currentPrice,
      moveSinceDecisionPct: moveSinceDecision,
      decidedAt: r.decided_at,
      thesis: r.thesis,
      skipReason: r.skip_reason,
      sector: live?.sector,
      rsRank: live?.rsRank,
    };
  });

  // ── Aggregate summary ────────────────────────────────────────────────
  const total = items.length;
  const submitted = items.filter(i => i.decision === 'submit').length;
  const waited    = items.filter(i => i.decision === 'wait').length;
  const skipped   = items.filter(i => i.decision === 'skip').length;
  const autoSkipped = items.filter(i => i.decision === 'auto_skip').length;
  const decided   = submitted + waited + skipped;
  const adherenceRate = total > 0 ? +(decided / total * 100).toFixed(1) : null;

  // ── Pattern detection — each function returns a callout or null ────
  const patterns = [];

  // Pattern A: skip-reason clustering. Group user-written reasons by
  // keyword themes. Threshold: 2+ skips citing same theme.
  const SKIP_THEMES = [
    { theme: 'extended', kw: /extend|stretched|too high|above pivot/i },
    { theme: 'earnings', kw: /earnings|er |report|print/i },
    { theme: 'low volume', kw: /low vol|thin|illiquid/i },
    { theme: 'gap', kw: /gap|opened up|opened above/i },
    { theme: 'sector concern', kw: /sector|rotation|weak sector/i },
    { theme: 'risk-off', kw: /risk|volatil|cautious|wait/i },
    { theme: 'pattern doubt', kw: /pattern|chart|setup unclear/i },
  ];
  const allSkips = items.filter(i => i.decision === 'skip' || i.decision === 'auto_skip');
  const themeCounts = {};
  for (const s of allSkips) {
    if (!s.skipReason) continue;
    for (const t of SKIP_THEMES) {
      if (t.kw.test(s.skipReason)) {
        themeCounts[t.theme] = themeCounts[t.theme] || { count: 0, ranAfter: 0, names: [] };
        themeCounts[t.theme].count++;
        themeCounts[t.theme].names.push(s.symbol);
        if (s.moveSinceDecisionPct != null && s.moveSinceDecisionPct > 2) {
          themeCounts[t.theme].ranAfter++;
        }
      }
    }
  }
  for (const [theme, c] of Object.entries(themeCounts)) {
    if (c.count >= 2) {
      const wrongRate = c.count > 0 ? Math.round(c.ranAfter / c.count * 100) : 0;
      patterns.push({
        kind: c.ranAfter > 0 ? 'warning' : 'observation',
        title: `Skip pattern: "${theme}"`,
        body: `${c.count} skips citing "${theme}" theme${c.ranAfter > 0 ? `; ${c.ranAfter} of those (${wrongRate}%) ran +2%+ since decision.` : '.'}`,
        names: c.names,
        priority: c.ranAfter * 10 + c.count,
      });
    }
  }

  // Pattern B: day-of-week adherence variance.
  const byDow = {};  // Mon=1..Fri=5
  for (const i of items) {
    const dow = new Date(i.date + 'T12:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6) continue;  // shouldn't have weekend rows but defensive
    const k = dow;
    byDow[k] = byDow[k] || { total: 0, decided: 0 };
    byDow[k].total++;
    if (['submit','wait','skip'].includes(i.decision)) byDow[k].decided++;
  }
  const dowRates = Object.entries(byDow)
    .map(([d, v]) => ({ dow: +d, rate: v.total > 0 ? v.decided / v.total * 100 : 0, total: v.total }))
    .filter(r => r.total >= 2);
  if (dowRates.length >= 3) {
    const avgRate = dowRates.reduce((a, r) => a + r.rate, 0) / dowRates.length;
    const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    for (const r of dowRates) {
      if (r.rate < avgRate - 20) {
        patterns.push({
          kind: 'warning',
          title: `${dayName[r.dow]} adherence slump`,
          body: `Your ${dayName[r.dow]} adherence is ${Math.round(r.rate)}% vs ${Math.round(avgRate)}% average across other days. Consider scheduling decisions earlier on ${dayName[r.dow]}s.`,
          priority: 50,
        });
      }
    }
  }

  // Pattern C: sector skew in skips. If a single sector accounts for
  // >50% of skips AND that sector is high-conviction in current rsData
  // (live decoration check), flag it.
  if (liveByTicker && allSkips.length >= 4) {
    const skipSectorCount = {};
    for (const s of allSkips) {
      if (!s.sector) continue;
      skipSectorCount[s.sector] = (skipSectorCount[s.sector] || 0) + 1;
    }
    const dominantSector = Object.entries(skipSectorCount)
      .sort((a, b) => b[1] - a[1])[0];
    if (dominantSector && (dominantSector[1] / allSkips.length) >= 0.5) {
      patterns.push({
        kind: 'observation',
        title: `Skip skew: ${dominantSector[0]}`,
        body: `${dominantSector[1]} of ${allSkips.length} (${Math.round(dominantSector[1]/allSkips.length*100)}%) skips this week were in ${dominantSector[0]}. If that sector is leading the rotation, you may be unconsciously avoiding the leaders.`,
        priority: 30,
      });
    }
  }

  // Pattern D: conviction-bucket outcomes. Check if you've been mis-
  // calibrated on high-conviction skips (≥70 conv that ran).
  const highConvSkips = allSkips.filter(s => (s.convictionAtDecision || 0) >= 70 && s.moveSinceDecisionPct != null && s.moveSinceDecisionPct > 2);
  if (highConvSkips.length >= 2) {
    const avgMove = highConvSkips.reduce((a, s) => a + s.moveSinceDecisionPct, 0) / highConvSkips.length;
    patterns.push({
      kind: 'warning',
      title: 'High-conviction skips ran',
      body: `${highConvSkips.length} skips with conviction ≥70 ran +${avgMove.toFixed(1)}% on average. The system flagged these as quality setups; reconsider what "skip" criteria override conviction.`,
      names: highConvSkips.map(s => s.symbol),
      priority: 80,
    });
  }

  // Pattern E: missed-winners rollup (skipped that ran +2%+)
  const missedWinners = items.filter(i =>
    (i.decision === 'skip' || i.decision === 'auto_skip')
    && i.moveSinceDecisionPct != null && i.moveSinceDecisionPct > 2
  ).sort((a, b) => b.moveSinceDecisionPct - a.moveSinceDecisionPct);
  // Don't add as a pattern — already surfaced as a separate panel in the UI.

  // Pattern F: good skips (validation of discipline)
  const skippedLosers = items.filter(i =>
    (i.decision === 'skip' || i.decision === 'auto_skip')
    && i.moveSinceDecisionPct != null && i.moveSinceDecisionPct < -2
  ).sort((a, b) => a.moveSinceDecisionPct - b.moveSinceDecisionPct);

  // Sort patterns by priority desc — highest-impact at top
  patterns.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  return {
    window: { from: cutoff, to: today },
    sampleSize: total,
    summary: {
      total, submitted, waited, skipped, autoSkipped, decided, adherenceRate,
    },
    patterns,
    missedWinners,
    skippedLosers,
    items,
  };
}

// 30-day rolling adherence baseline.
//
// Pre-fix the DailyPlanTab badge used opinion-coded thresholds (≥95% green,
// ≥70% amber). They had no empirical basis — pure Claude-as-judge.
// The honest version is to score TODAY relative to YOUR rolling baseline:
//   "you're +6 points over your 30-day average" or "−12 below average."
// This way every user finds their own equilibrium and improvement is
// measured as a delta, not against an external standard.
//
// Returns { sampleDays, baselineRate, last7Rate } where:
//   sampleDays   — how many distinct days have ≥1 decision (0 = no history)
//   baselineRate — adherence rate over those days (decided ÷ total)
//   last7Rate    — same metric over the last 7 distinct decision-days
function getAdherenceBaseline({ days = 30 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400_000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const today = _today();
  const db = getDB();

  // Per-day adherence — exclude today (still in flight) and any future-dated rows.
  const rows = db.prepare(`
    SELECT date,
           SUM(CASE WHEN decision IN ('submit','wait','skip') THEN 1 ELSE 0 END) AS decided,
           COUNT(*) AS total
    FROM daily_decisions
    WHERE date >= ? AND date < ?
    GROUP BY date
    ORDER BY date DESC
  `).all(cutoff, today);

  if (!rows.length) return { sampleDays: 0, baselineRate: null, last7Rate: null };

  const totalDecided = rows.reduce((a, r) => a + r.decided, 0);
  const totalDue     = rows.reduce((a, r) => a + r.total, 0);
  const baselineRate = totalDue > 0 ? +(totalDecided / totalDue * 100).toFixed(1) : null;

  // Last 7 distinct decision-days (not 7 calendar days — handles weekends).
  const last7 = rows.slice(0, 7);
  const last7Decided = last7.reduce((a, r) => a + r.decided, 0);
  const last7Total   = last7.reduce((a, r) => a + r.total, 0);
  const last7Rate    = last7Total > 0 ? +(last7Decided / last7Total * 100).toFixed(1) : null;

  return {
    sampleDays: rows.length,
    baselineRate,
    last7Rate,
  };
}

module.exports = {
  ensureTodayPlan,
  recordDecision,
  autoSkipExpiredPending,
  getTodayPlan,
  getYesterdaysOutcomes,
  getAdherenceBaseline,
  getWeeklyReview,
  // Exposed for cron + tests
  _today,
  _yesterday,
  _isPastCutoff,
};
