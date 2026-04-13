// ─── Multi-Provider Manager ─────────────────────────────────────────────────
// Cascading fallback: Polygon → Yahoo → FMP → Alpha Vantage
// Tracks provider health, auto-promotes/demotes based on success rate
const { getDB } = require('../database');
const { cacheGet, cacheSet } = require('../cache');

function db() { return getDB(); }

// Provider registry — order = priority (Polygon first for reliability)
const providers = [
  { key: 'polygon',       name: 'Polygon.io',      module: () => require('./polygon') },
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

async function getQuotes(symbols) {
  const { data } = await withFallback(`quote(${symbols.length} symbols)`, (mod, key) => {
    if (key === 'polygon') return () => mod.polygonQuote(symbols);
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
    if (key === 'yahoo') return () => mod.yahooHistory(symbol);
    if (key === 'fmp') return () => mod.fmpHistory(symbol);
    if (key === 'alphavantage') return () => mod.avHistory(symbol);
    return null;
  });
  return data;
}

async function getHistoryFull(symbol) {
  const { data } = await withFallback(`historyFull(${symbol})`, (mod, key) => {
    if (key === 'polygon') return () => mod.polygonHistoryFull(symbol);
    if (key === 'yahoo') return () => mod.yahooHistoryFull(symbol);
    if (key === 'fmp') return () => mod.fmpHistoryFull(symbol);
    if (key === 'alphavantage') return () => mod.avHistoryFull(symbol);
    return null;
  });
  return data;
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
