require('dotenv').config();
const { FULL_UNIVERSE, SECTOR_ETFS: UNI_SECTOR_ETFS, INDUSTRY_ETFS: IND_ETFS, INDUSTRY_STOCKS } = require('./universe');
const express   = require('express');
const cors      = require('cors');
const fetch     = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');
const fs        = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ─── Persistence paths ────────────────────────────────────────────────────────
const DATA_DIR           = path.join(__dirname, 'data');
const RS_HISTORY_FILE    = path.join(DATA_DIR, 'rs-history.json');       // stocks only
const SEC_HISTORY_FILE   = path.join(DATA_DIR, 'rs-history-sectors.json');  // sectors only
const IND_HISTORY_FILE   = path.join(DATA_DIR, 'rs-history-industries.json'); // industries only
const WATCHLIST_FILE     = path.join(DATA_DIR, 'watchlist.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadHistory(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(_) { return {}; }
}
function saveHistory(file, scores, dateStr) {
  const h = loadHistory(file);
  h[dateStr] = scores;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 95);
  const cut = cutoff.toISOString().split('T')[0];
  for (const d of Object.keys(h)) { if (d < cut) delete h[d]; }
  try { fs.writeFileSync(file, JSON.stringify(h)); } catch(_) {}
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
const CACHE = {};
function cacheGet(key, ttl) {
  const i = CACHE[key];
  if (!i || Date.now() - i.ts > ttl) return null;
  return i.data;
}
function cacheSet(key, data) { CACHE[key] = { data, ts: Date.now() }; }

const TTL_QUOTE = 10 * 60 * 1000;   // 10 min
const TTL_HIST  = 23 * 60 * 60 * 1000; // 23 hr

// ─── Yahoo Finance crumb auth ─────────────────────────────────────────────────
let yhCrumb = null, yhCookie = null;

async function getYahooCrumb() {
  if (yhCrumb && yhCookie) return { crumb: yhCrumb, cookie: yhCookie };
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, redirect: 'follow',
    });
    const m = (r1.headers.get('set-cookie') || '').match(/A3=[^;]+/);
    yhCookie = m ? m[0] : '';
  } catch (_) {
    const r1 = await fetch('https://finance.yahoo.com', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    yhCookie = r1.headers.get('set-cookie') || '';
  }
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': yhCookie },
  });
  yhCrumb = await r2.text();
  if (!yhCrumb || yhCrumb.includes('<') || yhCrumb.length > 20) {
    const r3 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)', 'Cookie': yhCookie },
    });
    yhCrumb = await r3.text();
  }
  console.log(`  ✓ Crumb: ${yhCrumb?.slice(0,8)}...`);
  return { crumb: yhCrumb, cookie: yhCookie };
}

async function yahooQuote(symbols) {
  const key = `q:${symbols.sort().join(',')}`;
  const cached = cacheGet(key, TTL_QUOTE);
  if (cached) return cached;
  const { crumb, cookie } = await getYahooCrumb();
  // Include earningsTimestamp fields — available in Yahoo free quote API with crumb
  const fields = 'regularMarketPrice,regularMarketChangePercent,regularMarketVolume,' +
    'fiftyTwoWeekHigh,fiftyTwoWeekLow,fiftyDayAverage,twoHundredDayAverage,' +
    'averageDailyVolume3Month,marketCap,forwardPE,shortName,sector,' +
    'earningsTimestamp,earningsTimestampStart,earningsTimestampEnd';
  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&fields=${encodeURIComponent(fields)}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': cookie, 'Accept': 'application/json' },
  });
  if (r.status === 401 || r.status === 403) { yhCrumb = null; yhCookie = null; throw new Error(`Yahoo auth expired (${r.status})`); }
  const data  = await r.json();
  const result = data?.quoteResponse?.result || [];
  cacheSet(key, result);
  return result;
}

