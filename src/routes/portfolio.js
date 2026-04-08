// ─── /api/portfolio/* and /api/trades/* routes ──────────────────────────────
// NEW: Risk management, position sizing, trade journal
const express = require('express');
const router  = express.Router();

const { calculatePositionSize, kellyOptimal } = require('../risk/position-sizer');
const {
  getConfig, updateConfig,
  getPortfolioHeat, getSectorExposure, getCorrelationRisk,
  getDrawdownStatus, preTradeCheck,
} = require('../risk/portfolio');
const { getMarketRegime } = require('../risk/regime');
const { createStopAlert, deactivateAlertsForTrade } = require('../broker/alerts');
const alpaca = require('../broker/alpaca');

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
      const drawdown = getDrawdownStatus(config.accountSize);
      const regime = await getMarketRegime();

      // Fetch live broker data for accurate dashboard
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
        // Build enriched broker positions with local trade data
        const tradeMap = {};
        for (const t of openPositions) tradeMap[t.symbol] = t;
        brokerPositions = positions.map(p => {
          const local = tradeMap[p.symbol];
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
            localStop:     local?.stop_price || null,
            localTarget1:  local?.target1 || null,
            sector:        local?.sector || null,
            inJournal:     !!local,
          };
        });
      } catch (_) { /* broker unavailable — fall back to local-only */ }

      res.json({
        heat,
        exposure,
        drawdown,
        regime: { mode: regime.regime, sizeMultiplier: regime.sizeMultiplier },
        openPositions: openPositions.length,
        config,
        broker,
        brokerPositions,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Position Sizer ────────────────────────────────────────────────────────
  router.post('/portfolio/size', async (req, res) => {
    try {
      const { entryPrice, stopPrice } = req.body;
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
      });
      res.json({ ...sizing, regime: regime.regime });
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
        entry_rs, entry_sepa, entry_regime, wave, sector, notes,
      } = req.body;
      if (!symbol || !entry_price) return res.status(400).json({ error: 'symbol and entry_price required' });

      const stmt = db.prepare(`
        INSERT INTO trades (symbol, side, entry_date, entry_price, stop_price, target1, target2,
                           shares, entry_rs, entry_sepa, entry_regime, wave, sector, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        symbol.toUpperCase(), side, entry_date || new Date().toISOString().split('T')[0],
        entry_price, stop_price, target1, target2,
        shares, entry_rs, entry_sepa, entry_regime, wave, sector, notes,
      );
      // Auto-create stop alert if stop_price is set
      if (stop_price) {
        try { createStopAlert(result.lastInsertRowid); } catch (_) {}
      }

      res.json({ ok: true, id: result.lastInsertRowid });
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
      const risk = trade.entry_price - (trade.stop_price || trade.entry_price * 0.95);
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

      res.json({ ok: true, pnl_dollars, pnl_percent, r_multiple });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/trades — List trades
  router.get('/trades', (req, res) => {
    try {
      const { status = 'all', limit = 50 } = req.query;
      let query = 'SELECT * FROM trades';
      if (status === 'open') query += ' WHERE exit_date IS NULL';
      else if (status === 'closed') query += ' WHERE exit_date IS NOT NULL';
      query += ' ORDER BY entry_date DESC LIMIT ?';
      const trades = db.prepare(query).all(limit);
      res.json({ trades, count: trades.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/trades/sync — Auto-sync filled broker orders into journal
  router.post('/trades/sync', async (req, res) => {
    try {
      // Get recent filled orders from Alpaca (last 7 days)
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const orders = await alpaca.getOrders({ status: 'closed', limit: 100, after: since });
      const filled = orders.filter(o => o.status === 'filled' && o.side === 'buy');

      // Get existing trades with alpaca_order_id to avoid duplicates
      const existing = db.prepare('SELECT alpaca_order_id FROM trades WHERE alpaca_order_id IS NOT NULL').all();
      const existingIds = new Set(existing.map(t => t.alpaca_order_id));

      // Also match by symbol+date to avoid duplicates for manually logged trades
      const openTrades = db.prepare('SELECT symbol, entry_date FROM trades WHERE exit_date IS NULL').all();
      const openSymDates = new Set(openTrades.map(t => `${t.symbol}:${t.entry_date}`));

      const synced = [];
      const stmt = db.prepare(`
        INSERT INTO trades (symbol, side, entry_date, entry_price, shares, alpaca_order_id, needs_review, notes)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `);

      for (const order of filled) {
        if (existingIds.has(order.id)) continue;
        const fillDate = (order.filled_at || order.created_at).split('T')[0];
        if (openSymDates.has(`${order.symbol}:${fillDate}`)) continue;

        // Find matching staged order for stop/target data
        const staged = db.prepare(
          'SELECT stop_price, target1_price, target2_price, source, conviction_score FROM staged_orders WHERE alpaca_order_id = ?'
        ).get(order.id);

        stmt.run(
          order.symbol,
          order.side === 'buy' ? 'long' : 'short',
          fillDate,
          +order.filled_avg_price,
          +order.filled_qty,
          order.id,
          `[AUTO-SYNCED] Filled at $${(+order.filled_avg_price).toFixed(2)} via ${staged?.source || 'broker'}. Add your trade thesis and setup notes.`,
        );

        // If we have staged order data, update stop/target
        if (staged) {
          db.prepare('UPDATE trades SET stop_price=?, target1=?, target2=? WHERE alpaca_order_id=?')
            .run(staged.stop_price, staged.target1_price, staged.target2_price, order.id);
        }

        synced.push({ symbol: order.symbol, price: +order.filled_avg_price, qty: +order.filled_qty, date: fillDate });
      }

      // Also detect closed positions (sells) and auto-exit journal entries
      const sells = orders.filter(o => o.status === 'filled' && o.side === 'sell');
      const exited = [];
      for (const sell of sells) {
        const trade = db.prepare(
          'SELECT * FROM trades WHERE symbol = ? AND exit_date IS NULL AND side = ? ORDER BY entry_date DESC LIMIT 1'
        ).get(sell.symbol, 'long');
        if (!trade) continue;

        const exitDate = (sell.filled_at || sell.created_at).split('T')[0];
        const exitPrice = +sell.filled_avg_price;
        const pnl_dollars = (exitPrice - trade.entry_price) * (trade.shares || 0);
        const pnl_percent = +((exitPrice / trade.entry_price - 1) * 100).toFixed(2);
        const risk = trade.entry_price - (trade.stop_price || trade.entry_price * 0.95);
        const r_multiple = risk > 0 ? +((exitPrice - trade.entry_price) / risk).toFixed(2) : 0;

        db.prepare(`
          UPDATE trades SET exit_date=?, exit_price=?, exit_reason='auto_sync',
            pnl_dollars=?, pnl_percent=?, r_multiple=?, needs_review=1,
            notes=COALESCE(notes,'') || ? WHERE id=?
        `).run(exitDate, exitPrice, pnl_dollars, pnl_percent, r_multiple,
          `\n[AUTO-EXIT] Sold at $${exitPrice.toFixed(2)}. Update exit reason and review.`, trade.id);

        exited.push({ symbol: sell.symbol, exitPrice, pnl_percent });
      }

      res.json({ synced, exited, message: `Synced ${synced.length} entries, ${exited.length} exits` });
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
      const kellyPct = kellyOptimal(winRate, avgWinPct, avgLossPct);

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

  return router;
};
