// ─── /api/daily-picks route ──────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const { getDB } = require('../data/database');
const { getRSTrend } = require('../signals/rs');
const { calcConviction, evaluateConvictionOverride } = require('../signals/conviction');
const { computeTradeSetup } = require('../signals/candidates');
const { getMarketRegime } = require('../risk/regime');
const { loadHistory, RS_HISTORY, SEC_HISTORY } = require('../data/store');
const { computeRotation } = require('../signals/rotation');
const { runETFScan } = require('../scanner');

function db() { return getDB(); }

module.exports = function(runRSScanFn, SECTOR_ETFS_ARG) {
  router.get('/daily-picks', async (req, res) => {
    try {
      const stocks  = await runRSScanFn();
      const history = loadHistory(RS_HISTORY);
      const regime  = await getMarketRegime();

      // Build rotation model for sector tilt in conviction scoring
      let rotationModel = null;
      try {
        if (SECTOR_ETFS_ARG) {
          const sectorData = await runETFScan(SECTOR_ETFS_ARG, SEC_HISTORY, 'SEC_');
          rotationModel = computeRotation(sectorData);
        }
      } catch (_) { /* non-critical — conviction works without rotation */ }

      const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 7));

      const ranked = stocks
        .filter(s => s.rsRank >= 60 && s.swingMomentum >= 40)
        .map(s => {
          const trend = getRSTrend(s.ticker, history);
          const { convictionScore, reasons } = calcConviction(s, trend, rotationModel);
          const swingSetup    = computeTradeSetup(s, 'swing');
          const positionSetup = computeTradeSetup(s, 'position');
          // Evaluate conviction override for weak regimes
          const convictionOverride = evaluateConvictionOverride(s, convictionScore, regime);
          return { ...s, rsTrend: trend, convictionScore, reasons, swingSetup, positionSetup, convictionOverride };
        })
        .sort((a, b) => b.convictionScore - a.convictionScore);

      const totalQualified = ranked.length;
      const picks = ranked.slice(0, limit);

      // Separate conviction overrides — stocks that deserve attention despite regime
      const convictionOverrides = ranked
        .filter(s => s.convictionOverride)
        .slice(0, 10);

      res.json({
        picks,
        convictionOverrides,
        totalQualified,
        regime,
        date: new Date().toISOString().split('T')[0],
        note: regime.swingOk === false
          ? 'BEAR REGIME — no new long setups recommended'
          : `${picks.length} of ${totalQualified} candidates ranked by conviction (RS + Accel + Momentum + SEPA)`,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Historical top-N picks from rs_snapshots (for cross-checking replay) ──
  // Returns top 7 conviction-proxy picks per day from stored snapshot data.
  // Uses the same composite score formula as the replay engine's conviction sort.
  router.get('/daily-picks/history', (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 365));
      const topN = Math.max(1, Math.min(20, parseInt(req.query.topN, 10) || 7));

      // Get distinct dates in descending order
      const dates = db().prepare(`
        SELECT DISTINCT date FROM rs_snapshots
        WHERE type = 'stock' AND date >= date('now', '-${days} days')
        ORDER BY date DESC
      `).all().map(r => r.date);

      if (!dates.length) return res.json({ history: [], dates: 0 });

      // Also get SPY data for regime detection
      const spyRows = db().prepare(`
        SELECT date, vs_ma50, vs_ma200 FROM rs_snapshots
        WHERE symbol = 'SPY' AND type = 'stock' AND date >= ?
        ORDER BY date
      `).all(dates[dates.length - 1]);
      const spyByDate = {};
      for (const r of spyRows) spyByDate[r.date] = r;

      const history = [];
      for (const date of dates) {
        // Detect regime for this date
        const spy = spyByDate[date];
        let regime = 'NEUTRAL';
        if (spy && spy.vs_ma50 != null && spy.vs_ma200 != null) {
          const above50 = spy.vs_ma50 > 0, above200 = spy.vs_ma200 > 0;
          if (above50 && above200) regime = 'BULL';
          else if (!above50 && above200) regime = 'NEUTRAL';
          else if (above50 && !above200) regime = 'CAUTION';
          else regime = 'CORRECTION';
        }

        // Get all stocks for this date, sorted by conviction proxy
        const stocks = db().prepare(`
          SELECT symbol, rs_rank, swing_momentum, sepa_score, stage, price,
                 vs_ma50, vs_ma200, volume_ratio, vcp_forming, rs_line_new_high,
                 atr_pct, rs_tf_alignment, accumulation_50
          FROM rs_snapshots
          WHERE type = 'stock' AND date = ? AND rs_rank >= 60
                AND swing_momentum >= 40 AND symbol != 'SPY'
          ORDER BY rs_rank DESC
        `).all(date);

        // Score and rank by conviction proxy (same formula as replay engine)
        const scored = stocks.map(s => {
          const score = (s.rs_rank || 0) * 0.25 + (s.swing_momentum || 0) * 0.20
            + (s.sepa_score || 0) * 2.5 + (s.rs_line_new_high ? 8 : 0)
            + (s.vcp_forming ? 6 : 0)
            + ((s.rs_tf_alignment || 0) >= 3 ? 8 : (s.rs_tf_alignment || 0) >= 2 ? 4 : 0)
            + ((s.accumulation_50 || 0) >= 1.2 ? 6 : 0);
          return { ...s, convictionProxy: +score.toFixed(1) };
        }).sort((a, b) => b.convictionProxy - a.convictionProxy);

        history.push({
          date,
          regime,
          longsPermitted: regime === 'BULL' || regime === 'NEUTRAL',
          picks: scored.slice(0, topN).map(s => ({
            symbol: s.symbol,
            price: s.price,
            rsRank: s.rs_rank,
            swingMomentum: s.swing_momentum,
            sepaScore: s.sepa_score,
            convictionProxy: s.convictionProxy,
            vsMA50: s.vs_ma50,
            atrPct: s.atr_pct,
          })),
        });
      }

      res.json({
        history,
        dates: dates.length,
        topN,
        note: 'Conviction proxy uses same formula as replay engine: RS*0.25 + Mom*0.20 + SEPA*2.5 + bonuses',
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
