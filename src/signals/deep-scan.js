// ─── Shared Deep Scan pipeline ─────────────────────────────────────────────
// Used by the /api/trade-setups/scan route (user-initiated) and the deep_scan
// scheduler job (auto-refresh). Keeping the pipeline in one place guarantees
// the UI, Morning Brief, and scheduler all see identical ranking.

const { isSwingCandidate, isPositionCandidate, computeTradeSetup } = require('./candidates');
const { calcConviction, evaluateConvictionOverride } = require('./conviction');
const { getRSTrend } = require('./rs');
const { loadHistory, RS_HISTORY, SEC_HISTORY } = require('../data/store');
const { computeRotation } = require('./rotation');
const { getMarketRegime } = require('../risk/regime');
const { getDB } = require('../data/database');

// Compute the enriched pick list. `stocks` must be the full RS-scan output
// (shape returned by src/scanner.runRSScan) — conviction needs the raw rows.
// `sectorEtfs` is optional — when provided, sector rotation is folded into
// convictionScore (matches the legacy Top Picks engine).
async function runDeepScan({ stocks, mode = 'both', sectorEtfs = null } = {}) {
  if (!Array.isArray(stocks) || !stocks.length) {
    return { results: [], regime: null, candidates: 0, totalInput: 0, convictionOverrides: [] };
  }

  const filter = mode === 'swing' ? isSwingCandidate
               : mode === 'position' ? isPositionCandidate
               : (s) => isSwingCandidate(s) || isPositionCandidate(s);
  // Tag each stock with which filter(s) it passed so the UI can render a
  // SWING / POSITION / BOTH badge per card (and the scheduler brief can pick
  // the right tradeType without re-evaluating the filters).
  const tagged = stocks.map(s => {
    const isSwing = isSwingCandidate(s);
    const isPos   = isPositionCandidate(s);
    const tradeTypes = [];
    if (isSwing) tradeTypes.push('swing');
    if (isPos)   tradeTypes.push('position');
    return { ...s, tradeTypes };
  });
  const candidates = tagged.filter(filter).slice(0, 20);
  const regime = await getMarketRegime();

  // Sector rotation — absorbed from the legacy Top Picks engine so the
  // unified scan factors industry leadership into convictionScore.
  let rotationModel = null;
  try {
    if (sectorEtfs) {
      const { runETFScan } = require('../scanner');
      const sectorData = await runETFScan(sectorEtfs, SEC_HISTORY, 'SEC_');
      rotationModel = computeRotation(sectorData);
    }
  } catch (_) { /* rotation is additive; carry on without it */ }

  let rsHistory = null;
  try { rsHistory = loadHistory(RS_HISTORY); } catch (_) {}

  const results = candidates.map(s => {
    let rsTrend = s.rsTrend || null;
    let convictionScore = s.convictionScore || 0;
    let reasons = [];
    if (rsHistory) {
      try {
        rsTrend = rsTrend || getRSTrend(s.ticker, rsHistory);
        const r = calcConviction(s, rsTrend, rotationModel);
        if (r.convictionScore != null) convictionScore = r.convictionScore;
        if (r.reasons) reasons = r.reasons;
      } catch (_) { /* fall back to whatever was on the stock */ }
    }
    const convictionOverride = evaluateConvictionOverride(s, convictionScore, regime);
    return {
      ...s,
      rsTrend,
      convictionScore,
      reasons,
      convictionOverride,
      tradeTypes: s.tradeTypes || [],
      swingSetup:    computeTradeSetup(s, 'swing'),
      positionSetup: computeTradeSetup(s, 'position'),
      algoSetup:     computeTradeSetup(s, mode === 'both' ? 'swing' : mode),
      brief: null,
    };
  });

  // Sort: conviction → RS rank (no AI-verdict ordering here — the route layer
  // adds that on top if briefs are present).
  results.sort((a, b) => {
    const ac = a.convictionScore || 0;
    const bc = b.convictionScore || 0;
    if (ac !== bc) return bc - ac;
    return (b.rsRank || 0) - (a.rsRank || 0);
  });

  const convictionOverrides = results.filter(r => r.convictionOverride).slice(0, 10);

  return {
    results,
    regime,
    candidates: candidates.length,
    totalInput: stocks.length,
    convictionOverrides,
  };
}

// Persist a scan result into deep_scan_cache. Keeps the most recent 10 runs.
function persistDeepScan({ mode, results, regime, scannedCount, totalInput }) {
  try {
    const db = getDB();
    const slim = results.map(r => ({
      ticker: r.ticker, name: r.name, price: r.price, sector: r.sector,
      rsRank: r.rsRank, swingMomentum: r.swingMomentum,
      tradeTypes: r.tradeTypes || [],
      sepaScore: r.sepaScore, stage: r.stage,
      vsMA50: r.vsMA50, vsMA200: r.vsMA200,
      atr: r.atr, atrPct: r.atrPct,
      distFromHigh: r.distFromHigh, volumeRatio: r.volumeRatio,
      volumeSurge: r.volumeSurge,
      vcpForming: r.vcpForming, rsLineNewHigh: r.rsLineNewHigh,
      ma50: r.ma50, ma200: r.ma200, ma150: r.ma150,
      convictionScore: r.convictionScore,
      convictionOverride: r.convictionOverride,
      rsTrend: r.rsTrend,
      swingSetup: r.swingSetup,
      positionSetup: r.positionSetup,
      algoSetup: r.algoSetup,
      brief: r.brief,
      bestPattern: r.bestPattern,
      earningsRisk: r.earningsRisk,
      daysToEarnings: r.daysToEarnings,
      earningsDate: r.earningsDate,
      institutionalTier: r.institutionalTier,
    }));
    db.prepare(`INSERT INTO deep_scan_cache (mode, results, regime, scanned_count, total_input) VALUES (?, ?, ?, ?, ?)`)
      .run(mode, JSON.stringify(slim), JSON.stringify(regime), scannedCount, totalInput);
    db.prepare(`DELETE FROM deep_scan_cache WHERE id NOT IN (SELECT id FROM deep_scan_cache ORDER BY created_at DESC LIMIT 10)`).run();
  } catch (_) { /* non-critical */ }
}

module.exports = { runDeepScan, persistDeepScan };
