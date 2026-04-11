// ─── Core RS Scan Orchestrator ────────────────────────────────────────────────
// Fetches quotes + history for entire universe, computes all signals, returns ranked results.

const { cacheGet, cacheSet, TTL_QUOTE } = require('./data/cache');

// US market date (Eastern timezone) — avoids writing tomorrow's date when
// running after midnight UTC (8 PM ET during EDT, 7 PM ET during EST).
function marketDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
const { loadHistory, saveHistory, RS_HISTORY, SEC_HISTORY, IND_HISTORY } = require('./data/store');
const { getQuotes, getHistory, getHistoryFull, pLimit } = require('./data/providers/manager');
const { calcRS, calcRSWeekly, calcRSMonthly, rankToRS, rankBySector, getRSTrend, preGenerateHistoryFor, getTimeframeAlignment } = require('./signals/rs');
const { calcSwingMomentum, calcPeriodReturns, calcATR, volumeTrend, calcVolumeProfile } = require('./signals/momentum');
const { calcVCP }    = require('./signals/vcp');
const { calcRSLine } = require('./signals/rsline');
const { calcStage }  = require('./signals/stage');
const { calcEarningsDrift } = require('./signals/earningsDrift');
const { calcBeta } = require('./risk/position-sizer');

// ─── Core RS scan (shared, cached) ──────────────────────────────────────────
async function runRSScan(UNIVERSE, SECTOR_MAP) {
  const cached = cacheGet('rs:full', TTL_QUOTE);
  if (cached) return cached;

  const uniq = [...new Set([...UNIVERSE, 'SPY'])];
  console.log(`  RS scan: ${uniq.length} stocks...`);

  // Fetch quotes (multi-provider with fallback)
  const allQuotes = {};
  for (let i = 0; i < uniq.length; i += 20) {
    const batch = await getQuotes(uniq.slice(i, i + 20));
    for (const q of batch) allQuotes[q.symbol] = q;
  }

  // Fetch full OHLCV history (concurrent, 5 at a time, multi-provider)
  // Full bars needed for True ATR calculation; closes extracted for RS/momentum/VCP
  const barsMap = {};   // symbol → [{date, open, high, low, close, volume}, ...]
  const histMap = {};   // symbol → [close, close, ...] (legacy compat for RS/momentum/VCP)
  await pLimit(uniq.map(sym => async () => {
    try {
      const bars = await getHistoryFull(sym);
      if (bars && bars.length >= 63) {
        barsMap[sym] = bars;
        histMap[sym] = bars.map(b => b.close);
      }
    } catch(_) {
      // Fallback to close-only if full history unavailable
      try {
        const c = await getHistory(sym);
        if (c.length >= 63) histMap[sym] = c;
      } catch(_) {}
    }
  }), 5);

  // Pre-generate history on first run
  preGenerateHistoryFor(histMap, sym => sym, RS_HISTORY, 'stock');

  const spyCloses = histMap['SPY'] || [];

  const results = [];
  for (const sym of uniq) {
    const q = allQuotes[sym];
    if (!q?.regularMarketPrice) continue;
    const closes = histMap[sym] || [];
    const price  = q.regularMarketPrice;
    const ma50   = q.fiftyDayAverage;
    const ma200  = q.twoHundredDayAverage;
    const vsMA50  = ma50  ? +((price-ma50) /ma50 *100).toFixed(2) : null;
    const vsMA200 = ma200 ? +((price-ma200)/ma200*100).toFixed(2) : null;
    const distFromHigh = q.fiftyTwoWeekHigh ? +((q.fiftyTwoWeekHigh-price)/q.fiftyTwoWeekHigh).toFixed(4) : null;
    const periods = calcPeriodReturns(closes);
    const atr     = calcATR(barsMap[sym] || closes);  // True ATR from OHLCV bars, fallback to closes
    const atrPct  = atr && price ? +(atr/price*100).toFixed(2) : null;
    const swingMom  = calcSwingMomentum(closes, q);
    const ma150     = closes.length >= 150
      ? closes.slice(-150).reduce((a,b)=>a+b,0)/150 : null;
    const vsMA150   = ma150 ? +((price-ma150)/ma150*100).toFixed(2) : null;

    // SEPA Trend Template (Minervini) — all 8 rules
    const ma50AboveAll = ma50 && ma150 && ma200 ? (ma50 > ma150 && ma50 > ma200) : null;
    const sepa = {
      aboveMA200:      vsMA200 != null && vsMA200 > 0,
      aboveMA150:      vsMA150 != null && vsMA150 > 0,
      ma150AboveMA200: ma150 && ma200 ? ma150 > ma200 : null,
      ma200Rising:     (() => {
        if (closes.length < 252) return null;
        const ma200_4wAgo = closes.slice(-252,-228).reduce((a,b)=>a+b,0)/24;
        return ma200 > ma200_4wAgo * 1.001;
      })(),
      ma50AboveAll,
      aboveMA50:       vsMA50 != null && vsMA50 > 0,
      low30pctBelow:   q.fiftyTwoWeekLow && price ? (price - q.fiftyTwoWeekLow)/price >= 0.30 : null,
      priceNearHigh:   distFromHigh != null && distFromHigh <= 0.25,
    };
    const sepaScore = Object.values(sepa).filter(v => v === true).length;
    const rawRS         = calcRS(closes);
    const rawRSWeekly   = calcRSWeekly(closes);
    const rawRSMonthly  = calcRSMonthly(closes);
    const volumeProfile = calcVolumeProfile(barsMap[sym]);
    const volRatio = q.averageDailyVolume3Month ? +(q.regularMarketVolume/q.averageDailyVolume3Month).toFixed(2) : 1;

    // Parse earnings date
    let earningsDate = null;
    let daysToEarnings = null;
    const ts = q.earningsTimestamp || q.earningsTimestampStart;
    if (ts && ts > 0) {
      const ed = new Date(ts * 1000);
      const now2 = new Date();
      daysToEarnings = Math.round((ed - now2) / (1000 * 60 * 60 * 24));
      if (daysToEarnings >= -5 && daysToEarnings <= 90) {
        earningsDate = ed.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      }
    }

    const earningsDrift = calcEarningsDrift(barsMap[sym], daysToEarnings, q);
    const beta = calcBeta(closes, spyCloses, 90);

    const epsTrailing   = q.epsTrailingTwelveMonths || null;
    const epsForward    = q.epsForward || null;
    const epsGrowthEst  = epsTrailing && epsForward && epsTrailing > 0
      ? +((epsForward/epsTrailing - 1)*100).toFixed(1) : null;
    const pegRatio      = q.pegRatio || null;
    const trailingPE    = q.trailingPE || null;

    results.push({
      ticker: sym, name: q.shortName || sym,
      price, chg1d: q.regularMarketChangePercent,
      chg1w: periods.chg1w, chg1m: periods.chg1m,
      chg3m: periods.chg3m, chg6m: periods.chg6m,
      vsMA50, vsMA200, distFromHigh,
      w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
      ma50, ma200, atr, atrPct,
      volume: q.regularMarketVolume, avgVol: q.averageDailyVolume3Month,
      volumeRatio: volRatio,
      volumeSurge: volRatio >= 2.0 && (distFromHigh || 1) <= 0.05,
      sector: SECTOR_MAP[sym] || 'Unknown',
      mktCap: q.marketCap, fwdPE: q.forwardPE,
      epsTrailing, epsForward, epsGrowthEst,
      pegRatio, trailingPE,
      rawSwingMomentum: swingMom,
      earningsDate,
      daysToEarnings,
      earningsRisk: daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 14,
      volumeTrend: volumeTrend(q),
      ...calcVCP(closes),
      ma150, vsMA150,
      sepa, sepaScore,
      ...calcRSLine(closes, histMap['SPY'] || []),
      ...calcStage(closes, ma150),
      rawRS,
      rawRSWeekly,
      rawRSMonthly,
      volumeProfile,
      earningsDrift,
      beta,
    });
  }

  rankToRS(results);
  rankToRS(results, 'rawRSWeekly', 'rsRankWeekly');
  rankToRS(results, 'rawRSMonthly', 'rsRankMonthly');
  rankToRS(results, 'rawSwingMomentum', 'swingMomentum');
  rankBySector(results);
  // Multi-timeframe alignment count (0-3) — used by conviction + UI
  for (const s of results) {
    s.rsTimeframeAlignment = getTimeframeAlignment(s, 80);
  }
  results.sort((a,b) => b.rsRank - a.rsRank);

  // Save today's snapshot (use market date to avoid UTC→tomorrow issues)
  const today = marketDate();
  const snap  = {};
  for (const s of results) snap[s.ticker] = s.rsRank;
  saveHistory(RS_HISTORY, snap, today);

  // Persist scan_results for signal replay / backtest
  try {
    const { getDB } = require('./data/database');
    const { calcConviction } = require('./signals/conviction');
    const rsHist = loadHistory(RS_HISTORY);
    const { getRSTrend } = require('./signals/rs');
    const scanInsert = getDB().prepare(
      'INSERT OR REPLACE INTO scan_results (date, symbol, data, conviction_score) VALUES (?, ?, ?, ?)'
    );
    const scanTxn = getDB().transaction(() => {
      for (const s of results) {
        const rsTrend = getRSTrend(s.ticker, rsHist);
        const { convictionScore } = calcConviction(s, rsTrend);
        scanInsert.run(today, s.ticker, JSON.stringify(s), convictionScore);
      }
    });
    scanTxn();
  } catch (_) { /* non-critical */ }

  console.log(`  ✓ RS scan: ${results.length} stocks, snapshot saved ${today}`);

  cacheSet('rs:full', results);
  return results;
}

