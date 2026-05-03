// ─── SEC EDGAR XBRL provider ────────────────────────────────────────────
//
// Free, primary-source fundamentals from SEC.gov. Replaces Yahoo's
// third-party-aggregated earnings data — Yahoo lags 24-72h after a print
// (user flagged AMZN's Q1 2026 print missing for hours), SEC has the data
// the moment a 10-Q / 10-K is filed.
//
// Endpoints used:
//
//   • https://www.sec.gov/files/company_tickers.json
//     Master ticker → CIK mapping. ~5,000 entries, refreshed daily by SEC.
//     Cached locally for 24h.
//
//   • https://data.sec.gov/api/xbrl/companyfacts/CIK{paddedCIK}.json
//     ALL XBRL numeric facts a company has ever filed, indexed by
//     concept (Revenues, NetIncomeLoss, EarningsPerShareDiluted, etc.).
//     Each concept has multiple periods + units. ~1-5MB per company.
//     Cached 6h (companies file at most quarterly).
//
//   • https://data.sec.gov/submissions/CIK{paddedCIK}.json
//     Filing history with accession numbers + form types + dates.
//     Used for earnings-marker chart annotations (10-Q file dates).
//
// SEC requires a User-Agent identifying the caller. The header is the
// only auth needed (no API key). Rate limit: ~10 req/sec. We cascade
// gracefully — Yahoo stays as fallback when SEC has no data (foreign
// ADRs like TSM/ASML/ARM aren't in EDGAR).

const { cacheGet, cacheSet, TTL_HIST } = require('../cache');

const SEC_USER_AGENT = process.env.SEC_USER_AGENT
  || 'alphahunter dev (alphahunter-dev@example.com)';

