// ─── Stock Brief — context panel for any ticker, no paid AI APIs ─────────
//
// Aggregates free, structured data into a "what should I know about this
// stock right now" payload. Powers the side-drawer the user opens by
// clicking any ticker in the app.
//
// Sources, all keyless:
//   • Yahoo quote          — price, 1D move, market cap, 52w range
//   • Yahoo asset profile  — sector, industry, longName, business summary
//   • Yahoo fundamentals   — earnings history (estimate vs actual), revenue Q/Q
//   • Yahoo recommendation — analyst rating distribution + 30d delta
//   • Yahoo news endpoint  — last ~20 headlines with publisher + link
//   • Local catalyst classifier — keyword tags on news headlines so the user
//     can scan "what kind of catalyst" at a glance instead of skimming text
//
// No LLM call in the hot path. The brief is shaped so a future LLM-summary
// add-on (Haiku, ~$0.0001/brief) can wrap this without re-fetching.

const { yahooQuote, getYahooFundamentals, yahooAssetProfile, getYahooCrumb, resetAuth } = require('../data/providers/yahoo');
const { getRecentFilings, summarizeFilings } = require('../data/providers/edgar');
const fetch = global.fetch || require('node-fetch');

// 6h cache. News and analyst views shift slowly; quote is light to refetch.
const CACHE = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;
function cacheGet(k) {
  const e = CACHE.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) { CACHE.delete(k); return null; }
  return e.v;
}
function cacheSet(k, v) { CACHE.set(k, { v, ts: Date.now() }); }

// ─── Catalyst classifier ─────────────────────────────────────────────────
// Keyword → tag, run against headline + (when present) story summary. Order
// matters: more specific patterns first so "upgrade" doesn't shadow
// "estimate upgrade". Each tag carries a sentiment direction the UI uses
// to color the chip (green/red/amber/gray).

const CATALYST_RULES = [
  { tag: 'upgrade',    sentiment: 'bull', re: /\b(upgrad|raised (?:target|price target|pt|to (?:buy|outperform|overweight))|initiated.*(?:buy|outperform|overweight)|reiterat(?:ed|es).*(?:buy|outperform))\b/i },
  { tag: 'downgrade',  sentiment: 'bear', re: /\b(downgrad|cut (?:target|price target|pt)|lowered (?:target|price target|pt)|cut to (?:hold|sell|underweight|underperform)|warns? on|sell rating)\b/i },
  { tag: 'earnings',   sentiment: 'neutral', re: /\b(earnings|reports? q[1-4]|reports? (?:third|fourth|first|second) quarter|beat[s]? (?:estimates|expectations)|miss(?:es|ed) (?:estimates|expectations)|eps |quarterly results)\b/i },
  { tag: 'guidance',   sentiment: 'neutral', re: /\b(guidance|outlook|forecast|raises? (?:full|fy)|cuts? (?:full|fy)|reaffirms (?:guidance|outlook)|narrow(?:s|ed) (?:guidance|outlook))\b/i },
  { tag: 'm_and_a',    sentiment: 'bull', re: /\b(acqui[rs]|merger|takeover|to buy|agrees to (?:buy|acquire)|deal to (?:buy|acquire))\b/i },
  { tag: 'buyback',    sentiment: 'bull', re: /\b(buyback|repurchase|share repurchase|return of capital)\b/i },
  { tag: 'dividend',   sentiment: 'bull', re: /\b(dividend (?:increase|raise|hike|boost)|special dividend|ex-?dividend)\b/i },
  { tag: 'litigation', sentiment: 'bear', re: /\b(lawsuit|sued|class action|sec (?:charge|investigation|probe)|doj (?:probe|investigation)|antitrust|fraud charge|criminal (?:charge|probe))\b/i },
  { tag: 'regulatory', sentiment: 'neutral', re: /\b(fda approv|fda reject|approves|cleared by|denied|regulatory|fcc |european commission|china regulator)\b/i },
  { tag: 'product',    sentiment: 'neutral', re: /\b(launches?|unveils?|announces? new|debuts?|new (?:product|feature|service))\b/i },
  { tag: 'leadership', sentiment: 'neutral', re: /\b(ceo (?:steps down|resign|appoint|named)|cfo (?:steps down|resign|appoint|named)|chief executive|new (?:ceo|cfo|coo))\b/i },
  { tag: 'insider',    sentiment: 'neutral', re: /\b(insider (?:buy|sell|purchase|sale)|form 4|10b5-1|sells? \$|buys? \$)\b/i },
  { tag: 'short_squeeze', sentiment: 'bull', re: /\b(short squeeze|short interest|gamma squeeze|reddit|wsb|meme stock)\b/i },
  { tag: 'macro',      sentiment: 'neutral', re: /\b(fed |inflation|cpi |jobs report|interest rate|recession|tariff|trade war)\b/i },
];

