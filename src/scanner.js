// ─── Core RS Scan Orchestrator ────────────────────────────────────────────────
// Fetches quotes + history for entire universe, computes all signals, returns ranked results.

const { cacheGet, cacheSet, TTL_QUOTE } = require('./data/cache');

// US market date (Eastern timezone) — avoids writing tomorrow's date when
// running after midnight UTC (8 PM ET during EDT, 7 PM ET during EST).
function marketDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Is `date` a US-equity trading day? Defense-in-depth guard for the persistence
// sites below. Pre-fix, runRSScan unconditionally wrote rows dated marketDate()
// — so a manual /api/rs-scan hit, a runJobNow trigger from the scheduler UI,
// or any other non-cron entry point on a Saturday morning would persist
// weekend-dated rs_snapshots / scan_results rows. Those rows are Friday's last
// close re-stamped with a Saturday date, which:
//   • shifts MA windows by 1 (oldest bar drops, "Saturday" bar adds — but
//     Saturday's close == Friday's close, so the MA wobbles by 1/N which can
//     flip a few names across the 50MA threshold)
//   • makes MAX(date) FROM rs_snapshots return Saturday, so anything that
//     queries "today's snapshot" gets the synthetic weekend row
//   • polluted the user's universe with the SLAB Saturday-row case we just
//     traced — the row that wasn't supposed to exist
//
// This only checks Sat/Sun. Holiday detection is out of scope: the existing
// `30 16 * * 1-5` cron doesn't honor holidays either, so the bar is
// "weekday-aware" not "holiday-aware". The risk on a market holiday is
// limited to one bad row that gets cleaned up by INSERT OR IGNORE on the
// next trading day's run.
function isTradingDay(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return true; // fail-open
  // Construct as UTC noon to avoid any local-time DST edge — only the day-of-week matters.
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  return dow !== 0 && dow !== 6;
}
const { loadHistory, saveHistory, RS_HISTORY, SEC_HISTORY, IND_HISTORY } = require('./data/store');
const { getQuotes, getHistory, getHistoryFull, pLimit } = require('./data/providers/manager');
const { calcRS, calcRSWeekly, calcRSMonthly, rankToRS, rankBySector, getRSTrend, preGenerateHistoryFor, getTimeframeAlignment } = require('./signals/rs');
const { calcSwingMomentum, calcPeriodReturns, calcATR, volumeTrend, calcVolumeProfile } = require('./signals/momentum');
const { calcVCP }    = require('./signals/vcp');
const { calcRSLine } = require('./signals/rsline');
const { calcStage }  = require('./signals/stage');
const { calcSEPA }   = require('./signals/sepa');
const { calcEarningsDrift } = require('./signals/earningsDrift');
const { calcBeta } = require('./risk/position-sizer');
const { detectPatterns } = require('./signals/patterns');
const { detectUnusualVolume, detectDarkPoolProxy, computeInstitutionalScore, calcInstitutionalAdjustment } = require('./signals/institutional');
const { getDB } = require('./data/database');

