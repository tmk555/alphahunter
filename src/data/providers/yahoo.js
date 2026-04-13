// ─── Yahoo Finance data provider ──────────────────────────────────────────────
const fetch = require('node-fetch');
const { cacheGet, cacheSet, TTL_QUOTE, TTL_HIST } = require('../cache');

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

function resetAuth() {
  yhCrumb = null;
  yhCookie = null;
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
  const r = await fetch(url, {
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
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Cookie': cookie },
  });
  const data   = await r.json();
  const closes = (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(p => p != null && p > 0);
  cacheSet(key, closes);
  return closes;
}

// Full OHLCV history (needed for cycle detection — distribution days require volume)
async function yahooHistoryFull(symbol) {
  const key = `hf:${symbol}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;
  const { crumb, cookie } = await getYahooCrumb();
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, {
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
      revGrowth_Q0_yoy, revGrowth_Q1_yoy,
      sharesFloat, sharesShort, shortPercentFloat, shortRatio,
      institutionPct, insiderPct,
      revenueGrowthYoY, grossMargins, returnOnEquity, debtToEquity, forwardPE,
      canSlimScore,
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
  const r = await fetch(url, {
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

module.exports = {
  getYahooCrumb, resetAuth,
  yahooQuote, yahooHistory, yahooHistoryFull,
  yahooIntradayBars,
  getYahooFundamentals, raw,
  pLimit,
};
