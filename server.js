require('dotenv').config();
const { FULL_UNIVERSE, INDUSTRY_ETFS: IND_ETFS, INDUSTRY_STOCKS } = require('./universe');
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

// ATR (14-day) — for position sizing
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

// Universe from universe.js module (187 S&P 500 names, AAPL included)
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
    const swingMom = calcSwingMomentum(closes, q);
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
      swingMomentum: swingMom,
      earningsDate,
      daysToEarnings,
      earningsRisk: daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 14,
      volumeTrend: volumeTrend(q),   // accumulating | distributing | neutral
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

    const result = quotes.map(q => {
      const meta = SECTOR_ETFS.find(s => s.t === q.symbol) || {};
      const closes = histMap[q.symbol] || [];
      const price = q.regularMarketPrice, ma50 = q.fiftyDayAverage, ma200 = q.twoHundredDayAverage;
      const periods = calcPeriodReturns(closes);
      return {
        symbol: q.symbol, name: meta.n, color: meta.color || '#888',
        price, ma50, ma200,
        vsMA50:  ma50  ? +((price-ma50) /ma50 *100).toFixed(2) : null,
        vsMA200: ma200 ? +((price-ma200)/ma200*100).toFixed(2) : null,
        chg1d: q.regularMarketChangePercent,
        chg1w: periods.chg1w, chg1m: periods.chg1m, chg3m: periods.chg3m, chg6m: periods.chg6m,
        w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
        volume: q.regularMarketVolume, rawRS: calcRS_real(closes),
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
    res.json({ sectors: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/industries ──────────────────────────────────────────────────────────
app.get('/api/industries', async (req, res) => {
  try {
    const symbols = INDUSTRY_ETFS.map(i => i.t);
    const quotes  = await yahooQuote(symbols);
    const histResults = await pLimit(symbols.map(sym => async () => ({ sym, closes: await yahooHistory(sym) })), 5);
    const histMap = {}; histResults.forEach(r => { if(r) histMap[r.sym] = r.closes; });

    const result = quotes.map(q => {
      const meta = INDUSTRY_ETFS.find(i => i.t === q.symbol) || {};
      const closes = histMap[q.symbol] || [];
      const price = q.regularMarketPrice;
      const ma50  = q.fiftyDayAverage;
      const ma200 = q.twoHundredDayAverage;
      const vsMA50  = ma50  ? +((price-ma50) /ma50 *100).toFixed(2) : null;
      const vsMA200 = ma200 ? +((price-ma200)/ma200*100).toFixed(2) : null;
      const periods = calcPeriodReturns(closes);
      return {
        symbol: q.symbol, name: meta.n, sector: meta.sec,
        price, ma50, ma200, vsMA50, vsMA200,
        chg1d: q.regularMarketChangePercent,
        chg1w: periods.chg1w, chg1m: periods.chg1m,
        chg3m: periods.chg3m, chg6m: periods.chg6m,
        w52h: q.fiftyTwoWeekHigh, w52l: q.fiftyTwoWeekLow,
        rawRS: calcRS_real(closes),
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
    res.json({ industries: result });
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
