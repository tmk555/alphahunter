// ─── Alpaca Options Trading Module ──────────────────────────────────────────
// Options chain data, order execution, and hedging strategy builders.
//
// Phase 3.14: Synthetic (BSM) data is NO LONGER returned as real-looking
// options chains. When live Alpaca options data is unavailable, the API
// returns { live: false, noData: true } with a clear message — not fake
// prices that could mislead trading decisions. Strategy builders return
// estimated cost ranges (not executable limit prices) when IV is unknown.

const fetch = require('node-fetch');
const { cacheGet, cacheSet } = require('../data/cache');
const { getConfig: getAlpacaConfig } = require('./alpaca');

const TTL_CHAIN = 60 * 1000;  // 1 minute for options chain
const DATA_URL  = 'https://data.alpaca.markets';

// ─── Helpers ───────────────────────────────────────────────────────────────

function headers() {
  const { key, secret } = getAlpacaConfig();
  return {
    'APCA-API-KEY-ID':     key,
    'APCA-API-SECRET-KEY': secret,
    'Content-Type':        'application/json',
  };
}

async function brokerRequest(method, path, body = null) {
  const { base, configured } = getAlpacaConfig();
  if (!configured) throw new Error('Alpaca API keys not configured');

  const url = `${base}${path}`;
  const opts = { method, headers: headers() };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetch(url, opts);
  const text = await r.text();

  if (!r.ok) {
    let msg;
    try { msg = JSON.parse(text).message; } catch (_) { msg = text; }
    throw new Error(`Alpaca ${method} ${path} -> ${r.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

async function dataRequest(path) {
  const { configured } = getAlpacaConfig();
  if (!configured) throw new Error('Alpaca API keys not configured');

  const url = `${DATA_URL}${path}`;
  const r = await fetch(url, { method: 'GET', headers: headers() });
  const text = await r.text();

  if (!r.ok) {
    let msg;
    try { msg = JSON.parse(text).message; } catch (_) { msg = text; }
    throw new Error(`Alpaca data ${path} -> ${r.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

// ─── Black-Scholes Approximation ───────────────────────────────────────────
// Used for synthetic/estimated data when live options aren't available.

function normalCDF(x) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function blackScholes(S, K, T, r, sigma, type) {
  if (T <= 0) return Math.max(0, type === 'call' ? S - K : K - S);

  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  if (type === 'call') {
    return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
  }
  return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
}

function calculateGreeks(S, K, T, r, sigma, type) {
  if (T <= 0) {
    return { delta: type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0),
             gamma: 0, theta: 0, vega: 0 };
  }

  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const nd1 = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI); // PDF of d1

  let delta, theta;
  if (type === 'call') {
    delta = normalCDF(d1);
    theta = (-S * nd1 * sigma / (2 * Math.sqrt(T))
             - r * K * Math.exp(-r * T) * normalCDF(d2)) / 365;
  } else {
    delta = normalCDF(d1) - 1;
    theta = (-S * nd1 * sigma / (2 * Math.sqrt(T))
             + r * K * Math.exp(-r * T) * normalCDF(-d2)) / 365;
  }

  const gamma = nd1 / (S * sigma * Math.sqrt(T));
  const vega  = S * nd1 * Math.sqrt(T) / 100; // per 1% vol change

  return {
    delta: +delta.toFixed(4),
    gamma: +gamma.toFixed(6),
    theta: +theta.toFixed(4),
    vega:  +vega.toFixed(4),
  };
}

// ─── Option Symbol Helpers ─────────────────────────────────────────────────
// OCC format: SPY250516C00450000 = SPY, 2025-05-16, Call, $450.00

function buildOCCSymbol(underlying, expiration, type, strike) {
  const sym = underlying.toUpperCase().padEnd(6, ' ').slice(0, 6);
  const date = expiration.replace(/-/g, '').slice(2); // YYMMDD
  const cp = type === 'call' ? 'C' : 'P';
  const strikeStr = Math.round(strike * 1000).toString().padStart(8, '0');
  return `${sym.trim()}${date}${cp}${strikeStr}`;
}

function parseOCCSymbol(occ) {
  // Trim any padding. The format is: SYMBOL + YYMMDD + C/P + 8-digit strike
  const match = occ.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, sym, dateStr, cp, strikeStr] = match;
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  return {
    underlying: sym,
    expiration: `20${yy}-${mm}-${dd}`,
    type: cp === 'C' ? 'call' : 'put',
    strike: parseInt(strikeStr, 10) / 1000,
  };
}

// ─── Synthetic Chain Generator ─────────────────────────────────────────────
// Generates realistic-looking options data from stock price + Black-Scholes.

function generateSyntheticChain(symbol, stockPrice, expirationDate) {
  const now = new Date();
  const exp = new Date(expirationDate + 'T16:00:00Z');
  const T = Math.max(0.001, (exp - now) / (365.25 * 24 * 3600 * 1000));
  const r = 0.05;     // risk-free rate estimate
  const iv = 0.30;    // default IV assumption

  // Generate strikes around the current price
  const step = stockPrice > 100 ? 5 : stockPrice > 50 ? 2.5 : 1;
  const center = Math.round(stockPrice / step) * step;
  const strikeCount = 15; // 15 strikes above and below
  const strikes = [];
  for (let i = -strikeCount; i <= strikeCount; i++) {
    const s = center + i * step;
    if (s > 0) strikes.push(s);
  }

  const calls = [];
  const puts  = [];

  for (const strike of strikes) {
    const moneyness = Math.abs(stockPrice - strike) / stockPrice;
    // IV smile: OTM options have higher IV
    const skewIV = iv * (1 + moneyness * 0.5);

    const callPrice = blackScholes(stockPrice, strike, T, r, skewIV, 'call');
    const putPrice  = blackScholes(stockPrice, strike, T, r, skewIV, 'put');
    const callGreeks = calculateGreeks(stockPrice, strike, T, r, skewIV, 'call');
    const putGreeks  = calculateGreeks(stockPrice, strike, T, r, skewIV, 'put');

    const spread = Math.max(0.01, callPrice * 0.03); // ~3% bid-ask spread

    calls.push({
      symbol: buildOCCSymbol(symbol, expirationDate, 'call', strike),
      type: 'call',
      strike,
      expiration: expirationDate,
      bid:   +Math.max(0.01, callPrice - spread / 2).toFixed(2),
      ask:   +(callPrice + spread / 2).toFixed(2),
      last:  +callPrice.toFixed(2),
      volume: Math.round(Math.max(10, 5000 * Math.exp(-moneyness * 10))),
      openInterest: Math.round(Math.max(100, 20000 * Math.exp(-moneyness * 5))),
      iv:    +skewIV.toFixed(4),
      ...callGreeks,
    });

    puts.push({
      symbol: buildOCCSymbol(symbol, expirationDate, 'put', strike),
      type: 'put',
      strike,
      expiration: expirationDate,
      bid:   +Math.max(0.01, putPrice - spread / 2).toFixed(2),
      ask:   +(putPrice + spread / 2).toFixed(2),
      last:  +putPrice.toFixed(2),
      volume: Math.round(Math.max(10, 4000 * Math.exp(-moneyness * 10))),
      openInterest: Math.round(Math.max(80, 18000 * Math.exp(-moneyness * 5))),
      iv:    +skewIV.toFixed(4),
      ...putGreeks,
    });
  }

  return { calls, puts };
}

function getNextMonthlyExpiration() {
  const now = new Date();
  // Third Friday of current or next month
  let year = now.getFullYear();
  let month = now.getMonth();

  for (let attempt = 0; attempt < 3; attempt++) {
    const firstDay = new Date(year, month, 1);
    const firstFriday = (5 - firstDay.getDay() + 7) % 7 + 1;
    const thirdFriday = firstFriday + 14;
    const expDate = new Date(year, month, thirdFriday);

    // Skip if already past this expiration
    if (expDate > now) {
      return expDate.toISOString().slice(0, 10);
    }

    month++;
    if (month > 11) { month = 0; year++; }
  }
  // Fallback: 30 days out
  const fallback = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  return fallback.toISOString().slice(0, 10);
}

function generateExpirations() {
  const expirations = [];
  const now = new Date();

  // Weekly expirations for next 4 weeks
  for (let i = 1; i <= 4; i++) {
    const d = new Date(now.getTime() + i * 7 * 24 * 3600 * 1000);
    // Find next Friday
    const dayOfWeek = d.getDay();
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    const friday = new Date(d.getTime() + daysUntilFriday * 24 * 3600 * 1000);
    expirations.push(friday.toISOString().slice(0, 10));
  }

  // Monthly expirations for next 6 months
  for (let m = 0; m < 6; m++) {
    let year = now.getFullYear();
    let month = now.getMonth() + m + 1;
    if (month > 11) { month -= 12; year++; }
    const firstDay = new Date(year, month, 1);
    const firstFriday = (5 - firstDay.getDay() + 7) % 7 + 1;
    const thirdFriday = firstFriday + 14;
    const exp = new Date(year, month, thirdFriday).toISOString().slice(0, 10);
    if (!expirations.includes(exp)) expirations.push(exp);
  }

  return [...new Set(expirations)].sort();
}

// ─── Stock Price Fetcher (for synthetic data) ──────────────────────────────

// Yahoo class-share format (BRK-B) → Alpaca's (BRK.B). Same translation as
// in src/data/providers/alpaca.js — duplicated here because options.js
// hits the Alpaca data API directly via dataRequest(), not through the
// data-provider layer where the symbol normalization lives.
function toAlpacaSymbol(symbol) {
  if (!symbol) return symbol;
  const m = /^([A-Z]+)-([A-Z])$/i.exec(symbol);
  if (m) return `${m[1].toUpperCase()}.${m[2].toUpperCase()}`;
  return symbol;
}

async function getStockPrice(symbol) {
  const apiSymbol = toAlpacaSymbol(symbol);
  try {
    const data = await dataRequest(`/v2/stocks/${encodeURIComponent(apiSymbol)}/quotes/latest`);
    if (data && data.quote) {
      return (data.quote.ap + data.quote.bp) / 2; // midpoint of bid/ask
    }
  } catch (_) { /* fall through */ }

  // Try trades endpoint
  try {
    const data = await dataRequest(`/v2/stocks/${encodeURIComponent(apiSymbol)}/trades/latest`);
    if (data && data.trade) return data.trade.p;
  } catch (_) { /* fall through */ }

  return null;
}

// ─── Options Chain ─────────────────────────────────────────────────────────

async function getOptionsChain(symbol, expirationDate) {
  const cacheKey = `options:chain:${symbol}:${expirationDate || 'default'}`;
  const cached = cacheGet(cacheKey, TTL_CHAIN);
  if (cached) return cached;

  if (!expirationDate) {
    expirationDate = getNextMonthlyExpiration();
  }

  const expirations = generateExpirations();

  // Try live Alpaca options data first
  const { configured } = getAlpacaConfig();
  if (configured) {
    try {
      const path = `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`
                 + `?feed=indicative&type=call,put&expiration_date=${expirationDate}`;
      const data = await dataRequest(path);

      if (data && data.snapshots && Object.keys(data.snapshots).length > 0) {
        const calls = [];
        const puts  = [];

        for (const [optSym, snap] of Object.entries(data.snapshots)) {
          const parsed = parseOCCSymbol(optSym);
          if (!parsed) continue;

          const quote = snap.latestQuote || {};
          const trade = snap.latestTrade || {};
          const greeks = snap.greeks || {};

          const option = {
            symbol:       optSym,
            type:         parsed.type,
            strike:       parsed.strike,
            expiration:   parsed.expiration,
            bid:          quote.bp || 0,
            ask:          quote.ap || 0,
            last:         trade.p  || 0,
            volume:       trade.s  || 0,
            openInterest: snap.openInterest || 0,
            iv:           greeks.impliedVolatility || 0,
            delta:        greeks.delta || 0,
            gamma:        greeks.gamma || 0,
            theta:        greeks.theta || 0,
            vega:         greeks.vega  || 0,
          };

          if (parsed.type === 'call') calls.push(option);
          else puts.push(option);
        }

        calls.sort((a, b) => a.strike - b.strike);
        puts.sort((a, b) => a.strike - b.strike);

        const result = { calls, puts, expirations, live: true, expiration: expirationDate };
        cacheSet(cacheKey, result);
        return result;
      }
    } catch (err) {
      // Options API may not be available; fall through to synthetic
      console.log(`Options chain live fetch failed for ${symbol}: ${err.message}`);
    }
  }

  // Phase 3.14: No synthetic fallback. Fake IV (hardcoded 0.30) produces
  // fake prices that are worse than no data — they look real but are fiction.
  // Return a clear "no data" response instead.
  let stockPrice = null;
  if (configured) {
    try { stockPrice = await getStockPrice(symbol); } catch (_) {}
  }

  const result = {
    calls: [], puts: [], expirations,
    live: false,
    noData: true,
    stockPrice,
    expiration: expirationDate,
    note: 'Live options data unavailable. Enable Alpaca options trading or upgrade your plan for real-time options chains.',
    reason: configured
      ? 'Alpaca options API returned no data for this symbol/expiration.'
      : 'Alpaca API keys not configured.',
  };

  // Don't cache "no data" — retry on next request
  return result;
}

// ─── Options Positions ─────────────────────────────────────────────────────

async function getOptionsPositions() {
  const { configured } = getAlpacaConfig();
  if (!configured) {
    return { positions: [], live: false, note: 'Alpaca API keys not configured' };
  }

  try {
    const allPositions = await brokerRequest('GET', '/v2/positions');
    const options = allPositions
      .filter(p => p.asset_class === 'us_option')
      .map(p => {
        const parsed = parseOCCSymbol(p.symbol) || {};
        return {
          symbol:        p.symbol,
          underlying:    parsed.underlying || p.symbol,
          type:          parsed.type || 'unknown',
          strike:        parsed.strike || 0,
          expiration:    parsed.expiration || '',
          qty:           +p.qty,
          side:          p.side,
          marketValue:   +p.market_value,
          costBasis:     +p.cost_basis,
          currentPrice:  +p.current_price,
          avgEntryPrice: +p.avg_entry_price,
          unrealizedPL:  +p.unrealized_pl,
          unrealizedPLPct: +(p.unrealized_plpc * 100),
        };
      });

    return { positions: options, live: true };
  } catch (err) {
    return { positions: [], live: false, error: err.message };
  }
}

// ─── Submit Options Order ──────────────────────────────────────────────────

async function submitOptionsOrder(order) {
  const { configured } = getAlpacaConfig();
  if (!configured) {
    throw new Error('Alpaca API keys not configured. Cannot submit orders.');
  }

  const { symbol, qty, side, type, timeInForce, limitPrice } = order;
  if (!symbol || !qty || !side) {
    throw new Error('symbol, qty, and side are required for options orders');
  }

  const payload = {
    symbol,
    qty:           String(qty),
    side,
    type:          type || 'limit',
    time_in_force: timeInForce || 'day',
  };

  if (limitPrice !== undefined && limitPrice !== null) {
    payload.limit_price = String(limitPrice);
  }

  return brokerRequest('POST', '/v2/orders', payload);
}

// ─── Strategy Builders ─────────────────────────────────────────────────────
// These build executable hedge plans with concrete option symbols and sizing.

function buildProtectivePut(stockSymbol, stockPrice, portfolioValue, hedgeRatio = 0.10, liveIV = null) {
  // Strike selection: 5-10% OTM for cost efficiency
  const otmPct = hedgeRatio > 0.15 ? 0.05 : 0.08;
  const strike = Math.round(stockPrice * (1 - otmPct) * 2) / 2;

  // Expiration: 30-60 DTE for time value balance
  const dte = hedgeRatio > 0.15 ? 45 : 30;
  const expDate = new Date();
  expDate.setDate(expDate.getDate() + dte);
  const daysToFriday = (5 - expDate.getDay() + 7) % 7;
  expDate.setDate(expDate.getDate() + daysToFriday);
  const expiration = expDate.toISOString().slice(0, 10);

  // Quantity: 1 put per 100 shares equivalent
  const exposureToHedge = portfolioValue * hedgeRatio;
  const sharesEquivalent = Math.round(exposureToHedge / stockPrice);
  const qty = Math.max(1, Math.round(sharesEquivalent / 100));

  const optionSymbol = buildOCCSymbol(stockSymbol, expiration, 'put', strike);
  const T = dte / 365;

  // Phase 3.14: Only compute pricing with real IV or explicit override.
  // Without real IV, return structure + cost RANGE (not executable prices).
  const hasRealIV = liveIV != null && liveIV > 0;
  const iv = hasRealIV ? liveIV : null;

  let estimatedCost = null, premium = null, breakeven = null, order = null;
  if (iv) {
    premium = blackScholes(stockPrice, strike, T, 0.05, iv, 'put');
    estimatedCost = +(qty * premium * 100).toFixed(2);
    breakeven = +(strike - premium).toFixed(2);
    order = {
      symbol: optionSymbol, qty, side: 'buy', type: 'limit',
      timeInForce: 'day', limitPrice: +Math.ceil(premium * 100) / 100,
    };
  }

  // Rough cost range estimate (IV typically 15-50% for large caps)
  const lowPremium = blackScholes(stockPrice, strike, T, 0.05, 0.15, 'put');
  const highPremium = blackScholes(stockPrice, strike, T, 0.05, 0.50, 'put');

  return {
    optionSymbol,
    underlying: stockSymbol,
    type: 'put',
    strike,
    expiration,
    dte,
    qty,
    estimatedCost,
    costRange: {
      low: +(qty * lowPremium * 100).toFixed(2),
      high: +(qty * highPremium * 100).toFixed(2),
      note: hasRealIV ? `Based on IV ${(iv * 100).toFixed(0)}%` : 'Range estimate — get live quote for exact pricing',
    },
    costPct: estimatedCost ? +((estimatedCost / portfolioValue) * 100).toFixed(3) : null,
    maxProtection: +(qty * strike * 100).toFixed(2),
    breakeven,
    protectionStart: `${(otmPct * 100).toFixed(0)}% below current price ($${strike})`,
    order,
    liveIV: hasRealIV,
  };
}

function buildCollar(stockSymbol, stockPrice, shares, liveIV = null) {
  if (!shares || shares < 100) {
    return { error: 'Collar requires at least 100 shares (1 contract equivalent)' };
  }

  const contracts = Math.floor(shares / 100);
  const putStrike = Math.round(stockPrice * 0.93 * 2) / 2;
  const callStrike = Math.round(stockPrice * 1.10 * 2) / 2;

  const dte = 45;
  const expDate = new Date();
  expDate.setDate(expDate.getDate() + dte);
  const daysToFriday = (5 - expDate.getDay() + 7) % 7;
  expDate.setDate(expDate.getDate() + daysToFriday);
  const expiration = expDate.toISOString().slice(0, 10);

  const T = dte / 365;
  const hasRealIV = liveIV != null && liveIV > 0;
  const iv = hasRealIV ? liveIV : null;

  const putSymbol  = buildOCCSymbol(stockSymbol, expiration, 'put',  putStrike);
  const callSymbol = buildOCCSymbol(stockSymbol, expiration, 'call', callStrike);

  // Phase 3.14: only produce executable orders with real IV
  let putPremium = null, callPremium = null, netCost = null;
  let putOrder = null, callOrder = null;
  if (iv) {
    putPremium  = +blackScholes(stockPrice, putStrike, T, 0.05, iv, 'put').toFixed(2);
    callPremium = +blackScholes(stockPrice, callStrike, T, 0.05, iv, 'call').toFixed(2);
    netCost = +((putPremium - callPremium) * contracts * 100).toFixed(2);
    putOrder = { symbol: putSymbol, qty: contracts, side: 'buy', type: 'limit',
                 timeInForce: 'day', limitPrice: +Math.ceil(putPremium * 100) / 100 };
    callOrder = { symbol: callSymbol, qty: contracts, side: 'sell', type: 'limit',
                  timeInForce: 'day', limitPrice: +Math.floor(callPremium * 100) / 100 };
  }

  // Cost range for planning
  const lowPutPrem  = blackScholes(stockPrice, putStrike, T, 0.05, 0.15, 'put');
  const highPutPrem = blackScholes(stockPrice, putStrike, T, 0.05, 0.50, 'put');
  const lowCallPrem  = blackScholes(stockPrice, callStrike, T, 0.05, 0.15, 'call');
  const highCallPrem = blackScholes(stockPrice, callStrike, T, 0.05, 0.50, 'call');

  return {
    put: {
      symbol: putSymbol, type: 'put', strike: putStrike, expiration,
      qty: contracts, premium: putPremium, side: 'buy', order: putOrder,
    },
    call: {
      symbol: callSymbol, type: 'call', strike: callStrike, expiration,
      qty: contracts, premium: callPremium, side: 'sell', order: callOrder,
    },
    netCost,
    netCostRange: {
      low: +((lowPutPrem - highCallPrem) * contracts * 100).toFixed(2),
      high: +((highPutPrem - lowCallPrem) * contracts * 100).toFixed(2),
      note: hasRealIV ? `Based on IV ${(iv * 100).toFixed(0)}%` : 'Range estimate — get live quotes',
    },
    netCostPct: netCost != null ? +((netCost / (stockPrice * shares)) * 100).toFixed(3) : null,
    maxLoss: netCost != null ? +((stockPrice - putStrike) * shares + Math.max(0, netCost)).toFixed(2) : null,
    maxGain: netCost != null ? +((callStrike - stockPrice) * shares - Math.max(0, netCost)).toFixed(2) : null,
    shares, contracts, dte,
    liveIV: hasRealIV,
    summary: `Collar: floor at $${putStrike}, cap at $${callStrike}` +
      (netCost != null ? (netCost <= 0 ? ' (zero-cost)' : ` ($${netCost})`) : ' (get live quote for pricing)'),
  };
}

function buildVIXHedge(vixLevel, portfolioValue, hedgeRatio = 0.003, liveIV = null) {
  if (!vixLevel || vixLevel <= 0) vixLevel = 18;

  const budget = portfolioValue * hedgeRatio;

  const longStrike  = Math.round(vixLevel + 5);
  const shortStrike = Math.round(vixLevel + 15);

  const dte = 30;
  const expDate = new Date();
  expDate.setDate(expDate.getDate() + dte);
  const daysToWed = (3 - expDate.getDay() + 7) % 7;
  expDate.setDate(expDate.getDate() + daysToWed);
  const expiration = expDate.toISOString().slice(0, 10);

  const T = dte / 365;
  const hasRealIV = liveIV != null && liveIV > 0;
  const iv = hasRealIV ? liveIV : null;

  const longSymbol  = buildOCCSymbol('VIX', expiration, 'call', longStrike);
  const shortSymbol = buildOCCSymbol('VIX', expiration, 'call', shortStrike);

  // Phase 3.14: only generate executable orders with real IV
  let longPremium = null, shortPremium = null, spreadCost = null;
  let contracts = null, totalCost = null, maxPayoff = null;
  let longOrder = null, shortOrder = null;

  if (iv) {
    longPremium  = +blackScholes(vixLevel, longStrike, T, 0.05, iv, 'call').toFixed(2);
    shortPremium = +blackScholes(vixLevel, shortStrike, T, 0.05, iv, 'call').toFixed(2);
    spreadCost = Math.max(0.10, longPremium - shortPremium);
    contracts = Math.max(1, Math.floor(budget / (spreadCost * 100)));
    totalCost = +(contracts * spreadCost * 100).toFixed(2);
    maxPayoff = +(contracts * (shortStrike - longStrike) * 100).toFixed(2);
    longOrder = { symbol: longSymbol, qty: contracts, side: 'buy', type: 'limit',
                  timeInForce: 'day', limitPrice: +Math.ceil(longPremium * 100) / 100 };
    shortOrder = { symbol: shortSymbol, qty: contracts, side: 'sell', type: 'limit',
                   timeInForce: 'day', limitPrice: +Math.floor(shortPremium * 100) / 100 };
  } else {
    // Budget-based rough contract estimate (VIX IV typically 60-120%)
    const estLongLow  = blackScholes(vixLevel, longStrike, T, 0.05, 0.60, 'call');
    const estShortLow = blackScholes(vixLevel, shortStrike, T, 0.05, 0.60, 'call');
    const estSpread = Math.max(0.10, estLongLow - estShortLow);
    contracts = Math.max(1, Math.floor(budget / (estSpread * 100)));
  }

  const recommendation = vixLevel < 15
    ? 'VIX is very low — options are cheap, good time to buy tail protection'
    : vixLevel < 20
      ? 'VIX is moderate — reasonable cost for insurance'
      : vixLevel < 30
        ? 'VIX is elevated — hedges are pricier but may be needed'
        : 'VIX is very high — consider reducing position size instead of buying expensive hedges';

  return {
    longCall: {
      symbol: longSymbol, strike: longStrike, premium: longPremium,
      side: 'buy', qty: contracts, order: longOrder,
    },
    shortCall: {
      symbol: shortSymbol, strike: shortStrike, premium: shortPremium,
      side: 'sell', qty: contracts, order: shortOrder,
    },
    maxCost: totalCost,
    costPct: totalCost ? +((totalCost / portfolioValue) * 100).toFixed(3) : null,
    maxPayoff,
    payoffRatio: totalCost && maxPayoff ? +(maxPayoff / totalCost).toFixed(1) : null,
    contracts,
    dte,
    expiration,
    vixLevel,
    liveIV: hasRealIV,
    recommendation,
    description: `Buy VIX ${longStrike}/${shortStrike} call spread for crash insurance` +
      (hasRealIV ? '' : ' (get live VIX options quote for exact pricing)'),
  };
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  getOptionsChain,
  getOptionsPositions,
  submitOptionsOrder,
  buildProtectivePut,
  buildCollar,
  buildVIXHedge,
  // Utilities exposed for testing / advanced use
  buildOCCSymbol,
  parseOCCSymbol,
  blackScholes,
  calculateGreeks,
  getNextMonthlyExpiration,
};
