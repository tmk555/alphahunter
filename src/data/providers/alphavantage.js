// ─── Alpha Vantage data provider ────────────────────────────────────────────
// Free tier: 25 requests/day — emergency fallback
const fetch = require('node-fetch');
const { cacheGet, cacheSet, TTL_QUOTE, TTL_HIST } = require('../cache');

const API_KEY = () => process.env.ALPHA_VANTAGE_API_KEY || '';
const BASE    = 'https://www.alphavantage.co/query';

function ensureKey() {
  if (!API_KEY()) throw new Error('ALPHA_VANTAGE_API_KEY not configured');
}

async function avQuote(symbols) {
  ensureKey();
  // Alpha Vantage only supports single-symbol quote queries
  const results = [];
  for (const symbol of symbols) {
    const key = `av:q:${symbol}`;
    const cached = cacheGet(key, TTL_QUOTE);
    if (cached) { results.push(cached); continue; }

    const url = `${BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${API_KEY()}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();
    const gq = data['Global Quote'];
    if (!gq || !gq['05. price']) continue;

    const normalized = {
      symbol: gq['01. symbol'],
      shortName: symbol,
      regularMarketPrice: parseFloat(gq['05. price']),
      regularMarketChangePercent: parseFloat(gq['10. change percent']?.replace('%', '')) || 0,
      regularMarketVolume: parseInt(gq['06. volume']) || 0,
      fiftyTwoWeekHigh: parseFloat(gq['03. high']) || null,
      fiftyTwoWeekLow: parseFloat(gq['04. low']) || null,
    };

    cacheSet(key, normalized);
    results.push(normalized);
  }
  return results;
}

async function avHistory(symbol) {
  ensureKey();
  const key = `av:h:${symbol}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;

  const url = `${BASE}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${API_KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Alpha Vantage history error (${res.status})`);
  const data = await res.json();

  const timeSeries = data['Time Series (Daily)'];
  if (!timeSeries) throw new Error('Alpha Vantage: no time series data');

  const entries = Object.entries(timeSeries)
    .sort(([a], [b]) => a.localeCompare(b)) // oldest first
    .slice(-252); // ~1 year

  const closes = entries.map(([, d]) => parseFloat(d['4. close'])).filter(p => p > 0);

  cacheSet(key, closes);
  return closes;
}

async function avHistoryFull(symbol) {
  ensureKey();
  const key = `av:hf:${symbol}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;

  const url = `${BASE}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${API_KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Alpha Vantage history full error (${res.status})`);
  const data = await res.json();

  const timeSeries = data['Time Series (Daily)'];
  if (!timeSeries) throw new Error('Alpha Vantage: no time series data');

  const bars = Object.entries(timeSeries)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-252)
    .map(([date, d]) => ({
      date,
      open: parseFloat(d['1. open']),
      high: parseFloat(d['2. high']),
      low: parseFloat(d['3. low']),
      close: parseFloat(d['4. close']),
      volume: parseInt(d['5. volume']) || 0,
    }))
    .filter(b => b.close > 0);

  cacheSet(key, bars);
  return bars;
}

function isConfigured() {
  return !!API_KEY();
}

module.exports = { avQuote, avHistory, avHistoryFull, isConfigured };
