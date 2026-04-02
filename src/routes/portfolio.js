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

      res.json({
        heat,
        exposure,
        drawdown,
        regime: { mode: regime.regime, sizeMultiplier: regime.sizeMultiplier },
        openPositions: openPositions.length,
        config,
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
      res.json({ ok: true, id: result.lastInsertRowid });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/trades/:id — Log exit
  router.put('/trades/:id', (req, res) => {
    try {
      const { exit_date, exit_price, exit_reason, notes } = req.body;
      if (!exit_price) return res.status(400).json({ error: 'exit_price required' });

      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
      if (!trade) return res.status(404).json({ error: 'Trade not found' });

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
