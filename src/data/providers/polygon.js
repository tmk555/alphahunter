// ─── Polygon.io Data Provider ────────────────────────────────────────────────
// Primary data provider ($29/mo Stocks Starter). Reliable, documented API.
// Provides EOD bars, snapshots, intraday bars, and fundamentals.
const fetch = require('node-fetch');
const { cacheGet, cacheSet, TTL_QUOTE, TTL_HIST } = require('../cache');

const API_KEY = () => process.env.POLYGON_API_KEY || '';
const BASE = 'https://api.polygon.io';

function isConfigured() { return !!API_KEY(); }

function ensureKey() {
  if (!API_KEY()) throw new Error('POLYGON_API_KEY not configured');
}

function dateStr(d) { return d.toISOString().slice(0, 10); }
function twoYearsAgo() {
  const d = new Date(); d.setFullYear(d.getFullYear() - 2); return dateStr(d);
}
function today() { return dateStr(new Date()); }

async function polyFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}apiKey=${API_KEY()}`;
  const res = await fetch(url, { timeout: 15000 });
  if (res.status === 429) throw new Error('Polygon rate limit exceeded');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polygon API error (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Batch Quote via Snapshot ───────────────────────────────────────────────

async function polygonQuote(symbols) {
  ensureKey();
  const key = `poly:q:${symbols.sort().join(',')}`;
  const cached = cacheGet(key, TTL_QUOTE);
  if (cached) return cached;

  // Batch snapshot — up to 250 tickers per call
  const batches = [];
  for (let i = 0; i < symbols.length; i += 250) {
    batches.push(symbols.slice(i, i + 250));
  }

  const allResults = [];
  for (const batch of batches) {
    const tickers = batch.join(',');
    const data = await polyFetch(`/v2/snapshot/locale/us/market/stocks/tickers?tickers=${tickers}`);
    if (data.tickers) {
      for (const t of data.tickers) {
        allResults.push({
          symbol: t.ticker,
          shortName: t.ticker,
          regularMarketPrice: t.day?.c || t.prevDay?.c || t.min?.c,
          regularMarketChangePercent: t.todaysChangePerc || 0,
          regularMarketVolume: t.day?.v || 0,
          fiftyTwoWeekHigh: t.day?.h || null,  // Snapshot doesn't have 52w — filled by MA calc
          fiftyTwoWeekLow: t.day?.l || null,
          fiftyDayAverage: null,     // Computed below from bars
          twoHundredDayAverage: null,
          averageDailyVolume3Month: null,
          marketCap: null,
          forwardPE: null,
          sector: undefined,
          earningsTimestamp: undefined,
          _polySnapshot: true,
        });
      }
    }
  }

  // Compute moving averages from daily bars for accuracy (batch of first 20 symbols)
  // Full MA computation is expensive — only do for small batches
  if (symbols.length <= 30) {
    try {
      for (const result of allResults) {
        const bars = await _fetchDailyBars(result.symbol, 210);
        if (bars && bars.length >= 50) {
          const closes = bars.map(b => b.c);
          result.fiftyDayAverage = +(closes.slice(-50).reduce((a, b) => a + b, 0) / 50).toFixed(2);
          if (closes.length >= 200) {
            result.twoHundredDayAverage = +(closes.slice(-200).reduce((a, b) => a + b, 0) / 200).toFixed(2);
          }
          // Average daily volume (3 month ~63 trading days)
          const vols = bars.slice(-63).map(b => b.v);
          result.averageDailyVolume3Month = Math.round(vols.reduce((a, b) => a + b, 0) / vols.length);
          // 52-week high/low
          const yr = closes.slice(-252);
          result.fiftyTwoWeekHigh = Math.max(...yr);
          result.fiftyTwoWeekLow = Math.min(...yr);
        }
      }
    } catch (_) {
      // MA computation is best-effort — snapshot data is still valid without it
    }
  }

  cacheSet(key, allResults);
  return allResults;
}

// ─── Internal: fetch raw daily bars ────────────────────────────────────────

async function _fetchDailyBars(symbol, days) {
  const from = new Date();
  from.setDate(from.getDate() - Math.ceil(days * 1.5)); // Buffer for weekends/holidays
  const data = await polyFetch(
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${dateStr(from)}/${today()}?adjusted=true&sort=asc&limit=${days + 50}`
  );
  return data.results || [];
}

// ─── Daily Close History (array of close prices, oldest first) ─────────────

async function polygonHistory(symbol) {
  ensureKey();
  const key = `poly:h:${symbol}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;

  const data = await polyFetch(
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${twoYearsAgo()}/${today()}?adjusted=true&sort=asc&limit=600`
  );

  if (!data.results?.length) throw new Error(`No history for ${symbol}`);

  const closes = data.results.map(r => r.c);
  cacheSet(key, closes);
  return closes;
}