// ─── Sector/Industry scan helper ─────────────────────────────────────────────
async function runETFScan(etfs, histType, prefix, extraMap) {
  const symbols = etfs.map(s => s.t);
  const quotes  = await getQuotes(symbols);
  const histResults = await pLimit([...symbols, 'SPY'].map(sym => async () => ({ sym, closes: await getHistory(sym) })), 5);
  const histMap = {}; histResults.forEach(r => { if(r) histMap[r.sym] = r.closes; });
  const spyCloses = histMap['SPY'] || [];

  const result = quotes.map(q => {
    const meta = etfs.find(s => s.t === q.symbol) || {};
    const closes = histMap[q.symbol] || [];
    const price = q.regularMarketPrice;
    const ma50  = q.fiftyDayAverage;
    const ma200 = q.twoHundredDayAverage;
    const vsMA50  = ma50  ? +((price-ma50) /ma50 *100).toFixed(2) : null;
    const vsMA200 = ma200 ? +((price-ma200)/ma200*100).toFixed(2) : null;
    const periods = calcPeriodReturns(closes);
    const ma150 = closes.length >= 150 ? closes.slice(-150).reduce((a,b)=>a+b,0)/150 : null;
    return {
      symbol: q.symbol,
      name: meta.n,
      color: meta.color || undefined,
      sector: meta.sec || undefined,
      price, ma50, ma200, vsMA50, vsMA200,
      chg1d: q.regularMarketChangePercent,
      chg1w: periods.chg1w, chg1m: periods.chg1m,
      chg3m: periods.chg3m, chg6m: periods.chg6m,
      w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
      volume: q.regularMarketVolume,
      rawRS: calcRS(closes),
      rawSwingMomentum: calcSwingMomentum(closes, q),
      ...calcVCP(closes),
      ...calcRSLine(closes, spyCloses),
      ...calcStage(closes, ma150),
      ma150,
    };
  });

  rankToRS(result);
  rankToRS(result, 'rawSwingMomentum', 'swingMomentum');
  result.sort((a,b) => b.rsRank - a.rsRank);

  // Pre-generate history
  preGenerateHistoryFor(histMap, sym => prefix + sym, histType, prefix.replace('_','').toLowerCase() || 'stock');

  // Save today's snapshot (use market date to avoid UTC→tomorrow issues)
  const todayStr = marketDate();
  const snap = {};
  for (const r of result) snap[prefix + r.symbol] = r.rsRank;
  saveHistory(histType, snap, todayStr);

  // Attach RS trends
  const hist = loadHistory(histType);
  return result.map(r => ({
    ...r, rsTrend: getRSTrend(prefix + r.symbol, hist),
  }));
}

module.exports = { runRSScan, runETFScan };
