// ─── Yahoo Finance data provider ──────────────────────────────────────────────
const fetch = require('node-fetch');
const { cacheGet, cacheSet, TTL_QUOTE, TTL_HIST } = require('../cache');

let yhCrumb = null, yhCookie = null, yhAuthInFlight = null;

async function getYahooCrumb() {
  if (yhCrumb && yhCookie) return { crumb: yhCrumb, cookie: yhCookie };
  // In-flight dedup: when 20 concurrent tasks all see null crumb at cold
  // start, they'd each launch their own auth hop — thundering-herd on
  // fc.yahoo.com, many of which Yahoo throttles and silently empty-caches
  // downstream. Collapse concurrent callers onto the same promise instead.
  if (yhAuthInFlight) return yhAuthInFlight;
  yhAuthInFlight = _fetchCrumb().finally(() => { yhAuthInFlight = null; });
  return yhAuthInFlight;
}

async function _fetchCrumb() {
  // 15s hard cap on each Yahoo auth hop — if fc.yahoo.com or query2 is slow we
  // used to hang the caller indefinitely (rs-scan / macro would spin until
  // the browser timed out). Now we fail fast and the user sees a real error.
  const TIMEOUT_MS = 15000;
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, redirect: 'follow',
      timeout: TIMEOUT_MS,
    });
    const m = (r1.headers.get('set-cookie') || '').match(/A3=[^;]+/);
    yhCookie = m ? m[0] : '';
  } catch (_) {
    const r1 = await fetch('https://finance.yahoo.com', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: TIMEOUT_MS });
    yhCookie = r1.headers.get('set-cookie') || '';
  }
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': yhCookie },
    timeout: TIMEOUT_MS,
  });
  yhCrumb = await r2.text();
  if (!yhCrumb || yhCrumb.includes('<') || yhCrumb.length > 20) {
    const r3 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)', 'Cookie': yhCookie },
      timeout: TIMEOUT_MS,
    });
    yhCrumb = await r3.text();
  }
  console.log(`  ✓ Crumb: ${yhCrumb?.slice(0,8)}...`);
  return { crumb: yhCrumb, cookie: yhCookie };
}

function resetAuth() {
  yhCrumb = null;
  yhCookie = null;
}

// ─── Network-error retry wrapper ────────────────────────────────────────────
// node-fetch throws (not returns a status) when the TCP connection is reset,
// DNS resolution fails, or the socket hangs up — all transient failures that
// used to bubble up as a hard error on a single blip. Retry up to 3 times
// with jittered exponential backoff (400ms → 800ms → 1600ms) before giving
// up. HTTP-level errors (401, 404, 500) still surface to the caller and are
// handled there (e.g. resetAuth on 401 → manager cascades to next provider).
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);
function _isNetworkError(e) {
  if (!e) return false;
  if (e.code && NETWORK_ERROR_CODES.has(e.code)) return true;
  if (e.type === 'request-timeout' || e.type === 'system') return true;
  const msg = String(e.message || '');
  return /socket hang up|network timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg);
}
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, opts = {}, { retries = 3 } = {}) {
  const optsWithTimeout = { timeout: 30000, ...opts };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, optsWithTimeout);
    } catch (e) {
      lastErr = e;
      if (!_isNetworkError(e) || attempt === retries) throw e;
      const backoff = 400 * Math.pow(2, attempt);
      await _sleep(backoff * (0.75 + Math.random() * 0.5));
    }
  }
  throw lastErr;
}

async function yahooQuote(symbols) {
  const key = `q:${symbols.sort().join(',')}`;
  const cached = cacheGet(key, TTL_QUOTE);
  if (cached) return cached;
  const { crumb, cookie } = await getYahooCrumb();
  const fields = 'regularMarketPrice,regularMarketChangePercent,regularMarketVolume,' +
    'fiftyTwoWeekHigh,fiftyTwoWeekLow,fiftyDayAverage,twoHundredDayAverage,' +
    'averageDailyVolume3Month,marketCap,forwardPE,shortName,sector,' +
    'earningsTimestamp,earningsTimestampStart,earningsTimestampEnd';
  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&fields=${encodeURIComponent(fields)}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': cookie, 'Accept': 'application/json' },
  });
  if (r.status === 401 || r.status === 403) { resetAuth(); throw new Error(`Yahoo auth expired (${r.status})`); }
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
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': cookie },
  });
  const data   = await r.json();
  const closes = (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(p => p != null && p > 0);
  cacheSet(key, closes);
  return closes;
}