// ─── HTTP helper ─────────────────────────────────────────────────────────
async function _secFetch(url, opts = {}) {
  const fetch = global.fetch || require('node-fetch');
  const r = await fetch(url, {
    headers: {
      'User-Agent': SEC_USER_AGENT,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Host': new URL(url).host,
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const err = new Error(`SEC ${r.status} for ${url}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Same shape as _secFetch but returns the raw text body (for Form 4 XML,
// 13F primary docs, etc.). The Accept header is widened so SEC knows we
// can take XML/HTML/text.
async function _secFetchText(url, opts = {}) {
  const fetch = global.fetch || require('node-fetch');
  const r = await fetch(url, {
    headers: {
      'User-Agent': SEC_USER_AGENT,
      'Accept': 'application/xml, text/xml, text/html, */*',
      'Accept-Encoding': 'gzip, deflate',
      'Host': new URL(url).host,
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const err = new Error(`SEC ${r.status} for ${url}`);
    err.status = r.status;
    throw err;
  }
  return r.text();
}

// ─── Ticker → CIK mapping ────────────────────────────────────────────────
// Cached for the same 23h as historical bars — SEC only adds new entries
// when companies file their first 10-K (rare).

let _cikMapPromise = null;
async function _loadCIKMap() {
  const cached = cacheGet('sec:cikmap', TTL_HIST);
  if (cached) return cached;
  if (_cikMapPromise) return _cikMapPromise;

  _cikMapPromise = (async () => {
    const json = await _secFetch('https://www.sec.gov/files/company_tickers.json');
    // Shape: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, ... }
    const map = {};
    for (const v of Object.values(json)) {
      if (v?.ticker && v?.cik_str != null) {
        map[v.ticker.toUpperCase()] = {
          cik: String(v.cik_str).padStart(10, '0'),
          name: v.title,
        };
      }
    }
    cacheSet('sec:cikmap', map);
    _cikMapPromise = null;
    return map;
  })();
  return _cikMapPromise;
}

async function getCIK(ticker) {
  if (!ticker) return null;
  const map = await _loadCIKMap();
  return map[ticker.toUpperCase()] || null;
}

// ─── Company facts (full XBRL dump) ──────────────────────────────────────
// Cached 6h — companies file at most quarterly so 6h is conservative
// freshness. Larger payloads (1-5MB) so we don't want to refetch on every
// page render.

const TTL_FACTS = 6 * 60 * 60 * 1000; // 6h

async function getCompanyFacts(ticker) {
  const cik = await getCIK(ticker);
  if (!cik) return null;
  const cacheKey = `sec:facts:${cik.cik}`;
  const cached = cacheGet(cacheKey, TTL_FACTS);
  if (cached) return cached;

  try {
    const data = await _secFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.cik}.json`);
    cacheSet(cacheKey, data);
    return data;
  } catch (e) {
    if (e.status === 404) return null;  // Foreign ADRs, recent IPOs not yet in EDGAR
    throw e;
  }
}

// ─── Helper: extract a concept's filtered fact rows ──────────────────────
// XBRL data is multi-dimensional. Each fact has: form (10-Q/10-K),
// fp (FY/Q1/Q2/Q3), fy (fiscal year), end (period end date), val.
// We filter to the form and frame we want.

function _extractConcept(facts, concept, namespace = 'us-gaap') {
  const c = facts?.facts?.[namespace]?.[concept];
  if (!c) return null;
  // Pick the most-populated unit (USD vs USD/shares).
  const units = c.units || {};
  const unitKey = Object.keys(units)[0]; // Most concepts have a single unit
  if (!unitKey) return null;
  return { unit: unitKey, rows: units[unitKey] || [] };
}

// Concept selector that prefers the candidate whose latest `end` date is
// freshest. Companies migrate XBRL concepts over time (e.g. AAPL/MSFT moved
// from `Revenues` / `SalesRevenueNet` to `RevenueFromContractWithCustomer-
// ExcludingAssessedTax` after ASC 606 in 2018) but keep the legacy concept
// shells in their facts dump with stale historical rows. Picking the first
// non-empty concept silently returns 7-year-old data; picking by recency
// always lands on the live one.
//
// Returns the same shape as _extractConcept, plus `concept` for diagnostics.
function _pickFreshestConcept(facts, candidates, namespace = 'us-gaap') {
  let best = null;
  for (const concept of candidates) {
    const ext = _extractConcept(facts, concept, namespace);
    if (!ext || !ext.rows.length) continue;
    // Find latest period-end date in this concept's rows.
    let latest = '';
    for (const r of ext.rows) {
      if (r.end && r.end > latest) latest = r.end;
    }
    if (!latest) continue;
    if (!best || latest > best.latest) {
      best = { ...ext, concept, latest };
    }
  }
  return best;
}

// ─── Quarterly EPS history (real per-share EPS) ──────────────────────────
//
// Returns the last N quarters of diluted EPS, sourced directly from the
// company's 10-Q / 10-K filings. This is the CANSLIM "C" metric — true
// per-share growth, not Yahoo's net-income proxy.
//
// EarningsPerShareDiluted is the gold-standard concept; falls back to
// EarningsPerShareBasic when diluted not reported (smaller companies).

async function getQuarterlyEPS(ticker, n = 8) {
  const facts = await getCompanyFacts(ticker);
  if (!facts) return null;

  let series = _extractConcept(facts, 'EarningsPerShareDiluted')
            || _extractConcept(facts, 'EarningsPerShareBasic');
  if (!series) return null;

  // Filter to quarterly facts (10-Q + Q-frame 10-K Q4). Each row:
  // { start, end, val, fy, fp, form, filed, accn }
  // 10-K rows are FY-aggregate — skip them for quarterly view.
  const quarters = (series.rows || [])
    .filter(r => r.form === '10-Q' || (r.form === '10-K' && r.fp === 'Q4'))
    .filter(r => r.end && r.val != null)
    // Dedupe by period end. Subsequent 10-Qs include prior quarters as
    // *comparative* line items — same `end` date, same `val`, but a later
    // `filed` date. We want the ORIGINAL filing (when the news first hit
    // the wire), so keep the EARLIEST filed for each period end.
    //
    // Edge case: a 10-Q/A amendment legitimately updates a prior period.
    // Those are rare; if/when we see one, we'd want the amendment's value.
    // For now we prefer "first reported" since that matches the chart's
    // price-reaction-anchored marker — the amendment date isn't typically
    // a price-moving event.
    .reduce((acc, r) => {
      const cur = acc.get(r.end);
      if (!cur || (r.filed < cur.filed)) acc.set(r.end, r);
      return acc;
    }, new Map());

  return [...quarters.values()]
    .sort((a, b) => b.end.localeCompare(a.end))  // newest first
    .slice(0, n)
    .map(r => ({
      date: r.end,
      eps: r.val,
      fy: r.fy,
      fiscalQuarter: r.fp,
      form: r.form,
      filedAt: r.filed,
      accessionNumber: r.accn,
    }));
}

// ─── Annual EPS YoY (CANSLIM "A") ────────────────────────────────────────
//
// Pulls ANNUAL diluted EPS from the FY frame (10-K filings). Returns the
// last 4 fiscal years and a YoY growth rate. Replaces the net-income
// hack we have in yahoo.js.

async function getAnnualEPS(ticker, n = 4) {
  const facts = await getCompanyFacts(ticker);
  if (!facts) return null;

  const series = _extractConcept(facts, 'EarningsPerShareDiluted')
              || _extractConcept(facts, 'EarningsPerShareBasic');
  if (!series) return null;

  // Filter to FY rows. 10-Ks include 2-3 prior fiscal years as comparative
  // columns — same `end` date appears multiple times with different `fy`
  // tags (e.g. AMZN's FY2024 EPS appears once with fy=2024 in the original
  // 2025-02 filing AND again with fy=2025 in the FY2025 10-K filed 2026-02).
  //
  // Dedupe by `end` (period-end date) — that's the natural unique key for a
  // fiscal year — and keep the EARLIEST `filed` date so we anchor to the
  // original 10-K filing (where the price reacted), not a comparative line.
  const annual = (series.rows || [])
    .filter(r => r.form === '10-K' && r.fp === 'FY' && r.val != null && r.end)
    .reduce((acc, r) => {
      const cur = acc.get(r.end);
      if (!cur || (r.filed < cur.filed)) acc.set(r.end, r);
      return acc;
    }, new Map());

  // Sort by period-end descending (newest fiscal year first) and slice top N.
  const sorted = [...annual.values()]
    .sort((a, b) => (b.end || '').localeCompare(a.end || ''))
    .slice(0, n);
  if (sorted.length < 2) return { years: sorted, growthYoY: null };

  // True per-share growth: (this_year_EPS / prior_year_EPS) - 1.
  // Defensive on negative-prior-year (sign flip = undefined).
  const cur = sorted[0].val;
  const pri = sorted[1].val;
  const growthYoY = (pri > 0)
    ? +((cur / pri - 1) * 100).toFixed(1)
    : null;

  return {
    years: sorted.map(r => ({
      fy: r.fy,
      // fyLabel = the calendar year the fiscal year ENDED in. For
      // calendar-year fiscals (AMZN, NVDA partial) end-year matches
      // r.fy. For offset fiscals like AAPL (FY ends in September), SEC
      // sometimes tags r.fy = end-year + 1 (their internal filing
      // convention). Display preference: derive from r.end so the user
      // sees "FY2024" when end is 2024-09-28, not SEC's confusing
      // r.fy=2025. Falls back to r.fy when end is missing.
      fyLabel: r.end ? `FY${r.end.slice(0, 4)}` : `FY${r.fy}`,
      end: r.end,
      eps: r.val,
      filedAt: r.filed,
    })),
    growthYoY,
    growthSource: 'sec_per_share',
    sourceLink: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${(await getCIK(ticker))?.cik}&type=10-K`,
  };
}

// ─── Quarterly revenue history (CANSLIM "N") ─────────────────────────────
//
// Yahoo's incomeStatementHistoryQuarterly only carries 4 quarters, and
// when we don't have 5+ quarters its YoY-growth field falls back to
// sequential Q/Q while keeping the YoY label — that's how AMZN ended up
// showing revenueGrowthYoY = -14.9% (actually Q1-2025 vs Q4-2024
// sequential) instead of the true +9% YoY.
//
// SEC's XBRL has 8-12+ quarters of revenue under one of three concepts
// (companies vary by industry / accounting policy):
//   - Revenues — generic, most common
//   - RevenueFromContractWithCustomerExcludingAssessedTax — ASC 606 era
//   - SalesRevenueNet — older / industrial
// We try them in turn and use whichever returns data.
//
// Returns rows in the same shape as getQuarterlyEPS — date, val (in $),
// fy, fp, form, filed.

async function getQuarterlyRevenue(ticker, n = 8) {
  const facts = await getCompanyFacts(ticker);
  if (!facts) return null;

  // Pick whichever revenue concept has the freshest data — see
  // _pickFreshestConcept comment for why first-non-empty is wrong.
  const series = _pickFreshestConcept(facts, [
    'RevenueFromContractWithCustomerExcludingAssessedTax', // ASC 606 era (2018+)
    'Revenues',                                            // generic, legacy
    'SalesRevenueNet',                                     // pre-ASC-606
  ]);
  if (!series) return null;

  // SEC reports revenue at the period level (Q1-only, FY-only). For the
  // per-quarter view we want non-cumulative figures; 10-Q facts are
  // already quarterly. 10-K Q4 is also a quarterly period. Avoid YTD
  // cumulative values (some companies report 6-mo and 9-mo aggregates
  // with the same `end` as Q2/Q3 — disambiguated by `start`).
  const quarters = (series.rows || [])
    .filter(r => r.form === '10-Q' || (r.form === '10-K' && r.fp === 'Q4'))
    .filter(r => r.end && r.val != null && r.start)
    // Quarterly periods span ~90 days. Drop YTD cumulative rows
    // (3 months ≈ 80–95 day windows; 6mo/9mo/FY are 180+, drop them).
    .filter(r => {
      const ms = new Date(r.end + 'T00:00:00Z') - new Date(r.start + 'T00:00:00Z');
      const days = ms / (1000 * 60 * 60 * 24);
      return days >= 80 && days <= 100;
    })
    .reduce((acc, r) => {
      const cur = acc.get(r.end);
      if (!cur || (r.filed < cur.filed)) acc.set(r.end, r);  // earliest filed wins
      return acc;
    }, new Map());

  return [...quarters.values()]
    .sort((a, b) => b.end.localeCompare(a.end))
    .slice(0, n)
    .map(r => ({
      date: r.end,
      revenue: r.val,
      fy: r.fy,
      fiscalQuarter: r.fp,
      form: r.form,
      filedAt: r.filed,
    }));
}

// ─── Annual revenue history ──────────────────────────────────────────────
//
// FY-frame revenue from 10-Ks. Used by the Levels card's annual values
// section (alongside annual EPS) and for revenue-trend tooltips.

async function getAnnualRevenue(ticker, n = 4) {
  const facts = await getCompanyFacts(ticker);
  if (!facts) return null;

  const series = _pickFreshestConcept(facts, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
  ]);
  if (!series) return null;

  // FY rows from 10-Ks. Period span ~360-370 days (full fiscal year).
  const annual = (series.rows || [])
    .filter(r => r.form === '10-K' && r.fp === 'FY' && r.val != null && r.end && r.start)
    .filter(r => {
      const ms = new Date(r.end + 'T00:00:00Z') - new Date(r.start + 'T00:00:00Z');
      const days = ms / (1000 * 60 * 60 * 24);
      return days >= 350 && days <= 380;
    })
    .reduce((acc, r) => {
      const cur = acc.get(r.end);
      if (!cur || (r.filed < cur.filed)) acc.set(r.end, r);  // earliest filed wins
      return acc;
    }, new Map());

  return [...annual.values()]
    .sort((a, b) => b.end.localeCompare(a.end))
    .slice(0, n)
    .map(r => ({
      fy: r.fy,
      fyLabel: r.end ? `FY${r.end.slice(0, 4)}` : `FY${r.fy}`,
      end: r.end,
      revenue: r.val,
      filedAt: r.filed,
    }));
}

// ─── Earnings dates for chart markers ────────────────────────────────────
//
// Pulls the actual 10-Q + 10-K filing dates so the user can see when
// each quarter was REPORTED. Yahoo's earningsHistory has approximate
// dates; SEC has the exact filing timestamp. Use these for vertical
// markers on price charts ("ER" = earnings release).

async function getFilingMarkers(ticker, formTypes = ['10-Q', '10-K', '8-K']) {
  const cik = await getCIK(ticker);
  if (!cik) return null;
  const cacheKey = `sec:filings:${cik.cik}:${formTypes.join(',')}`;
  const cached = cacheGet(cacheKey, TTL_FACTS);
  if (cached) return cached;

  const data = await _secFetch(`https://data.sec.gov/submissions/CIK${cik.cik}.json`).catch(() => null);
  if (!data?.filings?.recent) return [];

  const recent = data.filings.recent;
  const markers = [];
  for (let i = 0; i < (recent.form || []).length; i++) {
    if (formTypes.includes(recent.form[i])) {
      markers.push({
        form: recent.form[i],
        filedAt: recent.filingDate[i],
        reportPeriod: recent.reportDate[i] || null,
        accession: recent.accessionNumber[i],
        primaryDoc: recent.primaryDocument[i],
        // 8-K item codes (e.g. "2.02,9.01") tell you WHAT triggered the
        // 8-K — earnings press release, M&A announcement, exec change, etc.
        // For 10-Q / 10-K this field is empty.
        items: recent.items?.[i] || null,
        url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik.cik}&type=${recent.form[i]}&dateb=&owner=include&count=40`,
      });
    }
  }
  cacheSet(cacheKey, markers);
  return markers;
}

// ─── Form 4 (insider transactions) ───────────────────────────────────────
//
// Pulls insider trades for a ticker. SEC requires officers/directors/10%+
// owners to file Form 4 within 2 business days of any transaction; we
// re-fetch the submissions list (already cached 6h) to find Form 4
// accession numbers, then fetch each filing's primary XML and parse out
// the structured fields.
//
// Why regex parsing not a real XML library: Form 4 XML is small, well-
// formed, and structurally deterministic. Adding xml2js for two ten-line
// regexes isn't justified. Each Form 4 has at most ~5 transactions and
// 1-3 reportingOwners; the regexes parse them in a single pass.
//
// Transaction codes captured (see database.js comment for full list):
//   P = open-market purchase  (the actual buy signal)
//   S = open-market sale       (the actual sell signal)
//   A, M, F, D, G, J, V — non-trade transactions (grants, option ex, gifts,
//                          etc.); stored but excluded from cluster-buy logic
//
// Returns array of normalized rows ready for INSERT into insider_transactions.

const TTL_INSIDER = 6 * 60 * 60 * 1000;  // 6h — same as company facts

// Strip a single XML tag's text content. Tolerates tags with attributes.
// Returns null when not found. Form 4 wraps numbers in <value>X</value>
// inside the field tag, so `_xmlField(xml, 'transactionShares')` still
// needs a `_xmlValue` follow-up — separate helpers keep call sites clean.
function _xmlField(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}
function _xmlText(xml, tag) {
  const inner = _xmlField(xml, tag);
  if (inner == null) return null;
  // Strip any nested tags, return plain text trimmed.
  return inner.replace(/<[^>]+>/g, '').trim();
}
function _xmlValue(xml, tag) {
  // Field with <value>X</value> child. Returns the inner X as text.
  const inner = _xmlField(xml, tag);
  if (inner == null) return null;
  const v = inner.match(/<value>([\s\S]*?)<\/value>/);
  return v ? v[1].trim() : null;
}

// Parse one <reportingOwner> block.
function _parseOwner(ownerXml) {
  const name  = _xmlText(ownerXml, 'rptOwnerName') || _xmlText(ownerXml, 'reportingOwnerId') || null;
  const rel   = _xmlField(ownerXml, 'reportingOwnerRelationship') || '';
  const isDirector  = /<isDirector[^>]*>(?:1|true)/i.test(rel);
  const isOfficer   = /<isOfficer[^>]*>(?:1|true)/i.test(rel);
  const isTenPct    = /<isTenPercentOwner[^>]*>(?:1|true)/i.test(rel);
  const titleM      = rel.match(/<officerTitle[^>]*>([\s\S]*?)<\/officerTitle>/);
  const title       = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : null;
  return { name, title, isDirector, isOfficer, isTenPct };
}

// Parse all <nonDerivativeTransaction> blocks (common-stock buys/sells).
// Derivative transactions (options) live in <derivativeTable> and are
// usually compensation grants — we skip them for the signal layer.
function _parseTransactions(xml) {
  const blocks = [];
  const re = /<nonDerivativeTransaction[^>]*>([\s\S]*?)<\/nonDerivativeTransaction>/g;
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);

  return blocks.map(b => {
    const date  = _xmlValue(b, 'transactionDate');
    const code  = _xmlText(b, 'transactionCode');
    const shares = _xmlValue(b, 'transactionShares');
    const price  = _xmlValue(b, 'transactionPricePerShare');
    const post   = _xmlValue(b, 'sharesOwnedFollowingTransaction');
    const acquiredCode = _xmlValue(b, 'transactionAcquiredDisposedCode');  // 'A' or 'D'
    return {
      tradeDate:    date,
      transactionCode: code,
      shares:       shares != null ? parseInt(shares, 10) : null,
      pricePerShare: price != null ? parseFloat(price) : null,
      postShares:   post != null ? parseInt(post, 10) : null,
      // For 'P' transactions we expect acquiredDisposed='A' (acquired);
      // 'S' should be 'D' (disposed). We trust the transactionCode primarily.
      acquiredDisposed: acquiredCode,
    };
  });
}

async function getInsiderTransactions(ticker, { maxFilings = 30, sinceDate = null } = {}) {
  const cik = await getCIK(ticker);
  if (!cik) return null;

  const cacheKey = `sec:insider:${cik.cik}:${maxFilings}:${sinceDate || 'all'}`;
  const cached = cacheGet(cacheKey, TTL_INSIDER);
  if (cached) return cached;

  // Submissions endpoint already pulled by getFilingMarkers / getCompanyFacts.
  // We hit it again here but it's cache-friendly within a session.
  const data = await _secFetch(`https://data.sec.gov/submissions/CIK${cik.cik}.json`)
    .catch(() => null);
  if (!data?.filings?.recent) return [];

  const recent = data.filings.recent;
  const cikNum = String(parseInt(cik.cik, 10));  // un-padded for the Archives URL

  // Find Form 4 indices — both 'plain' and amendments ('4/A') count.
  const indices = [];
  for (let i = 0; i < (recent.form || []).length; i++) {
    if (recent.form[i] !== '4' && recent.form[i] !== '4/A') continue;
    if (sinceDate && recent.filingDate[i] < sinceDate) continue;
    indices.push(i);
    if (indices.length >= maxFilings) break;
  }
  if (!indices.length) {
    cacheSet(cacheKey, []);
    return [];
  }

  // Fetch each Form 4's primary XML and parse. Done sequentially with a
  // small delay to respect SEC's 10 req/sec ceiling — we share that
  // budget with everything else hitting EDGAR.
  //
  // URL note: SEC's submissions endpoint returns `primaryDocument` like
  //   xslF345X06/wk-form4_1774386816.xml
  // The `xslF345X06/` segment is the HTML viewer wrapper SEC injects for
  // browser viewing. The RAW XML — which is what we need to parse — lives
  // at the same path WITHOUT the xslF345X06/ prefix:
  //   wk-form4_1774386816.xml
  // Strip that prefix before building the URL.
  const rows = [];
  for (const i of indices) {
    const accDashed = recent.accessionNumber[i];
    const accNoDash = accDashed.replace(/-/g, '');
    let primary = recent.primaryDocument[i] || '';
    if (!primary) continue;
    // Strip xslF345X0(N)/ wrapper → raw XML path. Form 3, 4, 5 all use
    // this rendering convention.
    primary = primary.replace(/^xslF345X\d+\//, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${primary}`;
    let xml;
    try { xml = await _secFetchText(url); }
    catch (e) { continue; /* one bad filing shouldn't kill the whole pull */ }

    // Form 4 wraps payload in <ownershipDocument>. Anything else means
    // SEC served the HTML rendering instead of the raw XML — skip it.
    if (!/<ownershipDocument/.test(xml)) continue;

    // Insider info: take FIRST reportingOwner. Multi-owner Form 4s
    // (rare — filed by joint trusts) end up using the first as the
    // representative; the granular owner names are available in the
    // raw XML if a future feature wants them.
    const ownerBlocks = [];
    const ownerRe = /<reportingOwner[^>]*>([\s\S]*?)<\/reportingOwner>/g;
    let om;
    while ((om = ownerRe.exec(xml)) !== null) ownerBlocks.push(om[1]);
    const owner = ownerBlocks.length ? _parseOwner(ownerBlocks[0]) : { name: null };

    const filedAt = recent.filingDate[i];
    const txs = _parseTransactions(xml);
    for (const tx of txs) {
      if (!tx.tradeDate || !tx.transactionCode) continue;
      const shares = tx.shares || 0;
      const price  = tx.pricePerShare || 0;
      // Sign: buys positive, sells negative. Other codes (grants, gifts,
      // option ex) keep the unsigned absolute value — UI/signal logic
      // looks at transactionCode separately.
      const signedValue = tx.transactionCode === 'P' ? shares * price :
                          tx.transactionCode === 'S' ? -shares * price :
                          shares * price;
      rows.push({
        symbol: ticker.toUpperCase(),
        filedAt,
        tradeDate: tx.tradeDate,
        insiderName: owner.name,
        insiderTitle: owner.title,
        isDirector: owner.isDirector ? 1 : 0,
        isOfficer:  owner.isOfficer  ? 1 : 0,
        isTenPercent: owner.isTenPct ? 1 : 0,
        transactionCode: tx.transactionCode,
        shares,
        pricePerShare: price,
        totalValue: signedValue,
        postShares: tx.postShares,
        accessionNumber: accDashed,
        sourceUrl: url,
      });
    }
  }

  cacheSet(cacheKey, rows);
  return rows;
}

// ─── 8-K item code → human label map ─────────────────────────────────────
//
// 8-K is a "material events" form companies file between quarterly reports.
// The Item code identifies what's being disclosed. Most are noise (FD
// disclosure, exhibits-only). A small subset moves prices: earnings PR,
// M&A, executive change. We tag those for chart rendering.
//
// Reference: https://www.sec.gov/files/8K-Form-Instructions.pdf

const TRADER_RELEVANT_8K_ITEMS = {
  '1.01': 'M&A signed',
  '1.02': 'M&A terminated',
  '2.01': 'Acquisition closed',
  '2.02': 'Earnings release',     // ← most common reason for an 8-K
  '2.03': 'Direct financial obligation',
  '2.04': 'Triggering event — debt acceleration',
  '2.05': 'Restructuring costs',
  '2.06': 'Material impairment',
  '3.01': 'Listing standard fail / transfer',
  '3.02': 'Unregistered equity sale',
  '4.01': 'Auditor change',
  '4.02': 'Restated financials — non-reliance',
  '5.01': 'Change in control',
  '5.02': 'Director / officer change',
  '5.03': 'Bylaw / charter amendment',
  '7.01': 'Reg FD disclosure',
  '8.01': 'Other material events',
};

// Determine if an 8-K's items make it interesting for a trader's chart.
// Returns the friendliest item label or null to skip rendering.
function classify8KItems(itemsStr) {
  if (!itemsStr) return null;
  const items = itemsStr.split(',').map(s => s.trim());
  // Walk in priority order so an 8-K with both 2.02 + 9.01 (typical earnings
  // release) gets labeled "Earnings release" not "Other"
  const priority = ['2.02', '1.01', '1.02', '2.01', '2.05', '2.06', '4.02', '5.02', '5.01', '3.01', '4.01'];
  for (const code of priority) {
    if (items.includes(code) && TRADER_RELEVANT_8K_ITEMS[code]) {
      return { code, label: TRADER_RELEVANT_8K_ITEMS[code], allItems: items };
    }
  }
  // Skip pure-noise 8-Ks (only 7.01 / 8.01 / 9.01 = exhibits)
  return null;
}

module.exports = {
  getCIK,
  getCompanyFacts,
  getQuarterlyEPS,
  getAnnualEPS,
  getQuarterlyRevenue,
  getAnnualRevenue,
  getFilingMarkers,
  getInsiderTransactions,
  classify8KItems,
};
