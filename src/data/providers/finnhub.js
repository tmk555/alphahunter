// ─── Finnhub provider ───────────────────────────────────────────────────
//
// Currently used for ONE thing: company news with direct publisher URLs.
// Yahoo's news endpoint returns ad-heavy wrapper URLs (finance.yahoo.com/m/...)
// that redirect through ad-laden interstitials. Finnhub's company-news
// endpoint returns the original article URL straight to Reuters / CNBC /
// Bloomberg / etc.
//
// Free tier: 60 calls/min, 30 calls/sec, 250K/month — generous for a
// per-ticker news pull. Sign up at finnhub.io for a key, set FINNHUB_API_KEY.
//
// When FINNHUB_API_KEY is unset, this module's functions return null —
// callers cascade to Yahoo's existing news endpoint.

const { cacheGet, cacheSet } = require('../cache');

const TTL_NEWS = 30 * 60 * 1000; // 30 min — news doesn't change minute-by-minute

function _key() { return process.env.FINNHUB_API_KEY; }

function _fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// ─── Company news ────────────────────────────────────────────────────────
// GET /api/v1/company-news?symbol=AAPL&from=2026-04-01&to=2026-04-30
//
// Response: [{ category, datetime, headline, id, image, related, source,
//              summary, url }]
//
// `url` is the direct publisher URL (no Yahoo wrapper). Sorted desc by
// datetime by default. We slice to N most recent articles.

async function getCompanyNews(symbol, { days = 7, limit = 5 } = {}) {
  const key = _key();
  if (!key) return null;
  if (!symbol) return null;

  const cacheKey = `finnhub:news:${symbol.toUpperCase()}:${days}:${limit}`;
  const cached = cacheGet(cacheKey, TTL_NEWS);
  if (cached) return cached;

  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${_fmtDate(from)}&to=${_fmtDate(to)}&token=${encodeURIComponent(key)}`;

  try {
    const fetch = global.fetch || require('node-fetch');
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) {
      // 401 = bad key, 429 = rate limit, 403 = paid endpoint. Either way,
      // return null so caller falls back to Yahoo.
      console.warn(`[finnhub] news fetch failed ${r.status} for ${symbol}`);
      return null;
    }
    const arr = await r.json();
    if (!Array.isArray(arr)) return null;

    const out = arr
      .filter(a => a.url && a.headline)
      .slice(0, limit)
      .map(a => ({
        title:  a.headline,
        source: a.source,
        time:   a.datetime ? new Date(a.datetime * 1000).toLocaleDateString() : null,
        url:    a.url,           // ← DIRECT publisher URL, no ad wrapper
        summary: a.summary,
        image:  a.image || null,
      }));
    cacheSet(cacheKey, out);
    return out;
  } catch (e) {
    console.warn(`[finnhub] news error: ${e.message}`);
    return null;
  }
}

// ─── Earnings calendar ───────────────────────────────────────────────────
// /api/v1/calendar/earnings?from=...&to=...&symbol=AAPL
// Future-dated earnings expected dates (better than Yahoo's fuzzy "EarningsDate"
// which can be off by a week). Useful for chart markers and exit-rule planning.

async function getEarningsCalendar(symbol, { daysAhead = 30 } = {}) {
  const key = _key();
  if (!key || !symbol) return null;
  const cacheKey = `finnhub:earncal:${symbol.toUpperCase()}:${daysAhead}`;
  const cached = cacheGet(cacheKey, TTL_NEWS);
  if (cached) return cached;

  const from = new Date();
  const to = new Date(from.getTime() + daysAhead * 86400000);
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${_fmtDate(from)}&to=${_fmtDate(to)}&symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`;

  try {
    const fetch = global.fetch || require('node-fetch');
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const events = Array.isArray(j?.earningsCalendar) ? j.earningsCalendar : [];
    cacheSet(cacheKey, events);
    return events;
  } catch (_) { return null; }
}

module.exports = { getCompanyNews, getEarningsCalendar };
