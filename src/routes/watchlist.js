// ─── /api/watchlist CRUD routes ──────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const { loadWatchlist, saveWatchlist } = require('../data/store');

// GET /api/watchlist
router.get('/watchlist', (req, res) => {
  try {
    res.json({ watchlist: loadWatchlist() });
  } catch(e) { res.json({ watchlist: [] }); }
});

// POST /api/watchlist
router.post('/watchlist', (req, res) => {
  const { ticker, note, stage } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const wl = loadWatchlist();
  const existing = wl.findIndex(w => w.ticker === ticker.toUpperCase());
  const entry = { ticker: ticker.toUpperCase(), note: note||'', stage: stage||'watching', addedAt: new Date().toISOString() };
  if (existing >= 0) wl[existing] = entry; else wl.push(entry);
  saveWatchlist(wl);
  res.json({ ok: true, entry });
});

// DELETE /api/watchlist/:ticker
router.delete('/watchlist/:ticker', (req, res) => {
  const wl = loadWatchlist();
  const filtered = wl.filter(w => w.ticker !== req.params.ticker.toUpperCase());
  saveWatchlist(filtered);
  res.json({ ok: true });
});

module.exports = router;
