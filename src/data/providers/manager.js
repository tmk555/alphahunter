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
  return withFallbackOrdered(providers, operation, methodMap);
}

async function withFallbackOrdered(orderedProviders, operation, methodMap) {
  const errors = [];

  for (const provider of orderedProviders) {
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
// Helper: does this provider accept this symbol? Providers that have
// declared a `supportsSymbol` filter get consulted; ones without default to
// "yes" (the legacy providers — e.g. Yahoo — that accept everything we throw
// at them). Used to skip mismatched symbols BEFORE making an API call so
// bogus 400s don't trip the circuit breaker.
function providerAcceptsSymbol(mod, symbol) {
  if (!symbol) return true;
  if (typeof mod.supportsSymbol !== 'function') return true;
  return mod.supportsSymbol(symbol);
}

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
    // Skip providers whose symbol filter says they can't serve this ticker.
    // Returning null here (not throwing) means the manager moves on without
    // incrementing the circuit breaker — critical for symbols like ^VIX /
    // NQ=F that only Yahoo handles.
    if (!providerAcceptsSymbol(mod, symbol)) return null;
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
//
// `preferConsolidatedVolume` deprioritizes Alpaca's free-tier IEX feed
// (~2% of consolidated volume). Price prints are fine — they match the
// tape within 0.1% — but volume magnitudes are fractional. For CHARTS,
// that's visually jarring: today's live bar (built from consolidated
// intraday) would tower over historical IEX bars, producing phantom
// volume "spikes." Turn this on for any consumer that displays volume
// alongside a consolidated-source today bar. Backtests / RS / momentum
// should leave it off — Alpaca's deeper history wins there.
async function getHistoryFull(symbol, { minBars, preferConsolidatedVolume = false } = {}) {
  // Reorder the cascade when the caller wants consolidated volume. Alpaca
  // moves to the end (still a reachable fallback), Yahoo/Polygon/FMP/AV
  // stay in their natural priority order.
  const orderedProviders = preferConsolidatedVolume
    ? [...providers.filter(p => p.key !== 'alpaca'), ...providers.filter(p => p.key === 'alpaca')]
    : providers;

  if (!minBars) {
    // ── Persistent SQLite cache: serve from disk when fresh ────────────────
    // Falls back to the provider cascade only when the cache is missing or
    // stale (last bar older than the most recent trading day). After a
    // provider fetch, persist the result so the next call (and every call
    // after a server restart) is instant.
    //
    // Skipped when preferConsolidatedVolume=true — that path is volume-
    // sensitive and callers want freshly-sourced bars from a non-IEX feed.
    const barsCache = require('../bars-cache');
    if (!preferConsolidatedVolume) {
      try {
        if (barsCache.isFresh(symbol)) {
          const cached = barsCache.getCachedBars(symbol);
          if (cached && cached.length > 0) return cached;
        }
      } catch (_) { /* DB unavailable — fall through to providers */ }
    }

    const { data } = await withFallbackOrdered(orderedProviders, `historyFull(${symbol})`, (mod, key) => {
      if (!providerAcceptsSymbol(mod, symbol)) return null;  // don't trip CB on unsupported symbols
      if (key === 'polygon') return () => mod.polygonHistoryFull(symbol);
      if (key === 'alpaca')  return () => mod.alpacaHistoryFull(symbol);
      if (key === 'yahoo') return () => mod.yahooHistoryFull(symbol);
      if (key === 'fmp') return () => mod.fmpHistoryFull(symbol);
      if (key === 'alphavantage') return () => mod.avHistoryFull(symbol);
      return null;
    });

    // Persist successful provider responses to the disk cache so the next
    // restart-after-fetch is instant. Errors swallowed — the provider data
    // is still returned to the caller.
    if (!preferConsolidatedVolume && Array.isArray(data) && data.length > 0) {
      try { require('../bars-cache').saveBars(symbol, data); } catch (_) {}
    }
    return data;
  }

  // Deep-history path: collect from every available provider, keep the longest.
  // We still record success/failure per provider so the circuit breaker stays
  // calibrated. Errors on any one provider don't abort the sweep — we only
  // throw if nothing returned enough bars AND nothing returned at all.
  let best = null;
  const errors = [];
  for (const provider of orderedProviders) {
    if (!isAvailable(provider.key)) continue;
    const mod = provider.module();
    if (provider.key !== 'yahoo' && provider.key !== 'polygon' && mod.isConfigured && !mod.isConfigured()) continue;
    if (provider.key === 'polygon' && mod.isConfigured && !mod.isConfigured()) continue;
    if (!providerAcceptsSymbol(mod, symbol)) continue;  // skip unsupported symbols, don't trip CB

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
  // ── Step 1: Try the base provider cascade (Yahoo / Polygon) ───────────
  //
  // We deliberately swallow the "all providers failed" throw here rather
  // than let it propagate. Reason: when Yahoo has a transient hiccup
  // (rate limit, 5xx, crumb-rotation race) we don't want the user to see
  // a hard failure for a symbol that SEC EDGAR has perfectly fresh data
  // for. The augmentation step below can construct a useful response
  // from SEC alone for any US-domiciled ticker.
  //
  // For foreign ADRs (TSM, ASML, ARM, SAP) the inverse is true — SEC
  // returns null and we depend on Yahoo. The SEC-only build below also
  // returns null in that case, which is the correct behavior: the route
  // surfaces a "no data" 404 instead of a half-built response.
  let data = null;
  try {
    const result = await withFallback(`fundamentals(${symbol})`, (mod, key) => {
      if (key === 'polygon') return () => mod.polygonFundamentals(symbol);
      if (key === 'yahoo') return () => mod.getYahooFundamentals(symbol);
      // FMP and AV don't have CAN SLIM fundamentals — skip
      return null;
    });
    data = result.data;
  } catch (e) {
    // All base providers failed — log it but keep going so SEC can fill in.
    console.warn(`  Fundamentals base cascade failed for ${symbol}: ${e.message} — attempting SEC-only build`);
  }

  // SEC EDGAR augmentation. Yahoo's earningsHistory lags 24-72h after a
  // 10-Q filing; SEC has the data minutes after the company files. When
  // SEC reports a more-recent quarter than Yahoo's freshest, splice the
  // SEC data into epsActualQuarterly so the Levels card shows today's
  // print instead of last quarter's.
  //
  // Foreign ADRs (TSM, ASML, ARM) and very recent IPOs return null from
  // SEC — augmentation skips silently and the Yahoo data flows through.
  // 6h cache on SEC company-facts means this adds <50ms per call when
  // warm; ~2s on cold cache (one-time per symbol per 6 hours).
  try {
    const {
      getQuarterlyEPS, getAnnualEPS,
      getQuarterlyRevenue, getAnnualRevenue,
      getFilingMarkers,
    } = require('./secEdgar');
    const [secQ, secA, secRevQ, secRevA, secMarkers] = await Promise.all([
      getQuarterlyEPS(symbol, 8).catch(() => null),
      getAnnualEPS(symbol, 4).catch(() => null),
      getQuarterlyRevenue(symbol, 8).catch(() => null),
      getAnnualRevenue(symbol, 4).catch(() => null),
      getFilingMarkers(symbol, ['10-Q', '10-K']).catch(() => null),
    ]);

    // If the base cascade failed but SEC has data, build a minimal `data`
    // object with the Yahoo-shape fields initialized so the augmentation
    // splices below can populate them. Yahoo-only fields (short interest,
    // institutional %, forward estimates) stay null — clearly missing
    // beats wrong, and the UI tolerates nulls gracefully (the C/A/N cards
    // render from SEC fields, the S/I cards render "—" without crashing).
    const hasSEC = (Array.isArray(secQ) && secQ.length) ||
                   (Array.isArray(secRevQ) && secRevQ.length) ||
                   (secA && secA.years?.length);
    if (!data && hasSEC) {
      console.log(`  Fundamentals ${symbol}: SEC-only build (Yahoo unavailable)`);
      data = {
        // Yahoo-shape skeleton — augmentation block below fills the SEC fields
        epsGrowthQoQ: null,
        epsGrowthYoY: null,
        epsAccelerating: false,
        netIncomeGrowthYoY: null,
        epsGrowth_Q0_yoy: null, epsGrowth_Q1_yoy: null, epsGrowth_Q2_yoy: null,
        c_pass_q0: false, c_pass_q1: false, c_pass_q2: false,
        epsAccelerating_qoq: false,
        epsAnnualGrowth: [],
        annualEpsAccelerating: false,
        epsTurnaround: false,
        epsAnnualValues: [],
        epsActualQuarterly: [],
        revGrowth_Q0_yoy: null, revGrowth_Q1_yoy: null,
        revenueGrowthYoY: null,
        // Yahoo-only fields — null sentinel so UI shows "—" instead of crashing
        sharesFloat: null, sharesShort: null,
        shortPercentFloat: null, shortRatio: null,
        institutionPct: null, insiderPct: null,
        grossMargins: null, returnOnEquity: null, debtToEquity: null,
        forwardPE: null, canSlimScore: null,
        epsDataSource: 'sec_only',
      };
    }
    // If still no data (no SEC, no Yahoo), bail before the splices touch null.
    if (!data) return null;

    // Quarterly EPS: SEC is the primary source whenever it has data. SEC
    // gives us per-share diluted EPS (the true CANSLIM "C" metric) plus
    // the actual filing date so the chart can anchor markers to where the
    // price reacted. We blend in Yahoo's `estimate` / `surprisePct` /
    // `surprise` for any overlapping period since SEC doesn't carry analyst
    // estimates.
    if (Array.isArray(secQ) && secQ.length) {
      const yahooByDate = new Map((data.epsActualQuarterly || []).map(q => [q.date, q]));
      data.epsActualQuarterly = secQ.map(s => ({
        date: s.date,
        actual: s.eps,
        estimate:    yahooByDate.get(s.date)?.estimate    ?? null,
        surprise:    yahooByDate.get(s.date)?.surprise    ?? null,
        surprisePct: yahooByDate.get(s.date)?.surprisePct ?? null,
        filedAt: s.filedAt,
        form:    s.form,
        source:  'sec_edgar',
      }));
      data.epsDataSource = 'sec_edgar';

      // ── Re-derive Q0/Q-1/Q-2 YoY from SEC's true 8-quarter series ──
      //
      // Yahoo's `epsGrowth_Q*_yoy` fields are computed in yahoo.js from
      // `incomeStatementHistoryQuarterly`, which only carries 4 quarters.
      // When that's not enough, the code falls back to SEQUENTIAL Q/Q
      // while keeping the YoY label — that's how AMZN's Q0 ended up at
      // "0%" (Q4 2025 vs Q3 2025 sequential, both $1.95) instead of the
      // true +75% YoY (Q1 2026 $2.78 vs Q1 2025 $1.59).
      //
      // SEC gives us 8 quarters reliably. Match each quarter to the same
      // fiscal quarter one year earlier by month-day window (±15 days
      // tolerance for fiscal-year shift / 13-week vs 4-4-5 cadence).
      const findYoYMatch = (idx) => {
        const cur = secQ[idx];
        if (!cur) return null;
        const curEnd = new Date(cur.date + 'T00:00:00Z');
        for (let j = idx + 1; j < secQ.length; j++) {
          const cand = secQ[j];
          const candEnd = new Date(cand.date + 'T00:00:00Z');
          const daysDiff = (curEnd - candEnd) / (1000 * 60 * 60 * 24);
          // Same fiscal quarter prior year ≈ 365 days (350-380 window
          // covers leap years and 13-week vs 14-week quarters).
          if (daysDiff >= 350 && daysDiff <= 380) return cand;
          if (daysDiff > 380) break;  // gone past — no match exists
        }
        return null;
      };
      const yoyPct = (cur, prior) => {
        if (cur == null || prior == null) return null;
        // Defensive on zero / negative prior — sign-flip makes % meaningless
        if (prior <= 0) return null;
        return +((cur / prior - 1) * 100).toFixed(1);
      };
      for (const slot of [0, 1, 2]) {
        const cur = secQ[slot];
        const prior = findYoYMatch(slot);
        const pct = cur && prior ? yoyPct(cur.eps, prior.eps) : null;
        data[`epsGrowth_Q${slot}_yoy`] = pct;
        data[`c_pass_q${slot}`] = pct != null && pct >= 25;
      }
      // Re-derive headline epsGrowthQoQ + acceleration from the SEC-aligned
      // YoY values. Pre-fix these used Yahoo's mislabelled sequential.
      data.epsGrowthQoQ = data.epsGrowth_Q0_yoy ?? data.epsGrowthQoQ;
      data.epsAccelerating_qoq =
        data.epsGrowth_Q0_yoy != null && data.epsGrowth_Q1_yoy != null &&
        data.epsGrowth_Q0_yoy > data.epsGrowth_Q1_yoy;
    }

    // Annual EPS YoY: SEC's growthYoY uses true per-share diluted EPS,
    // strictly more honest than Yahoo's net-income proxy.
    if (secA?.growthYoY != null) {
      data.epsGrowthYoY = secA.growthYoY;
      data.epsGrowthYoY_source = 'sec_per_share';
      data.epsAnnualValuesSEC = secA.years;
    }

    // ── Quarterly REVENUE: same Yahoo-staleness problem as EPS ─────────
    //
    // Yahoo's revGrowth_Q*_yoy is computed from incomeStatementHistory-
    // Quarterly which has the 4-quarter ceiling, so it falls back to
    // sequential Q/Q with the YoY label. AMZN currently shows
    // revenueGrowthYoY = -14.9% (actually Q1-2025 vs Q4-2024 sequential)
    // when the true YoY is +9%. SEC has 8 quarters of revenue under one
    // of three concept names (Revenues / RevenueFromContractWith… /
    // SalesRevenueNet), enough to compute proper YoY.
    if (Array.isArray(secRevQ) && secRevQ.length) {
      data.revActualQuarterly = secRevQ.map(r => ({
        date: r.date,
        revenue: r.revenue,
        filedAt: r.filedAt,
        form: r.form,
        source: 'sec_edgar',
      }));
      data.revDataSource = 'sec_edgar';

      // Match each quarter to its same-fiscal-quarter-prior-year.
      const findRevYoY = (idx) => {
        const cur = secRevQ[idx];
        if (!cur) return null;
        const curEnd = new Date(cur.date + 'T00:00:00Z');
        for (let j = idx + 1; j < secRevQ.length; j++) {
          const candEnd = new Date(secRevQ[j].date + 'T00:00:00Z');
          const daysDiff = (curEnd - candEnd) / (1000 * 60 * 60 * 24);
          if (daysDiff >= 350 && daysDiff <= 380) return secRevQ[j];
          if (daysDiff > 380) break;
        }
        return null;
      };
      const revYoy = (cur, prior) => {
        if (cur == null || prior == null || prior <= 0) return null;
        return +((cur / prior - 1) * 100).toFixed(1);
      };
      for (const slot of [0, 1]) {
        const cur = secRevQ[slot];
        const prior = findRevYoY(slot);
        data[`revGrowth_Q${slot}_yoy`] = cur && prior ? revYoy(cur.revenue, prior.revenue) : null;
      }
      // Headline revenueGrowthYoY → SEC's Q0 YoY (true number).
      if (data.revGrowth_Q0_yoy != null) {
        data.revenueGrowthYoY = data.revGrowth_Q0_yoy;
        data.revenueGrowthYoY_source = 'sec_per_quarter';
      }
    }

    // Annual revenue values (parallel to epsAnnualValuesSEC). Used by the
    // Levels card for the trend strip alongside per-share EPS.
    if (Array.isArray(secRevA) && secRevA.length) {
      data.revAnnualValuesSEC = secRevA;
    }

    // Filing markers for the chart layer (vertical "ER" markers).
    if (Array.isArray(secMarkers) && secMarkers.length) {
      data.filingMarkers = secMarkers;
    }
  } catch (_) {
    // Augmentation is opt-in — Yahoo data already in `data`, return as-is.
  }

  return data;
}

// ─── Intraday bars (Phase 2: entry timing) ─────────────────────────────────
// Polygon primary, Yahoo fallback (free)
async function getIntradayBars(symbol, timespan = 'minute', multiplier = 5, from, to) {
  const { data } = await withFallback(`intraday(${symbol} ${multiplier}${timespan})`, (mod, key) => {
    if (!providerAcceptsSymbol(mod, symbol)) return null;  // don't trip CB on unsupported symbols
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