async function yahooHistory(symbol) {
  const key = `h:${symbol}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;
  const { crumb, cookie } = await getYahooCrumb();
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': cookie },
  });
  const data   = await r.json();
  const closes = (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(p => p != null && p > 0);
  cacheSet(key, closes);
  return closes;
}

async function pLimit(tasks, limit = 5) {
  const results = [];
  for (let i = 0; i < tasks.length; i += limit) {
    const batch = await Promise.allSettled(tasks.slice(i, i + limit).map(fn => fn()));
    results.push(...batch.map(r => r.status === 'fulfilled' ? r.value : null));
  }
  return results;
}

// ─── RS Calculations ──────────────────────────────────────────────────────────
// Real IBD RS: weighted 12-month performance
function calcRS_real(closes) {
  if (!closes || closes.length < 63) return null;
  const n    = closes.length;
  const now  = closes[n - 1];
  const p3m  = closes[Math.max(0, n - 63)];
  const p6m  = closes[Math.max(0, n - 126)] || p3m;
  const p9m  = closes[Math.max(0, n - 189)] || p6m;
  const p12m = closes[Math.max(0, n - 252)] || p9m;
  return ((now/p3m - 1)*100)*0.40 + ((now/p6m - 1)*100)*0.20
       + ((now/p9m - 1)*100)*0.20 + ((now/p12m- 1)*100)*0.20;
}

// Real period returns from price history
function calcPeriodReturns(closes) {
  if (!closes || closes.length < 5) return {};
  const n = closes.length, now = closes[n-1];
  const ret = (i) => closes[i] ? +((now/closes[i]-1)*100).toFixed(2) : null;
  return {
    chg1d: null, // comes from quote
    chg1w: ret(Math.max(0, n-5)),
    chg1m: ret(Math.max(0, n-21)),
    chg3m: ret(Math.max(0, n-63)),
    chg6m: ret(Math.max(0, n-126)),
  };
}

// Short-term momentum score for SWING trades (0-100)
// Separate from IBD RS — captures what's moving RIGHT NOW
function calcSwingMomentum(closes, q) {
  if (!closes || closes.length < 10) return 50;
  const n = closes.length, now = closes[n-1];
  let score = 50;
  // 5-day ROC (most weight for swing)
  const roc5  = closes[n-5]  ? (now/closes[n-5]  - 1)*100 : 0;
  const roc10 = closes[n-10] ? (now/closes[n-10] - 1)*100 : 0;
  const roc21 = closes[n-21] ? (now/closes[n-21] - 1)*100 : 0;
  score += roc5 * 3.0;   // 5-day move is most important for swings
  score += roc10 * 1.5;
  score += roc21 * 0.5;
  // Bonus: price above 10-day MA
  const ma10 = closes.slice(n-10).reduce((a,b)=>a+b,0)/10;
  if (now > ma10) score += 5;
  return Math.min(99, Math.max(1, Math.round(score)));
}

// ── VCP (Volatility Contraction Pattern) detector ──────────────────────────────
// Minervini's core setup: 3+ contractions where each price range < prior range
// Contracting volume on pullbacks = institutional accumulation = coiled spring
// Returns: vcpForming (bool), vcpContractionsCount, vcpTightness (% of last range)
function calcVCP(closes) {
  if (!closes || closes.length < 60) return { vcpForming: false, vcpCount: 0, vcpTightness: null };
  const n = closes.length;
  // 3-week windows (15 days) — captures meaningful pivot swings
  const windowSize = 15;
  const windows = [], lows = [], highs = [];

  for (let i = 0; i < 5; i++) {
    const start = n - (i + 1) * windowSize;
    const end   = n - i * windowSize;
    if (start < 0) break;
    const slice = closes.slice(start, end);
    const hi = Math.max(...slice), lo = Math.min(...slice);
    windows.push((hi - lo) / lo * 100);
    lows.push(lo); highs.push(hi);
  }
  windows.reverse(); lows.reverse(); highs.reverse();

  // Count contractions: each range at least 20% tighter than prior (halving ideal)
  let contractions = 0;
  for (let i = 1; i < windows.length; i++) {
    if (windows[i] < windows[i-1] * 0.80) contractions++;
  }
  // Higher lows = buyers stepping in earlier = institutional accumulation
  let higherLows = 0;
  for (let i = 1; i < lows.length; i++) { if (lows[i] > lows[i-1]) higherLows++; }

  const vcpForming = contractions >= 2;
  const vcpTight   = windows.length ? +windows[windows.length-1].toFixed(1) : null;
  const vcpPivot   = vcpForming ? +(Math.max(...closes.slice(-windowSize))).toFixed(2) : null;
  const vcpStop    = vcpForming ? +(Math.min(...closes.slice(-windowSize))).toFixed(2) : null;

  return {
    vcpForming, vcpCount: contractions,
    vcpTightness: vcpTight,      // % range of last contraction — lower = tighter = better
    vcpPivot,                     // breakout level: buy above this on volume
    vcpStop,                      // stop: below last contraction low
    vcpHigherLows: higherLows >= 2,
  };
}

// ── RS Line: stock / SPY ratio. New high = institutional accumulation signal ─────
// spyCloses: SPY daily closes (same length as stock closes)
// Returns: rsLineNewHigh (bool), rsLineVsSPY (latest ratio)
function calcRSLine(closes, spyCloses) {
  if (!closes || !spyCloses || closes.length < 10 || spyCloses.length < 10) {
    return { rsLineNewHigh: false, rsLine52wkHigh: false };
  }
  const n = Math.min(closes.length, spyCloses.length);
  // Compute RS line (ratio) for last 252 days
  const ratios = [];
  for (let i = Math.max(0, n - 252); i < n; i++) {
    const spy = spyCloses[i] || spyCloses[spyCloses.length - 1];
    ratios.push(spy > 0 ? closes[i] / spy : 0);
  }
  const currentRatio = ratios[ratios.length - 1];
  const max52w = Math.max(...ratios);
  const rsLineNewHigh = currentRatio >= max52w * 0.995; // within 0.5% of 52wk high
  return { rsLineNewHigh, rsLine52wkHigh: rsLineNewHigh };
}

// ── Stage Analysis (Weinstein stages) ─────────────────────────────────────────
// Stage 2 = uptrend: price above rising 30-week MA (150-day MA)
// Returns: stage (1-4), stageName
// ── Weinstein Stage Analysis ─────────────────────────────────────────────────
// Stage 1: Basing  — price near flat 150MA, post-downtrend
// Stage 2: Uptrend — price above RISING 150MA (the buy zone)
// Stage 3: Topping — price above 150MA but MA is flattening/declining
// Stage 4: Decline  — price below declining 150MA (avoid all longs)
// 150-day MA = Weinstein's 30-week MA (the key dividing line)
function calcStage(closes, ma150) {
  if (!closes || closes.length < 160 || !ma150) return { stage: 0, stageName: 'Unknown' };
  const price  = closes[closes.length - 1];
  // Compare current 150MA to 10 weeks ago (50 trading days back) to determine direction
  const ma150_10wkAgo = closes.slice(-200, -150).length >= 40
    ? closes.slice(-200, -150).reduce((a,b)=>a+b,0)/50 : ma150;
  const maRising = ma150 > ma150_10wkAgo * 1.001; // >0.1% rise = rising
  const maFlat   = Math.abs(ma150 - ma150_10wkAgo) / ma150_10wkAgo < 0.001;

  if (price > ma150 && maRising)            return { stage: 2, stageName: 'Stage 2 Uptrend ✓' };
  if (price > ma150 && (maFlat || !maRising)) return { stage: 3, stageName: 'Stage 3 Topping' };
  if (price < ma150 && !maRising)           return { stage: 4, stageName: 'Stage 4 Downtrend' };
  if (price < ma150 && (maFlat || maRising))  return { stage: 1, stageName: 'Stage 1 Basing' };
  return { stage: 1, stageName: 'Stage 1 Basing' };
}

// ── EPS/Revenue growth from Yahoo v11 (per-ticker, used only for Swing candidates) ─
// Helper: Yahoo returns either {raw: N, fmt: str} or plain N depending on endpoint/version
function raw(field) {
  if (field == null) return null;
  if (typeof field === 'object' && 'raw' in field) return field.raw;
  if (typeof field === 'number') return field;
  return null;
}

async function getYahooFundamentals(symbol) {
  try {
    const { crumb, cookie } = await getYahooCrumb();
    // Yahoo v10 is more reliable than v11 for fundamentals
    const modules = 'financialData,defaultKeyStatistics,incomeStatementHistory,incomeStatementHistoryQuarterly,earningsTrend';
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Cookie': cookie,
        'Accept': 'application/json',
      }
    });
    const d = await r.json();
    if (r.status === 401 || r.status === 403) {
      yhCrumb = null; yhCookie = null; // force re-auth
      throw new Error(`Yahoo auth expired (${r.status}) — retry`);
    }
    const result = d?.quoteSummary?.result?.[0];
    if (!result) {
      console.warn(`  v11 quoteSummary: no result for ${symbol}. Status: ${r.status}`);
      return null;
    }

    const fd  = result.financialData       || {};
    const ks  = result.defaultKeyStatistics || {};
    const ish = result.incomeStatementHistory?.incomeStatementHistory || [];
    const ishQ = result.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
    const et  = result.earningsTrend?.trend || [];

    // ── C: Current quarterly EPS — TRUE same-quarter Y/Y from quarterly history ──
    // IBD definition: compare Q0 vs same quarter prior year (Q4)
    // ishQ[0] = most recent quarter, ishQ[4] = same quarter 1 year ago
    let epsGrowthQoQ = null;         // legacy field (trailing QoQ)
    let epsQ_0 = null, epsQ_1 = null, epsQ_2 = null; // last 3 quarters EPS
    let revenueQ_0 = null, revenueQ_1 = null, revenueQ_2 = null;
    let epsGrowth_Q0_yoy = null;     // Q0 vs same qtr prior year (IBD 'C')
    let epsGrowth_Q1_yoy = null;     // Q-1
    let epsGrowth_Q2_yoy = null;     // Q-2
    let revGrowth_Q0_yoy = null;
    let revGrowth_Q1_yoy = null;

    if (ishQ.length >= 5) {
      epsQ_0 = raw(ishQ[0]?.netIncome);
      epsQ_1 = raw(ishQ[1]?.netIncome);
      epsQ_2 = raw(ishQ[2]?.netIncome);
      revenueQ_0 = raw(ishQ[0]?.totalRevenue);
      revenueQ_1 = raw(ishQ[1]?.totalRevenue);
      revenueQ_2 = raw(ishQ[2]?.totalRevenue);
      const epsQ_4 = raw(ishQ[4]?.netIncome);   // same qtr prior year
      const epsQ_5 = raw(ishQ[5]?.netIncome);
      const epsQ_6 = raw(ishQ[6]?.netIncome);
      const revQ_4 = raw(ishQ[4]?.totalRevenue);
      const revQ_5 = raw(ishQ[5]?.totalRevenue);

      if (epsQ_0 != null && epsQ_4 != null && epsQ_4 > 0)
        epsGrowth_Q0_yoy = +((epsQ_0/epsQ_4 - 1)*100).toFixed(1);
      if (epsQ_1 != null && epsQ_5 != null && epsQ_5 > 0)
        epsGrowth_Q1_yoy = +((epsQ_1/epsQ_5 - 1)*100).toFixed(1);
      if (epsQ_2 != null && epsQ_6 != null && epsQ_6 > 0)
        epsGrowth_Q2_yoy = +((epsQ_2/epsQ_6 - 1)*100).toFixed(1);
      if (revenueQ_0 != null && revQ_4 != null && revQ_4 > 0)
        revGrowth_Q0_yoy = +((revenueQ_0/revQ_4 - 1)*100).toFixed(1);
      if (revenueQ_1 != null && revQ_5 != null && revQ_5 > 0)
        revGrowth_Q1_yoy = +((revenueQ_1/revQ_5 - 1)*100).toFixed(1);
    }
    // Fallback to earningsGrowth from financialData if quarterly history unavailable
    epsGrowthQoQ = epsGrowth_Q0_yoy ?? (raw(fd.earningsGrowth) != null ? +(fd.earningsGrowth.raw * 100).toFixed(1) : null);

    // IBD 'C' passes if Q0, Q1, Q2 all ≥ 25% YoY (3 consecutive quarters)
    const c_pass_q0 = epsGrowth_Q0_yoy != null && epsGrowth_Q0_yoy >= 25;
    const c_pass_q1 = epsGrowth_Q1_yoy != null && epsGrowth_Q1_yoy >= 25;
    const c_pass_q2 = epsGrowth_Q2_yoy != null && epsGrowth_Q2_yoy >= 25;
    // EPS acceleration: each quarter better than the prior one
    const epsAccelerating_qoq =
      epsGrowth_Q0_yoy != null && epsGrowth_Q1_yoy != null &&
      epsGrowth_Q0_yoy > epsGrowth_Q1_yoy;

    // ── A: Annual EPS — 3-year trend for acceleration ─────────────────────────
    let epsGrowthYoY = null;
    let epsAnnualGrowth = [];   // [yr0_growth, yr1_growth] — is it accelerating YoY?
    if (ish.length >= 2) {
      const eps0 = raw(ish[0]?.netIncome);
      const eps1 = raw(ish[1]?.netIncome);
      const eps2 = raw(ish[2]?.netIncome);
      if (eps0 != null && eps1 != null && eps1 > 0)
        epsGrowthYoY = +((eps0/eps1 - 1)*100).toFixed(1);
      if (eps0 != null && eps1 != null && eps1 > 0)
        epsAnnualGrowth.push(+((eps0/eps1 - 1)*100).toFixed(1));
      if (eps1 != null && eps2 != null && eps2 > 0)
        epsAnnualGrowth.push(+((eps1/eps2 - 1)*100).toFixed(1));
    }
    // Annual EPS acceleration: each annual rate higher than prior year
    const annualEpsAccelerating = epsAnnualGrowth.length >= 2 &&
      epsAnnualGrowth[0] > epsAnnualGrowth[1];

    // EPS acceleration: quarterly rate exceeds annual rate (classic CAN SLIM signal)
    const epsAccelerating = epsGrowthQoQ != null && epsGrowthYoY != null
      && epsGrowthQoQ > epsGrowthYoY;

    // ── S: Supply (float, short interest) ────────────────────────────────────
    const sharesFloat       = raw(ks.floatShares) || null;
    const sharesShort       = raw(ks.sharesShort) || null;
    const shortPercentFloat = raw(ks.shortPercentOfFloat) != null
      ? +(ks.shortPercentOfFloat.raw * 100).toFixed(1) : null;
    const shortRatio        = raw(ks.shortRatio) || null;  // days to cover

    // ── I: Institutional ownership ────────────────────────────────────────────
    // Yahoo Finance v10 defaultKeyStatistics uses heldPercentInstitutions / heldPercentInsiders
    const _instField = ks.heldPercentInstitutions ?? ks.institutionsPercentHeld;
    const _insField  = ks.heldPercentInsiders     ?? ks.insidersPercentHeld;
    const institutionPct = raw(_instField) != null
      ? +(raw(_instField) * 100).toFixed(1) : null;
    const insiderPct     = raw(_insField)  != null
      ? +(raw(_insField)  * 100).toFixed(1) : null;

    // ── Other quality metrics ─────────────────────────────────────────────────
    const revenueGrowthYoY  = revGrowth_Q0_yoy ?? (raw(fd.revenueGrowth) != null
      ? +(fd.revenueGrowth.raw * 100).toFixed(1) : null);
    const grossMargins      = raw(fd.grossMargins) != null
      ? +(fd.grossMargins.raw * 100).toFixed(1) : null;
    const returnOnEquity    = raw(fd.returnOnEquity) != null
      ? +(fd.returnOnEquity.raw * 100).toFixed(1) : null;
    const debtToEquity      = raw(fd.debtToEquity) || null;
    const forwardPE         = raw(fd.forwardPE) || null;

    // ── CAN SLIM score (0-7) ──────────────────────────────────────────────────
    // C: 3 consecutive quarters ≥ 25% YoY EPS (max 3 pts, else 1 pt for Q0 only)
    // A: Annual EPS ≥ 25% AND accelerating = 1pt
    // N: Revenue ≥ 15% = 1pt
    // S: Short float ≤ 40% = 1pt
    // I: Institutional ≥ 10% = 1pt
    const canSlimScore = [
      epsGrowth_Q0_yoy != null && epsGrowth_Q0_yoy >= 25,            // C (Q0)
      epsGrowthYoY     != null && epsGrowthYoY >= 25,                // A
      revenueGrowthYoY != null && revenueGrowthYoY >= 15,            // N (proxy)
      shortPercentFloat != null && shortPercentFloat <= 40,           // S
      institutionPct   != null && institutionPct >= 10,              // I
      returnOnEquity   != null && returnOnEquity >= 15,              // quality
    ].filter(Boolean).length;

    return {
      // C — per-quarter YoY EPS (true CAN SLIM)
      epsGrowthQoQ, epsGrowthYoY, epsAccelerating,
      epsGrowth_Q0_yoy, epsGrowth_Q1_yoy, epsGrowth_Q2_yoy,
      c_pass_q0, c_pass_q1, c_pass_q2,
      epsAccelerating_qoq,
      // A — annual trend
      epsAnnualGrowth, annualEpsAccelerating,
      // Revenue per quarter
      revGrowth_Q0_yoy, revGrowth_Q1_yoy,
      // S
      sharesFloat, sharesShort, shortPercentFloat, shortRatio,
      // I
      institutionPct, insiderPct,
      // Quality
      revenueGrowthYoY, grossMargins, returnOnEquity, debtToEquity, forwardPE,
      // Score
      canSlimScore,
    };
  } catch(e) {
    console.warn('Fundamentals error:', e.message);
    return null;
  }
}

// ─── /api/fundamentals/:ticker ───────────────────────────────────────────────
// Called on-demand for individual stocks (Swing Lab candidates, Levels panel)

// ── ATR (14-day) — for position sizing
function calcATR(closes) {
  if (!closes || closes.length < 15) return null;
  const n = closes.length;
  let atrSum = 0;
  for (let i = n-14; i < n; i++) {
    atrSum += Math.abs(closes[i] - closes[i-1]);
  }
  return +(atrSum / 14).toFixed(2);
}

// Volume trend proxy (poor-man OBV from Yahoo data)
// Yahoo quote gives us: regularMarketVolume (today) and averageDailyVolume3Month
// We also have the price direction. A better signal: if price is above 50MA AND
// volume ratio > 1 = net accumulation. If below 50MA and vol ratio > 1 = distribution.
// Returns: 'accumulating' | 'distributing' | 'neutral'
function volumeTrend(q) {
  if (!q) return 'neutral';
  const price  = q.regularMarketPrice;
  const ma50   = q.fiftyDayAverage;
  const volR   = q.averageDailyVolume3Month
    ? q.regularMarketVolume / q.averageDailyVolume3Month : 1;
  if (!ma50) return 'neutral';
  if (price > ma50 && volR >= 1.2) return 'accumulating';
  if (price < ma50 && volR >= 1.2) return 'distributing';
  if (price > ma50 && volR >= 0.8) return 'neutral-up';
  return 'neutral';
}

function rankToRS(items, key = 'rawRS') {
  const valid = items.filter(s => s[key] != null);
  valid.sort((a, b) => a[key] - b[key]);
  valid.forEach((s, i) => { s.rsRank = Math.round((i / Math.max(valid.length-1, 1)) * 98) + 1; });
  items.filter(s => s[key] == null).forEach(s => { s.rsRank = 50; });
  return items;
}

// ─── RS History (stocks only — sectors/industries have separate files) ──────────
function loadRSHistory()           { return loadHistory(RS_HISTORY_FILE); }
function saveRSSnapshot(scores, d) { saveHistory(RS_HISTORY_FILE, scores, d); }

// Pre-generate 90 days of RS history from existing 1-year price data
// Called once on first scan. Uses same price data, no extra API calls.
// ── Generic pre-generation: works for stocks, sectors, or industries ────────────
// histMap: { symbol: [closes] }
// keyFn: how to key the snapshot (e.g. sym => sym, or sym => 'SEC_'+sym)
// histFile: which file to save to
// minSnapshots: skip if already have this many
function preGenerateHistoryFor(histMap, keyFn, histFile, label, minSnapshots = 13) {
  const history = loadHistory(histFile);
  if (Object.keys(history).length >= minSnapshots) return;

  console.log(`  Pre-generating ${label} RS history from 1-year price data...`);
  const today = new Date();

  for (let weeksBack = 13; weeksBack >= 0; weeksBack--) {
    const snapDate = new Date(today);
    snapDate.setDate(snapDate.getDate() - weeksBack * 7);
    const dateStr = snapDate.toISOString().split('T')[0];
    if (history[dateStr]) continue;

    const daysBack  = weeksBack * 5;
    const tempItems = [];

    for (const sym of Object.keys(histMap)) {
      const closes = histMap[sym];
      if (!closes || closes.length < 63) continue;
      // Truncate to simulate what RS was daysBack trading days ago
      const truncated = closes.slice(0, Math.max(63, closes.length - daysBack));
      tempItems.push({ ticker: sym, rawRS: calcRS_real(truncated) });
    }

    rankToRS(tempItems);
    const snap = {};
    for (const item of tempItems) snap[keyFn(item.ticker)] = item.rsRank;
    saveHistory(histFile, snap, dateStr);
  }
  console.log(`  ✓ ${label} RS history pre-generated (13 weekly snapshots)`);
}

// Backward-compat alias for stocks
function preGenerateHistory(histMap) {
  preGenerateHistoryFor(histMap, sym => sym, RS_HISTORY_FILE, 'stock');
}

function getRSTrend(ticker, history) {
  const dates = Object.keys(history).sort();
  if (dates.length < 2) return null;
  const last = dates[dates.length-1];
  const now  = history[last]?.[ticker];
  if (now == null) return null;
  const findAt = (daysAgo) => {
    const t = new Date(last); t.setDate(t.getDate() - daysAgo);
    const tStr = t.toISOString().split('T')[0];
    const before = dates.filter(d => d <= tStr);
    return before.length ? (history[before[before.length-1]]?.[ticker] ?? null) : null;
  };
  const w1 = findAt(7), w2 = findAt(14), w4 = findAt(28), m3 = findAt(90), m2 = findAt(60);
  const dir  = w1 != null ? (now-w1 > 3 ? 'rising' : now-w1 < -3 ? 'falling' : 'flat') : 'new';
  const note = now < 50 && dir === 'rising' ? 'low-RS-rising' : dir;
  return {
    current: now, direction: dir, note,
    vs1w: w1 != null ? +(now-w1).toFixed(0) : null,
    vs2w: w2 != null ? +(now-w2).toFixed(0) : null,
    vs4w: w4 != null ? +(now-w4).toFixed(0) : null,
    vs3m: m3 != null ? +(now-m3).toFixed(0) : null,
    vs1m: w4 != null ? +(now-w4).toFixed(0) : null,
    vs2m: m2 != null ? +(now-m2).toFixed(0) : null,
  };
}

// ─── Market Regime (pure data — no AI needed) ─────────────────────────────────
async function getMarketRegime() {
  const cached = cacheGet('regime', TTL_QUOTE);
  if (cached) return cached;
  try {
    const quotes = await yahooQuote(['SPY', '^VIX', 'QQQ', 'IWM', 'TLT']);
    const spy = quotes.find(q => q.symbol === 'SPY');
    const vix = quotes.find(q => q.symbol === '^VIX');
    const qqq = quotes.find(q => q.symbol === 'QQQ');
    const iwm = quotes.find(q => q.symbol === 'IWM');
    const tlt = quotes.find(q => q.symbol === 'TLT');

    const spyPrice   = spy?.regularMarketPrice;
    const spy50      = spy?.fiftyDayAverage;
    const spy200     = spy?.twoHundredDayAverage;
    const vixLevel   = vix?.regularMarketPrice || 20;
    const above200   = spyPrice && spy200 ? spyPrice > spy200 : true;
    const above50    = spyPrice && spy50  ? spyPrice > spy50  : true;
    const spyChg1d   = spy?.regularMarketChangePercent;

    let regime, swingOk, positionOk, color, warning, sizeMultiplier;

    if (vixLevel > 35 || !above200) {
      regime = 'HIGH RISK / BEAR';  color = '#ff3d57'; swingOk = false; positionOk = false; sizeMultiplier = 0;
      warning = 'AVOID NEW LONGS — SPY below 200MA or VIX >35. Cash or shorts only.';
    } else if (vixLevel > 25 || !above50) {
      regime = 'CAUTION';           color = '#ff8c00'; swingOk = true;  positionOk = false; sizeMultiplier = 0.5;
      warning = 'Half position size — elevated volatility, tighten stops to 1 ATR';
    } else if (above200 && above50 && vixLevel < 18) {
      regime = 'BULL / RISK ON';    color = '#00e676'; swingOk = true;  positionOk = true;  sizeMultiplier = 1.0;
      warning = null;
    } else {
      regime = 'NEUTRAL';           color = '#f0a500'; swingOk = true;  positionOk = true;  sizeMultiplier = 0.75;
      warning = 'Normal size — mixed signals, respect stops';
    }

    const result = {
      regime, color, swingOk, positionOk, sizeMultiplier, warning, vixLevel,
      spyPrice, spyChg1d, spy50, spy200, above50, above200,
      qqqChg1d: qqq?.regularMarketChangePercent,
      iwmChg1d: iwm?.regularMarketChangePercent,
      tltChg1d: tlt?.regularMarketChangePercent,
      riskOnSignals: [
        above50    && 'SPY above 50MA',
        above200   && 'SPY above 200MA',
        vixLevel < 20 && `VIX calm at ${vixLevel.toFixed(0)}`,
      ].filter(Boolean),
      riskOffSignals: [
        !above50   && 'SPY below 50MA',
        !above200  && 'SPY below 200MA',
        vixLevel > 25 && `VIX elevated at ${vixLevel.toFixed(0)}`,
      ].filter(Boolean),
    };
    cacheSet('regime', result);
    return result;
  } catch(e) {
    return { regime: 'UNKNOWN', color: '#888', swingOk: true, positionOk: true, sizeMultiplier: 0.75, warning: 'Could not fetch regime data' };
  }
}

// Universe from universe.js module (~150+ curated names + sector/industry ETFs)
const SECTOR_MAP = FULL_UNIVERSE;
const UNIVERSE   = Object.keys(SECTOR_MAP);
const INDUSTRY_ETFS = IND_ETFS;

const SECTOR_ETFS = [
  {t:'XLK',n:'Technology',color:'#00d4ff'},{t:'XLE',n:'Energy',color:'#ff8c00'},
  {t:'XLC',n:'Comm Services',color:'#c44dff'},{t:'XLI',n:'Industrials',color:'#f0a500'},
  {t:'XLF',n:'Financials',color:'#ffd700'},{t:'XLY',n:'Consumer Disc',color:'#80d8ff'},
  {t:'XLB',n:'Materials',color:'#b9f6ca'},{t:'XLV',n:'Healthcare',color:'#00e676'},
  {t:'XLP',n:'Cons Staples',color:'#b39ddb'},{t:'XLU',n:'Utilities',color:'#80cbc4'},
  {t:'XLRE',n:'Real Estate',color:'#ffab91'},
];

const MACRO_SYMBOLS = [
  {t:'SPY',n:'S&P 500'},{t:'QQQ',n:'Nasdaq 100'},{t:'IWM',n:'Russell 2000'},
  {t:'^VIX',n:'VIX'},{t:'TLT',n:'20yr Bond'},{t:'GLD',n:'Gold'},
  {t:'UUP',n:'US Dollar'},{t:'USO',n:'Crude Oil'},{t:'^TNX',n:'10Y Yield'},{t:'^IRX',n:'3M Yield'},
];

// ─── Core RS scan (shared, cached) ───────────────────────────────────────────
async function runRSScan() {
  const cached = cacheGet('rs:full', TTL_QUOTE);
  if (cached) return cached;

  const uniq = [...new Set([...UNIVERSE, 'SPY'])];
  console.log(`  RS scan: ${uniq.length} stocks...`);

  // Fetch quotes
  const allQuotes = {};
  for (let i = 0; i < uniq.length; i += 20) {
    const batch = await yahooQuote(uniq.slice(i, i + 20));
    for (const q of batch) allQuotes[q.symbol] = q;
  }

  // Fetch history (concurrent, 5 at a time)
  const histMap = {};
  await pLimit(uniq.map(sym => async () => {
    try {
      const c = await yahooHistory(sym);
      if (c.length >= 63) histMap[sym] = c;
    } catch(_) {}
  }), 5);

  // Pre-generate history on first run (no extra API calls)
  preGenerateHistory(histMap, uniq);

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
    const atr     = calcATR(closes);
    const atrPct  = atr && price ? +(atr/price*100).toFixed(2) : null;
    const swingMom  = calcSwingMomentum(closes, q);
    // 150-day MA from price history (Yahoo only provides 50 and 200 day in quote)
    const ma150     = closes.length >= 150
      ? closes.slice(-150).reduce((a,b)=>a+b,0)/150 : null;
    const vsMA150   = ma150 ? +((price-ma150)/ma150*100).toFixed(2) : null;
    // SEPA Trend Template (Minervini) — all 6 criteria
    // Minervini SEPA Trend Template — all 8 rules
    // Rule 5: 50MA must be above BOTH 150MA and 200MA (MAs stacked bullishly)
    const ma50AboveAll = ma50 && ma150 && ma200 ? (ma50 > ma150 && ma50 > ma200) : null;
    const sepa = {
      aboveMA200:      vsMA200 != null && vsMA200 > 0,           // 1. Price > 200MA
      aboveMA150:      vsMA150 != null && vsMA150 > 0,           // 2. Price > 150MA
      ma150AboveMA200: ma150 && ma200 ? ma150 > ma200 : null,    // 3. 150MA > 200MA
      ma200Rising:     (() => {  // 4. 200MA trending up for 4+ weeks
        if (closes.length < 252) return null;
        const ma200_4wAgo = closes.slice(-252,-228).reduce((a,b)=>a+b,0)/24;
        return ma200 > ma200_4wAgo * 1.001; // must be >0.1% higher
      })(),
      ma50AboveAll,            // 5. 50MA > 150MA AND 200MA (often missed!)
      aboveMA50:       vsMA50 != null && vsMA50 > 0,             // 6. Price > 50MA
      low30pctBelow:   q.fiftyTwoWeekLow && price ? (price - q.fiftyTwoWeekLow)/price >= 0.30 : null, // 7
      priceNearHigh:   distFromHigh != null && distFromHigh <= 0.25, // 8. Within 25% of high
    };
    const sepaScore = Object.values(sepa).filter(v => v === true).length; // 0-8
    const rawRS    = calcRS_real(closes);
    const volRatio = q.averageDailyVolume3Month ? +(q.regularMarketVolume/q.averageDailyVolume3Month).toFixed(2) : 1;

    // Parse earnings date from Yahoo timestamp
    let earningsDate = null;
    let daysToEarnings = null;
    const ts = q.earningsTimestamp || q.earningsTimestampStart;
    if (ts && ts > 0) {
      const ed = new Date(ts * 1000);
      const now2 = new Date();
      daysToEarnings = Math.round((ed - now2) / (1000 * 60 * 60 * 24));
      if (daysToEarnings >= -5 && daysToEarnings <= 90) { // within 90 days ahead
        earningsDate = ed.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      }
    }

    // Basic CAN SLIM quality from quote (already fetched — zero extra cost)
    const epsTrailing   = q.epsTrailingTwelveMonths || null;
    const epsForward    = q.epsForward || null;
    const epsGrowthEst  = epsTrailing && epsForward && epsTrailing > 0
      ? +((epsForward/epsTrailing - 1)*100).toFixed(1) : null;
    const pegRatio      = q.pegRatio || null;
    const trailingPE    = q.trailingPE || null;
    const forwardPE2    = q.forwardPE || null;

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
      epsTrailing, epsForward, epsGrowthEst,  // from quote — no extra API call
      pegRatio, trailingPE,
      swingMomentum: swingMom,
      earningsDate,
      daysToEarnings,
      earningsRisk: daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 14,
      volumeTrend: volumeTrend(q),
      ...calcVCP(closes),       // Minervini VCP: contracting volatility before breakout
      ma150, vsMA150,
      sepa, sepaScore,   // SEPA Trend Template score (0-6)
      // RS Line new high: stock outperforming SPY over last 52 weeks
      ...calcRSLine(closes, histMap['SPY'] || []),
      // Stage analysis (Weinstein): 2 = uptrend buy zone
      ...calcStage(closes, ma150),  // uses real 150-day MA computed from closes
      rawRS,
    });
  }

  rankToRS(results);
  results.sort((a,b) => b.rsRank - a.rsRank);

  // Save today's snapshot — include stocks + sector ETFs + industry ETFs
  const today = new Date().toISOString().split('T')[0];
  const snap  = {};
  for (const s of results) snap[s.ticker] = s.rsRank;
  // Also snapshot sector ETFs if they have RS ranks (from /api/sectors cache)
  // They are saved when sectors/industries tabs are loaded
  saveRSSnapshot(snap, today);
  console.log(`  ✓ RS scan: ${results.length} stocks, snapshot saved ${today}`);

  cacheSet('rs:full', results);
  return results;
}

// ─── /api/regime ──────────────────────────────────────────────────────────────
app.get('/api/regime', async (req, res) => {
  try { res.json(await getMarketRegime()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/rs-scan ─────────────────────────────────────────────────────────────
app.get('/api/rs-scan', async (req, res) => {
  try {
    const stocks  = await runRSScan();
    const history = loadRSHistory();
    const withTrend = stocks.map(s => ({ ...s, rsTrend: getRSTrend(s.ticker, history) }));
    // vsSPY3m: stock 3M return minus SPY 3M return — true outperformance vs benchmark
  const spyStock = withTrend.find(s => s.ticker === 'SPY');
  const spy3m = spyStock?.chg3m ?? null;
  const final = spy3m != null
    ? withTrend.map(s => ({ ...s, vsSPY3m: s.chg3m != null ? +(s.chg3m - spy3m).toFixed(2) : null }))
    : withTrend;
  res.json({ stocks: final, universeSize: final.length, spy3m });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── History endpoint factory ─────────────────────────────────────────────────
function makeHistoryEndpoint(file, prefix) {
  return async (req, res) => {
    try {
      const history = loadHistory(file);
      const dates   = Object.keys(history).sort();
      const ticker  = req.query.ticker?.toUpperCase();
      if (ticker) {
        const series = dates
          .map(d => ({ date: d, rs: history[d]?.[ticker] ?? null }))
          .filter(p => p.rs != null);
        return res.json({ ticker, series });
      }
      const last   = history[dates[dates.length-1]] || {};
      // Only include keys that DON'T have a prefix (stocks endpoint) or DO match (sec/ind endpoints)
      const keys = Object.keys(last).filter(k =>
        prefix ? k.startsWith(prefix) : !k.startsWith('SEC_') && !k.startsWith('IND_')
      );
      const trends = keys.map(k => {
        const displayTicker = prefix ? k.replace(prefix, '') : k;
        const trend = getRSTrend(k, history);
        if (!trend) return null;
        return { ticker: displayTicker, rawKey: k, ...trend };
      }).filter(Boolean).sort((a,b) => b.current - a.current);
      res.json({ dates, trends, totalDays: dates.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  };
}

app.get('/api/rs-history',            makeHistoryEndpoint(RS_HISTORY_FILE,  null));   // stocks only
app.get('/api/rs-history/sectors',    makeHistoryEndpoint(SEC_HISTORY_FILE, 'SEC_')); // sectors only
app.get('/api/rs-history/industries', makeHistoryEndpoint(IND_HISTORY_FILE, 'IND_')); // industries only

// ─── /api/sectors ─────────────────────────────────────────────────────────────
app.get('/api/sectors', async (req, res) => {
  try {
    const symbols = SECTOR_ETFS.map(s => s.t);
    const quotes  = await yahooQuote(symbols);
    const histResults = await pLimit(symbols.map(sym => async () => ({ sym, closes: await yahooHistory(sym) })), 5);
    const histMap = {}; histResults.forEach(r => { if(r) histMap[r.sym] = r.closes; });

    // Fetch SPY closes for RS Line comparison
    const spyCloses = histMap['SPY'] || (await yahooHistory('SPY').catch(()=>[]));
    const result = quotes.map(q => {
      const meta = SECTOR_ETFS.find(s => s.t === q.symbol) || {};
      const closes = histMap[q.symbol] || [];
      const price = q.regularMarketPrice, ma50 = q.fiftyDayAverage, ma200 = q.twoHundredDayAverage;
      const periods = calcPeriodReturns(closes);
      const ma150 = closes.length >= 150 ? closes.slice(-150).reduce((a,b)=>a+b,0)/150 : null;
      return {
        symbol: q.symbol, name: meta.n, color: meta.color || '#888',
        price, ma50, ma200,
        vsMA50:  ma50  ? +((price-ma50) /ma50 *100).toFixed(2) : null,
        vsMA200: ma200 ? +((price-ma200)/ma200*100).toFixed(2) : null,
        chg1d: q.regularMarketChangePercent,
        chg1w: periods.chg1w, chg1m: periods.chg1m, chg3m: periods.chg3m, chg6m: periods.chg6m,
        w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
        volume: q.regularMarketVolume, rawRS: calcRS_real(closes),
        swingMomentum: calcSwingMomentum(closes, q),
        ...calcVCP(closes),
        ...calcRSLine(closes, spyCloses),
        ...calcStage(closes, ma150),
        ma150,
      };
    });
    rankToRS(result);
    result.sort((a,b) => b.rsRank - a.rsRank);
    // Pre-generate sector RS history on first load (uses same 1-year price data)
    preGenerateHistoryFor(histMap, sym => 'SEC_' + sym, SEC_HISTORY_FILE, 'sector');

    // Save today's snapshot
    const todaySec = new Date().toISOString().split('T')[0];
    const secSnap  = {};
    for (const r of result) secSnap['SEC_' + r.symbol] = r.rsRank;
    saveHistory(SEC_HISTORY_FILE, secSnap, todaySec);
    // Attach RS Accel (28-day rank change) from sector history
    const secHist = loadHistory(SEC_HISTORY_FILE);
    const sectorsOut = result.map(r => ({
      ...r, rsTrend: getRSTrend('SEC_' + r.symbol, secHist),
    }));
    res.json({ sectors: sectorsOut });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/industries ──────────────────────────────────────────────────────────
app.get('/api/industries', async (req, res) => {
  try {
    const symbols = INDUSTRY_ETFS.map(i => i.t);
    const quotes  = await yahooQuote(symbols);
    const histResults = await pLimit([...symbols, 'SPY'].map(sym => async () => ({ sym, closes: await yahooHistory(sym) })), 5);
    const histMap = {}; histResults.forEach(r => { if(r) histMap[r.sym] = r.closes; });
    const spyCloses = histMap['SPY'] || [];

    const result = quotes.map(q => {
      const meta = INDUSTRY_ETFS.find(i => i.t === q.symbol) || {};
      const closes = histMap[q.symbol] || [];
      const price = q.regularMarketPrice;
      const ma50  = q.fiftyDayAverage;
      const ma200 = q.twoHundredDayAverage;
      const vsMA50  = ma50  ? +((price-ma50) /ma50 *100).toFixed(2) : null;
      const vsMA200 = ma200 ? +((price-ma200)/ma200*100).toFixed(2) : null;
      const periods = calcPeriodReturns(closes);
      const ma150 = closes.length >= 150 ? closes.slice(-150).reduce((a,b)=>a+b,0)/150 : null;
      return {
        symbol: q.symbol, name: meta.n, sector: meta.sec,
        price, ma50, ma200, vsMA50, vsMA200,
        chg1d: q.regularMarketChangePercent,
        chg1w: periods.chg1w, chg1m: periods.chg1m,
        chg3m: periods.chg3m, chg6m: periods.chg6m,
        w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
        rawRS: calcRS_real(closes),
        swingMomentum: calcSwingMomentum(closes, q),
        ...calcVCP(closes),
        ...calcRSLine(closes, spyCloses),
        ...calcStage(closes, ma150),
        ma150,
      };
    });
    rankToRS(result);
    result.sort((a,b) => b.rsRank - a.rsRank);
    // Pre-generate industry RS history on first load
    preGenerateHistoryFor(histMap, sym => 'IND_' + sym, IND_HISTORY_FILE, 'industry');

    // Save today's snapshot
    const todayInd = new Date().toISOString().split('T')[0];
    const indSnap  = {};
    for (const r of result) indSnap['IND_' + r.symbol] = r.rsRank;
    saveHistory(IND_HISTORY_FILE, indSnap, todayInd);
    // Attach RS Accel from industry history
    const indHist = loadHistory(IND_HISTORY_FILE);
    const industriesOut = result.map(r => ({
      ...r, rsTrend: getRSTrend('IND_' + r.symbol, indHist),
    }));
    res.json({ industries: industriesOut });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/macro ───────────────────────────────────────────────────────────────
app.get('/api/macro', async (req, res) => {
  try {
    const quotes = await yahooQuote(MACRO_SYMBOLS.map(m => m.t));
    const macro  = quotes.map(q => {
      const meta = MACRO_SYMBOLS.find(m => m.t === q.symbol) || {};
      return { symbol: q.symbol, name: meta.n, price: q.regularMarketPrice,
               chg1d: q.regularMarketChangePercent, w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
               ma50: q.fiftyDayAverage, ma200: q.twoHundredDayAverage };
    });
    const t10 = macro.find(r => r.symbol==='^TNX'), t3m = macro.find(r => r.symbol==='^IRX');
    const spread = t10?.price && t3m?.price ? +(t10.price - t3m.price).toFixed(2) : null;
    const regime = await getMarketRegime();
    res.json({ macro, yieldSpread: spread, regime });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/leaders-laggards ────────────────────────────────────────────────────
// Sorted by RS rank (institutional strength) — NOT 1-day % change
app.get('/api/leaders-laggards', async (req, res) => {
  try {
    const stocks  = await runRSScan();
    const history = loadRSHistory();
    const all = stocks.map(s => ({ ...s, rsTrend: getRSTrend(s.ticker, history) }));

    const leaders  = all.filter(s => s.vsMA50 != null && s.vsMA50 > 0).sort((a,b) => b.rsRank-a.rsRank).slice(0,15);
    const lSet     = new Set(leaders.map(s => s.ticker));
    const laggards = all.filter(s => !lSet.has(s.ticker)).sort((a,b) => a.rsRank-b.rsRank).slice(0,15);
    res.json({ leaders, laggards });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/watchlist ───────────────────────────────────────────────────────────
app.get('/api/watchlist', (req, res) => {
  try {
    const wl = fs.existsSync(WATCHLIST_FILE) ? JSON.parse(fs.readFileSync(WATCHLIST_FILE,'utf8')) : [];
    res.json({ watchlist: wl });
  } catch(e) { res.json({ watchlist: [] }); }
});

app.post('/api/watchlist', (req, res) => {
  const { ticker, note, stage } = req.body; // stage: 'watching'|'candidate'|'active'
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const wl = fs.existsSync(WATCHLIST_FILE) ? JSON.parse(fs.readFileSync(WATCHLIST_FILE,'utf8')) : [];
  const existing = wl.findIndex(w => w.ticker === ticker.toUpperCase());
  const entry = { ticker: ticker.toUpperCase(), note: note||'', stage: stage||'watching', addedAt: new Date().toISOString() };
  if (existing >= 0) wl[existing] = entry; else wl.push(entry);
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(wl, null, 2));
  res.json({ ok: true, entry });
});

app.delete('/api/watchlist/:ticker', (req, res) => {
  const wl = fs.existsSync(WATCHLIST_FILE) ? JSON.parse(fs.readFileSync(WATCHLIST_FILE,'utf8')) : [];
  const filtered = wl.filter(w => w.ticker !== req.params.ticker.toUpperCase());
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(filtered, null, 2));
  res.json({ ok: true });
});


// ─── /api/trade-setup (pure algo, no API key required) ────────────────────────
// Computes entry/stop/target from price + ATR. Works without Anthropic key.
app.post('/api/trade-setup', async (req, res) => {
  try {
    const { ticker, mode = 'swing' } = req.body;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    const stocks = await runRSScan();
    const stock  = stocks.find(s => s.ticker === ticker.toUpperCase());
    if (!stock) return res.status(404).json({ error: `${ticker} not in universe` });
    const setup = computeTradeSetup(stock, mode);
    res.json({
      ticker: stock.ticker,
      price:  stock.price,
      ibdRS:  stock.rsRank,
      swingMomentum: stock.swingMomentum,
      atr:    stock.atr,
      atrPct: stock.atrPct,
      vsMA50: stock.vsMA50,
      vsMA200: stock.vsMA200,
      rsTrend: stock.rsTrend?.direction,
      setup,
      mode,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/claude ──────────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in .env' });
  try {
    const { prompt, systemPrompt, useWebSearch = false, maxTokens = 1200 } = req.body;
    const tools = useWebSearch ? [{ type: 'web_search_20250305', name: 'web_search' }] : undefined;
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: maxTokens,
      ...(tools && { tools }), ...(systemPrompt && { system: systemPrompt }),
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ content: response.content.filter(b=>b.type==='text').map(b=>b.text).join('\n') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ─── Algorithmic trade setup (pure price math, no API) ────────────────────────
// Entry, stop, targets, R/R computed from ATR + price structure
// API key not required — these are deterministic calculations
function computeTradeSetup(stock, mode) {
  const price = stock.price;
  const atr   = stock.atr || (price * 0.02); // fallback: 2% of price
  const ma50  = stock.ma50;
  const ma200 = stock.ma200;
  const w52h  = stock.w52h;

  // SWING setup: breakout entry or near high
  // POSITION setup: pullback to 50MA entry
  let entryLow, entryHigh, stopLevel, target1, target2;

  if (mode === 'swing') {
    // Entry: slightly above current price (breakout)
    entryLow  = +(price * 0.998).toFixed(2);
    entryHigh = +(price * 1.005).toFixed(2);
    // Stop: 1.5 ATR below entry (standard swing stop)
    stopLevel = +(entryLow - 1.5 * atr).toFixed(2);
    // Targets: 2.5 ATR (T1), 4 ATR (T2) — risk-based targets
    target1   = +(entryLow + 2.5 * atr).toFixed(2);
    target2   = +(entryLow + 4.0 * atr).toFixed(2);
  } else {
    // Position: enter on pullback near 50MA
    const pivotEntry = ma50 ? Math.max(price, ma50 * 1.002) : price;
    entryLow  = +(pivotEntry * 0.995).toFixed(2);
    entryHigh = +(pivotEntry * 1.010).toFixed(2);
    // Stop: below 50MA or 2 ATR
    stopLevel = ma50 ? +Math.min(ma50 * 0.975, entryLow - 2 * atr).toFixed(2)
                     : +(entryLow - 2 * atr).toFixed(2);
    target1   = +(entryLow + 3.0 * atr).toFixed(2);
    target2   = +(entryLow + 5.0 * atr).toFixed(2);
  }

  const risk   = entryLow - stopLevel;
  const reward = target1  - entryLow;
  const rr     = risk > 0 ? +(reward / risk).toFixed(1) : 0;

  return {
    entryZone:  `$${entryLow} – $${entryHigh}`,
    stopLevel:  `$${stopLevel} (${mode === 'swing' ? '1.5' : '2'}× ATR below entry)`,
    target1:    `$${target1}`,
    target2:    `$${target2}`,
    riskReward: `${rr}:1`,
    stopPct:    +((risk / entryLow) * 100).toFixed(1),
    atrUsed:    +atr.toFixed(2),
  };
}

// ─── Swing Lab ────────────────────────────────────────────────────────────────
// SWING: IBD RS ≥ 70 + short-term momentum ≥ 55 + within 7% of high + vol ≥ 1.1x
// Requires BOTH long-term strength AND short-term momentum
// ── SWING: tight filter — must be near breakout AND actively moving ────────────
// All 5 conditions must be true simultaneously:
//   RS ≥ 70 (institutional backing)
//   RS trend RISING (not just high, actively being accumulated)
//   SwingMomentum ≥ 55 (moving right now, confirmed by 5/10-day ROC)
//   Within 7% of 52wk high (near breakout, not in the middle of a correction)
//   Volume ratio ≥ 1.1x (above-average volume confirms institutional participation)
function isSwingCandidate(s) {
  const rsRising = s.rsTrend?.direction === 'rising' || s.rsTrend?.vs1m > 3;
  return (
    s.rsRank       >= 70   &&
    rsRising               &&   // RS must be actively rising — not just historically high
    s.swingMomentum >= 55  &&
    s.vsMA50        >  0   &&   // price above 50MA
    s.volumeRatio   >= 1.1 &&
    (s.distFromHigh||1) <= 0.07 // within 7% of 52wk high
  );
}

// ── POSITION: selective — uptrend + RS rising + pullback opportunity ───────────
// The checklist says "RS ≥ 70 AND rising for ≥ 4 weeks" — enforcing that:
//   RS ≥ 70 (stronger threshold than before — 65 produced too many results)
//   RS trend rising (at minimum gained >3pts vs 1 month ago)
//   Above 200MA (uptrend intact — the non-negotiable)
//   Not extended more than 30% from high
//   NOT currently > 5% above 50MA (that's extended, not a pullback entry)
function isPositionCandidate(s) {
  const rsRisingMonth = s.rsTrend?.vs1m > 3; // gained > 3pts in last month
  return (
    s.rsRank       >= 70   &&   // raised from 65 — 65 was too broad
    rsRisingMonth          &&   // RS must be trending up, not just above threshold
    s.vsMA200      >  0    &&   // above 200MA (uptrend)
    s.vsMA50       <= 5    &&   // not extended (≤5% above 50MA = reasonable entry zone)
    s.vsMA50       > -15   &&   // not too far below 50MA (broken down)
    (s.distFromHigh||1) <= 0.30
  );
}

async function getBatchTradeBriefs(candidates, tradeType, regime) {
  const tickers = candidates.map(s => s.ticker);

  // Step 1: Sonnet + web search — news & earnings for ALL at once
  let newsMap = {};
  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: 'Financial data. Return ONLY raw JSON, no markdown.',
      messages: [{ role: 'user', content:
        `Search next earnings date and latest news for: ${tickers.join(', ')}
Return ONLY: { "TICKER": { "earningsDate": "Mon DD YYYY or null", "daysToEarnings": N or null, "news": "1 sentence" } }` }],
    });
    const t = r.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s !== -1) newsMap = JSON.parse(t.slice(s, e+1));
  } catch(err) { console.warn('News batch:', err.message); }

  // Step 2: Haiku — generate setups (no web search, ~20x cheaper)
  const stockData = candidates.map(s => ({
    ticker: s.ticker, price: s.price?.toFixed(2),
    ibdRS: s.rsRank, rsTrend: s.rsTrend?.direction || 'unknown',
    rsVs1m: s.rsTrend?.vs1m, rsVs3m: s.rsTrend?.vs3m,
    swingMomentum: s.swingMomentum,   // short-term momentum score
    vsMA50: s.vsMA50?.toFixed(1), vsMA200: s.vsMA200?.toFixed(1),
    ma50: s.ma50?.toFixed(2), ma200: s.ma200?.toFixed(2),
    atr: s.atr, atrPct: s.atrPct,     // for stop placement
    volRatio: s.volumeRatio?.toFixed(2), volumeSurge: s.volumeSurge,
    distFromHigh: ((s.distFromHigh||0)*100).toFixed(1),
    chg1w: s.chg1w?.toFixed(1), chg1m: s.chg1m?.toFixed(1),
    sector: s.sector,
    earningsDate: newsMap[s.ticker]?.earningsDate || null,
    daysToEarnings: newsMap[s.ticker]?.daysToEarnings || null,
    recentNews: newsMap[s.ticker]?.news || null,
  }));

  const holdDesc = tradeType === 'swing' ? '2-10 day swing' : '3-8 week position';
  const r2 = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 3500,
    system: `Professional ${tradeType} trader. Market: ${regime?.regime}. ${regime?.warning||''}. Size multiplier: ${regime?.sizeMultiplier}x. ONLY valid JSON array.`,
    messages: [{ role: 'user', content:
      `Generate ${holdDesc} trade setups using IBD RS (long-term strength) AND swingMomentum (short-term movement) together.

KEY RULES:
- BUY: IBD RS rising OR high + swingMomentum ≥ 60 + no earnings risk + above key MAs
- WATCH: good RS but swingMomentum 45-59 (wait for momentum to pick up)  
- AVOID: earnings <14 days, RS falling, swingMomentum <40, or extended >5% above 50MA
- Stops: always at ATR-based level (price - 1.5 × ATR), not arbitrary %
- Targets: use prior resistance or measured move from consolidation
- Mention if volumeSurge=true (institutional breakout signal)

Data: ${JSON.stringify(stockData, null, 1)}

Return JSON array:
[{
  "ticker":"XXX",
  "verdict":"BUY|WATCH|AVOID",
  "thesis":"2 sentences: why RS+momentum combo is compelling",
  "entryZone":"$XXX-$XXX",
  "stopLevel":"$XXX (1.5×ATR below entry)",
  "target1":"$XXX",
  "target2":"$XXX",
  "riskReward":"X:1",
  "holdPeriod":"X-Y days",
  "positionSize":"${regime?.sizeMultiplier||1}x normal (regime-adjusted)",
  "earningsRisk":true/false,
  "earningsDate":"date or null",
  "daysToEarnings":N or null,
  "catalysts":["..."],
  "riskFlags":["..."],
  "rsTrendNote":"RS rising Xpts over 4wks / flat / falling — implication",
  "riskScore":1-10,
  "confidence":"high|medium|low"
}]` }],
  });
  const t2 = r2.content.filter(b=>b.type==='text').map(b=>b.text).join('');
  const clean = t2.replace(/```json|```/g, '').trim();
  const s2 = clean.indexOf('['), e2 = clean.lastIndexOf(']');
  if (s2 === -1) throw new Error('No JSON array in setup response');
  const setups = JSON.parse(clean.slice(s2, e2+1));
  return setups.map(setup => ({
    ...setup,
    earningsDate:   newsMap[setup.ticker]?.earningsDate || null,
    daysToEarnings: newsMap[setup.ticker]?.daysToEarnings || null,
    recentNews:     newsMap[setup.ticker]?.news || null,
    tradeType,
  }));
}

app.post('/api/swing-lab/scan', async (req, res) => {
  const { stocks = [], mode = 'swing' } = req.body;
  if (!stocks.length) return res.status(400).json({ error: 'No stocks provided' });

  const filter = mode==='swing' ? isSwingCandidate : mode==='position' ? isPositionCandidate
               : s => isSwingCandidate(s)||isPositionCandidate(s);
  const candidates = stocks.filter(filter).slice(0, 20);
  const regime = await getMarketRegime();

  if (!candidates.length) {
    const sw = stocks.filter(isSwingCandidate).length, pos = stocks.filter(isPositionCandidate).length;
    return res.json({ results:[], regime,
      message:`No candidates matched. Swing: ${sw} stocks (RS≥70+SwingMom≥55+within 7% of high+vol≥1.1x). Position: ${pos} stocks (RS≥65+above 200MA).`,
      totalInput: stocks.length, scannedCount: 0 });
  }

  const tradeMode = mode==='both' ? 'swing' : mode;

  // Step 1: ALWAYS compute algorithmic levels (no API key needed)
  const results = candidates.map(s => ({
    ...s,
    algoSetup: computeTradeSetup(s, tradeMode),
    brief: null,
  }));

  // Step 2: Attempt AI briefs ONLY if API key is configured
  if (anthropic) {
    try {
      const briefs = await getBatchTradeBriefs(candidates, tradeMode, regime);
      for (const r of results) {
        r.brief = briefs.find(b => b.ticker === r.ticker) || null;
      }
    } catch(e) {
      console.warn('AI briefs failed (continuing with algo levels):', e.message);
    }
  }

  // Sort: AI verdict if available, else by RS rank
  const order = {BUY:0,WATCH:1,AVOID:2};
  results.sort((a,b) => {
    const av = order[a.brief?.verdict] ?? 3;
    const bv = order[b.brief?.verdict] ?? 3;
    return av !== bv ? av - bv : b.rsRank - a.rsRank;
  });

  res.json({ results, regime, hasAI: !!anthropic, scannedCount: candidates.length, totalInput: stocks.length });
});

app.post('/api/swing-lab/brief', async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
  const { stock, mode='swing' } = req.body;
  if (!stock?.ticker) return res.status(400).json({ error: 'stock.ticker required' });
  try {
    const regime = await getMarketRegime();
    const briefs = await getBatchTradeBriefs([stock], mode, regime);
    res.json({ ticker: stock.ticker, brief: briefs[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/industry-stocks ────────────────────────────────────────────────────
// Returns universe stocks that belong to a given industry ETF
app.get('/api/industry-stocks/:etf', async (req, res) => {
  try {
    const etf    = req.params.etf.toUpperCase();
    const tickers = INDUSTRY_STOCKS[etf] || [];
    const stocks  = await runRSScan();
    const history = loadRSHistory();
    const result  = tickers
      .map(t => stocks.find(s => s.ticker === t))
      .filter(Boolean)
      .map(s => ({ ...s, rsTrend: getRSTrend(s.ticker, history) }))
      .sort((a,b) => b.rsRank - a.rsRank);
    res.json({ etf, stocks: result, total: result.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/news/:ticker ───────────────────────────────────────────────────────
// Yahoo Finance RSS — completely free, no API key, no crumb needed
app.get('/api/news/:ticker', async (req, res) => {
  try {
    const sym = req.params.ticker.toUpperCase();
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`;
    const r   = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const xml = await r.text();
    // Parse RSS items
    const items = [];
    const re    = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 5) {
      const item  = m[1];
      const title = (/<title>([\s\S]*?)<\/title>/.exec(item)||[])[1]?.replace(/<!\[CDATA\[|\]\]>/g,'').trim();
      const link  = (/<link>([\s\S]*?)<\/link>/.exec(item)||[])[1]?.trim();
      const date  = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)||[])[1]?.trim();
      if (title) items.push({ title, link, date });
    }
    res.json({ ticker: sym, items, count: items.length });
  } catch(e) { res.status(500).json({ error: e.message, items: [] }); }
});

