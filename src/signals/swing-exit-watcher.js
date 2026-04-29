// ─── Swing-day + earnings auto-exit rule ─────────────────────────────────────
//
// O'Neil/Minervini position-trading discipline: close a swing trade when
//   (a) holding days >= swingLimitDays (default 10) for swing strategies, OR
//   (b) earnings announcement is within earningsWindowDays (default 2).
//
// Earnings guard is the bigger one in practice — holding through a binary
// event is uninvestable behaviour for momentum names. Swing-limit guard
// catches trades that have overstayed their thesis: momentum_swing is built
// around a ~5-10 day runup; anything still open past day 10 without a clean
// scale-out progression is usually dead money or a thesis shift.
//
// Strategies subject to the swing-limit rule (earnings rule applies to ALL
// open positions). Extend as strategies are added.
const SWING_STRATEGIES = new Set([
  'momentum_swing', 'rs_momentum', 'swing', 'vcp_breakout',
]);

// Core logic is plan-first so the scheduler can run in dry-run mode without
// submitting broker orders. The caller decides whether to actually flatten.
//
// Options:
//   swingLimitDays      holding-day cutoff for SWING_STRATEGIES (default 10)
//   earningsWindowDays  earnings-distance cutoff — ALL strategies (default 2)
//   dryRun              plan only, don't submit orders (default false)
//   today               override "today" for testability (default UTC today)
async function evaluateSwingExits({
  swingLimitDays = 10,
  earningsWindowDays = 2,
  dryRun = false,
  today = null,
} = {}) {
  const { getDB } = require('../data/database');
  const { yahooChartEvents } = require('../data/providers/yahoo');
  const db = getDB();

  const todayStr = today || new Date().toISOString().slice(0, 10);
  const todayMs = new Date(todayStr + 'T00:00:00Z').getTime();

  // Only open rows with live remaining shares.
  const openRows = db.prepare(`
    SELECT id, symbol, side, strategy, entry_date, entry_price,
           shares, initial_shares, remaining_shares
      FROM trades
     WHERE exit_date IS NULL
       AND COALESCE(remaining_shares, shares, 0) > 0
  `).all();

  const actions = [];
  for (const row of openRows) {
    // ── swing-limit check ─────────────────────────────────────────────────
    const entryMs = new Date((row.entry_date || todayStr).slice(0, 10) + 'T00:00:00Z').getTime();
    const holdingDays = Math.floor((todayMs - entryMs) / 86400000);
    const isSwing = SWING_STRATEGIES.has(String(row.strategy || '').toLowerCase());
    const hitSwingLimit = isSwing && holdingDays >= swingLimitDays;

    // ── earnings-window check ─────────────────────────────────────────────
    // yahooChartEvents is cached 6h so calling it once per open symbol per
    // run is cheap — and if Yahoo is down we just skip the earnings check
    // for that symbol (swing-limit still applies).
    let earningsDate = null;
    let daysToEarnings = null;
    try {
      const evs = await yahooChartEvents(row.symbol);
      earningsDate = evs?.earningsDate || null;
      if (earningsDate) {
        const eMs = new Date(earningsDate + 'T00:00:00Z').getTime();
        daysToEarnings = Math.ceil((eMs - todayMs) / 86400000);
      }
    } catch (_) {}
    const hitEarnings = daysToEarnings != null
      && daysToEarnings >= 0
      && daysToEarnings <= earningsWindowDays;

    if (!hitSwingLimit && !hitEarnings) continue;

    const reasons = [];
    if (hitEarnings) reasons.push(`earnings in ${daysToEarnings}d (${earningsDate})`);
    if (hitSwingLimit) reasons.push(`${holdingDays}d held ≥ ${swingLimitDays}d swing limit`);

    // earnings > swing — earnings is non-negotiable; swing-limit is "soft" in
    // the sense that a position still scaling out on its own gets a pass.
    const level = hitEarnings ? 'earnings_exit' : 'swing_limit_exit';
    const shares = row.remaining_shares != null ? row.remaining_shares : (row.shares || 0);

    actions.push({
      tradeId: row.id,
      symbol: row.symbol,
      side: row.side,
      strategy: row.strategy,
      entryDate: row.entry_date,
      holdingDays,
      shares,
      earningsDate,
      daysToEarnings,
      level,
      reason: reasons.join('; '),
    });
  }

  if (dryRun) return { actions, executed: [], skipped: [], dryRun: true };

  // ── Live mode: submit market close orders, log partial_exit, notify ─────
  const { closePosition, getOrders, cancelOrder } = require('../broker/alpaca');
  const { notifyTradeEvent } = require('../notifications/channels');

  // Pre-fix this loop submitted closePosition straight to Alpaca and frequently
  // got back "insufficient qty available for order (requested: N, available: 0)"
  // — the qty was tied up in OPEN sell legs (bracket stops, OCO stop-limit
  // pairs, take-profit limits). Net effect: the watcher correctly identified
  // a position needing exit (e.g. TER on its earnings day) but Alpaca rejected
  // every close attempt, the trade held through the binary event, and the
  // user discovered the failure after the fact in job_history.
  //
  // The fix: enumerate open sell-side orders for the symbol and cancel them
  // first so the qty unlocks. Then submit closePosition. We pull the open
  // order list ONCE per evaluateSwingExits call and reuse it across all
  // actions to keep the API cost flat.
  let openOrdersBySymbol = {};
  try {
    const open = await getOrders({ status: 'open', limit: 500 });
    for (const o of open) {
      if (o.side !== 'sell') continue;
      (openOrdersBySymbol[o.symbol] ||= []).push(o);
      // Bracket legs are surfaced as flat top-level orders here (we pass
      // nested=false at the alpaca layer); the parent order may also have
      // an embedded `.legs` array on some endpoints — handle both shapes.
      if (Array.isArray(o.legs)) {
        for (const leg of o.legs) {
          if (leg?.side === 'sell' && leg?.symbol === o.symbol) {
            openOrdersBySymbol[o.symbol].push(leg);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`  swing-exit-watcher: getOrders failed (${e.message}) — proceeding without leg cancel`);
  }

  const executed = [];
  const skipped = [];
  for (const a of actions) {
    try {
      // Avoid duplicate close submissions: if a pending_close_order_id is
      // already set for this trade row, the user / a previous pass already
      // fired an exit — let fills-sync reconcile that, don't double-submit.
      const pending = db.prepare(
        'SELECT pending_close_order_id FROM trades WHERE id = ?'
      ).get(a.tradeId);
      if (pending?.pending_close_order_id) {
        skipped.push({ ...a, skipReason: 'pending_close_already_set' });
        continue;
      }

      // Cancel any open sell legs (stop, take-profit, OCO siblings) on this
      // symbol before submitting the market close. Without this, Alpaca holds
      // the locked qty for the existing leg and rejects our DELETE
      // /v2/positions/<symbol> with "insufficient qty available". We do this
      // only ONCE per symbol — even if multiple journal rows for the same
      // ticker are in the actions list, the first cancel pass clears the
      // legs and subsequent rows skip the (now-empty) cancel block.
      const legs = openOrdersBySymbol[a.symbol] || [];
      const cancelledLegs = [];
      const failedLegs = [];
      for (const leg of legs) {
        if (!leg?.id) continue;
        try {
          await cancelOrder(leg.id);
          cancelledLegs.push({ id: leg.id, type: leg.type, qty: leg.qty });
        } catch (e) {
          // 404 = already filled/cancelled in another pass; ignore.
          if (!/not found|already/i.test(e.message)) {
            failedLegs.push({ id: leg.id, error: e.message });
          }
        }
      }
      // Mark the symbol's leg list as drained so the next action for this
      // symbol doesn't re-issue cancels.
      delete openOrdersBySymbol[a.symbol];
      a.cancelledLegs = cancelledLegs;
      if (failedLegs.length) a.failedLegCancels = failedLegs;

      const order = await closePosition(a.symbol);
      // Stamp the pending close so the UI shows PENDING CLOSE and fills-sync
      // pins the fill back to THIS row (not pro-rata across sibling tranches).
      db.prepare(`
        UPDATE trades
           SET pending_close_order_id = ?,
               pending_close_submitted_at = datetime('now'),
               needs_review = 1,
               notes = COALESCE(notes,'') ||
                       '\n[SWING-EXIT-WATCHER] ' || ?
         WHERE id = ?
      `).run(order?.id || null, a.reason, a.tradeId);

      executed.push({ ...a, orderId: order?.id || null });

      try {
        await notifyTradeEvent({
          event: a.level,          // 'earnings_exit' | 'swing_limit_exit'
          symbol: a.symbol,
          details: {
            reason: a.reason,
            shares: a.shares,
            holdingDays: a.holdingDays,
            earningsDate: a.earningsDate,
            daysToEarnings: a.daysToEarnings,
          },
        });
      } catch (_) {}
    } catch (err) {
      skipped.push({ ...a, skipReason: err.message });
    }
  }

  return { actions, executed, skipped };
}

module.exports = { evaluateSwingExits, SWING_STRATEGIES };
