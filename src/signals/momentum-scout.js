// ─── Momentum Scout — discover breakout stocks outside the core universe ────
// Problem: a curated 500-stock universe gives quality signals but misses
// momentum breakouts from stocks not yet in the universe (think SMCI, RKLB).
// This module scans a broader "expansion watchlist" for momentum criteria
// and surfaces candidates for potential universe inclusion.

const { getQuotes, getHistory } = require('../data/providers/manager');
const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Expansion Watchlist ────────────────────────────────────────────────────
// Stocks NOT in the core universe but worth monitoring for momentum breakouts.
// Categories: recent IPOs, mid-cap growth, sector disruptors, turnarounds.
// This list should be refreshed monthly with new names from IPO calendars,
// earnings movers, and sector scans.

const EXPANSION_WATCHLIST = {
  // Recent IPOs / SPACs with momentum potential
  RKLB: 'Industrials', IONQ: 'Technology', RGTI: 'Technology',
  LUNR: 'Industrials', RDW: 'Industrials', ACHR: 'Industrials',
  ASTS: 'Communication', CAVA: 'Consumer', CELH: 'Consumer',
  RIVN: 'Consumer', GRAB: 'Technology',

  // Mid-cap growth not in core universe
  SOUN: 'Technology', APLD: 'Technology', BTDR: 'Technology',
  WULF: 'Technology', CLSK: 'Technology', IREN: 'Technology',
  HIMS: 'Healthcare', DOCS: 'Healthcare', GMED: 'Healthcare',
  VERX: 'Technology', BRZE: 'Technology', CWAN: 'Technology',
  DOCN: 'Technology', DLO: 'Technology',

  // Sector disruptors / turnarounds
  U: 'Technology', JOBY: 'Industrials', BLDE: 'Industrials',
  OKLO: 'Energy', SMR: 'Energy', NNE: 'Energy', LEU: 'Energy',
  UUUU: 'Energy',
  TMDX: 'Healthcare', NUVL: 'Healthcare', RXRX: 'Healthcare',
};

// ─── Scout Scan ─────────────────────────────────────────────────────────────
// Lightweight momentum check: quote + 6-month history, compute RS proxy + momentum.
// Much faster than a full RS scan — we only need enough to flag potential breakouts.

