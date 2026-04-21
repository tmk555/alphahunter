// ─── Multi-Provider Manager ─────────────────────────────────────────────────
// Cascading fallback: Polygon → Alpaca → Yahoo → FMP → Alpha Vantage
// Tracks provider health, auto-promotes/demotes based on success rate
//
// Alpaca placement rationale: right after Polygon (when configured, both
// deliver 9+ years of daily bars — far beyond Yahoo's 2-year ceiling). Yahoo
// is still kept as a fallback for users without either. Ordering within the
// cascade means Alpaca wins over Yahoo for historical backtests while Yahoo
// still wins for unauthenticated lookups.
const { getDB } = require('../database');
const { cacheGet, cacheSet } = require('../cache');

function db() { return getDB(); }

// Provider registry — order = priority (Polygon first for reliability)
const providers = [
  { key: 'polygon',       name: 'Polygon.io',      module: () => require('./polygon') },
  { key: 'alpaca',        name: 'Alpaca Markets',  module: () => require('./alpaca') },
  { key: 'yahoo',         name: 'Yahoo Finance',   module: () => require('./yahoo') },
  { key: 'fmp',           name: 'FMP',             module: () => require('./fmp') },
  { key: 'alphavantage',  name: 'Alpha Vantage',   module: () => require('./alphavantage') },
];

// In-memory health tracking
const health = {};
for (const p of providers) {
  health[p.key] = { successes: 0, failures: 0, consecutiveFailures: 0, lastError: null, lastSuccess: null, disabled: false };
}

const CIRCUIT_BREAKER_THRESHOLD = 3;  // consecutive failures to disable
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000; // 5 min cooldown

function isAvailable(providerKey) {
  const h = health[providerKey];
  if (!h) return false;
  if (!h.disabled) return true;
  // Auto-reset circuit breaker after cooldown
  if (h.disabledAt && Date.now() - h.disabledAt > CIRCUIT_BREAKER_RESET_MS) {
    h.disabled = false;
    h.consecutiveFailures = 0;
    console.log(`  Provider: ${providerKey} circuit breaker reset`);
    return true;
  }
  return false;
}

function recordSuccess(providerKey) {
  const h = health[providerKey];
  h.successes++;
  h.consecutiveFailures = 0;
  h.lastSuccess = Date.now();
  h.disabled = false;
}

function recordFailure(providerKey, error) {
  const h = health[providerKey];
  h.failures++;
  h.consecutiveFailures++;
  h.lastError = error;
  if (h.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    h.disabled = true;
    h.disabledAt = Date.now();
    console.warn(`  Provider: ${providerKey} disabled (${CIRCUIT_BREAKER_THRESHOLD} consecutive failures)`);
  }
}

// ─── Fallback execution ────────────────────────────────────────────────────

async function withFallback(operation, methodMap) {
  const errors = [];

  for (const provider of providers) {
    if (!isAvailable(provider.key)) continue;

    const mod = provider.module();

    // Check if provider is configured (has API key)
    if (provider.key !== 'yahoo' && provider.key !== 'polygon' && mod.isConfigured && !mod.isConfigured()) continue;
    if (provider.key === 'polygon' && mod.isConfigured && !mod.isConfigured()) continue;

    const method = methodMap(mod, provider.key);
    if (!method) continue;

    try {
      const result = await method();
      recordSuccess(provider.key);
      return { data: result, provider: provider.key };
    } catch (e) {
      recordFailure(provider.key, e.message);
      errors.push({ provider: provider.key, error: e.message });
      console.warn(`  Provider ${provider.key} failed for ${operation}: ${e.message}`);
    }
  }

  throw new Error(`All providers failed for ${operation}: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`);
}

// ─── Public API (drop-in replacement for yahoo.js) ─────────────────────────

