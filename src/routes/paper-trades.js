// ─── Paper Trades routes ──────────────────────────────────────────────────
//
// Discretionary watchlist + paper P&L tracking. Distinct namespace from
// /api/staging (which goes to the broker) so the user can practice the
// hybrid Minervini-style workflow (judgment-overlay on systematic
// candidates) without committing capital.

const express = require('express');
const router = express.Router();

const {
  stagePaperTrade, listPaperTrades, getPaperTrade,
  closePaperTrade, cancelPaperTrade,
  autoCloseOnQuotes, getPaperStats,
} = require('../risk/paper-trades');

// POST /paper-trades — stage a new paper position
// Body: { symbol, themeTag?, entryPrice, stopPrice, target1Price?, target2Price?,
//          shares?, source?, notes?, entryDate? }
router.post('/paper-trades', (req, res) => {
  try {
    const trade = stagePaperTrade(req.body || {});
    res.status(201).json(trade);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /paper-trades?status=open|closed|cancelled&themeTag=...&limit=200
router.get('/paper-trades', (req, res) => {
  try {
    const { status, themeTag, limit } = req.query;
    res.json({
      trades: listPaperTrades({
        status: status || null,
        themeTag: themeTag || null,
        limit: +limit || 200,
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /paper-trades/stats?since=YYYY-MM-DD&themeTag=...
router.get('/paper-trades/stats', (req, res) => {
  try {
    res.json(getPaperStats({
      since: req.query.since || null,
      themeTag: req.query.themeTag || null,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /paper-trades/:id
router.get('/paper-trades/:id', (req, res) => {
  try {
    const t = getPaperTrade(+req.params.id);
    if (!t) return res.status(404).json({ error: 'Paper trade not found' });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /paper-trades/:id/close — manual close at user-supplied price
router.post('/paper-trades/:id/close', (req, res) => {
  try {
    const { exitPrice, exitReason, exitDate } = req.body || {};
    const t = closePaperTrade(+req.params.id, +exitPrice, exitReason || 'manual', exitDate || null);
    res.json(t);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /paper-trades/:id/cancel — change-of-mind before any move
router.post('/paper-trades/:id/cancel', (req, res) => {
  try {
    const t = cancelPaperTrade(+req.params.id, req.body?.reason);
    res.json(t);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /paper-trades/check — manual trigger for the auto-close cron
// (so the user doesn't have to wait for the daily fire to see a close).
router.post('/paper-trades/check', async (req, res) => {
  try {
    const result = await autoCloseOnQuotes();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