function classifyHeadline(headline = '', summary = '') {
  const text = `${headline} ${summary}`;
  const tags = [];
  for (const rule of CATALYST_RULES) {
    if (rule.re.test(text)) tags.push({ tag: rule.tag, sentiment: rule.sentiment });
  }
  // Ensure at most one of each tag (a "earnings beat" headline matches both
  // earnings and guidance regex — keep both because they're distinct angles).
  const seen = new Set();
  return tags.filter(t => { if (seen.has(t.tag)) return false; seen.add(t.tag); return true; });
}

// ─── Yahoo news fetch ────────────────────────────────────────────────────
// `/v1/finance/search` is keyless and stable. We pull up to 20 items and
// keep only the ones that actually reference our symbol (Yahoo sometimes
// returns sector-level stories too).

async function fetchYahooNews(symbol, count = 20) {
  const key = `news:${symbol}:${count}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=${count}&quotesCount=0`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const j = await r.json();
    const items = (j.news || []).map(n => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      // providerPublishTime is unix seconds
      published: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      type: n.type,
      relatedTickers: Array.isArray(n.relatedTickers) ? n.relatedTickers : [],
      // No summary in /search response; the link → story page has one but
      // scraping is brittle. Classifier runs on the title only, which is
      // good enough for the tags we care about.
      tags: classifyHeadline(n.title || ''),
    }));
    cacheSet(key, items);
    return items;
  } catch (_) {
    return [];
  }
}

// ─── Analyst recommendation trend ────────────────────────────────────────
// Yahoo's `recommendationTrend` module returns an array of {period, strongBuy,
// buy, hold, sell, strongSell} for 0m/-1m/-2m/-3m. The 30-day delta is the
// signal — a fresh wave of upgrades or downgrades vs the trailing baseline.