// Live quotes: skip Alpaca intentionally. Alpaca's free-tier quote feed is
// IEX-only (~2% of volume), which can slightly lag the consolidated tape on
// less-liquid names. Yahoo's free quote is consolidated and sufficient for
// scanner/dashboard use. Alpaca remains history-only for the 9-year bar depth.
async function getQuotes(symbols) {
  const { data } = await withFallback(`quote(${symbols.length} symbols)`, (mod, key) => {
    if (key === 'polygon') return () => mod.polygonQuote(symbols);
    if (key === 'alpaca')  return null;  // Alpaca = history-only (see note above)
    if (key === 'yahoo') return () => mod.yahooQuote(symbols);
    if (key === 'fmp') return () => mod.fmpQuote(symbols);
    if (key === 'alphavantage') return () => mod.avQuote(symbols);
    return null;
  });
  return data;
}

async function getHistory(symbol) {
  const { data } = await withFallback(`history(${symbol})`, (mod, key) => {
    if (key === 'polygon') return () => mod.polygonHistory(symbol);
    if (key === 'alpaca')  return () => mod.alpacaHistory(symbol);
    if (key === 'yahoo') return () => mod.yahooHistory(symbol);
    if (key === 'fmp') return () => mod.fmpHistory(symbol);
    if (key === 'alphavantage') return () => mod.avHistory(symbol);
    return null;
  });
  return data;
}

// `minBars` lets callers ask for deep history (e.g. a multi-year backfill).
// Default behavior is unchanged — first successful provider wins, which keeps
// the live scanner on Alpaca (higher-quality IEX prints). When minBars is set
// and the first winner returns fewer bars than that, we probe subsequent
// providers and return whichever response has the most bars.
//
// Why this matters: Alpaca's free IEX feed only retains ~5.5y of daily bars,
// while Yahoo's /v8/finance/chart?range=10y returns ~2500 bars back to 2016.
// For a 2017-forward backfill, first-success-wins would stop at Alpaca and
// silently give us a shallow window; minBars forces the cascade to keep
// looking until it finds a deeper source.
async function getHistoryFull(symbol, { minBars } = {}) {
  if (!minBars) {
    const { data } = await withFallback(`historyFull(${symbol})`, (mod, key) => {
      if (key === 'polygon') return () => mod.polygonHistoryFull(symbol);
      if (key === 'alpaca')  return () => mod.alpacaHistoryFull(symbol);
      if (key === 'yahoo') return () => mod.yahooHistoryFull(symbol);
      if (key === 'fmp') return () => mod.fmpHistoryFull(symbol);
      if (key === 'alphavantage') return () => mod.avHistoryFull(symbol);
      return null;
    });
    return data;
  }

  // Deep-history path: collect from every available provider, keep the longest.
  // We still record success/failure per provider so the circuit breaker stays
  // calibrated. Errors on any one provider don't abort the sweep — we only
  // throw if nothing returned enough bars AND nothing returned at all.
  let best = null;
  const errors = [];
  for (const provider of providers) {
    if (!isAvailable(provider.key)) continue;
    const mod = provider.module();
    if (provider.key !== 'yahoo' && provider.key !== 'polygon' && mod.isConfigured && !mod.isConfigured()) continue;
    if (provider.key === 'polygon' && mod.isConfigured && !mod.isConfigured()) continue;

    let method;
    if (provider.key === 'polygon')          method = () => mod.polygonHistoryFull(symbol);
    else if (provider.key === 'alpaca')      method = () => mod.alpacaHistoryFull(symbol);
    else if (provider.key === 'yahoo')       method = () => mod.yahooHistoryFull(symbol);
    else if (provider.key === 'fmp')         method = () => mod.fmpHistoryFull(symbol);
    else if (provider.key === 'alphavantage')method = () => mod.avHistoryFull(symbol);
    if (!method) continue;

    try {
      const result = await method();
      recordSuccess(provider.key);
      const n = Array.isArray(result) ? result.length : 0;
      if (n > 0 && (!best || n > best.n)) best = { data: result, n, provider: provider.key };
      if (best && best.n >= minBars) break;  // early-exit once we have enough
    } catch (e) {
      recordFailure(provider.key, e.message);
      errors.push({ provider: provider.key, error: e.message });
    }
  }
  if (!best) throw new Error(`All providers failed for historyFull(${symbol}): ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`);
  return best.data;
}

