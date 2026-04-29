// ─── /api/portfolio/* and /api/trades/* routes ──────────────────────────────
// NEW: Risk management, position sizing, trade journal
const express = require('express');
const router  = express.Router();

const { calculatePositionSize, kellyOptimal } = require('../risk/position-sizer');
const {
  getConfig, updateConfig,
  getPortfolioHeat, getSectorExposure, getCorrelationRisk,
  getDrawdownStatus, resetPeakEquity, preTradeCheck,
  suggestPyramidAdd,
} = require('../risk/portfolio');
const { getMarketRegime } = require('../risk/regime');
const { createStopAlert, deactivateAlertsForTrade } = require('../broker/alerts');
const alpaca = require('../broker/alpaca');
const { attributePerformance } = require('../signals/attribution');
const { notifyTradeEvent } = require('../notifications/channels');
const { createTaxLot, sellTaxLots } = require('../risk/tax-engine');
const { logExecution } = require('../risk/execution-quality');
const { assignStrategy } = require('../risk/strategy-manager');
const { syncBrokerFills } = require('../broker/fills-sync');

module.exports = function(db) {
  // ─── Portfolio Config ──────────────────────────────────────────────────────
  router.get('/portfolio/config', (req, res) => {
    res.json(getConfig());
  });

  router.post('/portfolio/config', (req, res) => {
    const updated = updateConfig(req.body);
    res.json(updated);
  });

  // ─── Portfolio Status ──────────────────────────────────────────────────────
  router.get('/portfolio/status', async (req, res) => {
    try {
      const openPositions = db.prepare(
        `SELECT * FROM trades WHERE exit_date IS NULL`
      ).all();
      const config = getConfig();
      const heat = getPortfolioHeat(openPositions);
      const exposure = getSectorExposure(openPositions);

      // Fetch live broker data FIRST so drawdown can use real equity.
      // Previously we passed config.accountSize to getDrawdownStatus, which
      // made drawdown stuck at 0.0% (peak seeded from accountSize, current
      // also accountSize → 0 delta). Now we use broker equity when available
      // and fall back to accountSize only when the broker is unreachable.
      let broker = null;
      let brokerPositions = [];
      try {
        const [account, positions] = await Promise.all([
          alpaca.getAccount(),
          alpaca.getPositions(),
        ]);
        broker = {
          equity:        +account.equity,
          cash:          +account.cash,
          buyingPower:   +account.buying_power,
          portfolioValue: +account.portfolio_value,
        };
        // Build enriched broker positions with local trade data.
        // Multi-tranche positions have multiple trade rows per symbol — prefer
        // the row that has stop/target data set (others may be sibling tranches
        // without setup context because the sync couldn't match their order id).
        const tradesBySymbol = {};
        for (const t of openPositions) {
          if (!tradesBySymbol[t.symbol]) tradesBySymbol[t.symbol] = [];
          tradesBySymbol[t.symbol].push(t);
        }
        const tradeMap = {};
        for (const [sym, rows] of Object.entries(tradesBySymbol)) {
          tradeMap[sym] = rows.find(r => r.stop_price != null)
                       || rows.find(r => r.target1 != null)
                       || rows[0];
        }

        // Also pull staged_orders as a fallback source for stop/target —
        // some older trades never had the trades.stop_price field synced.
        const { getDB } = require('../data/database');
        const stagedRows = getDB().prepare(
          "SELECT symbol, stop_price, target1_price, target2_price, exit_strategy FROM staged_orders WHERE status IN ('submitted','filled') ORDER BY created_at DESC"
        ).all();
        const stagedMap = {};
        for (const s of stagedRows) {
          if (!stagedMap[s.symbol]) stagedMap[s.symbol] = s;
        }

        brokerPositions = positions.map(p => {
          const local = tradeMap[p.symbol];
          const staged = stagedMap[p.symbol];
          return {
            symbol:        p.symbol,
            qty:           +p.qty,
            side:          p.side,
            currentPrice:  +p.current_price,
            avgEntryPrice: +p.avg_entry_price,
            marketValue:   +p.market_value,
            unrealizedPL:  +p.unrealized_pl,
            unrealizedPLPct: +p.unrealized_plpc * 100,
            changeToday:   +p.change_today * 100,
            localStop:         local?.stop_price   || staged?.stop_price     || null,
            localTarget1:      local?.target1      || staged?.target1_price  || null,
            localTarget2:      local?.target2      || staged?.target2_price  || null,
            localTradeId:      local?.id || null,
            localEntryDate:    local?.entry_date || null,
            localStrategy:     local?.strategy || null,
            localExitStrategy: local?.exit_strategy || staged?.exit_strategy || null,
            sector:            local?.sector || null,
            inJournal:         !!local,
            // Pending-close state: if the trader submitted a LIMIT sell via
            // /broker/close-position, the journal row carries an open
            // pending_close_order_id until fills-sync reconciles the fill.
            // Surface to the UI so LIVE POSITIONS can render a "PENDING CLOSE"
            // pill instead of looking like a fresh untouched position.
            pendingCloseOrderId:    local?.pending_close_order_id    || null,
            pendingCloseSubmittedAt: local?.pending_close_submitted_at || null,
          };
        });
      } catch (_) { /* broker unavailable — fall back to local-only */ }

      // Now that broker equity is captured (or null), compute drawdown
      // against real equity. Fallback to accountSize keeps dry-run sessions
      // and paper-token-expired states from producing garbage drawdown math.
      const liveEquity = broker?.equity || config.accountSize;
      const drawdown = getDrawdownStatus(liveEquity);
      const regime = await getMarketRegime();

      // Position-count telemetry. Broker = source of truth: pre-fix this
      // counted distinct symbols in the JOURNAL, which inflated the number
      // anytime a zombie row sat there waiting for fills-sync to reconcile.
      // The trader saw "4 / 3" while Alpaca actually had 2 positions — the
      // tier-cap warning fired falsely and looked like a bug. Now: if
      // broker is reachable, use its position count; fall back to journal
      // distinct-symbols only if broker is down. Either way we surface
      // 'drift' so the UI can flag a gap (qty-level too: e.g. broker
      // 14 shares vs journal 8 means a partial fill never got synced).
      const journalSymbols = new Set(openPositions.map(p => p.symbol));
      const brokerSymbols  = new Set((brokerPositions || []).map(p => p.symbol));
      const brokerReachable = Array.isArray(brokerPositions);
      const sourceOfTruth = brokerReachable ? brokerSymbols : journalSymbols;
      const symbolDrift = [
        ...[...journalSymbols].filter(s => !brokerSymbols.has(s)).map(s => ({ symbol: s, where: 'journal_only' })),
        ...[...brokerSymbols].filter(s => !journalSymbols.has(s)).map(s => ({ symbol: s, where: 'broker_only' })),
      ];
      // Per-symbol qty drift — when a partial sell was double-counted or a
      // pyramid-add never made it into the journal. Sums the journal's
      // remaining_shares vs the broker's qty.
      const qtyDrift = [];
      for (const sym of brokerSymbols) {
        const brokerQty = (brokerPositions.find(p => p.symbol === sym)?.qty) || 0;
        const journalQty = openPositions
          .filter(p => p.symbol === sym)
          .reduce((s, p) => s + (p.remaining_shares ?? p.shares ?? 0), 0);
        if (Math.abs(brokerQty - journalQty) >= 1) {
          qtyDrift.push({ symbol: sym, brokerQty, journalQty, gap: brokerQty - journalQty });
        }
      }
      const tier = regime?.exposureRamp?.exposureLevel;
      const tierCap = tier && config.maxOpenPositionsByTier?.[tier] != null
        ? config.maxOpenPositionsByTier[tier]
        : null;
      const effectiveMaxPositions = tierCap != null ? tierCap : config.maxOpenPositions;
      const positionCount = {
        current: sourceOfTruth.size,
        cap:     effectiveMaxPositions,
        tier:    tier || null,
        tierOverride: tierCap != null,
        atCap:   sourceOfTruth.size >= effectiveMaxPositions,
        // Diagnostic fields — UI shows these as a small "DRIFT N" badge
        // when symbolDrift.length || qtyDrift.length > 0, with a tooltip
        // listing the gaps. Self-healing: the next broker_fills_sync cron
        // (every 15 min market hours, EOD safety pass) closes journal_only
        // zombies and creates broker_only orphans automatically. The UI
        // can also offer a manual "RECONCILE NOW" button via the existing
        // /api/portfolio/reconcile-zombies route.
        source: brokerReachable ? 'broker' : 'journal',
        journalCount: journalSymbols.size,
        brokerCount:  brokerSymbols.size,
        symbolDrift,
        qtyDrift,
      };

      // Pyramid-first nudge. Feeds live broker prices (when we have them) so
      // the R-multiple calc uses the freshest mark. Falls back to stored
      // entry price when broker is unavailable — which produces a winners
      // list of ZERO (0R gain), harmless default.
      const currentPrices = {};
      for (const bp of brokerPositions) {
        if (bp.symbol && bp.currentPrice) currentPrices[bp.symbol] = bp.currentPrice;
      }
      const pyramidSuggestion = suggestPyramidAdd(openPositions, currentPrices, regime);

      res.json({
        heat,
        exposure,
        drawdown,
        // Surface above50/above200 so the UI can explain WHY a REDUCED tier
        // was chosen (e.g., "SPY below 50MA" vs. "3+ distribution days").
        regime: {
          mode: regime.regime,
          sizeMultiplier: regime.sizeMultiplier,
          exposureRamp: regime.exposureRamp,
          above50:  regime.above50,
          above200: regime.above200,
        },
        openPositions: openPositions.length,
        positionCount,
        pyramidSuggestion,
        config,
        broker,
        brokerPositions,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Peak Equity Reset ─────────────────────────────────────────────────────
  // Two modes:
  //   POST /portfolio/peak-equity/reset         → clear + recompute from trades
  //   POST /portfolio/peak-equity/reset {value} → pin peak to caller-supplied
  //
  // Use case: after a bulk trade import (the backfill on first load won't
  // re-run because a peak is already persisted), or after an account
  // deposit/withdrawal that the trade-based curve can't reflect.
  router.post('/portfolio/peak-equity/reset', (req, res) => {
    try {
      const { value } = req.body || {};
      if (value != null) {
        const peak = resetPeakEquity(+value);
        return res.json({ ok: true, peakEquity: peak, mode: 'forced' });
      }
      const peak = resetPeakEquity();
      res.json({ ok: true, peakEquity: peak, mode: 'recomputed' });
    } catch(e) { res.status(400).json({ error: e.message }); }
  });

  // ─── Position Sizer ────────────────────────────────────────────────────────
  router.post('/portfolio/size', async (req, res) => {
    try {
      const { entryPrice, stopPrice, beta, atrPct } = req.body;
      if (!entryPrice || !stopPrice) return res.status(400).json({ error: 'entryPrice and stopPrice required' });
      const config = getConfig();
      const regime = await getMarketRegime();
      const sizing = calculatePositionSize({
        accountSize: config.accountSize,
        riskPerTrade: config.riskPerTrade,
        entryPrice,
        stopPrice,
        regimeMultiplier: regime.sizeMultiplier,
        maxPositionPct: config.maxPositionPct,
        beta, atrPct,
      });
      res.json({ ...sizing, regime: regime.regime });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Correlation Matrix for open positions ────────────────────────────────
  router.get('/portfolio/correlations', async (req, res) => {
    try {
      const { calcCorrelationMatrix } = require('../risk/position-sizer');
      const { getHistory } = require('../data/providers/manager');
      const openPositions = db.prepare('SELECT symbol FROM trades WHERE exit_date IS NULL').all();
      if (openPositions.length < 2) {
        return res.json({ matrix: {}, symbols: [], warnings: [], note: 'Need at least 2 open positions' });
      }
      const closesMap = {};
      for (const p of openPositions) {
        try { closesMap[p.symbol] = await getHistory(p.symbol); } catch(_) {}
      }
      res.json(calcCorrelationMatrix(closesMap, 60));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Pre-trade Check ───────────────────────────────────────────────────────
  router.post('/portfolio/check', async (req, res) => {
    try {
      const candidate = req.body;
      if (!candidate.symbol) return res.status(400).json({ error: 'symbol required' });
      const openPositions = db.prepare(
        `SELECT * FROM trades WHERE exit_date IS NULL`
      ).all();
      const regime = await getMarketRegime();
      const result = preTradeCheck(candidate, openPositions, regime);
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Trade Journal ─────────────────────────────────────────────────────────
  // POST /api/trades — Log new entry
  router.post('/trades', (req, res) => {
    try {
      const {
        symbol, side = 'long', entry_date, entry_price,
        stop_price, target1, target2, shares,
        entry_rs, entry_sepa, entry_regime, wave, sector, notes, strategy,
      } = req.body;
      if (!symbol || !entry_price) return res.status(400).json({ error: 'symbol and entry_price required' });

      const stmt = db.prepare(`
        INSERT INTO trades (symbol, side, entry_date, entry_price, stop_price, target1, target2,
                           shares, initial_shares, remaining_shares,
                           entry_rs, entry_sepa, entry_regime, wave, sector, notes, strategy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Auto-assign strategy if not provided
      let assignedStrategy = strategy || null;
      if (!assignedStrategy) {
        try {
          const assigned = assignStrategy({
            symbol: symbol.toUpperCase(),
            rsRank: entry_rs || 0,
            swingMomentum: 0,
            vcpForming: false,
          });
          assignedStrategy = assigned.strategy;
          console.log(`  Strategy auto-assigned: ${symbol.toUpperCase()} → ${assigned.strategy} (${assigned.confidence}% confidence: ${assigned.reasons.join(', ')})`);
        } catch (_) {}
      }

      const result = stmt.run(
        symbol.toUpperCase(), side, entry_date || new Date().toISOString().split('T')[0],
        entry_price, stop_price, target1, target2,
        shares, shares, shares,
        entry_rs, entry_sepa, entry_regime, wave, sector, notes,
        assignedStrategy,
      );
      // Auto-create stop alert if stop_price is set
      if (stop_price) {
        try { createStopAlert(result.lastInsertRowid); } catch (_) {}
      }

      notifyTradeEvent({ event: 'buy', symbol: symbol.toUpperCase(), details: { shares, price: entry_price, stop: stop_price, strategy: assignedStrategy } }).catch(e => console.error('Notification error:', e.message));
      res.json({ ok: true, id: result.lastInsertRowid, strategy: assignedStrategy });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/trades/:id — Log exit or update notes
  router.put('/trades/:id', (req, res) => {
    try {
      const { exit_date, exit_price, exit_reason, notes, needs_review } = req.body;

      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
      if (!trade) return res.status(404).json({ error: 'Trade not found' });

      // Notes-only update (no exit)
      if (!exit_price && notes !== undefined) {
        db.prepare('UPDATE trades SET notes = ?, needs_review = ? WHERE id = ?')
          .run(notes, needs_review ?? 0, req.params.id);
        return res.json({ ok: true });
      }

      if (!exit_price) return res.status(400).json({ error: 'exit_price required' });

      const pnl_dollars = (exit_price - trade.entry_price) * (trade.shares || 0) * (trade.side === 'short' ? -1 : 1);
      const pnl_percent = +((exit_price / trade.entry_price - 1) * 100 * (trade.side === 'short' ? -1 : 1)).toFixed(2);
      // initial_stop_price preserves the pre-T1 stop so R-multiple isn't
      // collapsed by breakeven moves. See src/risk/scaling.js moveStopTo: entry.
      const riskBase = trade.initial_stop_price || trade.stop_price || trade.entry_price * 0.95;
      const risk = trade.entry_price - riskBase;
      const r_multiple = risk > 0 ? +((exit_price - trade.entry_price) / risk * (trade.side === 'short' ? -1 : 1)).toFixed(2) : 0;

      db.prepare(`
        UPDATE trades SET exit_date = ?, exit_price = ?, exit_reason = ?,
                         pnl_dollars = ?, pnl_percent = ?, r_multiple = ?,
                         notes = COALESCE(?, notes)
        WHERE id = ?
      `).run(
        exit_date || new Date().toISOString().split('T')[0],
        exit_price, exit_reason, pnl_dollars, pnl_percent, r_multiple,
        notes, req.params.id,
      );

      // Deactivate any stop alerts for this trade
      try { deactivateAlertsForTrade(+req.params.id); } catch (_) {}

      notifyTradeEvent({ event: 'exit', symbol: trade.symbol, details: { shares: trade.shares, price: exit_price, pnl: pnl_dollars, pnl_pct: pnl_percent, reason: exit_reason } }).catch(e => console.error('Notification error:', e.message));
      res.json({ ok: true, pnl_dollars, pnl_percent, r_multiple });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/trades — List trades
  //
  // excludePartials=1 strips rows that already carry scale-out events out of
  // the listing. Use case: the Journal's "Open" tab shouldn't double-count
  // names that are also surfaced in "Partials" — AVGO with 3 tranches and
  // 2 scale-outs per tranche is visible under both filters otherwise, which
  // makes the count mismatch Alpaca's untouched-lots view.
  router.get('/trades', (req, res) => {
    try {
      const { status = 'all', limit = 50, excludePartials } = req.query;
      const clauses = [];
      if (status === 'open')   clauses.push('exit_date IS NULL');
      else if (status === 'closed') clauses.push('exit_date IS NOT NULL');
      if (excludePartials === '1' || excludePartials === 'true') {
        // json_array_length is safe against NULL partial_exits (treats as 0)
        // via COALESCE. Rows with an empty array '[]' also pass through — only
        // rows that actually recorded ≥1 scale-out are filtered.
        clauses.push(
          `COALESCE(json_array_length(CASE WHEN json_valid(partial_exits) THEN partial_exits ELSE '[]' END), 0) = 0`
        );
      }
      let query = 'SELECT * FROM trades';
      if (clauses.length) query += ' WHERE ' + clauses.join(' AND ');
      query += ' ORDER BY entry_date DESC LIMIT ?';
      const trades = db.prepare(query).all(limit);
      res.json({ trades, count: trades.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/trades/partial-exits — Flatten partial_exits across rows
  //
  // A scale-out recorded on a still-open trade row (partial_exits JSON, realized
  // dollars captured in realized_pnl_dollars) doesn't surface in the "closed"
  // filter because exit_date is still NULL. The Trade Journal tab needs a way
  // to answer "how much P&L have I banked from scale-outs this week?" without
  // pretending the underlying position is closed. This endpoint flattens every
  // event out of the partial_exits JSON across ALL rows (open OR closed) into
  // a single ordered list: one row per event, with enough trade context for
  // the UI to render a journal entry. The parent row's entry stays visible
  // under the "open" filter.
  router.get('/trades/partial-exits', (req, res) => {
    try {
      const { limit = 100 } = req.query;
      // Only pull rows that have partial_exits data. JSON1 LENGTH skips empty arrays.
      const rows = db.prepare(`
        SELECT id, symbol, side, sector, strategy, entry_date, entry_price,
               stop_price, initial_stop_price, target1, target2, shares,
               initial_shares, remaining_shares, exit_date, partial_exits,
               realized_pnl_dollars, notes
          FROM trades
         WHERE partial_exits IS NOT NULL
           AND json_valid(partial_exits) = 1
           AND json_array_length(partial_exits) > 0
         ORDER BY entry_date DESC
      `).all();

      const events = [];
      for (const r of rows) {
        let parsed = [];
        try { parsed = JSON.parse(r.partial_exits || '[]'); } catch (_) { continue; }
        for (const pe of parsed) {
          // risk base for R — prefer initial_stop_price (see stop=entry bug fix).
          const stopBase = r.initial_stop_price || r.stop_price;
          const risk     = stopBase && stopBase > 0 && r.entry_price !== stopBase
            ? r.entry_price - stopBase : null;
          const sideMul  = r.side === 'short' ? -1 : 1;
          const rMult    = risk && risk !== 0 && pe.price != null
            ? +((pe.price - r.entry_price) / risk * sideMul).toFixed(2) : null;

          events.push({
            tradeId: r.id,
            symbol: r.symbol,
            side: r.side,
            sector: r.sector,
            strategy: r.strategy,
            entry_date: r.entry_date,
            entry_price: r.entry_price,
            stop_price: r.stop_price,
            initial_stop_price: r.initial_stop_price,
            target1: r.target1,
            target2: r.target2,
            initial_shares: r.initial_shares || r.shares,
            remaining_shares: r.remaining_shares,
            trade_exit_date: r.exit_date,       // null if parent row still open
            tradeClosed: r.exit_date != null,   // convenience flag for UI styling
            // partial event fields
            level: pe.level,
            shares: pe.shares,
            price: pe.price,
            pnl: pe.pnl,
            timestamp: pe.timestamp,
            order_id: pe.order_id || null,
            r_multiple: rMult,
          });
        }
      }

      // Sort newest-first by event timestamp (fallback entry_date)
      events.sort((a, b) => (b.timestamp || b.entry_date || '').localeCompare(a.timestamp || a.entry_date || ''));

      const sliced = events.slice(0, +limit || 100);

      // Summary for the tab header: realized dollars across all partial exits
      // where the parent row is still OPEN — this is the "hidden P&L" the UI
      // can't see in any other view.
      const openOnly = events.filter(e => !e.tradeClosed);
      const realizedOpen = openOnly.reduce((s, e) => s + (e.pnl || 0), 0);

      res.json({
        events: sliced,
        count: events.length,
        realizedOnOpenRows: +realizedOpen.toFixed(2),
        openEventsCount: openOnly.length,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/pullback-alerts — Today's live pullback watcher events
  //
  // The pullback watcher (src/signals/pullback-watcher.js) writes rows into
  // pullback_states when a strong-RS name actually touches its 50MA pullback
  // zone. These are the *actionable* pullback candidates — distinct from the
  // static "extended, waiting for pullback" watchlist computed client-side
  // in TradeSetupsTab from rs_snapshots. Without this endpoint those fired
  // alerts land in the phone push feed and nowhere else — the Trade Setup
  // tab has no way to surface them, so the trader can't see "AA entered the
  // zone 2h ago" without digging through Pushover history.
  //
  // Response shape:
  //   { alerts: [{ symbol, state, ma50, atr, price_at_fire, fired_at,
  //                updated_at, rsRank, sector, vsMA50, stage, sepaScore }],
  //     count, byState: { kissing, in_zone, approaching } }
  //
  // States, ranked by urgency (UI uses this to colour-code):
  //   kissing     → price within 1 ATR of 50MA (HOT — buy zone right now)
  //   in_zone     → price in the 50MA halo [-1% … +3%] (actionable)
  //   approaching → price 3-7% above 50MA, sliding toward the zone (watch)
  router.get('/pullback-alerts', (req, res) => {
    try {
      // Freshness window: default 3 days so over-weekend / Monday-morning
      // alerts still surface. Override via ?sinceHours=<n> if the trader
      // wants just today.
      const sinceHours = Math.max(1, Math.min(168, +req.query.sinceHours || 72));

      const rows = db.prepare(`
        SELECT symbol, state, ma50, atr, price_at_fire, fired_at, updated_at
          FROM pullback_states
         WHERE datetime(updated_at) >= datetime('now', ?)
         ORDER BY
           CASE state
             WHEN 'kissing'     THEN 0
             WHEN 'in_zone'     THEN 1
             WHEN 'approaching' THEN 2
             ELSE 3
           END,
           datetime(updated_at) DESC
      `).all(`-${sinceHours} hours`);

      // Enrich with latest RS snapshot per symbol so the UI can show
      // RS rank / sector / stage / sepa without a second round-trip.
      const symbols = rows.map(r => r.symbol);
      const rsBySym = {};
      if (symbols.length) {
        const placeholders = symbols.map(() => '?').join(',');
        const rsRows = db.prepare(`
          SELECT s.symbol, s.rs_rank, s.stage, s.sepa_score, s.vs_ma50,
                 s.price, s.pattern_type, s.pattern_confidence, s.vcp_forming,
                 s.rs_line_new_high, s.atr_pct
            FROM rs_snapshots s
            JOIN (
              SELECT symbol, MAX(date) AS max_date
                FROM rs_snapshots
               WHERE type='stock' AND symbol IN (${placeholders})
               GROUP BY symbol
            ) latest ON latest.symbol = s.symbol AND latest.max_date = s.date
           WHERE s.type='stock'
        `).all(...symbols);
        for (const r of rsRows) rsBySym[r.symbol] = r;
      }

      // Also pull sector from universe_mgmt (rs_snapshots doesn't carry sector).
      const uniBySym = {};
      if (symbols.length) {
        const placeholders = symbols.map(() => '?').join(',');
        try {
          const uniRows = db.prepare(`
            SELECT symbol, sector
              FROM universe_mgmt
             WHERE symbol IN (${placeholders})
               AND removed_date IS NULL
          `).all(...symbols);
          for (const u of uniRows) uniBySym[u.symbol] = u;
        } catch (_) { /* universe_mgmt optional */ }
      }

      // Pending-entry guard: if the symbol already has an open trade row,
      // flag it so the UI can disable the "Stage" button.
      const openSet = new Set(
        db.prepare(
          `SELECT DISTINCT symbol FROM trades WHERE exit_date IS NULL`
        ).all().map(r => r.symbol)
      );

      const alerts = rows.map(r => {
        const rs = rsBySym[r.symbol] || {};
        const uni = uniBySym[r.symbol] || {};
        // Entry zone — the buy band around the 50MA (±1 ATR is O'Neil's
        // classic pullback-to-rising-MA setup).
        const zoneLo = r.ma50 ? +(r.ma50 - (r.atr || 0) * 0.3).toFixed(2) : null;
        const zoneHi = r.ma50 ? +(r.ma50 + (r.atr || 0) * 0.8).toFixed(2) : null;
        return {
          symbol: r.symbol,
          state: r.state,
          ma50: r.ma50,
          atr: r.atr,
          priceAtFire: r.price_at_fire,
          firedAt: r.fired_at,
          updatedAt: r.updated_at,
          entryZone: (zoneLo != null && zoneHi != null) ? [zoneLo, zoneHi] : null,
          // RS context (may be null if snapshot is stale)
          rsRank:           rs.rs_rank ?? null,
          stage:            rs.stage ?? null,
          sepaScore:        rs.sepa_score ?? null,
          vsMA50:           rs.vs_ma50 ?? null,
          latestPrice:      rs.price ?? null,
          patternType:      rs.pattern_type ?? null,
          patternConfidence: rs.pattern_confidence ?? null,
          vcpForming:       !!rs.vcp_forming,
          rsLineNewHigh:    !!rs.rs_line_new_high,
          atrPct:           rs.atr_pct ?? null,
          sector:           uni.sector ?? null,
          hasOpenPosition:  openSet.has(r.symbol),
        };
      });

      const byState = alerts.reduce((m, a) => {
        m[a.state] = (m[a.state] || 0) + 1;
        return m;
      }, {});

      res.json({ alerts, count: alerts.length, byState, sinceHours });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── POST /api/trades/backfill-targets ────────────────────────────────
  // Compute T1/T2 using 2R/4R for any OPEN trade that has a stop but NULL
  // targets. Mirrors scripts/backfill-missing-targets.js so the user can
  // fire it from the UI without SSHing. Safe to re-run — COALESCE means
  // pre-existing non-NULL targets are never overwritten.
  router.post('/trades/backfill-targets', (req, res) => {
    try {
      const { computeTargetsFromStop } = require('../broker/fills-sync');
      const candidates = db.prepare(`
        SELECT id, symbol, entry_price, stop_price, target1, target2
          FROM trades
         WHERE exit_date IS NULL
           AND stop_price IS NOT NULL
           AND (target1 IS NULL OR target2 IS NULL)
      `).all();
      const upd = db.prepare(
        'UPDATE trades SET target1 = COALESCE(target1, ?), target2 = COALESCE(target2, ?) WHERE id = ?'
      );
      const patched = [];
      const skipped = [];
      for (const t of candidates) {
        const t1t2 = computeTargetsFromStop(t.entry_price, t.stop_price);
        if (!t1t2) { skipped.push({ id: t.id, symbol: t.symbol, reason: 'invalid entry/stop' }); continue; }
        upd.run(t1t2.target1, t1t2.target2, t.id);
        patched.push({ id: t.id, symbol: t.symbol, entry: t.entry_price, stop: t.stop_price, ...t1t2 });
      }
      res.json({
        ok: true,
        patched: patched.length,
        skipped: skipped.length,
        rows: patched,
        skippedRows: skipped,
        message: `Backfilled T1/T2 on ${patched.length} trade(s); skipped ${skipped.length}.`,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── POST /api/trades/dedup ────────────────────────────────────────────
  // Detect and delete duplicate OPEN trade rows (same alpaca_order_id, OR
  // same symbol+entry_date+entry_price+shares with NULL order_id). The
  // canonical row is the one with the most complete bracket + any
  // partial_exits history. Mirrors scripts/dedup-trade-rows.js.
  //
  // Requires ?apply=1 — default is a dry-run preview so a misfire doesn't
  // eat live data. Returns per-group plans either way.
  router.post('/trades/dedup', (req, res) => {
    try {
      const APPLY = req.query.apply === '1' || req.query.apply === 'true' || req.body?.apply === true;

      const openRows = db.prepare(`
        SELECT id, symbol, entry_date, entry_price, stop_price, initial_stop_price,
               target1, target2, shares, alpaca_order_id, strategy, partial_exits
          FROM trades WHERE exit_date IS NULL ORDER BY symbol, id
      `).all();

      const bracketScore = r => {
        let s = 0;
        if (r.stop_price != null) s += 2;
        if (r.target1 != null) s += 2;
        if (r.target2 != null) s += 2;
        if (r.strategy) s += 1;
        if (r.initial_stop_price) s += 1;
        if (r.partial_exits && r.partial_exits !== 'null' && r.partial_exits !== '[]') s += 100;
        return s;
      };
      const pickCanonical = rows => rows.slice().sort((a, b) => bracketScore(b) - bracketScore(a) || a.id - b.id)[0];

      const groupsA = {}; const groupsB = {};
      for (const r of openRows) {
        if (r.alpaca_order_id) (groupsA[r.alpaca_order_id] ||= []).push(r);
        else (groupsB[`${r.symbol}|${r.entry_date}|${r.entry_price}|${r.shares}`] ||= []).push(r);
      }
      const dupsA = Object.entries(groupsA).filter(([, g]) => g.length > 1);
      const dupsB = Object.entries(groupsB).filter(([, g]) => g.length > 1);

      const plan = [];
      for (const [key, rows] of [...dupsA, ...dupsB]) {
        const canonical = pickCanonical(rows);
        plan.push({
          key,
          keepId: canonical.id,
          deleteIds: rows.filter(r => r.id !== canonical.id).map(r => r.id),
          symbol: canonical.symbol,
        });
      }

      let deleted = 0;
      if (APPLY && plan.length) {
        const del     = db.prepare('DELETE FROM trades WHERE id = ?');
        const delHist = db.prepare('DELETE FROM decision_log WHERE trade_id = ?');
        const delExec = db.prepare('UPDATE execution_log SET trade_id = NULL WHERE trade_id = ?');
        const tx = db.transaction(() => {
          for (const p of plan) for (const id of p.deleteIds) {
            try { delExec.run(id); } catch (_) {}
            try { delHist.run(id); } catch (_) {}
            del.run(id);
            deleted++;
          }
        });
        tx();
      }

      res.json({
        ok: true,
        applied: APPLY,
        groupsFound: plan.length,
        rowsToDelete: plan.reduce((n, p) => n + p.deleteIds.length, 0),
        rowsDeleted: deleted,
        plan,
        message: APPLY
          ? `Deleted ${deleted} duplicate row(s) across ${plan.length} group(s). Restart server to enable the UNIQUE index.`
          : `Found ${plan.length} duplicate group(s). Pass ?apply=1 to delete.`,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/trades/sync — Auto-sync filled broker orders into journal
  // (Logic lives in src/broker/fills-sync.js so the scheduler job can reuse it.)
  // Runs both the order-centric sync (last 7d of filled BUYs) AND the
  // position-centric reconcile (every broker position not already in trades).
  router.post('/trades/sync', async (req, res) => {
    try {
      const { synced, exited, backfilled, reconciled } = await syncBrokerFills();
      const parts = [
        `Synced ${synced.length} entries`,
        `${exited.length} exits`,
      ];
      if (backfilled) parts.push(`backfilled sector on ${backfilled} trades`);
      if (reconciled?.reconciled?.length) {
        parts.push(`reconciled ${reconciled.reconciled.length} orphan position(s) from broker`);
      }
      if (reconciled?.stillOrphan?.length) {
        parts.push(`${reconciled.stillOrphan.length} still orphaned (see logs)`);
      }
      res.json({ synced, exited, backfilled, reconciled, message: parts.join(', ') });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Tier 3: Scaling actions (preview pending partial-exits) ──────────────
  router.get('/trades/scaling/pending', async (req, res) => {
    try {
      const { scanOpenPositionsForScaling } = require('../risk/scaling');
      // Use the manager cascade so scaling preview survives a single-provider outage.
      const { getQuotes } = require('../data/providers/manager');
      const trades = db.prepare('SELECT DISTINCT symbol FROM trades WHERE exit_date IS NULL').all();
      if (!trades.length) return res.json({ pending: [] });
      const symbols = trades.map(t => t.symbol);
      const quotes = await getQuotes(symbols);
      const prices = {};
      for (const q of quotes) if (q.regularMarketPrice) prices[q.symbol] = q.regularMarketPrice;
      const pending = scanOpenPositionsForScaling(prices);
      res.json({ pending: pending.map(p => ({
        tradeId: p.trade.id,
        symbol: p.trade.symbol,
        entry: p.trade.entry_price,
        currentPrice: prices[p.trade.symbol],
        ...p.action,
      })) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/trades/:id/scale', (req, res) => {
    try {
      const { applyScalingAction, evaluateScalingAction } = require('../risk/scaling');
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(+req.params.id);
      if (!trade) return res.status(404).json({ error: 'Trade not found' });
      const { currentPrice, action: forcedAction } = req.body;
      const action = forcedAction || evaluateScalingAction(trade, currentPrice);
      if (!action) return res.json({ message: 'No action available at this price' });
      const result = applyScalingAction(+req.params.id, action);
      notifyTradeEvent({ event: action.action === 'full_exit' ? 'auto_stop' : 'scale_out', symbol: trade.symbol, details: { shares: action.shares, price: currentPrice, reason: action.reason, level: action.level } }).catch(e => console.error('Notification error:', e.message));
      res.json({ ok: true, action: result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Tier 5: Performance Attribution (beta/sector/stock-alpha decomposition)
  router.get('/trades/attribution', (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const result = attributePerformance({ startDate, endDate });
      if (!result.totalTrades) return res.json({ message: 'No closed trades', totalTrades: 0 });
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Journal Analytics ────────────────────────────────────────────────────
  // Aggregate analytics across all closed trades for pattern discovery

  // GET /api/trades/journal/streaks — Win/loss streak analysis
  router.get('/trades/journal/streaks', (req, res) => {
    try {
      const closed = db.prepare(
        'SELECT * FROM trades WHERE exit_date IS NOT NULL ORDER BY exit_date, entry_date'
      ).all();
      if (!closed.length) return res.json({ message: 'No closed trades' });

      let currentStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
      let streakType = null;
      const streaks = [];

      for (const t of closed) {
        const win = (t.pnl_percent || 0) > 0;
        if (streakType === null || win !== streakType) {
          if (currentStreak > 0) streaks.push({ type: streakType ? 'win' : 'loss', length: currentStreak });
          streakType = win;
          currentStreak = 1;
        } else {
          currentStreak++;
        }
        if (win && currentStreak > maxWinStreak)   maxWinStreak = currentStreak;
        if (!win && currentStreak > maxLossStreak) maxLossStreak = currentStreak;
      }
      if (currentStreak > 0) streaks.push({ type: streakType ? 'win' : 'loss', length: currentStreak });

      // Current streak
      const current = streaks[streaks.length - 1] || null;

      res.json({
        maxWinStreak, maxLossStreak,
        currentStreak: current,
        avgWinStreak: streaks.filter(s => s.type === 'win').length
          ? +(streaks.filter(s => s.type === 'win').reduce((a, s) => a + s.length, 0) /
              streaks.filter(s => s.type === 'win').length).toFixed(1) : 0,
        avgLossStreak: streaks.filter(s => s.type === 'loss').length
          ? +(streaks.filter(s => s.type === 'loss').reduce((a, s) => a + s.length, 0) /
              streaks.filter(s => s.type === 'loss').length).toFixed(1) : 0,
        recentStreaks: streaks.slice(-10),
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/trades/journal/monthly — Monthly P&L breakdown
  router.get('/trades/journal/monthly', (req, res) => {
    try {
      const closed = db.prepare(
        'SELECT * FROM trades WHERE exit_date IS NOT NULL ORDER BY exit_date'
      ).all();
      if (!closed.length) return res.json({ message: 'No closed trades', months: [] });

      const months = {};
      let cumPnl = 0;
      for (const t of closed) {
        const m = t.exit_date.slice(0, 7);
        if (!months[m]) months[m] = { pnl: 0, trades: 0, wins: 0, bestR: -Infinity, worstR: Infinity };
        months[m].pnl += (t.pnl_dollars || 0);
        months[m].trades++;
        if ((t.pnl_percent || 0) > 0) months[m].wins++;
        const r = t.r_multiple || 0;
        if (r > months[m].bestR)  months[m].bestR = r;
        if (r < months[m].worstR) months[m].worstR = r;
      }

      const result = Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => {
        cumPnl += v.pnl;
        return {
          month,
          pnl:      +v.pnl.toFixed(2),
          cumPnl:   +cumPnl.toFixed(2),
          trades:   v.trades,
          winRate:  +((v.wins / v.trades) * 100).toFixed(1),
          bestR:    v.bestR === -Infinity ? 0 : +v.bestR.toFixed(2),
          worstR:   v.worstR === Infinity ? 0 : +v.worstR.toFixed(2),
        };
      });

      res.json({ months: result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/trades/journal/dayofweek — Performance by entry day of week
  router.get('/trades/journal/dayofweek', (req, res) => {
    try {
      const closed = db.prepare(
        'SELECT * FROM trades WHERE exit_date IS NOT NULL'
      ).all();
      if (!closed.length) return res.json({ message: 'No closed trades' });

      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const byDay = {};
      for (const t of closed) {
        const d = days[new Date(t.entry_date + 'T12:00:00').getDay()];
        if (!byDay[d]) byDay[d] = { trades: 0, wins: 0, pnl: 0, totalR: 0 };
        byDay[d].trades++;
        if ((t.pnl_percent || 0) > 0) byDay[d].wins++;
        byDay[d].pnl += (t.pnl_dollars || 0);
        byDay[d].totalR += (t.r_multiple || 0);
      }

      const result = {};
      for (const [day, v] of Object.entries(byDay)) {
        result[day] = {
          trades:  v.trades,
          winRate: +((v.wins / v.trades) * 100).toFixed(1),
          pnl:     +v.pnl.toFixed(2),
          avgR:    +(v.totalR / v.trades).toFixed(2),
        };
      }

      res.json({ byDayOfWeek: result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/trades/journal/exit-reasons — Performance by exit reason
  router.get('/trades/journal/exit-reasons', (req, res) => {
    try {
      const closed = db.prepare(
        'SELECT * FROM trades WHERE exit_date IS NOT NULL'
      ).all();
      if (!closed.length) return res.json({ message: 'No closed trades' });

      const byReason = {};
      for (const t of closed) {
        const reason = t.exit_reason || 'unspecified';
        if (!byReason[reason]) byReason[reason] = { trades: 0, wins: 0, pnl: 0, totalR: 0 };
        byReason[reason].trades++;
        if ((t.pnl_percent || 0) > 0) byReason[reason].wins++;
        byReason[reason].pnl += (t.pnl_dollars || 0);
        byReason[reason].totalR += (t.r_multiple || 0);
      }

      const result = {};
      for (const [reason, v] of Object.entries(byReason)) {
        result[reason] = {
          trades:  v.trades,
          winRate: +((v.wins / v.trades) * 100).toFixed(1),
          pnl:     +v.pnl.toFixed(2),
          avgR:    +(v.totalR / v.trades).toFixed(2),
        };
      }

      res.json({ byExitReason: result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/trades/journal/rs-band — Performance by entry RS band
  router.get('/trades/journal/rs-band', (req, res) => {
    try {
      const closed = db.prepare(
        'SELECT * FROM trades WHERE exit_date IS NOT NULL'
      ).all();
      if (!closed.length) return res.json({ message: 'No closed trades' });

      const byBand = {};
      for (const t of closed) {
        const rs = t.entry_rs || 0;
        let band;
        if (rs >= 90) band = 'RS 90-99';
        else if (rs >= 80) band = 'RS 80-89';
        else if (rs >= 70) band = 'RS 70-79';
        else if (rs >= 50) band = 'RS 50-69';
        else band = 'RS <50';
        if (!byBand[band]) byBand[band] = { trades: 0, wins: 0, pnl: 0, totalR: 0 };
        byBand[band].trades++;
        if ((t.pnl_percent || 0) > 0) byBand[band].wins++;
        byBand[band].pnl += (t.pnl_dollars || 0);
        byBand[band].totalR += (t.r_multiple || 0);
      }

      const result = {};
      for (const [band, v] of Object.entries(byBand)) {
        result[band] = {
          trades:  v.trades,
          winRate: +((v.wins / v.trades) * 100).toFixed(1),
          pnl:     +v.pnl.toFixed(2),
          avgR:    +(v.totalR / v.trades).toFixed(2),
        };
      }

      res.json({ byRsBand: result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/trades/performance — Win rate, profit factor, R-multiples
  router.get('/trades/performance', (req, res) => {
    try {
      const closed = db.prepare(
        'SELECT * FROM trades WHERE exit_date IS NOT NULL ORDER BY exit_date DESC'
      ).all();

      if (!closed.length) return res.json({ message: 'No closed trades yet', trades: 0 });

      const wins  = closed.filter(t => t.pnl_percent > 0);
      const losses = closed.filter(t => t.pnl_percent <= 0);

      const totalPnl   = closed.reduce((s, t) => s + (t.pnl_dollars || 0), 0);
      const grossWins   = wins.reduce((s, t) => s + (t.pnl_dollars || 0), 0);
      const grossLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl_dollars || 0), 0));

      const avgRMultiple = closed.reduce((s, t) => s + (t.r_multiple || 0), 0) / closed.length;
      const avgWinR   = wins.length ? wins.reduce((s, t) => s + (t.r_multiple || 0), 0) / wins.length : 0;
      const avgLossR  = losses.length ? losses.reduce((s, t) => s + (t.r_multiple || 0), 0) / losses.length : 0;

      // Kelly from actual performance
      const winRate = wins.length / closed.length;
      const avgWinPct = wins.length ? wins.reduce((s, t) => s + t.pnl_percent, 0) / wins.length : 0;
      const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.pnl_percent, 0) / losses.length : 0;
      const kellyPct = kellyOptimal(winRate, avgWinPct, avgLossPct, closed.length);

      res.json({
        totalTrades: closed.length,
        winRate: +(winRate * 100).toFixed(1),
        wins: wins.length,
        losses: losses.length,
        totalPnl: +totalPnl.toFixed(2),
        grossWins: +grossWins.toFixed(2),
        grossLosses: +grossLosses.toFixed(2),
        profitFactor: grossLosses > 0 ? +(grossWins / grossLosses).toFixed(2) : Infinity,
        avgRMultiple: +avgRMultiple.toFixed(2),
        avgWinR: +avgWinR.toFixed(2),
        avgLossR: +avgLossR.toFixed(2),
        avgWinPct: +avgWinPct.toFixed(2),
        avgLossPct: +avgLossPct.toFixed(2),
        kellyOptimalPct: kellyPct,
        recentTrades: closed.slice(0, 10).map(t => ({
          symbol: t.symbol, entry_date: t.entry_date, exit_date: t.exit_date,
          pnl_percent: t.pnl_percent, r_multiple: t.r_multiple, exit_reason: t.exit_reason,
        })),
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Phase 1: Portfolio Alpha Tracking ──────────────────────────────────────

  router.get('/portfolio/alpha', async (req, res) => {
    try {
      const { generateAlphaReport } = require('../risk/alpha-tracker');
      const windowDays = parseInt(req.query.window) || 30;
      const report = generateAlphaReport(windowDays);
      res.json(report);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/portfolio/equity-curve', (req, res) => {
    try {
      const { getEquitySnapshots } = require('../risk/alpha-tracker');
      const { start, end } = req.query;
      const snapshots = getEquitySnapshots(start, end);
      res.json({ snapshots, count: snapshots.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/portfolio/equity-snapshot', async (req, res) => {
    try {
      const { recordEquitySnapshot } = require('../risk/alpha-tracker');
      const { equity, cashFlow = 0, spyClose, openPositions, heatPct } = req.body;
      if (!equity) return res.status(400).json({ error: 'equity required' });

      // Auto-fetch SPY close if not provided
      let spyPrice = spyClose;
      if (!spyPrice) {
        try {
          const { getQuotes } = require('../data/providers/manager');
          const quotes = await getQuotes(['SPY']);
          spyPrice = quotes?.[0]?.price || null;
        } catch (_) {}
      }

      const snapshot = recordEquitySnapshot(equity, cashFlow, spyPrice, openPositions, heatPct);
      res.json(snapshot);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Manual trigger: scan equity_snapshots for stale-SPY rows (spy_close
  // exactly matching prior trading day) and overwrite them with the real
  // settled close from history. UI can call this when the diagnostic
  // banner flags rows the daily-path guard couldn't prevent because they
  // pre-date the guard. Safe to call anytime — idempotent and only writes
  // when the historical close actually differs from the stored stale value.
  router.post('/portfolio/correct-stale-spy', async (req, res) => {
    try {
      const { correctStaleSpyRows } = require('../risk/alpha-tracker');
      const result = await correctStaleSpyRows();
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Manual trigger for journal/broker drift reconcile. Closes any open
  // journal row whose symbol Alpaca reports zero qty on, using the most
  // recent broker sell-fill within 90 days as the close price. Same logic
  // the broker_fills_sync cron runs every 15 min — this just lets the user
  // force it without waiting. dryRun=true returns the plan without writing.
  router.post('/portfolio/reconcile-zombies', async (req, res) => {
    try {
      const { reconcileZombieJournalRows } = require('../broker/fills-sync');
      const result = await reconcileZombieJournalRows({ dryRun: !!req.body?.dryRun });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Manual trigger for journal→broker stop sync. Ensures every open journal
  // row has a matching broker sell-stop at the journal's stop_price. Patches
  // mismatched legs, creates new stops where none exist, never loosens.
  // Same logic the broker_fills_sync cron runs every 15 min.
  router.post('/portfolio/sync-broker-stops', async (req, res) => {
    try {
      const { syncJournalStopsToBroker } = require('../broker/stops-sync');
      const result = await syncJournalStopsToBroker({ dryRun: !!req.body?.dryRun });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/portfolio/alpha/rolling', (req, res) => {
    try {
      const { calculateRollingSharpe, calculateRollingSortino, getEquitySnapshots } = require('../risk/alpha-tracker');
      const window = parseInt(req.query.window) || 30;
      const snapshots = getEquitySnapshots();
      if (!snapshots.length) return res.json({ sharpe: [], sortino: [], window, error: 'No equity snapshots' });
      const sharpe = calculateRollingSharpe(snapshots, window);
      const sortino = calculateRollingSortino(snapshots, window);
      res.json({ sharpe, sortino, window });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Phase 2: Scale-In Routes ───────────────────────────────────────────────

  router.post('/trades/:id/scale-in', (req, res) => {
    try {
      const { createScaleInPlan } = require('../risk/scale-in');
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(+req.params.id);
      if (!trade) return res.status(404).json({ error: 'Trade not found' });
      if (trade.exit_date) return res.status(400).json({ error: 'Trade already closed' });

      const plan = createScaleInPlan({
        tradeId: trade.id,
        symbol: trade.symbol,
        totalShares: req.body.totalShares || trade.shares || trade.initial_shares,
        entryPrice: trade.entry_price,
        stopPrice: trade.stop_price,
        target1: trade.target1,
        target2: trade.target2,
        ...req.body,
      });

      // Link trade to plan
      db.prepare('UPDATE trades SET scale_in_plan_id = ? WHERE id = ?').run(plan.id, trade.id);
      res.json(plan);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/trades/:id/scale-in', (req, res) => {
    try {
      const { getScaleInPlan } = require('../risk/scale-in');
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(+req.params.id);
      if (!trade?.scale_in_plan_id) return res.status(404).json({ error: 'No scale-in plan for this trade' });
      const plan = getScaleInPlan(trade.scale_in_plan_id);
      res.json(plan);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/trades/:id/scale-in/trigger', (req, res) => {
    try {
      const { fillTranche, getScaleInPlan } = require('../risk/scale-in');
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(+req.params.id);
      if (!trade?.scale_in_plan_id) return res.status(404).json({ error: 'No scale-in plan for this trade' });

      const plan = getScaleInPlan(trade.scale_in_plan_id);
      const fillPrice = req.body.fillPrice || trade.entry_price;
      const result = fillTranche(plan.id, plan.current_tranche, fillPrice);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