async function fetchAnalystTrend(symbol) {
  const key = `analyst:${symbol}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const { crumb, cookie } = await getYahooCrumb();
    const modules = 'recommendationTrend,upgradeDowngradeHistory,financialData';
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    });
    if (r.status === 401 || r.status === 403) { resetAuth(); return null; }
    const d = await r.json();
    const result = d?.quoteSummary?.result?.[0];
    if (!result) return null;

    const trend = result.recommendationTrend?.trend || [];
    // 0m = current, -1m = one month ago. Period strings vary ("0m", "-1m", …)
    const cur  = trend.find(t => t.period === '0m')  || null;
    const prev = trend.find(t => t.period === '-1m') || null;

    const totalCur  = cur  ? (cur.strongBuy + cur.buy + cur.hold + cur.sell + cur.strongSell)  : 0;
    const totalPrev = prev ? (prev.strongBuy + prev.buy + prev.hold + prev.sell + prev.strongSell) : 0;
    const bullishCur  = cur  ? cur.strongBuy + cur.buy   : 0;
    const bullishPrev = prev ? prev.strongBuy + prev.buy : 0;
    const bullishSharCur  = totalCur  > 0 ? bullishCur  / totalCur  : null;
    const bullishSharPrev = totalPrev > 0 ? bullishPrev / totalPrev : null;
    const bullishDelta = (bullishSharCur != null && bullishSharPrev != null)
      ? +((bullishSharCur - bullishSharPrev) * 100).toFixed(1) : null;

    // Recent rating-change history (max 12 events)
    const upgrades = (result.upgradeDowngradeHistory?.history || [])
      .slice(0, 12)
      .map(h => ({
        firm: h.firm,
        action: h.action,            // 'up' / 'down' / 'init' / 'main' / 'reit'
        toGrade: h.toGrade,
        fromGrade: h.fromGrade,
        epoch: h.epochGradeDate,
        date: h.epochGradeDate ? new Date(h.epochGradeDate * 1000).toISOString().slice(0,10) : null,
      }));

    // Mean target price (financialData module)
    const fd = result.financialData || {};
    const meanTargetPrice = fd.targetMeanPrice?.raw ?? null;
    const recommendationKey = fd.recommendationKey || null;   // 'buy' / 'hold' / …
    const numAnalysts = fd.numberOfAnalystOpinions?.raw ?? null;

    const out = {
      current: cur,
      prior: prev,
      bullishSharePct: bullishSharCur != null ? +(bullishSharCur*100).toFixed(1) : null,
      bullishDelta30d: bullishDelta,
      meanTargetPrice,
      recommendationKey,
      numAnalysts,
      recentChanges: upgrades,
    };
    cacheSet(key, out);
    return out;
  } catch (_) { return null; }
}

// ─── Earnings track record ───────────────────────────────────────────────
// Reuses getYahooFundamentals; pulls the last 4 quarters of estimate vs
// actual and surprise %. Distinct from the daily PEAD score elsewhere — this
// is the analyst-expectations track record, useful context for "is this
// company in the habit of beating numbers?"

async function fetchEarningsTrack(symbol) {
  try {
    const fund = await getYahooFundamentals(symbol);
    const eps = fund?.epsActualQuarterly || [];
    return eps.slice(0, 4).map(q => ({
      date: q.date,
      actual: q.actual,
      estimate: q.estimate,
      surprise: q.surprise,
      surprisePct: q.surprisePct,
      beat: q.actual != null && q.estimate != null && q.actual > q.estimate,
    }));
  } catch (_) {
    return [];
  }
}

// ─── Brief assembly ──────────────────────────────────────────────────────

async function getStockBrief(symbol) {
  if (!symbol) throw new Error('symbol required');
  symbol = symbol.toUpperCase().trim();
  const key = `brief:${symbol}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // Fetch in parallel — quote is fast, news + analyst + earnings + EDGAR
  // can each take a second. Failures fall through (null/empty) so the
  // panel still renders the pieces that did succeed. EDGAR is a separate
  // catch — most ETFs / ADRs / foreign listings won't resolve to a CIK
  // and we don't want a missing-filings 500 to take down the whole brief.
  const [quoteArr, profile, analyst, earnings, news, secResp] = await Promise.all([
    yahooQuote([symbol]).catch(() => []),
    yahooAssetProfile(symbol).catch(() => null),
    fetchAnalystTrend(symbol).catch(() => null),
    fetchEarningsTrack(symbol).catch(() => []),
    fetchYahooNews(symbol).catch(() => []),
    getRecentFilings(symbol, { daysBack: 90, limit: 30 }).catch(() => ({ filings: [], cik: null, name: null })),
  ]);
  const quote = (Array.isArray(quoteArr) && quoteArr[0]) || null;

  // ATR(14) — read from the latest scanner cache instead of refetching
  // bars. The scanner already computes ATR for every symbol every 5 min
  // and writes to rs:full. Re-reading is free; recomputing would add a
  // 30-bar history fetch per drawer-open which is wasteful since the
  // value barely moves intraday.
  let atr = null, atrPct = null;
  try {
    const cachedRs = cacheGet('rs:full', 5 * 60 * 1000);  // 5 min
    if (Array.isArray(cachedRs)) {
      const row = cachedRs.find(r => r.ticker === symbol);
      if (row) { atr = row.atr ?? null; atrPct = row.atrPct ?? null; }
    }
  } catch (_) { /* ATR is best-effort */ }

  // Catalyst summary — count by tag across the news set so the panel can
  // render "5 upgrades · 2 downgrades · 1 lawsuit" at a glance instead of
  // forcing the user to scan 20 headlines.
  const catalystCounts = {};
  for (const n of news) {
    for (const t of (n.tags || [])) {
      catalystCounts[t.tag] = (catalystCounts[t.tag] || 0) + 1;
    }
  }

  // Days to earnings — proxy from the calendar (yahoo.calendarEvents) is
  // already pulled by yahooChartEvents, but we don't want to add another
  // round-trip just for that here. The Trade Setups panel already shows
  // "Earnings in N days" elsewhere; the brief leaves that to the caller.

  const brief = {
    symbol,
    fetchedAt: new Date().toISOString(),
    // Company overview surfaces what the ticker actually IS (business
     // summary, sector/industry, hq, employees, website) so the user
     // doesn't have to leave the app to remember "wait, is XYZ the fab
     // or the services co?" Powers the new overview block at the top
     // of the brief drawer.
    overview: {
      summary: profile?.summary || null,
      sector: profile?.sector || null,
      industry: profile?.industry || null,
      quoteType: profile?.quoteType || null,
      country: profile?.country || null,
      website: profile?.website || null,
      employees: profile?.employees ?? null,
      headquarters: profile?.headquarters || null,
      // Market cap from quote (it's only on quote, not the asset profile).
      marketCap: quote?.marketCap ?? null,
    },
    header: {
      longName: profile?.longName || symbol,
      sector: profile?.sector || null,
      industry: profile?.industry || null,
      quoteType: profile?.quoteType || null,
      price: quote?.regularMarketPrice ?? null,
      previousClose: quote?.regularMarketPreviousClose ?? null,
      dayChange: quote?.regularMarketPrice != null && quote?.regularMarketPreviousClose
        ? +((quote.regularMarketPrice - quote.regularMarketPreviousClose).toFixed(2))
        : null,
      dayChangePct: quote?.regularMarketPrice != null && quote?.regularMarketPreviousClose
        ? +(((quote.regularMarketPrice / quote.regularMarketPreviousClose) - 1) * 100).toFixed(2)
        : null,
      fiftyTwoWeekHigh: quote?.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow:  quote?.fiftyTwoWeekLow  ?? null,
      dayHigh: quote?.regularMarketDayHigh ?? null,
      dayLow:  quote?.regularMarketDayLow  ?? null,
      volume:  quote?.regularMarketVolume  ?? null,
      // distance to 52w high / low (% off — negative means below high)
      pctOff52wHigh: (quote?.regularMarketPrice && quote?.fiftyTwoWeekHigh)
        ? +(((quote.regularMarketPrice / quote.fiftyTwoWeekHigh) - 1) * 100).toFixed(1) : null,
      pctOff52wLow:  (quote?.regularMarketPrice && quote?.fiftyTwoWeekLow)
        ? +(((quote.regularMarketPrice / quote.fiftyTwoWeekLow ) - 1) * 100).toFixed(1) : null,
      atr,
      atrPct,
    },
    analyst,
    earningsTrack: earnings,
    news,
    catalystCounts,
    // SEC filings — last 90 days of high-signal forms (8-K, 10-K, 10-Q,
    // Form 4 insider, 13D/G, etc.). secResp.cik is null for symbols that
    // don't map to an EDGAR registrant (most ETFs, foreign-only listings).
    secFilings: {
      cik: secResp?.cik || null,
      registrantName: secResp?.name || null,
      filings: secResp?.filings || [],
      filingCounts: summarizeFilings(secResp?.filings || []),
      insiderActivityCount: (secResp?.filings || []).filter(f => f.isInsider).length,
    },
  };

  cacheSet(key, brief);
  return brief;
}

module.exports = {
  getStockBrief,
  // exposed for tests
  classifyHeadline,
  CATALYST_RULES,
};
