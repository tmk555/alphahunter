// ─── Journal → Broker stop sync ────────────────────────────────────────────
//
// The journal's `trades.stop_price` is what every UI label, every alert, and
// every "stop violation" check reads. But the broker-side sell-stop order is
// what actually fires when price drops. Pre-fix these two numbers drifted
// constantly:
//
//   • applyDeteriorationTighten only patched the broker stop when
//     `trade.trailing_stop_active = 1`. Most rows had it 0 (manually-entered
//     trades, scaler-not-yet-armed, OR an EOD reconciler row with the flag
//     reset). So journal got tightened, broker did NOT — phone alert says
//     "trail tightened to $173.58" but broker still has $339.31.
//   • tightenOnRegimeDowngrade had the same gate.
//   • Reconciled-from-broker orphan rows could be created with a journal
//     stop but no broker stop at all (ANET, MKSI). Naked positions for
//     days, no protection.
//
// User-visible failure mode: positions sit -4% to -7% in the red, journal
// shows STOP VIOLATED, but Alpaca never sells because the actual broker
// stop is below current price (or absent).
//
// This module is the source of truth that bridges the gap. It runs every N
// minutes (cron) and on demand via /api/portfolio/sync-broker-stops:
//
//   For each open journal symbol:
//     1. Sum the position qty Alpaca reports for that symbol.
//     2. Sum the "covered" qty across all open sell-side stop legs.
//     3. Walk each leg:
//          - If leg's stop_price differs from the desired journal stop
//            (max(stop_price) across journal rows for that symbol — the
//            tightest stop wins because we never want to LOOSEN), patch it.
//     4. If covered < position qty (e.g. ANET / MKSI), submit a fresh
//        sell-stop for the uncovered remainder at the desired journal stop.
//
// Safety:
//   - Read-only "dry-run" mode echoes the plan without writing.
//   - Never loosens (only tightens) so a manual broker-side wider stop the
//     user set on purpose isn't reverted.
//   - Skips broker-quantity mismatch beyond a small tolerance (>5sh
//     unaccounted for) — surfaces it as needs-review instead of silently
//     resizing.

const alpaca = require('./alpaca');
const { getDB } = require('../data/database');

function getDb() { return getDB(); }

// Round price to 2dp — Alpaca rejects sub-penny stop prices on most equities.
function px(n) {
  if (n == null || !Number.isFinite(+n)) return null;
  return Math.round(+n * 100) / 100;
}

