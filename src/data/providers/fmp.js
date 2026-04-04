// ─── Financial Modeling Prep (FMP) data provider ────────────────────────────
// Free tier: 250 requests/day — good fallback for Yahoo outages
const fetch = require('node-fetch');
const { cacheGet, cacheSet, TTL_QUOTE, TTL_HIST } = require('../cache');

const API_KEY = () => process.env.FMP_API_KEY || '';
const BASE    = 'https://financialmodelingprep.com/api/v3';

function ensureKey() {
  if (!API_KEY()) throw new Error('FMP_API_KEY not configured');
}

async function fmpQuote(symbols) {
  ensureKey();
  const key = `fmp:q:${symbols.sort().join(',')}`;
  const cached = cacheGet(key, TTL_QUOTE);
  if (cached) return cached;

  const url = `${BASE}/quote/${encodeURIComponent(symbols.join(','))}?apikey=${API_KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP quote error (${res.status})`);
  const data = await res.json();

  // Normalize to Yahoo-like format for compatibility
  const result = data.map(q => ({
    symbol: q.symbol,
    shortName: q.name,
    regularMarketPrice: q.price,
    regularMarketChangePercent: q.changesPercentage,
    regularMarketVolume: q.volume,
    averageDailyVolume3Month: q.avgVolume,
    fiftyTwoWeekHigh: q.yearHigh,
    fiftyTwoWeekLow: q.yearLow,
    fiftyDayAverage: q.priceAvg50,
    twoHundredDayAverage: q.priceAvg200,
    marketCap: q.marketCap,
    forwardPE: q.pe,
    sector: q.sector || undefined,
    earningsTimestamp: q.earningsAnnouncement ? Math.floor(new Date(q.earningsAnnouncement).getTime() / 1000) : undefined,
  }));

  cacheSet(key, result);
  return result;
}

async function fmpHistory(symbol) {
  ensureKey();
  const key = `fmp:h:${symbol}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;

  const url = `${BASE}/historical-price-full/${encodeURIComponent(symbol)}?timeseries=365&apikey=${API_KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP history error (${res.status})`);
  const data = await res.json();

  const historical = (data.historical || []).reverse(); // oldest first
  const closes = historical.map(d => d.close).filter(p => p != null && p > 0);

  cacheSet(key, closes);
  return closes;
}

async function fmpHistoryFull(symbol) {
  ensureKey();
  const key = `fmp:hf:${symbol}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;

  const url = `${BASE}/historical-price-full/${encodeURIComponent(symbol)}?timeseries=365&apikey=${API_KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP history full error (${res.status})`);
  const data = await res.json();

  const bars = (data.historical || []).reverse().map(d => ({
    date: d.date,
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
    volume: d.volume || 0,
  })).filter(b => b.close != null);

  cacheSet(key, bars);
  return bars;
}

function isConfigured() {
  return !!API_KEY();
}

module.exports = { fmpQuote, fmpHistory, fmpHistoryFull, isConfigured };
