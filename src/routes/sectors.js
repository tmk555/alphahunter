// ─── /api/sectors, /api/industries, /api/industry-stocks routes ──────────────
const express = require('express');
const router  = express.Router();

const { runRSScan, runETFScan } = require('../scanner');
const { getRSTrendsBulk, RS_HISTORY, SEC_HISTORY, IND_HISTORY } = require('../data/store');
const { computeRotation, getSectorRotationHistory } = require('../signals/rotation');
const {
  computeLeadingEdge, computeThemes,
  listRotationPicks, markPick,
  runRotationAlert,
} = require('../signals/rotation-alert');

module.exports = function(SECTOR_ETFS, INDUSTRY_ETFS, INDUSTRY_STOCKS, UNIVERSE, SECTOR_MAP) {
  // /api/sectors
  router.get('/sectors', async (req, res) => {
    try {
      const sectorsOut = await runETFScan(SECTOR_ETFS, SEC_HISTORY, 'SEC_');
      res.json({ sectors: sectorsOut });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/sectors/rotation — Quantitative sector rotation model
  router.get('/sectors/rotation', async (req, res) => {
    try {
      const sectorsOut = await runETFScan(SECTOR_ETFS, SEC_HISTORY, 'SEC_');
      const rotation = computeRotation(sectorsOut);
      if (!rotation) return res.json({ error: 'Insufficient sector data for rotation model' });
      res.json(rotation);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/sectors/rotation/history — Historical sector rotation rankings
  router.get('/sectors/rotation/history', (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
      const history = getSectorRotationHistory(days);
      res.json({ days, snapshots: history.length, history });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/industries
  router.get('/industries', async (req, res) => {
    try {
      const industriesOut = await runETFScan(INDUSTRY_ETFS, IND_HISTORY, 'IND_');
      res.json({ industries: industriesOut });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // /api/rotation/leading-edge — industries rotating IN before the tilt
  // model has flagged them as "leading". Powers the UI banner and the
  // daily rotation_alert push. Computation is cheap (uses cached rotation
  // model + bulk RS trend lookup) but the underlying runETFScan does hit
  // the provider on first call after cache expiry.
  router.get('/rotation/leading-edge', async (req, res) => {
    try {
      const { leadingEdge, watching, risingWeak } = await computeLeadingEdge();
      res.json({
        asOf:        new Date().toISOString().slice(0, 10),
        leadingEdge,
        watching,
        risingWeak,
        counts: {
          leadingEdge: leadingEdge.length,
          watching:    watching.length,
          risingWeak:  risingWeak.length,
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // /api/rotation/themes — theme-level RS aggregation. Themes group
  // industries that share a macro driver (e.g. SMH/IGV/HACK/ROBO →
  // "AI / Compute"). Each theme carries member ETF list + mean current
  // rank + mean vs1w/vs1m/vs3m. Often leads the per-industry rotation by
  // 1-2 weeks because the market hits theme baskets before differentiating.
  router.get('/rotation/themes', async (req, res) => {
    try {
      const themes = await computeThemes();
      res.json({ asOf: new Date().toISOString().slice(0, 10), count: themes.length, themes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // /api/rotation/alerter/run — manually trigger the rotation_alert job.
  // Same computation the daily cron runs. Quality-of-life: lets the user
  // refresh Leading Edge + repopulate rotation_picks from the panel
  // header without trekking to Scheduler. Returns the same shape as the
  // cron handler so the caller can show "found N picks" toast inline.
  router.post('/rotation/alerter/run', async (req, res) => {
    try {
      const result = await runRotationAlert({});
      res.json({
        ok: true,
        date: result.date,
        leadingEdgeCount: result.leadingEdge.length,
        newAlerts: result.newAlerts.map(a => ({ etf: a.etf, name: a.name, picks: a.topPicks?.map(p => p.symbol) || [] })),
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // /api/rotation/picks — server-side queue of Leading-Edge stock picks
  // produced by the daily rotation_alert job. The Watchlist tab fetches
  // status=pending on load, auto-promotes to Tier 2, then POSTs accept on
  // each. Survives across browsers because it lives in SQLite, not
  // localStorage.
  router.get('/rotation/picks', (req, res) => {
    try {
      const status = req.query.status || 'pending';
      const picks = listRotationPicks({ status, sinceDays: 30 });
      res.json({ status, count: picks.length, picks });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/rotation/picks/:id/:action', express.json(), (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const action = req.params.action;
      const status = action === 'accept' ? 'accepted'
                   : action === 'dismiss' ? 'dismissed'
                   : null;
      if (!status) return res.status(400).json({ error: 'action must be accept|dismiss' });
      res.json(markPick(id, status));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // /api/industry-stocks/:etf
  router.get('/industry-stocks/:etf', async (req, res) => {
    try {
      const etf    = req.params.etf.toUpperCase();
      const tickers = INDUSTRY_STOCKS[etf] || [];
      const stocks  = await runRSScan(UNIVERSE, SECTOR_MAP);
      const filtered = tickers
        .map(t => stocks.find(s => s.ticker === t))
        .filter(Boolean);
      // Bulk trend lookup scoped to this industry's tickers — typically a
      // few dozen names, so the IN-clause path stays well under 200 rows
      // instead of loading the full 3.7M-row history.
      const trends = getRSTrendsBulk(RS_HISTORY, filtered.map(s => s.ticker));
      const result = filtered
        .map(s => ({ ...s, rsTrend: trends.get(s.ticker) || null }))
        .sort((a,b) => b.rsRank - a.rsRank);
      res.json({ etf, stocks: result, total: result.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