// ─── /api/fundamentals/:ticker ──────────────────────────────────────────────────
// Free from Yahoo v11 quoteSummary — called per-ticker only for Swing Lab candidates
// Returns: EPS growth, revenue growth, short float %, gross margins, ROE
app.get('/api/fundamentals/:ticker', async (req, res) => {
  try {
    const sym  = req.params.ticker.toUpperCase();
    console.log(`  Fetching fundamentals for ${sym}...`);
    const data = await getYahooFundamentals(sym);
    if (!data) {
      console.warn(`  Fundamentals: no data for ${sym}`);
      return res.status(404).json({ error: `No fundamental data for ${sym} — Yahoo v11 may not cover this ticker` });
    }
    console.log(`  ✓ Fundamentals ${sym}: EPS=${data.epsGrowthQoQ}% Rev=${data.revenueGrowthYoY}% Short=${data.shortPercentFloat}%`);
    res.json({ ticker: sym, ...data });
  } catch(e) {
    console.error(`  Fundamentals error ${req.params.ticker}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/daily-picks ────────────────────────────────────────────────────────
// Auto-ranks candidates by combined conviction score — the app's opinionated picks
// Score = IBD_RS×0.3 + RS_Accel×0.25 + SwingMom×0.2 + SEPA×0.15 + bonuses
app.get('/api/daily-picks', async (req, res) => {
  try {
    const stocks  = await runRSScan();
    const history = loadRSHistory();
    const regime  = await getMarketRegime();

    const scored = stocks
      .filter(s => s.rsRank >= 60 && s.swingMomentum >= 40)
      .map(s => {
        const trend = getRSTrend(s.ticker, history);
        const accel = trend?.vs4w || 0;
        const sepa  = s.sepaScore || 0;
        // Conviction score (0-100)
        let score = (s.rsRank * 0.30)
          + (Math.min(accel, 20) * 1.25)    // RS Accel capped at 20pts
          + (s.swingMomentum * 0.20)
          + (sepa * 2.5);                    // SEPA 0-6 → 0-15pts
        // Bonuses
        if (s.rsLineNewHigh)  score += 8;   // IBD's #1 signal
        if (s.vcpForming)     score += 6;   // Minervini setup
        if (s.volumeSurge)    score += 5;   // institutional breakout
        if (s.earningsRisk)   score -= 15;  // penalty for near earnings
        if (s.distFromHigh > 0.15) score -= 10; // too far from high for swing

        const reasons = [];
        if (s.rsRank >= 80 && accel > 5) reasons.push(`RS ${s.rsRank} rising +${accel} pts`);
        if (s.rsLineNewHigh) reasons.push('RS Line at 52-week high');
        if (s.vcpForming) reasons.push(`VCP forming (${s.vcpCount} contractions)`);
        if (s.swingMomentum >= 65) reasons.push(`Strong momentum (${s.swingMomentum})`);
        if (sepa >= 5) reasons.push(`SEPA ${sepa}/6 — ideal structure`);
        if (s.earningsRisk) reasons.push(`⚠ Earnings in ${s.daysToEarnings} days`);

        return { ...s, rsTrend: trend, convictionScore: +score.toFixed(1), reasons };
      })
      .sort((a, b) => b.convictionScore - a.convictionScore)
      .slice(0, 7);

    res.json({
      picks: scored,
      regime,
      date: new Date().toISOString().split('T')[0],
      note: regime.swingOk === false
        ? 'BEAR REGIME — no new long setups recommended'
        : `${scored.length} candidates ranked by conviction (RS + Accel + Momentum + SEPA)`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/news/:ticker (free, no API key) ────────────────────────────────────
// Yahoo Finance returns news headlines in the quote response
// Also fetch from Yahoo RSS feed for richer content
app.get('/api/news/:ticker', async (req, res) => {
  try {
    const sym = req.params.ticker.toUpperCase();
    // Yahoo quote includes news array
    const quotes = await yahooQuote([sym]);
    const q = quotes[0];
    // Also try Yahoo Finance search news
    const { crumb, cookie } = await getYahooCrumb();
    const newsUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=news&crumb=${encodeURIComponent(crumb)}`;
    let headlines = [];
    try {
      const nr = await fetch(newsUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': cookie }
      });
      const nd = await nr.json();
      const articles = nd?.quoteSummary?.result?.[0]?.news || [];
      headlines = articles.slice(0, 5).map(a => ({
        title:     a.title,
        source:    a.publisher,
        time:      a.providerPublishTime
          ? new Date(a.providerPublishTime * 1000).toLocaleDateString() : null,
        url:       a.link,
      }));
    } catch(_) {}
    res.json({ ticker: sym, headlines, earningsDate: q?.earningsDate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/health ──────────────────────────────────────────────────────────────
app.get('/api/health', async (_, res) => {
  const h = loadRSHistory(), dates = Object.keys(h).sort();
  res.json({ ok:true, claude:!!anthropic, rsHistoryDays:dates.length,
    lastSnapshot:dates[dates.length-1]||'none', universeSize:UNIVERSE.length,
    sectorBreakdown: Object.entries(SECTOR_MAP).reduce((acc,[,sec])=>{ acc[sec]=(acc[sec]||0)+1; return acc; },{}),
    rsModel:'REAL IBD 12-month daily closes', time:new Date().toISOString() });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  const counts = Object.entries(SECTOR_MAP).reduce((a,[,s])=>{a[s]=(a[s]||0)+1;return a},{});
  console.log(`\n🎯 Alpha Hunter v8  →  http://localhost:${PORT}`);
  console.log(`   Universe: ${UNIVERSE.length} stocks (S&P500 expanded — includes AAPL, MSFT, all majors)`);
  console.log(`   RS model: REAL IBD (12-month daily closes)`);
  console.log(`   RS history auto pre-generates 90 days on first scan`);
  console.log(`   Swing: IBD RS + short-term momentum (5/10-day ROC)`);
  console.log(`   Claude: ${anthropic?'✓ sonnet-4-6 / haiku-4-5':'⚠ Set ANTHROPIC_API_KEY'}\n`);
});