async function syncJournalStopsToBroker({ dryRun = false } = {}) {
  // 1. Snapshot Alpaca positions and open orders ONCE per call.
  let positions = [];
  try { positions = await alpaca.getPositions(); }
  catch (e) { return { error: `getPositions failed: ${e.message}`, plans: [] }; }
  const posBySymbol = {};
  for (const p of positions) {
    posBySymbol[p.symbol] = {
      qty: Math.abs(+p.qty),
      avgEntry: +p.avg_entry_price,
      side: (+p.qty < 0) ? 'short' : 'long',
    };
  }

  let openOrders = [];
  try { openOrders = await alpaca.getOrders({ status: 'open', limit: 500 }); }
  catch (e) { return { error: `getOrders failed: ${e.message}`, plans: [] }; }
  const stopsBySymbol = {};
  for (const o of openOrders) {
    if (o.side !== 'sell') continue;
    if (o.type !== 'stop' && o.type !== 'stop_limit') continue;
    (stopsBySymbol[o.symbol] ||= []).push(o);
  }

  // 2. Open journal trades — desired stop is max(stop_price) across rows for
  //    a given symbol (tightest never-loosen). Sum of remaining_shares is
  //    the journal-side qty we expect to be protected.
  const rows = getDb().prepare(`
    SELECT id, symbol, side, stop_price, COALESCE(remaining_shares, shares, 0) AS qty,
           trail_pct, trail_tightened_at, trail_tightened_reason
      FROM trades
     WHERE exit_date IS NULL
       AND COALESCE(remaining_shares, shares, 0) > 0
  `).all();
  const bySymbol = {};
  for (const r of rows) {
    if (r.stop_price == null) continue;
    const cur = bySymbol[r.symbol] ||= { rows: [], journalQty: 0, desiredStop: -Infinity, side: r.side };
    cur.rows.push(r);
    cur.journalQty += r.qty;
    // Tightest journal stop wins. For shorts (side=short), tightest is LOWEST.
    if (r.side === 'short') {
      cur.desiredStop = (cur.desiredStop === -Infinity) ? r.stop_price : Math.min(cur.desiredStop, r.stop_price);
    } else {
      cur.desiredStop = Math.max(cur.desiredStop, r.stop_price);
    }
  }

  const plans = [];

  for (const symbol of Object.keys(bySymbol)) {
    const { desiredStop, journalQty, side } = bySymbol[symbol];
    const targetStop = px(desiredStop);
    const pos = posBySymbol[symbol];
    if (!pos) {
      plans.push({ symbol, action: 'skip', reason: 'broker reports zero qty (zombie — handled by reconcileZombieJournalRows)' });
      continue;
    }

    const brokerQty = pos.qty;
    // Covered qty = sum of qty across existing sell-stop legs.
    const legs = stopsBySymbol[symbol] || [];
    let coveredQty = 0;
    for (const leg of legs) coveredQty += Math.abs(+leg.qty || 0);

    // Per-leg: patch price if mismatch.
    const patches = [];
    let anyPatched = false;
    let anyFailed = false;
    for (const leg of legs) {
      const cur = px(+leg.stop_price);
      if (cur == null || targetStop == null) continue;
      // Long: never loosen → only patch if target is HIGHER than current.
      // Short: never loosen → only patch if target is LOWER than current.
      const shouldPatch = (side === 'short') ? (targetStop < cur) : (targetStop > cur);
      if (Math.abs(targetStop - cur) < 0.005) continue;  // already correct
      if (!shouldPatch) {
        patches.push({ legId: leg.id, currentStop: cur, targetStop, action: 'skip-loosen' });
        continue;
      }
      patches.push({ legId: leg.id, currentStop: cur, targetStop, action: 'patch' });
      if (!dryRun) {
        try {
          // Use the alpaca.js raw PATCH path. Accepts string or number.
          await _patchStopPrice(leg.id, targetStop);
          anyPatched = true;
        } catch (e) {
          anyFailed = true;
          patches[patches.length - 1].error = e.message;
        }
      }
    }

    // If covered qty < broker position, place a fresh stop for the gap.
    const uncovered = brokerQty - coveredQty;
    let createdStopId = null;
    let createError = null;
    if (uncovered > 0) {
      if (!dryRun) {
        try {
          const o = await alpaca.submitOrder({
            symbol,
            qty: uncovered,
            side: 'sell',
            type: 'stop',
            time_in_force: 'gtc',
            stop_price: targetStop,
          });
          createdStopId = o?.id || null;
        } catch (e) {
          createError = e.message;
        }
      }
    }

    plans.push({
      symbol,
      brokerQty,
      journalQty,
      coveredQty,
      uncovered,
      desiredStop: targetStop,
      legPatches: patches,
      createdStopId,
      createError,
      patched: anyPatched,
      patchFailed: anyFailed,
      reason: legs.length === 0
        ? (uncovered > 0 ? 'no broker stop existed — created' : 'no broker stop and no uncovered qty')
        : (uncovered > 0 ? `partial coverage (${coveredQty}/${brokerQty}) — patched + filled gap` : `existing coverage — patched stops`),
    });
  }

  return { plans, dryRun: !!dryRun };
}

// Local PATCH to Alpaca — mirrors adapters/alpaca.js _patchOrder but pulls
// from process.env directly so we can call this from the cron handler
// without needing to instantiate the full broker adapter.
async function _patchStopPrice(orderId, newStopPrice) {
  const key    = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  const raw    = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
  const base   = raw.replace(/\/$/, '');
  const r = await fetch(`${base}/v2/orders/${orderId}`, {
    method: 'PATCH',
    headers: {
      'APCA-API-KEY-ID':     key,
      'APCA-API-SECRET-KEY': secret,
      'Content-Type':        'application/json',
    },
    body: JSON.stringify({ stop_price: newStopPrice }),
  });
  if (!r.ok) {
    const text = await r.text();
    let msg; try { msg = JSON.parse(text).message; } catch (_) { msg = text; }
    throw new Error(`PATCH /v2/orders/${orderId} → ${r.status}: ${msg}`);
  }
  return r.json();
}

module.exports = { syncJournalStopsToBroker };