// ─── Full OHLCV History ──────────────────────────────────────────────────────

async function polygonHistoryFull(symbol) {
  ensureKey();
  const key = `poly:hf:${symbol}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;

  const data = await polyFetch(
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${twoYearsAgo()}/${today()}?adjusted=true&sort=asc&limit=600`
  );

  if (!data.results?.length) throw new Error(`No history for ${symbol}`);

  const bars = data.results.map(r => ({
    date: new Date(r.t).toISOString().slice(0, 10),
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    volume: r.v,
  }));

  cacheSet(key, bars);
  return bars;
}

// ─── Intraday Bars (Phase 2: Entry Timing) ──────────────────────────────────

async function polygonIntradayBars(symbol, timespan = 'minute', multiplier = 5, from, to) {
  ensureKey();
  const fromDate = from || today();
  const toDate = to || today();
  const key = `poly:id:${symbol}:${multiplier}${timespan}:${fromDate}:${toDate}`;
  const cached = cacheGet(key, 5 * 60 * 1000); // 5 min cache for intraday
  if (cached) return cached;

  const data = await polyFetch(
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=5000`
  );

  if (!data.results?.length) throw new Error(`No intraday data for ${symbol}`);

  const bars = data.results.map(r => {
    const dt = new Date(r.t);
    return {
      date: dt.toISOString().slice(0, 10),
      time: dt.toISOString().slice(11, 19),
      timestamp: r.t,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
      vwap: r.vw || null,
    };
  });

  cacheSet(key, bars);
  return bars;
}

// ─── Fundamentals (CAN SLIM fields) ────────────────────────────────────────

async function polygonFundamentals(symbol) {
  ensureKey();
  const key = `poly:f:${symbol}`;
  const cached = cacheGet(key, 24 * 60 * 60 * 1000); // 24h cache
  if (cached) return cached;

  try {
    // Get quarterly financials
    const data = await polyFetch(
      `/vX/reference/financials?ticker=${encodeURIComponent(symbol)}&timeframe=quarterly&order=desc&limit=8&sort=period_of_report_date`
    );

    const results = data.results || [];
    if (results.length < 2) {
      return { symbol, error: 'Insufficient financial data' };
    }

    // Extract EPS and revenue from income statements
    const quarters = results.map(r => {
      const income = r.financials?.income_statement || {};
      return {
        period: r.fiscal_period,
        year: r.fiscal_year,
        date: r.period_of_report_date,
        eps: income.basic_earnings_per_share?.value || null,
        revenue: income.revenues?.value || null,
      };
    });

    // Compute growth rates
    const current = quarters[0];
    const priorQ = quarters[1];
    const yearAgo = quarters.find(q => q.year === current.year - 1 && q.period === current.period);

    const epsGrowthQoQ = current?.eps && priorQ?.eps && priorQ.eps !== 0
      ? +(((current.eps - priorQ.eps) / Math.abs(priorQ.eps)) * 100).toFixed(1) : null;
    const epsGrowthYoY = current?.eps && yearAgo?.eps && yearAgo.eps !== 0
      ? +(((current.eps - yearAgo.eps) / Math.abs(yearAgo.eps)) * 100).toFixed(1) : null;
    const revenueGrowthQoQ = current?.revenue && priorQ?.revenue && priorQ.revenue !== 0
      ? +(((current.revenue - priorQ.revenue) / Math.abs(priorQ.revenue)) * 100).toFixed(1) : null;
    const revenueGrowthYoY = current?.revenue && yearAgo?.revenue && yearAgo.revenue !== 0
      ? +(((current.revenue - yearAgo.revenue) / Math.abs(yearAgo.revenue)) * 100).toFixed(1) : null;

    // Get sector from ticker details
    let sector = undefined;
    try {
      const details = await polyFetch(`/v3/reference/tickers/${encodeURIComponent(symbol)}`);
      sector = details.results?.sic_description || details.results?.type || undefined;
    } catch (_) {}

    const result = {
      symbol,
      epsGrowthQoQ,
      epsGrowthYoY,
      revenueGrowthQoQ,
      revenueGrowthYoY,
      latestEPS: current?.eps,
      latestRevenue: current?.revenue,
      quartersAvailable: quarters.length,
      sector,
    };

    cacheSet(key, result);
    return result;
  } catch (e) {
    return { symbol, error: e.message };
  }
}

module.exports = {
  isConfigured,
  polygonQuote,
  polygonHistory,
  polygonHistoryFull,
  polygonIntradayBars,
  polygonFundamentals,
};
