// ─── /api/broker/* routes ───────────────────────────────────────────────────
// Alpaca broker account, positions, orders, market clock
const express = require('express');
const router  = express.Router();

const alpaca = require('../broker/alpaca');

module.exports = function(db) {
  // ─── Account ────────────────────────────────────────────────────────────────
  router.get('/broker/account', async (req, res) => {
    try {
      const account = await alpaca.getAccount();
      res.json({
        equity:        +account.equity,
        buyingPower:   +account.buying_power,
        cash:          +account.cash,
        portfolioValue: +account.portfolio_value,
        daytradeCount:  account.daytrade_count,
        patternDayTrader: account.pattern_day_trader,
        tradingBlocked:   account.trading_blocked,
        status:         account.status,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Positions ──────────────────────────────────────────────────────────────
  router.get('/broker/positions', async (req, res) => {
    try {
      const positions = await alpaca.getPositions();
      // Enrich with local trade data. Multi-tranche positions have multiple
      // trade rows per symbol (one per tranche). Only the row synced from the
      // original staged_order has stop/target populated — sibling tranche
      // rows have NULLs because they didn't match an alpaca_order_id lookup.
      // So we:
      //   1. Group trades by symbol
      //   2. Prefer the row that HAS stop_price/target data (real setup context)
      //   3. Aggregate totals across all tranches (shares, partial_exits, etc.)
      const localTrades = db.prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();
      const tradesBySymbol = {};
      for (const t of localTrades) {
        if (!tradesBySymbol[t.symbol]) tradesBySymbol[t.symbol] = [];
        tradesBySymbol[t.symbol].push(t);
      }
      // For each symbol pick the "canonical" trade row — one with setup data.
      // Fall back to the first row if none have stop data.
      const tradeMap = {};
      for (const [sym, rows] of Object.entries(tradesBySymbol)) {
        const withStop = rows.find(r => r.stop_price != null);
        const withTarget = rows.find(r => r.target1 != null);
        tradeMap[sym] = withStop || withTarget || rows[0];
      }

      // Also fetch matching staged_orders for tranches_json (lets UI show
      // each tranche's individual TP level). We key by symbol; for multi-
      // tranche setups this will pick the most recent submitted row.
      const stagedRows = db.prepare(
        "SELECT * FROM staged_orders WHERE status IN ('submitted','filled') AND tranches_json IS NOT NULL ORDER BY created_at DESC"
      ).all();
      const stagedMap = {};
      for (const s of stagedRows) {
        if (!stagedMap[s.symbol]) stagedMap[s.symbol] = s;
      }

      const enriched = positions.map(p => {
        const local = tradeMap[p.symbol];
        const staged = stagedMap[p.symbol];
        let trancheTargets = null;
        if (staged?.tranches_json) {
          try {
            trancheTargets = JSON.parse(staged.tranches_json)
              .map(t => ({ label: t.label, qty: t.qty, tp: t.tp }));
          } catch (_) {}
        }
        // Parse partial exits so UI can know if any tranches already fired
        let partialExits = [];
        try { partialExits = JSON.parse(local?.partial_exits || '[]'); } catch (_) {}

        return {
          symbol:         p.symbol,
          qty:            +p.qty,
          side:           p.side,
          marketValue:    +p.market_value,
          costBasis:      +p.cost_basis,
          currentPrice:   +p.current_price,
          avgEntryPrice:  +p.avg_entry_price,
          unrealizedPL:   +p.unrealized_pl,
          unrealizedPLPct: +p.unrealized_plpc * 100,
          changeToday:    +p.change_today * 100,
          // Local enrichments
          localStop:         local?.stop_price || staged?.stop_price || null,
          // ORIGINAL stop from staged_orders — used for R-multiple calc.
          // This never changes even after stop moves to breakeven post-T1.
          localInitialStop:  staged?.stop_price || local?.stop_price || null,
          localTarget1:      local?.target1 || staged?.target1_price || null,
          localTarget2:      local?.target2 || staged?.target2_price || null,
          localEntryRS:      local?.entry_rs || null,
          localTradeId:      local?.id || null,
          localEntryDate:    local?.entry_date || null,
          localStrategy:     local?.strategy || null,
          localExitStrategy: local?.exit_strategy || staged?.exit_strategy || null,
          localPartialExits: partialExits,  // [{level: 'target1', shares, price, pnl, timestamp}, ...]
          localTrailPct:     local?.trail_pct ?? null,
          trancheTargets,    // array of {label, qty, tp} for multi-tranche display
        };
      });

      res.json({ positions: enriched, count: enriched.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Orders ─────────────────────────────────────────────────────────────────
  //
  // Returns flat Alpaca orders enriched with local staged_orders data.
  // After a bracket parent fills, the stop-loss and take-profit legs appear
  // as independent flat orders. We match each order's ID against our
  // staged_orders.tranches_json to attach the tranche label, shared stop
  // price, and target prices so the UI can group and display them clearly.
  router.get('/broker/orders', async (req, res) => {
    try {
      const { status = 'open', limit = 50 } = req.query;
      // Alpaca's status=open filter excludes OCO bracket siblings whose status
      // is 'held' (e.g. the stop leg sitting dormant alongside an active TP).
      // Fetch all statuses and drop terminal ones server-side so the UI sees
      // every live order attached to an open position.
      let orders;
      if (status === 'open') {
        const raw = await alpaca.getOrders({ status: 'all', limit: 500 });
        const terminal = new Set(['filled','canceled','cancelled','expired','rejected','done_for_day','replaced']);
        orders = raw.filter(o => !terminal.has(o.status)).slice(0, +limit);
      } else {
        orders = await alpaca.getOrders({ status, limit: +limit });
      }

      // ── Build enrichment map from staged_orders ──
      let enrichById = {};    // orderId → enrichment
      let enrichBySymbol = {}; // symbol  → enrichment (fallback)
      try {
        const submitted = db.prepare(
          "SELECT * FROM staged_orders WHERE status IN ('submitted', 'filled') AND alpaca_order_id IS NOT NULL ORDER BY created_at DESC"
        ).all();
        for (const staged of submitted) {
          const base = {
            stagedId:     staged.id,
            stopPrice:    staged.stop_price,
            entryPrice:   staged.entry_price,
            target1:      staged.target1_price,
            target2:      staged.target2_price,
            exitStrategy: staged.exit_strategy,
          };
          // Map the primary (first tranche) order ID
          enrichById[staged.alpaca_order_id] = { ...base, trancheLabel: null };

          // Map individual tranche parent + stop leg IDs
          if (staged.tranches_json) {
            try {
              const tranches = JSON.parse(staged.tranches_json);
              for (const t of tranches) {
                if (t.orderId)     enrichById[t.orderId]     = { ...base, trancheLabel: t.label, trancheTP: t.tp };
                if (t.stopOrderId) enrichById[t.stopOrderId] = { ...base, trancheLabel: t.label, isStopLeg: true };
              }
            } catch (_) { /* malformed JSON, skip */ }
          }
          // Symbol-level fallback (most recent staged order wins)
          if (!enrichBySymbol[staged.symbol]) enrichBySymbol[staged.symbol] = base;
        }
      } catch (_) { /* non-critical — orders still work without enrichment */ }

      // ── Attach enrichment to each order ──
      const enriched = orders.map(o => ({
        ...o,
        _staged: enrichById[o.id] || enrichBySymbol[o.symbol] || null,
      }));

      res.json({ orders: enriched, count: enriched.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/broker/orders/:id', async (req, res) => {
    try {
      const order = await alpaca.getOrder(req.params.id);
      res.json(order);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Diagnostic: per-symbol stop reconciliation ────────────────────────
  // Shows three things side-by-side so the user can confirm the trailing
  // stop actually made it to the broker:
  //   1. DB desired stops (from open `trades` rows for this symbol)
  //   2. Live broker stop legs (filtered from listOrders)
  //   3. Recent stop_moves audit rows for the symbol
  //
  // Flags mismatch when the broker's stop_price differs from the DB's
  // stop_price by more than 1¢. This is the canonical endpoint to answer
  // "did my stop move to breakeven after T1?"
  router.get('/broker/stops/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const tradeRows = db.prepare(
        'SELECT id, stop_price, entry_price, target1, target2, remaining_shares, partial_exits FROM trades WHERE exit_date IS NULL AND symbol = ?'
      ).all(symbol);

      // Canonical desired stop = the scale-out row with populated stop_price.
      // Other tranche rows may have NULL stops (data hygiene gap).
      const desiredRow = tradeRows.find(r => r.stop_price != null) || null;
      const desiredStop = desiredRow?.stop_price ?? null;

      let liveLegs = [];
      let brokerError = null;
      try {
        const open = await alpaca.listOrders({ status: 'open', symbol });
        liveLegs = open
          .filter(o => o.type === 'stop' || o.type === 'stop_limit')
          .map(o => ({
            id: o.id, symbol: o.symbol, type: o.type,
            stop_price: +o.stop_price || null,
            qty: +o.qty || 0, status: o.status,
            submitted_at: o.submitted_at, updated_at: o.updated_at,
          }));
      } catch (e) {
        brokerError = e.message;
      }

      const recentMoves = db.prepare(
        'SELECT * FROM stop_moves WHERE symbol = ? ORDER BY attempted_at DESC LIMIT 20'
      ).all(symbol);

      // Reconciliation verdict
      const driftCents = 1;
      let verdict = 'unknown';
      let mismatches = [];
      if (brokerError) {
        verdict = 'broker_error';
      } else if (desiredStop == null) {
        verdict = 'no_desired_stop';
      } else if (!liveLegs.length) {
        verdict = 'no_live_stop_legs';
      } else {
        mismatches = liveLegs.filter(
          l => Math.abs((l.stop_price ?? 0) - desiredStop) * 100 > driftCents
        );
        verdict = mismatches.length === 0 ? 'in_sync' : 'out_of_sync';
      }

      res.json({
        symbol,
        verdict,
        desiredStop,
        desiredRow,
        liveLegs,
        liveLegCount: liveLegs.length,
        mismatches,
        brokerError,
        recentMoves,
        tradeRows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Stop-move audit log (unfiltered tail) ────────────────────────────
  router.get('/broker/stop-moves', (req, res) => {
    try {
      const limit = Math.min(+req.query.limit || 50, 500);
      const status = req.query.status || null;
      const rows = status
        ? db.prepare('SELECT * FROM stop_moves WHERE status = ? ORDER BY attempted_at DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM stop_moves ORDER BY attempted_at DESC LIMIT ?').all(limit);
      res.json({ rows, count: rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/broker/orders', async (req, res) => {
    try {
      const { symbol, qty, side, type, time_in_force, limit_price, stop_price,
              order_class, take_profit, stop_loss } = req.body;
      if (!symbol || !qty || !side || !type) {
        return res.status(400).json({ error: 'symbol, qty, side, and type are required' });
      }
      const order = await alpaca.submitOrder({
        symbol, qty, side, type, time_in_force: time_in_force || 'day',
        limit_price, stop_price, order_class, take_profit, stop_loss,
      });
      res.json(order);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/broker/orders/:id', async (req, res) => {
    try {
      await alpaca.cancelOrder(req.params.id);
      res.json({ ok: true, cancelled: req.params.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Market Clock ──────────────────────────────────────────────────────────
  router.get('/broker/clock', async (req, res) => {
    try {
      const clock = await alpaca.getClock();
      res.json({
        isOpen:    clock.is_open,
        nextOpen:  clock.next_open,
        nextClose: clock.next_close,
        timestamp: clock.timestamp,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Connection Status ────────────────────────────────────────────────────
  router.get('/broker/status', async (req, res) => {
    try {
      const connection = await alpaca.validateConnection();
      const { getMonitorStatus } = require('../broker/monitor');
      const monitor = getMonitorStatus();
      res.json({ broker: connection, monitor });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Real-Time Stream Status & Prices ─────────────────────────────────────
  router.get('/broker/stream/status', (req, res) => {
    try {
      const { priceStream } = require('../broker/monitor');
      res.json(priceStream.getStatus());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/broker/stream/prices', (req, res) => {
    try {
      const { priceStream } = require('../broker/monitor');
      const symbols = req.query.symbols ? req.query.symbols.split(',') : null;
      const allPrices = priceStream.getAllPrices();
      if (symbols) {
        const filtered = {};
        for (const s of symbols) {
          if (allPrices[s]) filtered[s] = allPrices[s];
        }
        res.json(filtered);
      } else {
        res.json(allPrices);
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // SSE endpoint for real-time price updates to the UI
  router.get('/broker/stream/sse', (req, res) => {
    try {
      const { priceStream } = require('../broker/monitor');

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const symbols = req.query.symbols ? req.query.symbols.split(',') : null;

      const handler = (symbol, update) => {
        if (symbols && !symbols.includes(symbol)) return;
        res.write(`data: ${JSON.stringify({ symbol, ...update })}\n\n`);
      };

      priceStream.on('price', handler);

      req.on('close', () => {
        priceStream.removeListener('price', handler);
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Manual Close Position ─────────────────────────────────────────────────
  // Two paths with very different correctness characteristics:
  //
  //   MARKET (no exitPrice)      — alpaca.closePosition() fills instantly on
  //                                Alpaca's side. Safe to mark journal closed.
  //   LIMIT  (exitPrice provided) — alpaca.submitOrder(..., type:'limit').
  //                                Order MAY OR MAY NOT FILL. We MUST NOT
  //                                mark journal closed until fills-sync sees
  //                                the fill. The prior version of this route
  //                                marked closed on submission — that's why
  //                                "Exit" was leaving stuck positions when
  //                                the limit didn't cross the spread.
  //
  // Contract: a broker submission failure is surfaced as HTTP 502, and the
  // journal row is NOT touched. The UI must trust the response. Only a
  // successful MARKET close mutates the trade row here.
  router.post('/broker/close-position', async (req, res) => {
    try {
      const { tradeId, symbol, shares, exitPrice, exitType = 'manual' } = req.body;
      if (!symbol) return res.status(400).json({ error: 'symbol is required' });

      // 1. Cancel any open orders for this symbol (OCO/bracket legs, stops, etc.)
      //    Best-effort — if this fails the close-submit still runs and Alpaca
      //    will reject if quantities overlap, which we'd then surface.
      try {
        const openOrders = await alpaca.getOrders({ status: 'open', limit: 200 });
        const related = openOrders.filter(o => o.symbol === symbol.toUpperCase());
        for (const o of related) {
          try { await alpaca.cancelOrder(o.id); } catch (_) { /* already filled/cancelled */ }
        }
      } catch (_) { /* no open orders or broker unavailable — proceed */ }

      // 2. Submit sell order. Errors are NOT swallowed — they bubble up so
      //    the UI/journal don't go out of sync with the broker.
      let brokerOrder = null;
      const isLimit = !!exitPrice;
      try {
        if (isLimit) {
          brokerOrder = await alpaca.submitOrder({
            symbol: symbol.toUpperCase(),
            qty: shares || undefined,
            side: 'sell',
            type: 'limit',
            time_in_force: 'day',
            limit_price: exitPrice,
          });
        } else {
          brokerOrder = await alpaca.closePosition(symbol.toUpperCase());
        }
      } catch (e) {
        console.error(`Broker close-position FAILED for ${symbol}: ${e.message}`);
        return res.status(502).json({
          ok: false,
          error: `Broker rejected close: ${e.message}`,
          brokerSubmitted: false,
        });
      }
      if (!brokerOrder) {
        return res.status(502).json({
          ok: false,
          error: 'Broker returned no order object — submission state is unknown',
          brokerSubmitted: false,
        });
      }

      // 3. Locate the local trade row(s).
      //
      //    MARKET close (alpaca.closePosition): flattens ALL shares for the
      //    symbol on the broker side. We must therefore close ALL open
      //    journal rows for the symbol — otherwise a multi-tranche position
      //    (e.g. DAL 3 tranches) ends up with broker=0/journal=still-open
      //    ghost rows that poison P&L and heat calcs.
      //
      //    LIMIT close: user supplied a specific qty. Target the single
      //    most-recent row (or the explicit tradeId) and stash the pending
      //    order id so fills-sync reconciles the exact lot when the limit
      //    fills.
      const openTradeRows = tradeId
        ? [db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId)].filter(Boolean)
        : db.prepare('SELECT * FROM trades WHERE symbol = ? AND exit_date IS NULL ORDER BY id DESC')
            .all(symbol.toUpperCase());

      // For the LIMIT branch we still operate on just one row (user qty is
      // partial by construction). Otherwise we touch every open row.
      const findTrade = openTradeRows[0] || null;

      let updatedTrade = null;
      let journalState = 'untouched';
      let rowsClosed = 0;

      if (openTradeRows.length) {
        if (isLimit) {
          // Record the pending close order id so the UI can show "pending
          // close submitted" and so reconcile can match the fill later.
          db.prepare(`
            UPDATE trades
            SET pending_close_order_id = ?, pending_close_submitted_at = datetime('now')
            WHERE id = ? AND exit_date IS NULL
          `).run(brokerOrder.id, findTrade.id);
          journalState = 'pending_limit_fill';
          updatedTrade = db.prepare('SELECT * FROM trades WHERE id = ?').get(findTrade.id);
        } else {
          // Market close — alpaca.closePosition flattens ALL shares. Close
          // every open row for this symbol, each priced at the single fill
          // price (alpaca.closePosition returns one aggregate fill).
          const fillPrice = +brokerOrder.filled_avg_price
                         || +brokerOrder.filledAvgPrice
                         || openTradeRows[0].entry_price;

          const updateStmt = db.prepare(`
            UPDATE trades
            SET exit_date = datetime('now'), exit_price = ?, exit_reason = ?,
                pnl_dollars = ?, pnl_percent = ?, r_multiple = ?
            WHERE id = ? AND exit_date IS NULL
          `);

          const closeAll = db.transaction((rows) => {
            for (const r of rows) {
              const pnlDollars = r.side === 'long'
                ? (fillPrice - r.entry_price) * (r.shares || 0)
                : (r.entry_price - fillPrice) * (r.shares || 0);
              const pnlPercent = r.entry_price
                ? ((fillPrice - r.entry_price) / r.entry_price) * 100 * (r.side === 'long' ? 1 : -1)
                : 0;
              // Use initial_stop_price so breakeven-moved stops don't collapse R.
              const stopBase = r.initial_stop_price || r.stop_price;
              const rMultiple = stopBase && r.entry_price !== stopBase
                ? (fillPrice - r.entry_price) / (r.entry_price - stopBase)
                : null;
              const info = updateStmt.run(fillPrice, exitType, pnlDollars, pnlPercent, rMultiple, r.id);
              rowsClosed += info.changes;
            }
          });
          closeAll(openTradeRows);

          journalState = 'closed_market';
          // Return the primary row (what existing callers expect); caller gets
          // rowsClosed separately so the UI can say "closed 3 tranches."
          updatedTrade = db.prepare('SELECT * FROM trades WHERE id = ?').get(findTrade.id);
        }
      }

      // 5. Fire notification. Different message for market vs pending-limit
      //    so the user knows whether the position is actually gone.
      try {
        const { notifyTradeEvent } = require('../notifications/channels');
        await notifyTradeEvent({
          event: 'manual_exit',
          symbol: symbol.toUpperCase(),
          details: {
            shares: updatedTrade?.shares || shares,
            price: exitPrice || updatedTrade?.exit_price,
            pnl: updatedTrade?.pnl_dollars,
            pnl_pct: updatedTrade?.pnl_percent,
            reason: 'Manual exit via UI',
            message: isLimit
              ? `Limit sell submitted @ $${exitPrice} — will close when filled (order ${brokerOrder.id})`
              : `Market close submitted (order ${brokerOrder.id})`,
          },
        });
      } catch (e) {
        console.warn(`Manual exit notification failed for ${symbol}: ${e.message}`);
      }

      res.json({
        ok: true,
        trade: updatedTrade,
        journalState,                // 'closed_market' | 'pending_limit_fill' | 'untouched'
        pending: isLimit,            // tells UI to show "pending" instead of "closed"
        orderType: isLimit ? 'limit' : 'market',
        rowsClosed,                  // # of tranches closed (market) — 1 for limit
        brokerOrder: { id: brokerOrder.id, status: brokerOrder.status, type: brokerOrder.type },
        cancelledOrders: true,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