async function runMomentumScout(coreUniverse) {
  // Filter out stocks already in core universe
  const coreSet = new Set(Object.keys(coreUniverse || {}));
  const scoutTickers = Object.keys(EXPANSION_WATCHLIST).filter(t => !coreSet.has(t));

  if (!scoutTickers.length) return { candidates: [], scanned: 0 };

  // Fetch quotes
  let quotes;
  try {
    quotes = await getQuotes([...scoutTickers, 'SPY']);
  } catch (e) {
    return { candidates: [], scanned: 0, error: e.message };
  }

  const spyQuote = quotes.find(q => q.symbol === 'SPY');
  const spyPrice = spyQuote?.regularMarketPrice;
  const spy50 = spyQuote?.fiftyDayAverage;
  const spy200 = spyQuote?.twoHundredDayAverage;
  const spyReturn6m = spyQuote?.fiftyTwoWeekLow && spyPrice
    ? ((spyPrice - spyQuote.fiftyTwoWeekLow) / spyQuote.fiftyTwoWeekLow * 100) : 0;

  const candidates = [];

  for (const ticker of scoutTickers) {
    const q = quotes.find(qq => qq.symbol === ticker);
    if (!q?.regularMarketPrice) continue;

    const price = q.regularMarketPrice;
    const ma50 = q.fiftyDayAverage;
    const ma200 = q.twoHundredDayAverage;
    const mktCap = q.marketCap || 0;
    const avgVol = q.averageDailyVolume3Month || 0;

    // Minimum quality filters
    if (price < 5) continue;                    // no penny stocks
    if (mktCap < 500_000_000) continue;         // $500M+ market cap
    if (avgVol < 200_000) continue;             // 200K+ avg volume

    // Momentum signals
    const above50 = ma50 ? price > ma50 : false;
    const above200 = ma200 ? price > ma200 : false;
    const vsMA50 = ma50 ? +((price / ma50 - 1) * 100).toFixed(1) : null;
    const vsMA200 = ma200 ? +((price / ma200 - 1) * 100).toFixed(1) : null;

    // 6-month relative performance vs SPY (proxy for RS)
    const wkLow = q.fiftyTwoWeekLow || price;
    const wkHigh = q.fiftyTwoWeekHigh || price;
    const fromLow = +((price / wkLow - 1) * 100).toFixed(1);
    const fromHigh = +((1 - price / wkHigh) * 100).toFixed(1);

    // RS proxy: relative performance vs SPY using change percentages
    const chg50d = q.fiftyDayAverageChange || 0;
    const pctChg = price > 0 && ma50 > 0 ? (price - ma50) / ma50 : 0;
    const spyPct = spyPrice > 0 && spy50 > 0 ? (spyPrice - spy50) / spy50 : 0;
    const relativeStrength = +(pctChg - spyPct).toFixed(3);

    // Volume surge check
    const todayVol = q.regularMarketVolume || 0;
    const volumeRatio = avgVol > 0 ? +(todayVol / avgVol).toFixed(2) : 1;

    // Momentum score (simplified — not full conviction, just enough to rank)
    let momentumScore = 0;
    if (above50 && above200) momentumScore += 25;
    else if (above50) momentumScore += 15;
    else if (above200) momentumScore += 10;

    if (relativeStrength > 0.05) momentumScore += 20;
    else if (relativeStrength > 0.02) momentumScore += 10;

    if (fromLow > 50) momentumScore += 15;
    else if (fromLow > 25) momentumScore += 10;

    if (fromHigh < 10) momentumScore += 15;  // near 52-week high
    else if (fromHigh < 20) momentumScore += 8;

    if (volumeRatio > 1.5) momentumScore += 10;
    else if (volumeRatio > 1.2) momentumScore += 5;

    if (vsMA50 > 0 && vsMA50 < 10) momentumScore += 5;  // not too extended

    // Only surface stocks with strong momentum
    if (momentumScore < 40) continue;

    const reasons = [];
    if (above50 && above200) reasons.push('Above 50MA & 200MA');
    if (relativeStrength > 0.05) reasons.push(`Outperforming SPY by ${(relativeStrength * 100).toFixed(1)}%`);
    if (fromHigh < 10) reasons.push(`Within ${fromHigh}% of 52-week high`);
    if (volumeRatio > 1.5) reasons.push(`Volume surge ${volumeRatio}x average`);
    if (fromLow > 50) reasons.push(`Up ${fromLow}% from 52-week low`);

    candidates.push({
      ticker,
      sector: EXPANSION_WATCHLIST[ticker],
      price: +price.toFixed(2),
      mktCap,
      mktCapLabel: mktCap >= 1e9 ? `$${(mktCap / 1e9).toFixed(1)}B` : `$${(mktCap / 1e6).toFixed(0)}M`,
      vsMA50,
      vsMA200,
      above50,
      above200,
      fromHigh,
      fromLow,
      volumeRatio,
      relativeStrength,
      momentumScore,
      reasons,
      source: 'momentum_scout',
    });
  }

  // Sort by momentum score
  candidates.sort((a, b) => b.momentumScore - a.momentumScore);

  return {
    candidates: candidates.slice(0, 15),
    scanned: scoutTickers.length,
    totalCandidates: candidates.length,
    note: `Scanned ${scoutTickers.length} stocks outside core universe, found ${candidates.length} with momentum score >= 40`,
  };
}

// ─── Get/update expansion watchlist ─────────────────────────────────────────
function getExpansionWatchlist() {
  return { ...EXPANSION_WATCHLIST };
}

module.exports = { runMomentumScout, getExpansionWatchlist, EXPANSION_WATCHLIST };