// Writes detected patterns to pattern_detections table for replay/backtest use.
// One row per (symbol, date, pattern_type); upsert preserves today's latest confidence.
let _patternUpsertStmt = null;
function persistPatternDetections(symbol, patternData) {
  if (!patternData || !patternData.patterns) return;
  try {
    const db = getDB();
    if (!_patternUpsertStmt) {
      _patternUpsertStmt = db.prepare(`
        INSERT INTO pattern_detections (symbol, date, pattern_type, confidence, pivot_price, stop_price, details)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, date, pattern_type) DO UPDATE SET
          confidence  = excluded.confidence,
          pivot_price = excluded.pivot_price,
          stop_price  = excluded.stop_price,
          details     = excluded.details
      `);
    }
    const today = marketDate();
    for (const [type, p] of Object.entries(patternData.patterns)) {
      if (!p || !p.detected) continue;
      _patternUpsertStmt.run(
        symbol, today, type,
        p.confidence || 0,
        p.pivotPrice || null,
        p.stopPrice || null,
        JSON.stringify(p)
      );
    }
  } catch(_) { /* best-effort */ }
}

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
    // Distance below 52w low (mirror of distFromHigh, decimal). 0 = AT the low.
    // Used by breadth.js for the NYSE-style new-lows count.
    const distFromLow  = q.fiftyTwoWeekLow  ? +((price-q.fiftyTwoWeekLow)/q.fiftyTwoWeekLow).toFixed(4) : null;
    const periods = calcPeriodReturns(closes);
    const atr     = calcATR(barsMap[sym] || closes);  // True ATR from OHLCV bars, fallback to closes
    const atrPct  = atr && price ? +(atr/price*100).toFixed(2) : null;
    const swingMom  = calcSwingMomentum(closes, q);
    const ma150     = closes.length >= 150
      ? closes.slice(-150).reduce((a,b)=>a+b,0)/150 : null;
    const vsMA150   = ma150 ? +((price-ma150)/ma150*100).toFixed(2) : null;

    // SEPA Trend Template (Minervini) — all 8 rules
    const { sepa, ma50AboveAll } = calcSEPA(price, ma50, ma150, ma200, closes, distFromHigh, null);
    // Rule 7 (within 30% of 52-week low) is caller-patched — it needs w52l.
    sepa.low30pctBelow = q.fiftyTwoWeekLow && price ? (price - q.fiftyTwoWeekLow)/price >= 0.30 : null;
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
    const beta = calcBeta(closes, spyCloses, 252);

    // Enhanced pattern detection (v8)
    let patternData = { patterns: {}, patternCount: 0, bestPattern: null };
    try {
      patternData = detectPatterns(barsMap[sym] || [], closes, ma50, ma150, ma200);
      persistPatternDetections(sym, patternData);
    } catch(_) {}

    // Institutional flow proxy (v8)
    let institutionalData = null;
    try {
      if (barsMap[sym] && barsMap[sym].length >= 50) {
        const unusualVol = detectUnusualVolume(barsMap[sym], q.averageDailyVolume3Month);
        const darkPool = detectDarkPoolProxy(barsMap[sym]);
        institutionalData = computeInstitutionalScore(unusualVol, darkPool, null);
        institutionalData.unusualVolume = unusualVol;
        institutionalData.darkPool = darkPool;
      }
    } catch(_) {}

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
      vsMA50, vsMA200, distFromHigh, distFromLow,
      w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
      ma50, ma200, atr, atrPct,
      volume: q.regularMarketVolume, avgVol: q.averageDailyVolume3Month,
      volumeRatio: volRatio,
      volumeSurge: volRatio >= 2.0 && (distFromHigh || 1) <= 0.05,
      sector: SECTOR_MAP[sym] || 'Unknown',
      mktCap: q.marketCap, fwdPE: q.forwardPE,
      epsTrailing, epsForward, epsGrowthEst,
      pegRatio, trailingPE,
      swingMomentum: swingMom,
      earningsDate,
      daysToEarnings,
      earningsRisk: daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 14,
      volumeTrend: volumeTrend(q),
      // Pass full OHLCV bars so calcVCP engages textbook mode (intraday
      // high/low for pivot/stop + volume-drying confirmation). Falls back
      // to price-only checks when bars are missing.
      ...calcVCP(closes, barsMap[sym]),
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
      patternData,
      bestPattern: patternData.bestPattern,
      patternCount: patternData.patternCount,
      institutionalData,
      institutionalScore: institutionalData?.institutionalScore || null,
      institutionalTier: institutionalData?.tier || null,
    });
  }

  rankToRS(results);
  rankToRS(results, 'rawRSWeekly', 'rsRankWeekly');
  rankToRS(results, 'rawRSMonthly', 'rsRankMonthly');
  rankBySector(results);
  // Multi-timeframe alignment count (0-3) — used by conviction + UI
  for (const s of results) {
    s.rsTimeframeAlignment = getTimeframeAlignment(s, 80);
  }

  // ── Stage transition detection ──────────────────────────────────────────
  // Look up each stock's prior-day stage from rs_snapshots so we can flag
  // S1→S2 breakouts (fresh uptrend entries) in the conviction scorer and UI.
  try {
    const { getDB } = require('./data/database');
    const priorDate = getDB().prepare(
      `SELECT MAX(date) as date FROM rs_snapshots WHERE date < ? AND type = 'stock'`
    ).get(today)?.date;
    if (priorDate) {
      const priorRows = getDB().prepare(
        `SELECT symbol, stage FROM rs_snapshots WHERE date = ? AND type = 'stock' AND stage IS NOT NULL`
      ).all(priorDate);
      const priorMap = {};
      for (const r of priorRows) priorMap[r.symbol] = r.stage;
      for (const s of results) {
        s.priorStage = priorMap[s.ticker] ?? null;
      }
    }
  } catch (_) {
    // Non-critical — priorStage will be null on first run
  }

  // ── Attach latest analyst revision score for conviction bonus ──────────
  // The revision engine runs on its own cron; it stores per-symbol scores
  // in revision_scores. We read the latest row per symbol and attach it
  // to each scan row so conviction.js's +6 upgrade bonus actually fires,
  // and the Scanner UI can show a REV↑ badge without a separate API call.
  try {
    const { getDB } = require('./data/database');
    const revRows = getDB().prepare(`
      SELECT symbol, revision_score, direction, tier
      FROM revision_scores
      WHERE date >= date('now', '-14 days')
      GROUP BY symbol
      HAVING date = MAX(date)
    `).all();
    const revMap = {};
    for (const r of revRows) revMap[r.symbol] = r;
    for (const s of results) {
      const r = revMap[s.ticker];
      if (r) {
        s.revisionData = { revisionScore: r.revision_score, direction: r.direction, tier: r.tier };
        s.revisionScore = r.revision_score;
        s.revisionTier = r.tier;
      }
    }
  } catch (_) { /* revision_scores table may not exist on first run */ }

  results.sort((a,b) => b.rsRank - a.rsRank);

  // Save today's snapshot (use market date to avoid UTC→tomorrow issues)
  const today = marketDate();

  // Trading-day guard: skip persistence on Sat/Sun even if the scan was
  // triggered (e.g. via /api/rs-scan, runJobNow). The fresh `results` are
  // still returned to the caller for live display — we just don't pollute
  // rs_snapshots / scan_results with weekend-dated rows that aren't real
  // market data. See isTradingDay() comment for the full rationale.
  if (isTradingDay(today)) {
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
  } else {
    console.log(`  runRSScan: skipping persistence for non-trading day ${today} (returning live results only)`);
  }

  // Sync universe tracker — captures additions/removals for survivorship-bias-free backtesting
  try {
    const { syncUniverse } = require('./signals/universe-tracker');
    const syncResult = syncUniverse(UNIVERSE, SECTOR_MAP);
    if (syncResult.added || syncResult.removed) {
      console.log(`  ✓ Universe sync: +${syncResult.added} / -${syncResult.removed} (total ${syncResult.total})`);
    }
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
      swingMomentum: calcSwingMomentum(closes, q),
      ...calcVCP(closes),
      ...calcRSLine(closes, spyCloses),
      ...calcStage(closes, ma150),
      ma150,
    };
  });

  rankToRS(result);
  result.sort((a,b) => b.rsRank - a.rsRank);

  // Pre-generate history
  preGenerateHistoryFor(histMap, sym => prefix + sym, histType, prefix.replace('_','').toLowerCase() || 'stock');

  // Save today's snapshot (use market date to avoid UTC→tomorrow issues)
  // Same trading-day guard as the stock-RS persistence above — keeps
  // weekend-dated sector/industry rows out of rs_snapshots even when the
  // scan is triggered manually on a non-trading day.
  const todayStr = marketDate();
  if (isTradingDay(todayStr)) {
    const snap = {};
    for (const r of result) snap[prefix + r.symbol] = r.rsRank;
    saveHistory(histType, snap, todayStr);
  }

  // Attach RS trends
  const hist = loadHistory(histType);
  return result.map(r => ({
    ...r, rsTrend: getRSTrend(prefix + r.symbol, hist),
  }));
}

module.exports = { runRSScan, runETFScan };
