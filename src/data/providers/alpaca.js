// ─── Alpaca Market Data Provider ─────────────────────────────────────────────
//
// Uses Alpaca's free market data API for historical daily bars. Key advantages
// over Yahoo Finance:
//   - 9+ years of daily history (2016+) vs Yahoo's 2-year cap
//   - Reliable institutional-grade data (IEX feed on free tier, SIP on paid)
//   - Same API keys as the trading adapter — no extra setup
//   - Much higher rate limit (200 req/min) than Yahoo
//
// Free tier caveat: uses IEX feed for bars. IEX represents ~2% of US equity
// volume, but the price prints ARE real trades (not synthetic). For daily
// OHLCV, this matches consolidated data within 0.1% on liquid names — more
// than good enough for backtesting RS/momentum strategies.
//
// Paid tier ($99/mo) gets SIP (consolidated tape) which exactly matches
// what you'd see on Polygon/Bloomberg. If you upgrade, set
// ALPACA_DATA_FEED=sip in .env — this module auto-switches.
//
// Environment: uses the same ALPACA_API_KEY / ALPACA_API_SECRET as the
// broker adapter (src/broker/alpaca.js). No new credentials needed.

const fetch = require('node-fetch');
const { cacheGet, cacheSet } = require('../cache');

const DATA_BASE = 'https://data.alpaca.markets';
const TTL_HIST  = 23 * 60 * 60 * 1000;  // 23h (matches Yahoo provider)
const TTL_QUOTE = 15 * 1000;            // 15s

function getConfig() {
  const key    = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  const feed   = process.env.ALPACA_DATA_FEED || 'iex';  // iex=free, sip=paid
  return { key, secret, feed, configured: !!(key && secret) };
}

function isConfigured() { return getConfig().configured; }

function headers() {
  const { key, secret } = getConfig();
  return {
    'APCA-API-KEY-ID':     key,
    'APCA-API-SECRET-KEY': secret,
  };
}

async function alpacaRequest(path, params = {}) {
  const { configured } = getConfig();
  if (!configured) throw new Error('Alpaca data provider: ALPACA_API_KEY and ALPACA_API_SECRET must be set');

  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  const url = `${DATA_BASE}${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { headers: headers() });
  const text = await r.text();
  if (!r.ok) {
    let msg; try { msg = JSON.parse(text).message; } catch (_) { msg = text; }
    throw new Error(`Alpaca data ${path} → ${r.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

// ─── Historical bars (paginated) ────────────────────────────────────────────
//
// Alpaca returns up to 10,000 bars per page. For daily bars that's ~40 years
// — we'll never hit it for a single symbol. But we paginate defensively via
// next_page_token in case they ever throttle differently.

async function alpacaDailyBars(symbol, { start, end, adjustment = 'split', limit = 10000 } = {}) {
  const { feed } = getConfig();
  const allBars = [];
  let pageToken = null;

  do {
    const data = await alpacaRequest(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, {
      timeframe: '1Day',
      start,
      end,
      limit,
      adjustment,   // split/dividend/all — 'split' is the default "adjusted for splits only"
      feed,
      page_token: pageToken,
    });

    const bars = data?.bars || [];
    for (const b of bars) {
      // Alpaca format: { t, o, h, l, c, v, n, vw }
      allBars.push({
        date:   b.t ? b.t.split('T')[0] : null,
        open:   b.o,
        high:   b.h,
        low:    b.l,
        close:  b.c,
        volume: b.v || 0,
      });
    }
    pageToken = data?.next_page_token || null;
  } while (pageToken);

  return allBars;
}

// ─── Public API — drop-in compatible with yahoo.js ─────────────────────────

// Close prices only (used by RS calculations, 12-month window)
// Cache key matches Yahoo for easy migration.
async function alpacaHistory(symbol) {
  const key = `h:alpaca:${symbol}`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;

  // Match Yahoo's 2-year window for RS calcs — no need to pull more than needed
  const end   = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - 2 * 365 * 86400000).toISOString().split('T')[0];

  const bars = await alpacaDailyBars(symbol, { start, end });
  const closes = bars.map(b => b.close).filter(c => c != null && c > 0);
  cacheSet(key, closes);
  return closes;
}

// Full OHLCV bars — used by backfill, distribution day detection, etc.
// Pulls up to 9 years (~2016-present) of daily history by default.
async function alpacaHistoryFull(symbol, { yearsBack = 9 } = {}) {
  const key = `hf:alpaca:${symbol}:${yearsBack}y`;
  const cached = cacheGet(key, TTL_HIST);
  if (cached) return cached;

  const end   = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - yearsBack * 365 * 86400000).toISOString().split('T')[0];

  const bars = await alpacaDailyBars(symbol, { start, end });
  cacheSet(key, bars);
  return bars;
}

// Quote (latest trade + bar) — matches Yahoo's quote shape for drop-in use.
// Alpaca exposes last-trade + latest-bar via two small calls; we fold both
// into a single object to match yahooQuote's schema.
async function alpacaQuote(symbols) {
  if (!Array.isArray(symbols)) symbols = [symbols];
  const results = [];

  // Batch endpoint: /v2/stocks/quotes/latest?symbols=A,B,C  (free tier)
  // Also grab latest bars for OHLCV fields.
  try {
    const [quotesResp, barsResp] = await Promise.all([
      alpacaRequest(`/v2/stocks/quotes/latest`, { symbols: symbols.join(','), feed: getConfig().feed }),
      alpacaRequest(`/v2/stocks/bars/latest`,   { symbols: symbols.join(','), feed: getConfig().feed }),
    ]);

    const quoteMap = quotesResp?.quotes || {};
    const barMap   = barsResp?.bars     || {};

    for (const sym of symbols) {
      const q = quoteMap[sym];
      const b = barMap[sym];
      if (!q && !b) continue;
      // Prefer bar close (real trade) over quote midpoint when available
      const price = b?.c ?? ((q?.bp + q?.ap) / 2) ?? null;
      if (price == null) continue;
      results.push({
        symbol: sym,
        regularMarketPrice:          price,
        regularMarketPreviousClose:  b?.c ?? null,
        regularMarketVolume:         b?.v ?? null,
        regularMarketDayHigh:        b?.h ?? null,
        regularMarketDayLow:         b?.l ?? null,
        regularMarketOpen:           b?.o ?? null,
        // Alpaca doesn't provide 52w high/low/MAs in quote response — leave null
        fiftyTwoWeekHigh:            null,
        fiftyTwoWeekLow:             null,
        fiftyDayAverage:             null,
        twoHundredDayAverage:        null,
        averageDailyVolume50Day:     null,
        averageDailyVolume10Day:     null,
      });
    }
  } catch (e) {
    throw new Error(`Alpaca quote: ${e.message}`);
  }
  return results;
}

module.exports = {
  isConfigured,
  alpacaQuote,
  alpacaHistory,
  alpacaHistoryFull,
  alpacaDailyBars,  // exposed for backfill customization
  getConfig,
};
