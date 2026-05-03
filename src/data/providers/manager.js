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

// ─── Helpers for getFundamentals ─────────────────────────────────────────
//
// Same-fiscal-quarter-prior-year matcher: walk a series (newest-first)
// looking for the row whose period-end is 350-380 days before `cur`.
// Window covers leap years and 13/14-week fiscal quarters cleanly without
// hardcoding fiscal-calendar shifts (Apple Sep year-end, Walmart Jan, etc).
function _findPriorYearMatch(series, idx) {
  const cur = series?.[idx];
  if (!cur?.date) return null;
  const curEnd = new Date(cur.date + 'T00:00:00Z');
  for (let j = idx + 1; j < series.length; j++) {
    const cand = series[j];
    if (!cand?.date) continue;
    const candEnd = new Date(cand.date + 'T00:00:00Z');
    const daysDiff = (curEnd - candEnd) / (1000 * 60 * 60 * 24);
    if (daysDiff >= 350 && daysDiff <= 380) return cand;
    if (daysDiff > 380) break;
  }
  return null;
}
function _yoyPct(cur, prior) {
  if (cur == null || prior == null || prior <= 0) return null;
  return +((cur / prior - 1) * 100).toFixed(1);
}

async function getFundamentals(symbol) {
  // ─────────────────────────────────────────────────────────────────────
  // Source-of-truth contract for fundamentals
  //
  //   SEC EDGAR is PRIMARY (computed from SEC when SEC available):
  //     epsActualQuarterly      ─ per-share diluted, with filedAt
  //     epsAnnualValuesSEC      ─ per-share diluted FY values
  //     epsGrowthYoY            ─ annual YoY (true per-share)
  //     epsGrowth_Q{0,1,2}_yoy  ─ quarterly YoY (same fiscal qtr prior yr)
  //     c_pass_q{0,1,2}         ─ CANSLIM "C" pass flags (≥25%)
  //     epsAccelerating_qoq     ─ Q0 YoY > Q1 YoY
  //     revActualQuarterly      ─ quarterly $, with filedAt
  //     revAnnualValuesSEC      ─ FY $
  //     revGrowth_Q{0,1}_yoy    ─ quarterly revenue YoY
  //     revenueGrowthYoY        ─ headline revenue YoY (CANSLIM "N")
  //     filingMarkers           ─ 10-Q/10-K filing dates
  //
  //   YAHOO is PRIMARY (SEC has no equivalent):
  //     shortPercentFloat, shortRatio, sharesFloat, sharesShort
  //     institutionPct, insiderPct
  //     grossMargins, returnOnEquity, debtToEquity
  //     forwardPE
  //     analyst estimate / surprise / surprisePct (overlay onto SEC quarters)
  //     epsAnnualValues (net-income $B series, used by net-income chart)
  //
  //   FALLBACK rules:
  //     SEC-primary field, SEC empty   → fall back to Yahoo's value if any
  //     Yahoo-primary field, Yahoo empty → null (clearly missing)
  //
  // Both providers fire in PARALLEL. Yahoo throwing is non-fatal as long
  // as SEC returned something; SEC empty is non-fatal as long as Yahoo has
  // data (foreign ADRs, recent IPOs). Both empty → null → route 404.
  // ─────────────────────────────────────────────────────────────────────

  const sec = require('./secEdgar');

  const yahooP = withFallback(`fundamentals(${symbol})`, (mod, key) => {
    if (key === 'polygon') return () => mod.polygonFundamentals(symbol);
    if (key === 'yahoo')   return () => mod.getYahooFundamentals(symbol);
    return null;
  }).then(r => r.data).catch(e => {
    console.warn(`  Fundamentals: Yahoo cascade failed for ${symbol}: ${e.message}`);
    return null;
  });

  const [yahoo, secQ, secA, secRevQ, secRevA, secMarkers] = await Promise.all([
    yahooP,
    sec.getQuarterlyEPS(symbol, 8).catch(() => null),
    sec.getAnnualEPS(symbol, 4).catch(() => null),
    sec.getQuarterlyRevenue(symbol, 8).catch(() => null),
    sec.getAnnualRevenue(symbol, 4).catch(() => null),
    sec.getFilingMarkers(symbol, ['10-Q', '10-K']).catch(() => null),
  ]);

  const hasSEC = (Array.isArray(secQ)    && secQ.length) ||
                 (Array.isArray(secRevQ) && secRevQ.length) ||
                 (secA && Array.isArray(secA.years) && secA.years.length);

  // Both empty → genuine no-coverage. Route surfaces a friendly 404.
  if (!yahoo && !hasSEC) return null;

  // Provenance map — UI badges + diagnostics. Updated as we choose sources.
  const dataSources = {
    epsQuarterly:     null,
    epsAnnual:        null,
    revQuarterly:     null,
    revAnnual:        null,
    filingDates:      null,
    shortInterest:    yahoo ? 'yahoo' : null,
    ownership:        yahoo ? 'yahoo' : null,
    forwardEstimates: yahoo ? 'yahoo' : null,
    ttmRatios:        yahoo ? 'yahoo' : null,
    analystEstimates: yahoo ? 'yahoo' : null,
  };

  // ─── SEC-PRIMARY FIELDS ──────────────────────────────────────────────
  //
  // For each, we COMPUTE FROM SEC FIRST. If SEC has the data we use it
  // directly. If SEC is empty (foreign ADR, etc.) we fall back to Yahoo's
  // equivalent. Nothing gets "spliced on top" — each field is chosen once.

  // Quarterly EPS list. SEC actual + Yahoo's analyst estimate/surprise overlay.
  let epsActualQuarterly = [];
  if (Array.isArray(secQ) && secQ.length) {
    const yahooByDate = new Map((yahoo?.epsActualQuarterly || []).map(q => [q.date, q]));
    epsActualQuarterly = secQ.map(s => ({
      date:        s.date,
      actual:      s.eps,
      estimate:    yahooByDate.get(s.date)?.estimate    ?? null,
      surprise:    yahooByDate.get(s.date)?.surprise    ?? null,
      surprisePct: yahooByDate.get(s.date)?.surprisePct ?? null,
      filedAt:     s.filedAt,
      form:        s.form,
      source:      'sec_edgar',
    }));
    dataSources.epsQuarterly = 'sec_edgar';
  } else if (Array.isArray(yahoo?.epsActualQuarterly) && yahoo.epsActualQuarterly.length) {
    epsActualQuarterly = yahoo.epsActualQuarterly;
    dataSources.epsQuarterly = 'yahoo';
  }

  // Quarterly EPS YoY (Q0/Q-1/Q-2) + CANSLIM "C" pass flags.
  // SEC: compute from 8-quarter series matched to same fiscal qtr prior yr.
  // Yahoo: use whatever it computed (may be sequential Q/Q mislabelled when
  // Yahoo only has 4 quarters — better than nothing for foreign ADRs).
  let epsGrowth_Q0_yoy = null, epsGrowth_Q1_yoy = null, epsGrowth_Q2_yoy = null;
  let c_pass_q0 = false, c_pass_q1 = false, c_pass_q2 = false;
  if (Array.isArray(secQ) && secQ.length) {
    for (const slot of [0, 1, 2]) {
      const cur = secQ[slot];
      const prior = _findPriorYearMatch(secQ, slot);
      const pct = cur && prior ? _yoyPct(cur.eps, prior.eps) : null;
      if (slot === 0) { epsGrowth_Q0_yoy = pct; c_pass_q0 = pct != null && pct >= 25; }
      if (slot === 1) { epsGrowth_Q1_yoy = pct; c_pass_q1 = pct != null && pct >= 25; }
      if (slot === 2) { epsGrowth_Q2_yoy = pct; c_pass_q2 = pct != null && pct >= 25; }
    }
  } else if (yahoo) {
    epsGrowth_Q0_yoy = yahoo.epsGrowth_Q0_yoy ?? null;
    epsGrowth_Q1_yoy = yahoo.epsGrowth_Q1_yoy ?? null;
    epsGrowth_Q2_yoy = yahoo.epsGrowth_Q2_yoy ?? null;
    c_pass_q0 = !!yahoo.c_pass_q0;
    c_pass_q1 = !!yahoo.c_pass_q1;
    c_pass_q2 = !!yahoo.c_pass_q2;
  }
  const epsAccelerating_qoq =
    epsGrowth_Q0_yoy != null && epsGrowth_Q1_yoy != null &&
    epsGrowth_Q0_yoy > epsGrowth_Q1_yoy;
  const epsGrowthQoQ = epsGrowth_Q0_yoy ?? yahoo?.epsGrowthQoQ ?? null;

  // Annual EPS YoY (CANSLIM "A"). SEC = true per-share diluted; Yahoo
  // fallback = net-income proxy (less honest, distorts on buybacks).
  let epsGrowthYoY = null, epsGrowthYoY_source = null;
  if (secA?.growthYoY != null) {
    epsGrowthYoY        = secA.growthYoY;
    epsGrowthYoY_source = 'sec_per_share';
    dataSources.epsAnnual = 'sec_edgar';
  } else if (yahoo?.epsGrowthYoY != null) {
    epsGrowthYoY        = yahoo.epsGrowthYoY;
    epsGrowthYoY_source = yahoo.epsGrowthYoY_source || 'yahoo';
    dataSources.epsAnnual = 'yahoo';
  }
  const epsAnnualValuesSEC = secA?.years || null;

  // Quarterly revenue list + YoY.
  let revActualQuarterly = [];
  let revGrowth_Q0_yoy = null, revGrowth_Q1_yoy = null;
  let revenueGrowthYoY = null, revenueGrowthYoY_source = null;
  if (Array.isArray(secRevQ) && secRevQ.length) {
    revActualQuarterly = secRevQ.map(r => ({
      date: r.date, revenue: r.revenue,
      filedAt: r.filedAt, form: r.form, source: 'sec_edgar',
    }));
    for (const slot of [0, 1]) {
      const cur = secRevQ[slot];
      const prior = _findPriorYearMatch(secRevQ, slot);
      const pct = cur && prior ? _yoyPct(cur.revenue, prior.revenue) : null;
      if (slot === 0) revGrowth_Q0_yoy = pct;
      if (slot === 1) revGrowth_Q1_yoy = pct;
    }
    revenueGrowthYoY        = revGrowth_Q0_yoy;
    revenueGrowthYoY_source = 'sec_per_quarter';
    dataSources.revQuarterly = 'sec_edgar';
  } else if (yahoo) {
    revGrowth_Q0_yoy = yahoo.revGrowth_Q0_yoy ?? null;
    revGrowth_Q1_yoy = yahoo.revGrowth_Q1_yoy ?? null;
    revenueGrowthYoY = yahoo.revenueGrowthYoY ?? null;
    revenueGrowthYoY_source = revenueGrowthYoY != null ? 'yahoo' : null;
    dataSources.revQuarterly = revenueGrowthYoY != null ? 'yahoo' : null;
  }
  const revAnnualValuesSEC = (Array.isArray(secRevA) && secRevA.length) ? secRevA : null;
  if (revAnnualValuesSEC) dataSources.revAnnual = 'sec_edgar';

  // Filing markers — SEC-only (Yahoo doesn't have filing dates).
  const filingMarkers = (Array.isArray(secMarkers) && secMarkers.length) ? secMarkers : null;
  if (filingMarkers) dataSources.filingDates = 'sec_edgar';

  // ─── Insider activity (Form 4 — SEC EDGAR only) ─────────────────────
  // Read from local insider_transactions table (populated by the daily
  // cron). The fundamentals call doesn't trigger a Form 4 fetch — that
  // would add ~2-5s of latency per request. The cron keeps the table
  // fresh; we just read aggregated 30-day metrics.
  let insiderActivity = null;
  try {
    const { getInsiderActivity } = require('../insider-store');
    insiderActivity = getInsiderActivity(symbol, { lookbackDays: 30 });
    if (insiderActivity) dataSources.insiderActivity = 'sec_edgar';
  } catch (_) { /* table missing on older DBs — silent */ }

  // ─── YAHOO-PRIMARY FIELDS (SEC has no equivalent) ────────────────────
  // Pass through directly; null when Yahoo unavailable.
  const sharesFloat        = yahoo?.sharesFloat        ?? null;
  const sharesShort        = yahoo?.sharesShort        ?? null;
  const shortPercentFloat  = yahoo?.shortPercentFloat  ?? null;
  const shortRatio         = yahoo?.shortRatio         ?? null;
  const institutionPct     = yahoo?.institutionPct     ?? null;
  const insiderPct         = yahoo?.insiderPct         ?? null;
  const grossMargins       = yahoo?.grossMargins       ?? null;
  const returnOnEquity     = yahoo?.returnOnEquity     ?? null;
  const debtToEquity       = yahoo?.debtToEquity       ?? null;
  const forwardPE          = yahoo?.forwardPE          ?? null;

  // Yahoo-derived series the UI still consumes (net-income chart strip).
  const epsAnnualValues       = yahoo?.epsAnnualValues       || [];
  const epsAnnualGrowth       = yahoo?.epsAnnualGrowth       || [];
  const annualEpsAccelerating = !!yahoo?.annualEpsAccelerating;
  const epsTurnaround         = !!yahoo?.epsTurnaround;
  const netIncomeGrowthYoY    = yahoo?.netIncomeGrowthYoY    ?? null;

  // ─── DERIVED: CANSLIM score (recomputed from MERGED values) ──────────
  // Pre-fix this came from Yahoo's score using its mislabeled sequential.
  // Now computed from the actually-correct merged values above.
  const canSlimScore = [
    epsGrowth_Q0_yoy != null && epsGrowth_Q0_yoy >= 25,    // C: latest qtr ≥25% YoY
    epsGrowthYoY     != null && epsGrowthYoY     >= 25,    // A: annual ≥25%
    revenueGrowthYoY != null && revenueGrowthYoY >= 15,    // N: rev ≥15%
    shortPercentFloat != null && shortPercentFloat <= 40,  // S: short float ≤40%
    institutionPct   != null && institutionPct   >= 10,    // I: inst ≥10%
    returnOnEquity   != null && returnOnEquity   >= 15,    // ROE ≥15%
  ].filter(Boolean).length;

  // ─── ASSEMBLE FINAL RESPONSE ─────────────────────────────────────────
  const epsDataSource = dataSources.epsQuarterly === 'sec_edgar'
    ? 'sec_edgar'
    : (yahoo?.epsDataSource || (hasSEC ? 'sec_only' : 'yahoo'));

  if (!yahoo) {
    console.log(`  Fundamentals ${symbol}: SEC-only build (Yahoo unavailable)`);
  }

  return {
    canSlimScore,
    epsDataSource,
    dataSources,

    // SEC-primary block
    epsActualQuarterly,
    epsGrowthQoQ,
    epsGrowth_Q0_yoy, epsGrowth_Q1_yoy, epsGrowth_Q2_yoy,
    c_pass_q0, c_pass_q1, c_pass_q2,
    epsAccelerating_qoq,
    epsAccelerating: epsAccelerating_qoq,
    epsGrowthYoY, epsGrowthYoY_source,
    epsAnnualValuesSEC,
    revActualQuarterly,
    revGrowth_Q0_yoy, revGrowth_Q1_yoy,
    revenueGrowthYoY, revenueGrowthYoY_source,
    revAnnualValuesSEC,
    revDataSource: dataSources.revQuarterly,
    filingMarkers,
    insiderActivity,

    // Yahoo-primary block
    sharesFloat, sharesShort, shortPercentFloat, shortRatio,
    institutionPct, insiderPct,
    grossMargins, returnOnEquity, debtToEquity,
    forwardPE,

    // Yahoo derivative series (legacy net-income display)
    epsAnnualValues, epsAnnualGrowth, annualEpsAccelerating, epsTurnaround,
    netIncomeGrowthYoY,
  };
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
