// ─── SEC EDGAR provider — keyless filings + insider data ─────────────────
//
// Pulls SEC submissions for any ticker. EDGAR is free and key-less but
// REQUIRES a User-Agent that identifies the caller (per their fair-access
// policy: https://www.sec.gov/os/accessing-edgar-data). They throttle
// aggressive scrapers, so we cache aggressively (24h for the ticker→CIK
// table, 30 min per company submission set).
//
// Endpoints used:
//   GET https://www.sec.gov/files/company_tickers.json
//       → ticker → CIK lookup (~13,000 entries)
//   GET https://data.sec.gov/submissions/CIK{10-digit-padded}.json
//       → last 1000 filings for a company; we slice to last 90 days for
//         the brief panel.
//
// Output is normalized to:
//   { form, formLabel, date, accessionNumber, primaryDocument, url, summary }
//
// 8-K events carry a coded `items` field on the index page (1.01/2.02/etc.)
// that would let us tag them with friendly labels — but pulling that adds
// one HTTP call per 8-K. We surface the 8-K rows as-is for v1; the user
// can click through to read the items inline. A future enhancement could
// fetch and parse the index docs in parallel.

const fetch = global.fetch || require('node-fetch');

const UA = process.env.SEC_EDGAR_USER_AGENT
  || 'AlphaHunter (open-source replay tool, contact: noreply@example.com)';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS_URL = (cik) => `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`;

const TICKER_TTL = 24 * 60 * 60 * 1000;   // 24h
const SUB_TTL    = 30 * 60 * 1000;        // 30 min

let _tickerMap = null;
let _tickerFetchedAt = 0;
const _subCache = new Map(); // cik → {at, data}

// Friendly form-type labels — these are the form names users actually
// recognize. Others fall through with the raw form code.
const FORM_LABELS = {
  '8-K':  'Material Event',
  '10-K': 'Annual Report',
  '10-Q': 'Quarterly Report',
  '10-K/A': 'Annual Report (amended)',
  '10-Q/A': 'Quarterly Report (amended)',
  '4':    'Insider Transaction',
  '4/A':  'Insider Transaction (amended)',
  '3':    'Initial Insider Holdings',
  '5':    'Annual Insider Holdings',
  '13D':    'Activist Position (≥5%)',
  '13D/A':  'Activist Position (amended)',
  'SC 13D': 'Activist Position (≥5%)',
  'SC 13D/A': 'Activist Position (amended)',
  'SC 13G':   'Passive Position (≥5%)',
  'SC 13G/A': 'Passive Position (amended)',
  '13F-HR':   'Institutional Holdings',
  '13F-HR/A': 'Institutional Holdings (amended)',
  'S-1':  'IPO Registration',
  'S-3':  'Shelf Registration',
  'S-4':  'M&A Registration',
  '424B': 'Prospectus',
  'DEF 14A': 'Proxy Statement',
  '144':     'Notice of Proposed Sale',
  '6-K':     'Foreign Issuer Report',
  '20-F':    'Foreign Annual Report',
  '40-F':    'Canadian Annual Report',
};

// Forms we surface in the brief by default. Filings outside this set are
// fetchable via getAllFilings() but excluded from getRecentFilings()
// to keep the brief signal-dense.
const HIGH_SIGNAL_FORMS = new Set([
  '8-K', '10-K', '10-Q', '10-K/A', '10-Q/A',
  '4', '4/A',
  'SC 13D', 'SC 13D/A', '13D', '13D/A',
  'SC 13G', 'SC 13G/A',
  'S-1', 'S-3', 'S-4',
  'DEF 14A',
  '20-F', '40-F', '6-K',
]);

function classifyForm(form) {
  return FORM_LABELS[form] || form;
}

// Insider-form detection — Form 4 is the most actively-watched insider
// document; Forms 3/5 are surrounding context.
function isInsiderForm(form) {
  return form === '4' || form === '4/A' || form === '3' || form === '5';
}

async function _fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    },
  });
  if (!r.ok) throw new Error(`EDGAR ${url} → ${r.status}`);
  return r.json();
}

async function getTickerMap() {
  if (_tickerMap && (Date.now() - _tickerFetchedAt) < TICKER_TTL) return _tickerMap;
  const j = await _fetchJson(TICKERS_URL);
  // Shape: { "0": { cik_str, ticker, title }, "1": {...}, ... }
  const map = new Map();
  for (const k of Object.keys(j)) {
    const e = j[k];
    if (e?.ticker && e?.cik_str != null) {
      map.set(e.ticker.toUpperCase(), { cik: e.cik_str, name: e.title });
    }
  }
  _tickerMap = map;
  _tickerFetchedAt = Date.now();
  return map;
}

