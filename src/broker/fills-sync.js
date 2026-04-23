// ─── Broker fills → trade journal sync ───────────────────────────────────────
// Shared implementation for /api/trades/sync (manual) and the broker_fills_sync
// scheduler job. Pulls the last 7 days of filled orders from Alpaca, inserts
// missing entries into `trades`, mirrors staged_order context, creates tax
// lots, and (the reason this lives outside the route) calls logExecution so
// slippage lands in execution_log in near-real-time.

const { getDB } = require('../data/database');
const alpaca = require('./alpaca');
const { getMarketRegime } = require('../risk/regime');
const { createTaxLot, sellTaxLots } = require('../risk/tax-engine');
const { logExecution } = require('../risk/execution-quality');
const { assignStrategy } = require('../risk/strategy-manager');

// ─── ensureBracketFields ────────────────────────────────────────────────
// Guarantee that a freshly-inserted trade row has a usable bracket
// (stop/T1/T2) and share-accounting (initial/remaining_shares) so the
// scale-out tracker participates this row when target legs fire.
//
// Strategy (first match wins):
//   1. Already set — no-op.
//   2. Sibling OPEN row for the same symbol with a bracket — copy it.
//      This is the common scale-in case: row #1 has a full bracket from
//      staged_orders, rows #2 and #3 were filled without staged entries.
//   3. Broker's live stop leg for the symbol — use its stop_price (T1/T2
//      stay NULL; not ideal but better than a fully orphaned row).
//
// initial_shares/remaining_shares are ALWAYS coalesced from shares so
// scale-out partial_exit accounting works even when no bracket is found.
//
// Called by:
//   • syncBrokerFills() after the staged_orders backfill
//   • reconcileOrphanPositions() after the position-centric INSERT
function ensureBracketFields(db, alpacaOrderId, symbol, opts = {}) {
  const row = db.prepare(
    'SELECT id, stop_price, target1, target2, initial_shares, remaining_shares, shares, strategy, exit_strategy FROM trades WHERE alpaca_order_id = ?'
  ).get(alpacaOrderId);
  if (!row) return;

  const needsBracket = row.stop_price == null || row.target1 == null;

  if (needsBracket) {
    // Look for a sibling open row with a usable bracket.
    const sibling = db.prepare(
      `SELECT stop_price, target1, target2, strategy, exit_strategy
         FROM trades
        WHERE symbol = ? AND id != ? AND exit_date IS NULL
          AND stop_price IS NOT NULL AND target1 IS NOT NULL
        ORDER BY entry_date DESC
        LIMIT 1`
    ).get(symbol, row.id);

    if (sibling) {
      db.prepare(
        `UPDATE trades SET
           stop_price    = COALESCE(stop_price, ?),
           target1       = COALESCE(target1, ?),
           target2       = COALESCE(target2, ?),
           strategy      = COALESCE(strategy, ?),
           exit_strategy = COALESCE(exit_strategy, ?)
         WHERE id = ?`
      ).run(sibling.stop_price, sibling.target1, sibling.target2,
            sibling.strategy, sibling.exit_strategy || 'full_in_scale_out', row.id);
    } else if (opts.brokerStop != null) {
      // Last resort: whatever live stop leg the broker has on this symbol.
      // T1/T2 remain NULL — the row will be flagged needs_review=1 already.
      db.prepare('UPDATE trades SET stop_price = COALESCE(stop_price, ?) WHERE id = ?')
        .run(opts.brokerStop, row.id);
    }
  }

  // Always lock in share accounting.
  db.prepare(
    `UPDATE trades SET
       initial_shares   = COALESCE(initial_shares, shares),
       remaining_shares = COALESCE(remaining_shares, shares)
     WHERE id = ?`
  ).run(row.id);
}