// Full OHLCV history (needed for cycle detection — distribution days require
// volume, backfill needs multi-year bars for point-in-time snapshots).
//
// Range default is 10y so replay/backfill can walk deep historical windows —
// Alpaca free tier only serves bars back to ~mid-2020 (IEX retention), so
// Yahoo is the only configured provider that reaches 2016+. Bars are daily,
// so 10y ≈ 2500 bars; the 23h TTL means we pay this once per symbol per day.
// Callers that only need recent history still benefit from the cache — they
// just slice the tail. Override via { range } if you want a smaller window.
async function yahooHistoryFull(symbol, { range = '10y' } = {}) {
  const key = `hf:${symbol}:${range}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;
  const { crumb, cookie } = await getYahooCrumb();
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': cookie },
  });
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const ts     = result.timestamp || [];
  const quote  = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (quote.close?.[i] == null) continue;
    bars.push({
      date:   new Date(ts[i] * 1000).toISOString().split('T')[0],
      open:   quote.open?.[i],
      high:   quote.high?.[i],
      low:    quote.low?.[i],
      close:  quote.close[i],
      volume: quote.volume?.[i] || 0,
    });
  }
  cacheSet(key, bars);
  return bars;
}

// Helper: extract raw value from Yahoo Finance response field
function raw(field) {
  if (field == null) return null;
  if (typeof field === 'object' && 'raw' in field) return field.raw;
  if (typeof field === 'number') return field;
  return null;
}

async function getYahooFundamentals(symbol) {
  try {
    const { crumb, cookie } = await getYahooCrumb();
    const modules = 'financialData,defaultKeyStatistics,incomeStatementHistory,incomeStatementHistoryQuarterly,earningsTrend,earningsHistory';
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Cookie': cookie,
        'Accept': 'application/json',
      }
    });
    const d = await r.json();
    if (r.status === 401 || r.status === 403) {
      resetAuth();
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

    // ── C: Current quarterly EPS — TRUE same-quarter Y/Y from quarterly history
    let epsGrowthQoQ = null;
    let epsQ_0 = null, epsQ_1 = null, epsQ_2 = null;
    let revenueQ_0 = null, revenueQ_1 = null, revenueQ_2 = null;
    let epsGrowth_Q0_yoy = null, epsGrowth_Q1_yoy = null, epsGrowth_Q2_yoy = null;
    let revGrowth_Q0_yoy = null, revGrowth_Q1_yoy = null;
    let epsActualQuarterly = []; // per-share EPS from earningsHistory

    if (ishQ.length >= 5) {
      epsQ_0 = raw(ishQ[0]?.netIncome);
      epsQ_1 = raw(ishQ[1]?.netIncome);
      epsQ_2 = raw(ishQ[2]?.netIncome);
      revenueQ_0 = raw(ishQ[0]?.totalRevenue);
      revenueQ_1 = raw(ishQ[1]?.totalRevenue);
      revenueQ_2 = raw(ishQ[2]?.totalRevenue);
      const epsQ_4 = raw(ishQ[4]?.netIncome);
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

    // Fallback: Use earningsHistory for per-share EPS when incomeStatement only has 4 quarters
    // earningsHistory gives actual reported EPS/share + sequential growth trend
    const ehist = result.earningsHistory?.history || [];
    if (ehist.length >= 2 && epsGrowth_Q0_yoy == null) {
      // earningsHistory is chronological (oldest first), reverse to newest first
      const sorted = [...ehist].sort((a, b) => {
        const da = a.quarter?.raw || 0;
        const db = b.quarter?.raw || 0;
        return db - da;
      });
      epsActualQuarterly = sorted.map(q => ({
        date: q.quarter?.fmt,
        actual: raw(q.epsActual),
        estimate: raw(q.epsEstimate),
        surprise: raw(q.epsDifference),
        surprisePct: raw(q.surprisePercent),
      })).filter(q => q.actual != null);

      // Calculate sequential Q/Q growth (not Y/Y, but still shows acceleration)
      if (epsActualQuarterly.length >= 2) {
        const q0 = epsActualQuarterly[0]?.actual;
        const q1 = epsActualQuarterly[1]?.actual;
        const q2 = epsActualQuarterly[2]?.actual;
        if (q0 != null && q1 != null && q1 > 0)
          epsGrowth_Q0_yoy = +((q0/q1 - 1)*100).toFixed(1);
        if (q1 != null && q2 != null && q2 > 0)
          epsGrowth_Q1_yoy = +((q1/q2 - 1)*100).toFixed(1);
        if (epsActualQuarterly.length >= 4) {
          const q3 = epsActualQuarterly[3]?.actual;
          if (q2 != null && q3 != null && q3 > 0)
            epsGrowth_Q2_yoy = +((q2/q3 - 1)*100).toFixed(1);
        }
      }
    }

    // Revenue Q/Q from incomeStatement (uses available 4 quarters)
    if (revGrowth_Q0_yoy == null && ishQ.length >= 2) {
      revenueQ_0 = raw(ishQ[0]?.totalRevenue);
      revenueQ_1 = raw(ishQ[1]?.totalRevenue);
      if (revenueQ_0 != null && revenueQ_1 != null && revenueQ_1 > 0)
        revGrowth_Q0_yoy = +((revenueQ_0/revenueQ_1 - 1)*100).toFixed(1);
      if (ishQ.length >= 3) {
        revenueQ_2 = raw(ishQ[2]?.totalRevenue);
        if (revenueQ_1 != null && revenueQ_2 != null && revenueQ_2 > 0)
          revGrowth_Q1_yoy = +((revenueQ_1/revenueQ_2 - 1)*100).toFixed(1);
      }
    }

    epsGrowthQoQ = epsGrowth_Q0_yoy ?? (raw(fd.earningsGrowth) != null ? +(fd.earningsGrowth.raw * 100).toFixed(1) : null);

    const c_pass_q0 = epsGrowth_Q0_yoy != null && epsGrowth_Q0_yoy >= 25;
    const c_pass_q1 = epsGrowth_Q1_yoy != null && epsGrowth_Q1_yoy >= 25;
    const c_pass_q2 = epsGrowth_Q2_yoy != null && epsGrowth_Q2_yoy >= 25;
    const epsAccelerating_qoq =
      epsGrowth_Q0_yoy != null && epsGrowth_Q1_yoy != null &&
      epsGrowth_Q0_yoy > epsGrowth_Q1_yoy;

    // ── A: Annual EPS
    let epsGrowthYoY = null;
    let epsAnnualGrowth = [];
    let epsTurnaround = false;    // loss → profit transition
    let epsAnnualValues = [];     // actual annual net income for display
    if (ish.length >= 2) {
      const eps0 = raw(ish[0]?.netIncome);
      const eps1 = raw(ish[1]?.netIncome);
      const eps2 = raw(ish[2]?.netIncome);
      const rev0 = raw(ish[0]?.totalRevenue);

      // Store actual values for display
      for (let i = 0; i < Math.min(ish.length, 4); i++) {
        const ni = raw(ish[i]?.netIncome);
        if (ni != null) epsAnnualValues.push({ date: ish[i]?.endDate?.fmt, netIncome: ni });
      }

      if (eps0 != null && eps1 != null && eps1 > 0) {
        epsGrowthYoY = +((eps0/eps1 - 1)*100).toFixed(1);
      } else if (eps0 != null && eps0 > 0 && eps1 != null && eps1 <= 0) {
        // Turnaround: loss last year → profit this year
        epsTurnaround = true;
        epsGrowthYoY = null; // can't compute meaningful %, but flag it
      }

      if (eps0 != null && eps1 != null && eps1 > 0)
        epsAnnualGrowth.push(+((eps0/eps1 - 1)*100).toFixed(1));
      if (eps1 != null && eps2 != null && eps2 > 0)
        epsAnnualGrowth.push(+((eps1/eps2 - 1)*100).toFixed(1));
    }
    const annualEpsAccelerating = epsAnnualGrowth.length >= 2 &&
      epsAnnualGrowth[0] > epsAnnualGrowth[1];
    const epsAccelerating = epsGrowthQoQ != null && epsGrowthYoY != null
      && epsGrowthQoQ > epsGrowthYoY;

    // ── S: Supply
    const sharesFloat       = raw(ks.floatShares) || null;
    const sharesShort       = raw(ks.sharesShort) || null;
    const shortPercentFloat = raw(ks.shortPercentOfFloat) != null
      ? +(ks.shortPercentOfFloat.raw * 100).toFixed(1) : null;
    const shortRatio        = raw(ks.shortRatio) || null;

    // ── I: Institutional ownership
    const _instField = ks.heldPercentInstitutions ?? ks.institutionsPercentHeld;
    const _insField  = ks.heldPercentInsiders     ?? ks.insidersPercentHeld;
    const institutionPct = raw(_instField) != null
      ? +(raw(_instField) * 100).toFixed(1) : null;
    const insiderPct     = raw(_insField)  != null
      ? +(raw(_insField)  * 100).toFixed(1) : null;

    // ── Quality metrics
    const revenueGrowthYoY  = revGrowth_Q0_yoy ?? (raw(fd.revenueGrowth) != null
      ? +(fd.revenueGrowth.raw * 100).toFixed(1) : null);
    const grossMargins      = raw(fd.grossMargins) != null
      ? +(fd.grossMargins.raw * 100).toFixed(1) : null;
    const returnOnEquity    = raw(fd.returnOnEquity) != null
      ? +(fd.returnOnEquity.raw * 100).toFixed(1) : null;
    const debtToEquity      = raw(fd.debtToEquity) || null;
    const forwardPE         = raw(fd.forwardPE) || null;

    // ── CAN SLIM score (0-6)
    const canSlimScore = [
      epsGrowth_Q0_yoy != null && epsGrowth_Q0_yoy >= 25,
      epsGrowthYoY     != null && epsGrowthYoY >= 25,
      revenueGrowthYoY != null && revenueGrowthYoY >= 15,
      shortPercentFloat != null && shortPercentFloat <= 40,
      institutionPct   != null && institutionPct >= 10,
      returnOnEquity   != null && returnOnEquity >= 15,
    ].filter(Boolean).length;

    return {
      epsGrowthQoQ, epsGrowthYoY, epsAccelerating,
      epsGrowth_Q0_yoy, epsGrowth_Q1_yoy, epsGrowth_Q2_yoy,
      c_pass_q0, c_pass_q1, c_pass_q2,
      epsAccelerating_qoq,
      epsAnnualGrowth, annualEpsAccelerating,
      epsTurnaround, epsAnnualValues,
      epsActualQuarterly,
      revGrowth_Q0_yoy, revGrowth_Q1_yoy,
      sharesFloat, sharesShort, shortPercentFloat, shortRatio,
      institutionPct, insiderPct,
      revenueGrowthYoY, grossMargins, returnOnEquity, debtToEquity, forwardPE,
      canSlimScore,
      epsDataSource: ishQ.length >= 5 ? 'yoy' : ehist.length >= 2 ? 'sequential' : 'estimate',
    };
  } catch(e) {
    console.warn('Fundamentals error:', e.message);
    return null;
  }
}

// ─── Intraday Bars (VWAP / ORB / S&R) ────────────────────────────────────────
// Uses same v8 chart endpoint with intraday interval (1m, 5m, 15m, etc.)
// Yahoo provides up to 60 days of intraday data; last 5 trading days at 1m.
async function yahooIntradayBars(symbol, timespan = 'minute', multiplier = 5, from, to) {
  const interval = timespan === 'minute' ? `${multiplier}m`
    : timespan === 'hour' ? `${multiplier}h`
    : `${multiplier}m`;

  const cacheKey = `yid:${symbol}:${interval}:${from}`;
  const cached = cacheGet(cacheKey, 5 * 60 * 1000); // 5 min cache for intraday
  if (cached) return cached;

  const { crumb, cookie } = await getYahooCrumb();

  // Build period params — Yahoo uses period1/period2 (epoch) or range
  let rangeParam;
  if (from) {
    const p1 = Math.floor(new Date(from + 'T04:00:00-04:00').getTime() / 1000);
    const p2 = to ? Math.floor(new Date(to + 'T20:00:00-04:00').getTime() / 1000)
      : Math.floor(Date.now() / 1000);
    rangeParam = `period1=${p1}&period2=${p2}`;
  } else {
    rangeParam = 'range=1d';
  }

  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${rangeParam}&interval=${interval}&crumb=${encodeURIComponent(crumb)}&includePrePost=false`;
  const r = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': cookie },
  });
  if (r.status === 401 || r.status === 403) { resetAuth(); throw new Error(`Yahoo auth expired (${r.status})`); }
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`No intraday data for ${symbol}`);

  const ts    = result.timestamp;
  const quote = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (quote.close?.[i] == null || quote.high?.[i] == null) continue;
    bars.push({
      timestamp: ts[i] * 1000,
      date: new Date(ts[i] * 1000).toISOString(),
      open:   quote.open?.[i],
      high:   quote.high?.[i],
      low:    quote.low?.[i],
      close:  quote.close[i],
      volume: quote.volume?.[i] || 0,
    });
  }

  if (!bars.length) throw new Error(`No valid intraday bars for ${symbol}`);
  cacheSet(cacheKey, bars);
  return bars;
}

