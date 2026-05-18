// ─── Trade Architect routes ──────────────────────────────────────────────
// Stage 4 (Dossier) + Stage 5 (Sizing) data plane.
//
//   GET    /api/dossiers           — list all dossiers (newest first)
//   GET    /api/dossiers/:ticker   — fetch single dossier
//   PUT    /api/dossiers/:ticker   — upsert dossier JSON
//   DELETE /api/dossiers/:ticker   — delete dossier
//   GET    /api/themes             — list themes (union of curated + user-added)
//   PUT    /api/themes             — add a new theme (body: {theme})
//
// Sizing math lives on the client (reads dossier + portfolio config). The
// server side here is the data store only — keeps the math transparent
// and re-runnable as the user tweaks pivot / stop in the UI.

const express = require('express');
const router  = express.Router();

const {
  listDossiers, getDossier, upsertDossier, deleteDossier,
  listThemes, addTheme,
} = require('../data/dossiers-store');

router.use(express.json());

router.get('/dossiers', (req, res) => {
  try {
    res.json({ dossiers: listDossiers() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/dossiers/:ticker', (req, res) => {
  try {
    const d = getDossier(req.params.ticker);
    if (!d) return res.status(404).json({ error: 'not found' });
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/dossiers/:ticker', (req, res) => {
  try {
    res.json(upsertDossier(req.params.ticker, req.body || {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/dossiers/:ticker', (req, res) => {
  try {
    res.json(deleteDossier(req.params.ticker));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/themes', (req, res) => {
  try {
    res.json({ themes: listThemes() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/themes', (req, res) => {
  try {
    res.json(addTheme(req.body?.theme));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
