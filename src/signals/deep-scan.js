// ─── Shared Deep Scan pipeline ─────────────────────────────────────────────
// Used by the /api/trade-setups/scan route (user-initiated) and the deep_scan
// scheduler job (auto-refresh). Keeping the pipeline in one place guarantees
// the UI, Morning Brief, and scheduler all see identical ranking.

const { isSwingCandidate, isPositionCandidate, computeTradeSetup } = require('./candidates');
const { calcConviction, evaluateConvictionOverride } = require('./conviction');
const { getRSTrendsBulk, RS_HISTORY, SEC_HISTORY } = require('../data/store');
const { computeRotation, computeIndustryRotation, getIndustryTilt } = require('./rotation');
const { getMarketRegime } = require('../risk/regime');
const { getDB } = require('../data/database');

// Compute the enriched pick list. `stocks` must be the full RS-scan output
// (shape returned by src/scanner.runRSScan) — conviction needs the raw rows.
// `sectorEtfs` is optional — when provided, sector rotation is folded into
// convictionScore (matches the legacy Top Picks engine).
// `industryEtfs` is the array from universe.INDUSTRY_ETFS (`{t,n,sec}` shape).
// When provided, industry rotation is computed as a secondary tilt on top
// of sector rotation — a stock in a leading industry within a leading
// sector gets both boosts stacked ("leading industry in a leading sector"
// is IBD's classic alpha signal).
async function runDeepScan({ stocks, mode = 'both', sectorEtfs = null, industryEtfs = null } = {}) {
  if (!Array.isArray(stocks) || !stocks.length) {
    return { results: [], regime: null, candidates: 0, totalInput: 0, convictionOverrides: [] };
  }

  const filter = mode === 'swing' ? isSwingCandidate
               : mode === 'position' ? isPositionCandidate
               : (s) => isSwingCandidate(s) || isPositionCandidate(s);

  // Attach rsTrend BEFORE filtering. The scanner (runRSScan) does NOT put
  // rsTrend on its output rows — it's only added inside scan_results
  // persistence and ETF scans. Without this step here, every filter call
  // sees `s.rsTrend === undefined` and the `rsRising` / `rsRisingMonth`
  // checks collapse to false, returning 0 candidates for every mode.
  // This was the root cause of "Deep Scan shows 0 results in Position mode".
  let trendMap = null;
  try { trendMap = getRSTrendsBulk(RS_HISTORY, stocks.map(s => s.ticker)); } catch (_) {}
  const withTrend = stocks.map(s => ({
    ...s,
    rsTrend: s.rsTrend || (trendMap ? (trendMap.get(s.ticker) || null) : null),
  }));

  // Tag each stock with which filter(s) it passed so the UI can render a
  // SWING / POSITION / BOTH badge per card (and the scheduler brief can pick
  // the right tradeType without re-evaluating the filters).
  const tagged = withTrend.map(s => {
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
  let industryRotationModel = null;
  try {
    if (sectorEtfs) {
      const { runETFScan } = require('../scanner');
      const sectorData = await runETFScan(sectorEtfs, SEC_HISTORY, 'SEC_');
      rotationModel = computeRotation(sectorData);
    }
  } catch (_) { /* rotation is additive; carry on without it */ }

  // Industry rotation — secondary signal on top of sector rotation.
  // Ranks the 27 industry ETFs (SMH, IGV, ITA, GRID, JETS, IYT, XHB, etc.)
  // and boosts stocks whose industry ETF is leading within a leading sector.
  // Smaller magnitude than sector tilt (±8% vs ±15%) because industry is
  // a narrower cut — we don't want a noisy industry rank overriding a
  // clean sector signal.
  try {
    if (industryEtfs && industryEtfs.length) {
      const { runETFScan } = require('../scanner');
      // Reuse the sector ETF history store — runETFScan just needs a writable
      // history slot, and industry ETFs don't collide with sector tickers.
      const industryData = await runETFScan(industryEtfs, SEC_HISTORY, 'IND_');
      industryRotationModel = computeIndustryRotation(industryEtfs, industryData);
    }
  } catch (_) { /* industry rotation is additive; carry on without it */ }

  // trendMap already built above (used for the pre-filter rsTrend attach).

  const results = candidates.map(s => {
    let rsTrend = s.rsTrend || null;
    let convictionScore = s.convictionScore || 0;
    let reasons = [];
    if (trendMap) {
      try {
        rsTrend = rsTrend || trendMap.get(s.ticker) || null;
        const r = calcConviction(s, rsTrend, rotationModel, industryRotationModel);
        if (r.convictionScore != null) convictionScore = r.convictionScore;
        if (r.reasons) reasons = r.reasons;
      } catch (_) { /* fall back to whatever was on the stock */ }
    }
    const convictionOverride = evaluateConvictionOverride(s, convictionScore, regime);
    const industryTilt = getIndustryTilt(s.sector, industryRotationModel);
    return {
      ...s,
      rsTrend,
      convictionScore,
      reasons,
      convictionOverride,
      industryTilt,   // multiplier (0.92 | 1.0 | 1.08) — for UI badges / sizing
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
    rotationModel,         // sector rotation (11 ETFs)
    industryRotationModel, // industry rotation (27 ETFs, sub-sector tilt)
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
      industryTilt: r.industryTilt,
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