async function getFundamentals(symbol) {
  const { data } = await withFallback(`fundamentals(${symbol})`, (mod, key) => {
    if (key === 'polygon') return () => mod.polygonFundamentals(symbol);
    if (key === 'yahoo') return () => mod.getYahooFundamentals(symbol);
    // FMP and AV don't have CAN SLIM fundamentals — skip
    return null;
  });
  return data;
}

// ─── Intraday bars (Phase 2: entry timing) ─────────────────────────────────
// Polygon primary, Yahoo fallback (free)
async function getIntradayBars(symbol, timespan = 'minute', multiplier = 5, from, to) {
  const { data } = await withFallback(`intraday(${symbol} ${multiplier}${timespan})`, (mod, key) => {
    if (key === 'polygon' && mod.polygonIntradayBars) {
      return () => mod.polygonIntradayBars(symbol, timespan, multiplier, from, to);
    }
    if (key === 'yahoo' && mod.yahooIntradayBars) {
      return () => mod.yahooIntradayBars(symbol, timespan, multiplier, from, to);
    }
    return null;
  });
  return data;
}

// ─── Health & Status ───────────────────────────────────────────────────────

function getProviderHealth() {
  return providers.map(p => {
    const h = health[p.key];
    const mod = p.module();
    const configured = p.key === 'yahoo' ? true : (mod.isConfigured ? mod.isConfigured() : false);
    const total = h.successes + h.failures;
    return {
      key: p.key,
      name: p.name,
      configured,
      available: configured && isAvailable(p.key),
      successes: h.successes,
      failures: h.failures,
      successRate: total > 0 ? +((h.successes / total) * 100).toFixed(1) : null,
      consecutiveFailures: h.consecutiveFailures,
      circuitBroken: h.disabled,
      lastError: h.lastError,
      lastSuccess: h.lastSuccess ? new Date(h.lastSuccess).toISOString() : null,
    };
  });
}

function resetProviderHealth(providerKey) {
  if (providerKey && health[providerKey]) {
    health[providerKey] = { successes: 0, failures: 0, consecutiveFailures: 0, lastError: null, lastSuccess: null, disabled: false };
  } else {
    for (const key of Object.keys(health)) {
      health[key] = { successes: 0, failures: 0, consecutiveFailures: 0, lastError: null, lastSuccess: null, disabled: false };
    }
  }
}

function setProviderPriority(providerKey, newIndex) {
  const idx = providers.findIndex(p => p.key === providerKey);
  if (idx === -1) throw new Error(`Unknown provider: ${providerKey}`);
  const [provider] = providers.splice(idx, 1);
  providers.splice(Math.max(0, Math.min(newIndex, providers.length)), 0, provider);
  return providers.map(p => p.key);
}

// Log provider event to DB for observability
function logProviderEvent(provider, event, details) {
  try {
    db().prepare(`
      INSERT INTO provider_log (provider, event, details)
      VALUES (?, ?, ?)
    `).run(provider, event, JSON.stringify(details || {}));
  } catch (_) {}
}

function getProviderLog(limit = 100) {
  try {
    return db().prepare('SELECT * FROM provider_log ORDER BY created_at DESC LIMIT ?').all(limit);
  } catch (_) {
    return [];
  }
}

module.exports = {
  getQuotes, getHistory, getHistoryFull, getFundamentals,
  getIntradayBars,
  getProviderHealth, resetProviderHealth, setProviderPriority,
  getProviderLog,
  // Re-export pLimit from yahoo for scanner compatibility
  pLimit: require('./yahoo').pLimit,
};