/**
 * Translate a stock symbol to its EDGAR CIK. Returns null when the symbol
 * isn't an SEC-registered US-listed entity (ETFs, ADRs without separate
 * filings, foreign-only listings, crypto, etc.).
 *
 * Yahoo's class-share format BRK-B maps to EDGAR's plain "BRK.B" — the
 * ticker map already uses the dot form, so we normalize before looking up.
 */
async function getCikForSymbol(symbol) {
  if (!symbol) return null;
  const sym = String(symbol).toUpperCase().trim();
  // Normalize Yahoo's class-share dash (BRK-B) → EDGAR's dot (BRK.B). This
  // is the same translation src/data/providers/alpaca.js does for the
  // Alpaca data API. Multi-letter and numeric suffixes pass through.
  const normalized = sym.replace(/^([A-Z]+)-([A-Z])$/, '$1.$2');
  const map = await getTickerMap();
  const e = map.get(normalized);
  return e ? { cik: e.cik, name: e.name, normalized } : null;
}

async function getSubmissions(cik) {
  const cached = _subCache.get(cik);
  if (cached && (Date.now() - cached.at) < SUB_TTL) return cached.data;
  const data = await _fetchJson(SUBMISSIONS_URL(cik));
  _subCache.set(cik, { at: Date.now(), data });
  return data;
}

function _accessionToHtmlPath(acc) {
  // acc looks like "0000320193-25-000123" — index page is /Archives/edgar/data/{cik}/{acc-no-dashes}/{acc-with-dashes}-index.htm
  return acc.replace(/-/g, '');
}

function _filingUrl(cik, accession, primaryDocument) {
  const accNoDashes = _accessionToHtmlPath(accession);
  if (primaryDocument) {
    return `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${primaryDocument}`;
  }
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=10`;
}

/**
 * Recent filings for a ticker, normalized to a flat array of:
 *   { form, formLabel, date, accessionNumber, primaryDocument, url,
 *     isInsider, daysAgo }
 * Sorted by filing date desc. Filtered to the high-signal form set and
 * the last `daysBack` calendar days.
 */
async function getRecentFilings(symbol, { daysBack = 90, limit = 30 } = {}) {
  const cikInfo = await getCikForSymbol(symbol);
  if (!cikInfo) return { filings: [], cik: null, name: null };
  const subs = await getSubmissions(cikInfo.cik);
  const r = subs.filings?.recent;
  if (!r?.form?.length) return { filings: [], cik: cikInfo.cik, name: subs.name || cikInfo.name };

  const cutoffMs = Date.now() - daysBack * 86400_000;
  const out = [];
  // Each `recent` field is a parallel array. Iterate by index; rows are
  // already filing-date desc.
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    const form = r.form[i];
    if (!HIGH_SIGNAL_FORMS.has(form)) continue;
    const dateStr = r.filingDate[i];
    const dateMs = Date.parse(dateStr + 'T00:00:00Z');
    if (Number.isFinite(dateMs) && dateMs < cutoffMs) {
      // Submissions JSON is sorted by date desc; once we cross cutoff
      // we can break (older rows don't qualify either).
      break;
    }
    out.push({
      form,
      formLabel: classifyForm(form),
      date: dateStr,
      accessionNumber: r.accessionNumber[i],
      primaryDocument: r.primaryDocument[i],
      reportDate: r.reportDate?.[i] || null,
      url: _filingUrl(cikInfo.cik, r.accessionNumber[i], r.primaryDocument[i]),
      isInsider: isInsiderForm(form),
      daysAgo: Math.max(0, Math.floor((Date.now() - dateMs) / 86400_000)),
    });
  }
  return {
    filings: out,
    cik: cikInfo.cik,
    name: subs.name || cikInfo.name,
  };
}

/**
 * Quick aggregate counts for the brief's catalyst panel — how many of
 * each high-signal form fired in the window. Cheap; just iterates the
 * already-pulled list.
 */
function summarizeFilings(filings) {
  const counts = {};
  for (const f of filings) {
    counts[f.form] = (counts[f.form] || 0) + 1;
  }
  // Insider net activity — Form 4 count alone, no transaction-code parse
  // (would need to fetch the XML). The user clicks through to inspect.
  return counts;
}

module.exports = {
  getCikForSymbol,
  getRecentFilings,
  summarizeFilings,
  classifyForm,
  isInsiderForm,
  HIGH_SIGNAL_FORMS,
};