async function syncBrokerFills() {
  const db = getDB();

  const since  = new Date(Date.now() - 7 * 86400000).toISOString();
  const orders = await alpaca.getOrders({ status: 'closed', limit: 100, after: since });
  const filled = orders.filter(o => o.status === 'filled' && o.side === 'buy');

  // Dedupe strictly on alpaca_order_id — the old symbol:date guard blocked
  // subsequent pyramid tranches on the same day from ever being synced.
  const existing     = db.prepare('SELECT alpaca_order_id FROM trades WHERE alpaca_order_id IS NOT NULL').all();
  const existingIds  = new Set(existing.map(t => t.alpaca_order_id));

  // Backfill sector on older auto-synced trades that predated sector capture.
  const backfilled = db.prepare(`
    UPDATE trades
       SET sector = (SELECT u.sector FROM universe_mgmt u WHERE u.symbol = trades.symbol)
     WHERE sector IS NULL
       AND symbol IN (SELECT symbol FROM universe_mgmt)
  `).run().changes;

  const todayStr     = new Date().toISOString().split('T')[0];
  const synced       = [];
  const stmt         = db.prepare(`
    INSERT INTO trades (symbol, side, entry_date, entry_price, shares, sector, alpaca_order_id, needs_review, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const sectorLookup = db.prepare('SELECT sector FROM universe_mgmt WHERE symbol = ?');

  for (const order of filled) {
    if (existingIds.has(order.id)) continue;
    let fillDate = (order.filled_at || order.created_at).split('T')[0];
    if (fillDate > todayStr) fillDate = todayStr;          // clamp UTC-offset future dates

    const staged = db.prepare(
      'SELECT stop_price, target1_price, target2_price, source, conviction_score, strategy, exit_strategy, entry_price, created_at FROM staged_orders WHERE alpaca_order_id = ?'
    ).get(order.id);

    const sector = sectorLookup.get(order.symbol)?.sector || null;

    stmt.run(
      order.symbol,
      order.side === 'buy' ? 'long' : 'short',
      fillDate,
      +order.filled_avg_price,
      +order.filled_qty,
      sector,
      order.id,
      `[AUTO-SYNCED] Filled at $${(+order.filled_avg_price).toFixed(2)} via ${staged?.source || 'broker'}. Add your trade thesis and setup notes.`,
    );

    if (staged) {
      db.prepare('UPDATE trades SET stop_price=?, target1=?, target2=?, strategy=?, exit_strategy=?, was_system_signal=1 WHERE alpaca_order_id=?')
        .run(staged.stop_price, staged.target1_price, staged.target2_price, staged.strategy || null, staged.exit_strategy || 'full_in_scale_out', order.id);
    }

    // ─── Bracket backfill for scale-in tranches ─────────────────────────
    // When the 2nd/3rd pyramid tranche lacks a staged_orders row (e.g. filled
    // outside this app, or the staged row was pruned), the INSERT above
    // leaves stop_price / target1 / target2 NULL. The scale-out tracker
    // then IGNORES this row at T1/T2 time, so when a broker sell fires
    // proportionally across tranches, this row's slice is never recorded —
    // journal silently drifts from broker.
    //
    // Fix: if we still have NULL bracket fields after the staged step, copy
    // them from a sibling OPEN row for the same symbol. Falls back to the
    // live broker stop leg as a last resort. Always populate
    // initial_shares/remaining_shares from shares so scale-out accounting
    // works even in the no-bracket case.
    ensureBracketFields(db, order.id, order.symbol);

    let snapData = null;
    try {
      const snap = db.prepare(`
        SELECT rs_rank, sepa_score, swing_momentum FROM rs_snapshots
        WHERE symbol = ? AND date <= ? AND type = 'stock' ORDER BY date DESC LIMIT 1
      `).get(order.symbol, fillDate);
      if (snap) {
        snapData = snap;
        db.prepare('UPDATE trades SET entry_rs=?, entry_sepa=? WHERE alpaca_order_id=? AND entry_rs IS NULL')
          .run(snap.rs_rank, snap.sepa_score, order.id);
      }
      const regime = getMarketRegime();
      if (regime?.regime) {
        db.prepare('UPDATE trades SET regime_at_entry=? WHERE alpaca_order_id=? AND regime_at_entry IS NULL')
          .run(regime.regime, order.id);
      }
    } catch (_) {}

    if (!staged?.strategy) {
      try {
        const scanRow  = db.prepare(`SELECT data FROM scan_results WHERE symbol = ? ORDER BY date DESC LIMIT 1`).get(order.symbol);
        const scanData = scanRow ? JSON.parse(scanRow.data) : {};
        const assigned = assignStrategy({
          symbol: order.symbol,
          rsRank: snapData?.rs_rank || scanData.rsRank || 0,
          swingMomentum: snapData?.swing_momentum || scanData.swingMomentum || 0,
          vcpForming: scanData.vcpForming || false,
          patternDetected: scanData.bestPattern || false,
        });
        db.prepare('UPDATE trades SET strategy=? WHERE alpaca_order_id=? AND strategy IS NULL')
          .run(assigned.strategy, order.id);
        console.log(`  Strategy auto-assigned: ${order.symbol} → ${assigned.strategy} (${assigned.confidence}%)`);
      } catch (_) {}
    }

    const lastTradeId = db.prepare('SELECT id FROM trades WHERE alpaca_order_id = ?').get(order.id)?.id;

    if (lastTradeId) {
      try {
        createTaxLot({
          tradeId: lastTradeId,
          symbol: order.symbol,
          shares: +order.filled_qty,
          costBasis: +order.filled_avg_price,
          acquiredDate: fillDate,
        });
      } catch (_) {}
    }

    // Slippage capture. intended_price = staged limit, else staged entry_price,
    // else fill price (0 slippage when we can't tell).
    if (lastTradeId) {
      try {
        const signalDate  = staged?.created_at?.split('T')[0] || fillDate;
        const buyIntended = order.limit_price != null ? +order.limit_price
          : staged?.entry_price ? +staged.entry_price
          : +order.filled_avg_price;
        logExecution({
          tradeId: lastTradeId,
          symbol: order.symbol,
          side: 'buy',
          intendedPrice: buyIntended,
          fillPrice: +order.filled_avg_price,
          shares: +order.filled_qty,
          orderType: order.type || 'market',
          signalDate,
          orderDate: (order.submitted_at || order.created_at)?.split('T')[0],
          fillDate,
        });
      } catch (_) {}
    }

    synced.push({ symbol: order.symbol, price: +order.filled_avg_price, qty: +order.filled_qty, date: fillDate });
  }

  // Sells → auto-exit journal entries.
  //
  // Match priority:
  //   1. Exact match on trades.pending_close_order_id — when the user submitted
  //      a LIMIT sell via /broker/close-position, that column pins the fill to
  //      the specific lot. Matters for multi-tranche positions where several
  //      open trade rows share a symbol and the "most recent" heuristic would
  //      close the wrong one.
  //   2. Fallback: most-recent-entry open long row for the symbol (legacy path
  //      for sells that originated outside this app — e.g. bracket TP legs,
  //      or manual Alpaca-UI sells).
  //
  // After a pending-close fill is reconciled we null out the pending_close_*
  // columns so the row no longer renders the PENDING CLOSE pill, and the exit
  // reason is tagged 'manual_exit_fill' instead of the generic 'auto_sync'.
  const sells  = orders.filter(o => o.status === 'filled' && o.side === 'sell');
  const exited = [];

  // Pre-load the set of sell order ids already reconciled into the journal.
  // THIS IS THE IDEMPOTENCY KEY. Without it, every call re-applied every sell
  // in the 7-day window, and since orphan-reconcile kept creating fresh open
  // rows for lingering Alpaca positions, the same real sell kept "closing"
  // new ghost rows each pass (DELL had 6 ghosts before this was added).
  const seenExitIds = new Set(
    db.prepare('SELECT exit_order_id FROM trades WHERE exit_order_id IS NOT NULL').all()
      .map(r => r.exit_order_id)
  );

  for (const sell of sells) {
    // 0. Hard idempotency: this sell already closed a row in a prior sync.
    if (seenExitIds.has(sell.id)) continue;

    // 1. Prefer the row that explicitly submitted this sell (pending_close
    //    path — user clicked Exit with a limit price). Pins to the exact lot.
    const pendingTrade = db.prepare(
      'SELECT * FROM trades WHERE pending_close_order_id = ? AND exit_date IS NULL LIMIT 1'
    ).get(sell.id);

    let exitDate = (sell.filled_at || sell.created_at).split('T')[0];
    if (exitDate > todayStr) exitDate = todayStr;
    const exitPrice = +sell.filled_avg_price;
    const sellQty   = +sell.filled_qty;
    const orderDate = (sell.submitted_at || sell.created_at)?.split('T')[0];

    // ── PATH A: pending_close pinned to a specific lot ──────────────────
    if (pendingTrade) {
      const trade       = pendingTrade;
      const pnl_dollars = (exitPrice - trade.entry_price) * (trade.shares || 0);
      const pnl_percent = +((exitPrice / trade.entry_price - 1) * 100).toFixed(2);
      const risk        = trade.entry_price - (trade.stop_price || trade.entry_price * 0.95);
      const r_multiple  = risk > 0 ? +((exitPrice - trade.entry_price) / risk).toFixed(2) : 0;
      const noteSuffix  = `\n[PENDING-CLOSE FILLED] Limit sell order ${sell.id} filled at $${exitPrice.toFixed(2)}.`;

      db.prepare(`
        UPDATE trades SET exit_date=?, exit_price=?, exit_reason='manual_exit_fill',
          pnl_dollars=?, pnl_percent=?, r_multiple=?, needs_review=1,
          exit_order_id=?,
          pending_close_order_id=NULL, pending_close_submitted_at=NULL,
          notes=COALESCE(notes,'') || ? WHERE id=?
      `).run(exitDate, exitPrice, pnl_dollars, pnl_percent, r_multiple,
        sell.id, noteSuffix, trade.id);

      seenExitIds.add(sell.id);
      try { sellTaxLots({ symbol: sell.symbol, shares: trade.shares || sellQty, salePrice: exitPrice, saleDate: exitDate, method: 'fifo' }); } catch (_) {}
      try { logExecution({ tradeId: trade.id, symbol: sell.symbol, side: 'sell', intendedPrice: trade.target1 || exitPrice, fillPrice: exitPrice, shares: sellQty || trade.shares, orderType: sell.type || 'market', signalDate: exitDate, orderDate, fillDate: exitDate }); } catch (_) {}
      exited.push({ symbol: sell.symbol, exitPrice, pnl_percent, source: 'pending_close_fill' });
      continue;
    }

    // ── PATH B: fallback — pro-rate across all open rows ────────────────
    //
    // The old code closed the oldest open row wholesale with the full sell
    // qty. For multi-tranche positions that's badly wrong: a 9-share sell
    // on 3 open 9-share lots belongs 3/3/3, not 9/0/0. Symptom: the oldest
    // row showed as "closed" in the UI while Alpaca still held the position
    // (the ghost-close that bit DELL #23 on 2026-04-22).
    //
    // Fix: allocate sellQty across open rows proportional to remaining_shares
    // (floor + remainder-to-last), append a partial_exit to each row, and
    // close only rows whose remaining_shares reaches 0.
    const openRows = db.prepare(
      'SELECT * FROM trades WHERE symbol = ? AND exit_date IS NULL AND side = ? ORDER BY entry_date ASC, id ASC'
    ).all(sell.symbol, 'long');
    if (!openRows.length) continue;

    const totalRem = openRows.reduce((s, r) => s + (r.remaining_shares != null ? r.remaining_shares : (r.shares || 0)), 0);
    if (totalRem <= 0) continue;

    // Proportional allocation. Floor per row, remainder goes to the last row
    // so the allocation sums exactly to sellQty.
    const allocs = openRows.map(r => {
      const rem = r.remaining_shares != null ? r.remaining_shares : (r.shares || 0);
      return { row: r, rem, alloc: Math.floor(rem / totalRem * sellQty) };
    });
    const allocSum = allocs.reduce((s, a) => s + a.alloc, 0);
    if (allocSum < sellQty && allocs.length) {
      allocs[allocs.length - 1].alloc += (sellQty - allocSum);
    }

    const isProrata = allocs.filter(a => a.alloc > 0).length > 1;
    const reason    = isProrata ? 'auto_sync_prorata' : 'auto_sync';

    let rowsTouched = 0;
    for (const { row, rem, alloc } of allocs) {
      if (alloc <= 0) continue;
      const actualAlloc = Math.min(alloc, rem);  // defensive clamp
      const newRem      = rem - actualAlloc;
      const existing    = row.partial_exits ? JSON.parse(row.partial_exits) : [];
      const partialPnl  = +((exitPrice - row.entry_price) * actualAlloc).toFixed(2);
      existing.push({
        level: isProrata ? 'auto_sync_prorata' : 'auto_sync',
        shares: actualAlloc, price: exitPrice, pnl: partialPnl,
        timestamp: sell.filled_at || sell.created_at, order_id: sell.id,
      });

      if (newRem <= 0) {
        // Fully closed this row.
        const pnl_dollars = (exitPrice - row.entry_price) * (row.shares || 0);
        const pnl_percent = +((exitPrice / row.entry_price - 1) * 100).toFixed(2);
        const risk        = row.entry_price - (row.stop_price || row.entry_price * 0.95);
        const r_multiple  = risk > 0 ? +((exitPrice - row.entry_price) / risk).toFixed(2) : 0;
        const noteSuffix  = `\n[AUTO-EXIT${isProrata ? ' PRO-RATA' : ''}] Closed ${actualAlloc}sh @ $${exitPrice.toFixed(2)} (order ${sell.id.slice(0,8)}).`;
        db.prepare(`
          UPDATE trades SET exit_date=?, exit_price=?, exit_reason=?,
            pnl_dollars=?, pnl_percent=?, r_multiple=?, needs_review=1,
            remaining_shares=0, partial_exits=?, exit_order_id=?,
            notes=COALESCE(notes,'') || ? WHERE id=?
        `).run(exitDate, exitPrice, reason, pnl_dollars, pnl_percent, r_multiple,
          JSON.stringify(existing), sell.id, noteSuffix, row.id);
      } else {
        // Still open — append partial_exit + decrement remaining.
        const noteSuffix = `\n[AUTO-EXIT PRO-RATA] Sold ${actualAlloc}sh @ $${exitPrice.toFixed(2)} (order ${sell.id.slice(0,8)}); ${newRem}sh remain.`;
        db.prepare(`
          UPDATE trades SET remaining_shares=?, partial_exits=?, needs_review=1,
            exit_order_id=?,
            notes=COALESCE(notes,'') || ? WHERE id=?
        `).run(newRem, JSON.stringify(existing), sell.id, noteSuffix, row.id);
      }

      rowsTouched++;
      try { sellTaxLots({ symbol: sell.symbol, shares: actualAlloc, salePrice: exitPrice, saleDate: exitDate, method: 'fifo' }); } catch (_) {}
      try { logExecution({ tradeId: row.id, symbol: sell.symbol, side: 'sell', intendedPrice: row.target1 || exitPrice, fillPrice: exitPrice, shares: actualAlloc, orderType: sell.type || 'market', signalDate: exitDate, orderDate, fillDate: exitDate }); } catch (_) {}
    }

    if (rowsTouched > 0) {
      seenExitIds.add(sell.id);
      exited.push({ symbol: sell.symbol, exitPrice, qty: sellQty, rows: rowsTouched, source: reason });
    }
  }

  // ── Position-centric reconcile ──
  // The order-centric sync above only sees filled BUY orders in the last 7d.
  // Positions that predate that window — or positions whose originating order
  // was placed via the broker's own UI before this app existed — never get a
  // trades row, so they show up as "N position(s) not in journal" and their
  // risk is invisible to preTradeCheck. Run a position sweep to backfill them.
  const reconciled = await reconcileOrphanPositions({ lookbackDays: 90 });

  return { synced, exited, backfilled, reconciled };
}

// ─── Position-centric reconcile ─────────────────────────────────────────────
//
// For every open Alpaca position without a matching open trades row, create
// one. Best-effort enrichment:
//   • entry_price  ← Alpaca avg_entry_price (source of truth)
//   • shares       ← Alpaca qty
//   • stop_price   ← live broker stop-loss leg (queried from open orders)
//   • entry_date   ← most-recent filled buy for this symbol within lookback,
//                    else today (flagged in notes for manual review)
//   • alpaca_order_id ← that originating buy order when discoverable, else null
// All reconciled rows are created with needs_review=1 and a clear notes prefix
// so the journal UI flags them for human follow-up.

async function reconcileOrphanPositions({ lookbackDays = 90, recentCloseWindowMin = 15 } = {}) {
  const db = getDB();

  let positions = [];
  try { positions = await alpaca.getPositions(); }
  catch (e) { return { reconciled: [], stillOrphan: [], error: `getPositions failed: ${e.message}` }; }
  if (!positions.length) return { reconciled: [], stillOrphan: [] };

  const openTrades = db.prepare('SELECT symbol FROM trades WHERE exit_date IS NULL').all();
  const tracked = new Set(openTrades.map(t => t.symbol));

  // Cooldown guard: symbols that had a trade closed within the last
  // `recentCloseWindowMin` minutes are NOT eligible for orphan-reconcile.
  //
  // Why: the sells loop above runs before reconcile in the same call. If a
  // broker sell just filled and closed the open row for SYMBOL, Alpaca's
  // position endpoint still reports that position briefly (settlement +
  // 1-tick staleness in Alpaca's positions cache). Without this cooldown,
  // reconcile creates a fresh orphan row → next sync the same 7-day-window
  // sell closes it again → ghost loop (DELL produced 6 duplicates before
  // this cooldown was added). 15 min is generous vs. Alpaca's ~1-minute
  // settlement and gives the broker cache plenty of time to catch up.
  const recentlyClosed = new Set(
    db.prepare(
      `SELECT DISTINCT symbol FROM trades
        WHERE exit_date IS NOT NULL
          AND datetime(exit_date) > datetime('now', ?)`
    ).all(`-${recentCloseWindowMin} minutes`).map(r => r.symbol)
  );

  const orphans = positions.filter(p => !tracked.has(p.symbol) && !recentlyClosed.has(p.symbol));
  if (!orphans.length) return { reconciled: [], stillOrphan: [] };

  // Extended order history — find the originating buy when possible. 500 cap
  // covers ~3 months of typical activity; widen if your flow is heavier.
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let allOrders = [];
  try { allOrders = await alpaca.getOrders({ status: 'all', limit: 500, after: since }); } catch (_) {}
  const buysBySymbol = {};
  for (const o of allOrders) {
    if (o.status !== 'filled' || o.side !== 'buy') continue;
    (buysBySymbol[o.symbol] ||= []).push(o);
  }

  // Open stop-loss orders (including bracket-parent legs) → populate stop_price.
  let openOrders = [];
  try { openOrders = await alpaca.getOrders({ status: 'open', limit: 500 }); } catch (_) {}
  const stopBySymbol = {};
  const harvestStop = (o) => {
    if ((o.type === 'stop' || o.type === 'stop_limit') && o.side === 'sell' && o.stop_price) {
      stopBySymbol[o.symbol] = +o.stop_price;
    }
  };
  for (const o of openOrders) {
    harvestStop(o);
    if (Array.isArray(o.legs)) o.legs.forEach(harvestStop);
  }

  // Sector lookup for universe-known symbols (mirrors order-centric path).
  const sectorLookup = db.prepare('SELECT sector FROM universe_mgmt WHERE symbol = ?');

  const stmt = db.prepare(`
    INSERT INTO trades (symbol, side, entry_date, entry_price, shares, sector,
                        stop_price, alpaca_order_id, needs_review, notes, was_system_signal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0)
  `);

  const reconciled = [];
  const stillOrphan = [];
  const todayStr = new Date().toISOString().split('T')[0];

  for (const pos of orphans) {
    try {
      const sym      = pos.symbol;
      const qty      = Math.abs(+pos.qty);
      const avgEntry = +pos.avg_entry_price;
      if (!(qty > 0) || !(avgEntry > 0)) {
        stillOrphan.push({ symbol: sym, reason: 'invalid_qty_or_price' });
        continue;
      }

      // Pick the most-recent buy as the originating order (best heuristic in
      // the absence of explicit linkage). This is only used for metadata
      // (entry_date, alpaca_order_id); the authoritative qty/price come from
      // the position itself.
      const candidates = (buysBySymbol[sym] || []).slice().sort((a, b) =>
        (b.filled_at || b.created_at || '').localeCompare(a.filled_at || a.created_at || '')
      );
      const originating = candidates[0];
      const orderId     = originating?.id || null;
      const entryDate   = originating
        ? (originating.filled_at || originating.created_at).split('T')[0]
        : todayStr;

      const brokerStop = stopBySymbol[sym] || null;
      const sector     = sectorLookup.get(sym)?.sector || null;

      const note = originating
        ? `[RECONCILED-FROM-BROKER] ${qty}sh @ $${avgEntry.toFixed(2)} — linked to filled order ${orderId.slice(0,8)}... Review thesis + exit plan, then clear needs_review.`
        : `[RECONCILED-FROM-BROKER] ${qty}sh @ $${avgEntry.toFixed(2)} — no originating buy order found within last ${lookbackDays}d (older than window, or submitted outside this app). Set entry_date / strategy manually if needed.`;

      stmt.run(sym, 'long', entryDate, avgEntry, qty, sector, brokerStop, orderId, note);

      // Sibling-copy bracket + always set initial/remaining_shares.
      // Orphan rows were the original stop/T1/T2 NULL source — this closes
      // the loop so re-running this reconciler on partial-position days
      // (e.g. after a scale-out) produces rows that fully participate in
      // the next scale-out trigger.
      if (orderId) {
        try { ensureBracketFields(db, orderId, sym, { brokerStop }); } catch (_) {}
      }

      reconciled.push({
        symbol: sym, qty, avgEntry, stopPrice: brokerStop,
        linkedOrderId: orderId, entryDate,
        source: originating ? 'linked_order' : 'position_only',
      });
    } catch (e) {
      stillOrphan.push({ symbol: pos.symbol, reason: e.message });
    }
  }

  return { reconciled, stillOrphan };
}

module.exports = { syncBrokerFills, reconcileOrphanPositions };