async function pLimit(tasks, limit = 5) {
  const results = [];
  for (let i = 0; i < tasks.length; i += limit) {
    const batch = await Promise.allSettled(tasks.slice(i, i + limit).map(fn => fn()));
    results.push(...batch.map(r => r.status === 'fulfilled' ? r.value : null));
  }
  return results;
}

// ── Calendar events: earnings + ex-dividend dates ─────────────────────────
// Pulls the next-scheduled earnings date and the next ex-dividend date from
// Yahoo's quoteSummary endpoint. Used by the chart route to annotate the
// price pane with vertical markers so the user can spot upcoming volatility
// events at a glance.
//
// Returns:
//   {
//     earningsDate:    'YYYY-MM-DD' | null,   // next upcoming earnings
//     exDividendDate:  'YYYY-MM-DD' | null,   // next upcoming ex-div
//     earningsHistory: [                      // last 4 quarters (oldest→newest)
//       { date: 'YYYY-MM-DD',
//         epsActual:   number | null,
//         epsEstimate: number | null,
//         surprisePct: number | null,         // (actual-est)/|est| × 100
//       }, …
//     ],
//   }
//
// Always returns a shape (never null) so callers don't need null-checks.
// Cached for 6h — these dates rarely change mid-day.
const TTL_EVENTS = 6 * 60 * 60 * 1000; // 6 hours
async function yahooChartEvents(symbol) {
  const key = `cev:${symbol}`;
  const cached = cacheGet(key, TTL_EVENTS);
  if (cached) return cached;

  const empty = { earningsDate: null, exDividendDate: null, earningsHistory: [] };
  try {
    const { crumb, cookie } = await getYahooCrumb();
    // earningsHistory returns last 4 quarters with EPS actual / estimate /
    // surprise — everything we need for a TradingView-style bottom strip.
    const modules = 'calendarEvents,summaryDetail,earningsHistory';
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    });
    // Transient failures (auth expiry, missing result) must NOT be cached —
    // otherwise a single Yahoo hiccup during cold-fetch pins `earningsDate:null`
    // for the full 6h TTL, and the Upcoming Earnings panel silently shows
    // missing symbols until the cache expires.
    if (r.status === 401 || r.status === 403) { resetAuth(); return empty; }
    const d = await r.json();
    const result = d?.quoteSummary?.result?.[0];
    if (!result) return empty; // NB: no cacheSet — retry next call

    // Earnings: calendarEvents.earnings.earningsDate is an ARRAY of timestamps.
    // Yahoo returns a range [start, end] when the date is unconfirmed, or a
    // single-element array when confirmed. Use the first entry — it's always
    // the earliest possible report date.
    const earningsArr = result.calendarEvents?.earnings?.earningsDate || [];
    const earningsTs  = earningsArr.length ? raw(earningsArr[0]) : null;

    // Ex-dividend: summaryDetail.exDividendDate is a single timestamp field.
    const exDivTs = raw(result.summaryDetail?.exDividendDate);

    const toISO = (ts) => {
      if (!ts || typeof ts !== 'number') return null;
      // Yahoo returns unix seconds; convert to YYYY-MM-DD in market TZ (ET)
      // so a "Wednesday" earnings print stays on Wednesday regardless of
      // where the user's browser clock lives.
      const d = new Date(ts * 1000);
      const et = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return et; // en-CA gives 'YYYY-MM-DD'
    };

    // Historical earnings — last 4 quarters. Yahoo's `earningsHistory.history`
    // is ordered most-recent-first; reverse so oldest comes first (natural
    // left-to-right on a chart). Each item has `quarter` — the timestamp of
    // the fiscal QUARTER END, NOT the report date. For TXN, Q1 2026 ended
    // 2026-03-31 but TXN actually announced earnings on 2026-04-22 — a
    // 22-day gap. Yahoo's free API doesn't expose announcement dates.
    //
    // Two sources of truth in this object now:
    //   • `date` — uses Yahoo's pre-formatted `q.quarter.fmt` (string,
    //     no TZ ambiguity) so the chart-marker date and the Levels-tab
    //     "ACTUAL EPS" date agree. The old toISO(q.quarter.raw) path was
    //     converting Unix timestamps via America/New_York, which shifted
    //     the calendar day by 1 vs Yahoo's own formatted view (e.g.
    //     "2026-03-30" vs "2026-03-31" for the same Q1-end).
    //   • `kind: 'quarter_end'` — explicit type tag so consumers know
    //     this isn't an announcement date. UI labels say "Q ended X"
    //     accordingly.
    const rawHist = result.earningsHistory?.history || [];
    const earningsHistory = rawHist
      .map(h => {
        const fmt      = h.quarter?.fmt;
        // Prefer Yahoo's pre-formatted string; fall back to raw→ET conversion
        // only when fmt is missing (older API responses sometimes lack it).
        const date     = fmt && /^\d{4}-\d{2}-\d{2}$/.test(fmt) ? fmt : toISO(raw(h.quarter));
        const actual   = raw(h.epsActual);
        const estimate = raw(h.epsEstimate);
        if (!date) return null;
        let surprisePct = null;
        if (actual != null && estimate != null && estimate !== 0) {
          surprisePct = +(((actual - estimate) / Math.abs(estimate)) * 100).toFixed(1);
        }
        return {
          date,
          kind: 'quarter_end',
          epsActual:   actual != null ? +actual.toFixed(2) : null,
          epsEstimate: estimate != null ? +estimate.toFixed(2) : null,
          surprisePct,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const events = {
      earningsDate:    toISO(earningsTs),
      exDividendDate:  toISO(exDivTs),
      earningsHistory,
    };
    cacheSet(key, events);
    return events;
  } catch (e) {
    // Chart overlay is best-effort — never break the chart on event fetch failure.
    // Do NOT cache the empty shape: a transient Yahoo failure during a cold
    // fetch would otherwise poison the 6h cache and make the symbol silently
    // disappear from the Upcoming Earnings panel until TTL expiry. Returning
    // empty without caching lets the next request retry.
    return empty;
  }
}

// ─── Lightweight asset profile lookup (sector / industry / longName) ────────
//
// Used when we need just the classification of a symbol without the full
// fundamentals payload — e.g. "add to universe" UX, where we need to pick
// one of the 11 canonical sectors. Modules requested are the smallest set
// Yahoo will fulfil for this field.
//
// Returns null on any failure so the caller can decide whether to fall back
// (we currently fall back to Technology in the add-to-universe handler).
// Cached 7d — sector reclassifications are once-in-blue-moon events.
const TTL_PROFILE = 7 * 24 * 60 * 60 * 1000;
async function yahooAssetProfile(symbol) {
  const key = `prof:${symbol}`;
  const cached = cacheGet(key, TTL_PROFILE);
  if (cached) return cached;
  try {
    const { crumb, cookie } = await getYahooCrumb();
    const modules = 'assetProfile,quoteType';
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    });
    if (r.status === 401 || r.status === 403) { resetAuth(); return null; }
    const d = await r.json();
    const result = d?.quoteSummary?.result?.[0];
    if (!result) return null;
    const profile = result.assetProfile || {};
    const qt = result.quoteType || {};
    const out = {
      symbol,
      longName: qt.longName || qt.shortName || null,
      sector:   profile.sector   || null,
      industry: profile.industry || null,
      quoteType: qt.quoteType || null,   // EQUITY / ETF / …
    };
    cacheSet(key, out);
    return out;
  } catch (_) {
    return null;
  }
}

module.exports = {
  getYahooCrumb, resetAuth,
  yahooQuote, yahooHistory, yahooHistoryFull,
  yahooIntradayBars,
  getYahooFundamentals, raw,
  yahooChartEvents,
  yahooAssetProfile,
  pLimit,
};
