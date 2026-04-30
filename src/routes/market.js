// ─── Market Pulse: sentiment + event-risk routes ────────────────────────────
//
// Two thin endpoints that power the Market Pulse tab's sentiment &
// upcoming-event-risk panels:
//
//   /api/market/fear-greed         — CNN Business Fear & Greed Index (0-100)
//   /api/market/upcoming-earnings  — next-N-days earnings for notable names
//
// Both endpoints are caller-cached (Yahoo is 6h, CNN is 1h) so repeat polls
// from the dashboard are cheap. Shape of responses is stable — UI can treat
// missing fields as "not available right now" and render a dash.
const express = require('express');
const router  = express.Router();

const { cacheGet, cacheSet } = require('../data/cache');
const { yahooChartEvents } = require('../data/providers/yahoo');
const { getQuotes } = require('../data/providers/manager');
const { getDB } = require('../data/database');

// ─── Fear & Greed Index (CNN) ───────────────────────────────────────────────
//
// CNN publishes their index via an unauthed JSON endpoint — same data the
// fearandgreed.cnn.com page uses. No key required, but the server does
// 403 on a blank User-Agent so we send a browser-ish one.
//
// Score bands (CNN's own):
//   0–24   Extreme Fear        (contrarian-bullish at persistent extremes)
//   25–44  Fear
//   45–55  Neutral
//   56–74  Greed
//   75–100 Extreme Greed       (contrarian-bearish at persistent extremes)
//
// Cached 1h — CNN only recomputes daily post-close plus a few intraday taps.
const FNG_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const TTL_FNG = 60 * 60 * 1000; // 1 hour

function classifyFngScore(n) {
  if (n == null) return null;
  if (n < 25)  return 'Extreme Fear';
  if (n < 45)  return 'Fear';
  if (n <= 55) return 'Neutral';
  if (n <= 74) return 'Greed';
  return 'Extreme Greed';
}

router.get('/market/fear-greed', async (req, res) => {
  try {
    const cached = cacheGet('fng', TTL_FNG);
    if (cached) return res.json(cached);

    const r = await fetch(FNG_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.cnn.com',
        'Referer': 'https://www.cnn.com/',
      },
    });
    if (!r.ok) return res.status(502).json({ error: `CNN returned ${r.status}` });
    const j = await r.json();

    const fg = j?.fear_and_greed || {};
    const out = {
      score:          fg.score != null ? Math.round(fg.score) : null,
      rating:         fg.rating || classifyFngScore(fg.score),
      previousClose:  fg.previous_close != null ? Math.round(fg.previous_close) : null,
      oneWeekAgo:     fg.previous_1_week != null ? Math.round(fg.previous_1_week) : null,
      oneMonthAgo:    fg.previous_1_month != null ? Math.round(fg.previous_1_month) : null,
      oneYearAgo:     fg.previous_1_year != null ? Math.round(fg.previous_1_year) : null,
      updatedAt:      fg.timestamp || new Date().toISOString(),
    };
    cacheSet('fng', out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Upcoming notable earnings (next N days) ────────────────────────────────
//
// "Notable" = market-moving names the user actually needs to watch. Three
// sources are unioned so we don't miss anything that matters to THIS book:
//
//   1. Mega-cap index movers — hardcoded below. These set the tape.
//   2. Current open positions — any `trades` row with exit_date IS NULL.
//      Earnings here are binary events; user MUST see them.
//   3. High-RS names (rs_snapshots latest, rs_rank >= 80) — leaders the
//      scanner has flagged. Their prints often ripple through the group.
//
// For each symbol we call the existing yahooChartEvents() helper (6h cached)
// and keep rows whose earningsDate lands in [today, today+N). The heavy lift
// is already memoised — first call after cache expiry is the only expensive
// one, subsequent polls are instant.
//
// Response: [{ symbol, earningsDate, daysOut, source: [...], rsRank }]
// sorted by daysOut ascending.
const MEGA_CAPS = [
  // Mega-cap tech (index-movers)
  'AAPL','MSFT','NVDA','GOOGL','GOOG','AMZN','META','TSLA',
  // Broad mega-caps / sector bellwethers
  'AVGO','BRK-B','LLY','JPM','V','MA','UNH','XOM','JNJ','WMT',
  'PG','HD','COST','ORCL','AMD','NFLX','CRM','BAC','ADBE','DIS',
  // Financials / Insurance / Energy leaders
  'GS','MS','C','WFC','CVX',
  // Semis / AI infra
  'TSM','ASML','MU','QCOM','INTC',
];

// Final-result cache: the earnings endpoint is expensive on cold start
// (fetches ~60 symbols' earnings dates from Yahoo). After the first call
// the per-symbol 6h cache handles it, but we still run the full fan-out on
// every request. Cache the shaped response for 30 min so back-to-back hits
// are instant.
const TTL_EARNINGS_RESPONSE = 30 * 60 * 1000; // 30 min

router.get('/market/upcoming-earnings', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days || '7', 10) || 7));
    const notableOnly = req.query.notable !== '0'; // default: notable-only

    // Cache key depends on the window + mode so the user can flip 3/7/14/30
    // days without poisoning the cache.
    // v3: date-primary sort (was holdings-primary) + we now skip caching
    // responses whose earningsDate coverage looks suspiciously low (likely
    // transient Yahoo failure during cold fetch).
    const cacheKey = `upE:v3:${days}:${notableOnly ? 1 : 0}`;
    const cached = cacheGet(cacheKey, TTL_EARNINGS_RESPONSE);
    if (cached) return res.json(cached);

    // 'Today' must be the US Eastern calendar day, NOT UTC. From ~8 PM
    // local CDT onward (or earlier in PST), UTC has already rolled to
    // tomorrow's date — that made daysOut compute one day ahead of what
    // the user sees on their wall clock. Earnings are reported on ET
    // trading days, so ET is the correct anchor.
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });  // YYYY-MM-DD
    const todayMs = Date.parse(todayET + 'T00:00:00Z');
    const cutoffMs = todayMs + days * 86400000;

    // ── Build the symbol universe ─────────────────────────────────────────
    const db = getDB();
    const openRows = db.prepare(
      "SELECT DISTINCT symbol FROM trades WHERE exit_date IS NULL AND COALESCE(remaining_shares, shares, 0) > 0"
    ).all().map(r => r.symbol).filter(Boolean);

    // High-RS leaders from latest snapshot date — guarded: table may not
    // exist on fresh installs, and schema varies. Fall back to empty.
    // LIMIT 25 (was 40) — the mega-cap list already covers ~35 names, and
    // 25 leaders is plenty for the "watch out" use case. Cuts cold-start
    // Yahoo fan-out by ~15 symbols.
    let highRs = [];
    let latestRsDate = null;
    try {
      const latest = db.prepare(
        "SELECT MAX(date) AS d FROM rs_snapshots WHERE type = 'stock'"
      ).get();
      if (latest?.d) {
        latestRsDate = latest.d;
        highRs = db.prepare(
          `SELECT symbol, rs_rank FROM rs_snapshots
            WHERE type = 'stock' AND date = ? AND rs_rank >= 85
            ORDER BY rs_rank DESC LIMIT 25`
        ).all(latestRsDate);
      }
    } catch (_) {}

    // rsRankBySymbol is populated below (after the full universe is known)
    // so every earnings row — not just leaders — can carry an RS score.
    const rsRankBySymbol = new Map();
    const openSet = new Set(openRows);
    const megaSet = new Set(MEGA_CAPS);

    // Deduped symbol list with a source tag per symbol
    const sourceBySym = new Map();
    const addSrc = (s, tag) => {
      if (!s) return;
      const cur = sourceBySym.get(s) || [];
      if (!cur.includes(tag)) cur.push(tag);
      sourceBySym.set(s, cur);
    };
    if (notableOnly) {
      MEGA_CAPS.forEach(s => addSrc(s, 'mega'));
      openRows.forEach(s => addSrc(s, 'holding'));
      highRs.forEach(r => addSrc(r.symbol, 'leader'));
    } else {
      // Broader mode: include everything in the latest RS snapshot (rs_rank≥60).
      MEGA_CAPS.forEach(s => addSrc(s, 'mega'));
      openRows.forEach(s => addSrc(s, 'holding'));
      try {
        const latest = db.prepare(
          "SELECT MAX(date) AS d FROM rs_snapshots WHERE type = 'stock'"
        ).get();
        if (latest?.d) {
          const broad = db.prepare(
            `SELECT symbol FROM rs_snapshots
              WHERE type = 'stock' AND date = ? AND rs_rank >= 60
              ORDER BY rs_rank DESC LIMIT 150`
          ).all(latest.d);
          broad.forEach(r => addSrc(r.symbol, 'scan'));
        }
      } catch (_) {}
    }

    const symbols = [...sourceBySym.keys()];

    // ── Populate rs_rank for EVERY symbol in the universe ────────────────
    //
    // Previously we only mapped rs_rank for the top-25 leaders (rs_rank≥85),
    // which meant mega-caps & holdings that weren't in the leader set
    // rendered with no RS score in the UI. Here we do one extra indexed
    // read to fill in rs_rank for the whole universe from the same snapshot
    // date, so every earnings row can show a score (or null if the symbol
    // genuinely isn't in the snapshot — e.g. ADRs we don't scan).
    if (latestRsDate && symbols.length) {
      try {
        const placeholders = symbols.map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT symbol, rs_rank FROM rs_snapshots
            WHERE type = 'stock' AND date = ? AND symbol IN (${placeholders})`
        ).all(latestRsDate, ...symbols);
        for (const row of rows) rsRankBySymbol.set(row.symbol, row.rs_rank);
      } catch (_) {}
    }

    // ── Call Yahoo in parallel (with a concurrency cap) ───────────────────
    //
    // yahooChartEvents is per-symbol cached for 6h so most of these are
    // memory hits after the first warm-up call. Concurrency 5 (was 20) —
    // higher values let Yahoo silently drop responses for quoteSummary under
    // burst load even though the crumb endpoint holds up fine. 5 keeps cold
    // fetches ~8-10s but produces complete results. Once the 6h per-symbol
    // cache is warm, subsequent polls are near-instant regardless.
    //
    // NOTE: our in-repo pLimit is a BATCH RUNNER, not the npm p-limit wrapper:
    // signature is `pLimit(tasks: (() => Promise<T>)[], concurrency)`. It
    // awaits `concurrency` tasks in parallel per batch, so we build an array
    // of zero-arg thunks and hand them over.
    const { pLimit } = require('../data/providers/yahoo');
    const tasks = symbols.map(sym => async () => {
      try {
        const evs = await yahooChartEvents(sym);
        return { sym, earningsDate: evs?.earningsDate || null };
      } catch (_) {
        return { sym, earningsDate: null };
      }
    });
    const results = (await pLimit(tasks, 5)) || [];

    // ── Filter to window + shape response ─────────────────────────────────
    // pLimit returns null for tasks that rejected (Promise.allSettled rejected
    // branch), so defend against that before dereferencing.
    const items = [];
    for (const r of results) {
      if (!r || !r.earningsDate) continue;
      const d = new Date(r.earningsDate + 'T00:00:00Z').getTime();
      if (isNaN(d) || d < todayMs || d > cutoffMs) continue;
      items.push({
        symbol:       r.sym,
        earningsDate: r.earningsDate,
        daysOut:      Math.round((d - todayMs) / 86400000),
        source:       sourceBySym.get(r.sym) || [],
        rsRank:       rsRankBySymbol.get(r.sym) ?? null,
        isHolding:    openSet.has(r.sym),
        isMegaCap:    megaSet.has(r.sym),
      });
    }

    // Date-primary sort: soonest reports at the top regardless of whether
    // they're holdings or not — tomorrow's print matters more than a holding
    // reporting two weeks out. Within the same date: holdings first (visual
    // flag for the user's book), then higher RS ranks.
    items.sort((a, b) => {
      if (a.daysOut !== b.daysOut) return a.daysOut - b.daysOut;
      if (a.isHolding !== b.isHolding) return a.isHolding ? -1 : 1;
      return (b.rsRank || 0) - (a.rsRank || 0);
    });

    // Coverage sanity check: how many symbols came back with ANY earningsDate
    // (not just ones inside the requested window)? If that rate is abnormally
    // low, Yahoo almost certainly hiccuped during fan-out and we'd otherwise
    // cache a thin response for 30 min. Skip the cacheSet in that case so the
    // next UI poll retries. Threshold: fewer than 25% of symbols returned ANY
    // date — legitimate coverage is usually 40-60% of the notable universe.
    const withDateCount = results.filter(r => r && r.earningsDate).length;
    const coverageOk    = symbols.length === 0 || (withDateCount / symbols.length) >= 0.25;

    const out = {
      days,
      notableOnly,
      asOf: new Date().toISOString(),
      universe: symbols.length,
      count: items.length,
      coverage: { withDate: withDateCount, total: symbols.length },
      // RS snapshot freshness — UI uses this to flag when the leader-set
      // contributing to the universe is stale (e.g. weekend, scan failed,
      // server hasn't run rs_scan_daily yet today). Compared against the
      // current US date in the UI; > 1 trading day old triggers a badge.
      rsSnapshotDate: latestRsDate,
      items,
    };
    if (coverageOk) cacheSet(cacheKey, out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Bulk live quotes (for tabs that need to overlay real-time prices) ──────
//
// GET /api/quotes?symbols=AAPL,MSFT,NVDA
//
// Thin wrapper over the provider manager. Use it from client-side tabs that
// render prices but don't want to kick a full rs-scan just to refresh them.
// Response shape is minimal on purpose — just what a UI needs to repaint a
// price cell. Cached 60s (TTL_QUOTE) via the provider cache, so polling at
// 30s from multiple tabs is still cheap.
router.get('/quotes', async (req, res) => {
  try {
    const raw = String(req.query.symbols || '').trim();
    if (!raw) return res.json({ quotes: [] });
    const symbols = raw.split(',').map(s => s.trim().toUpperCase())
      .filter(Boolean).slice(0, 100);   // hard cap, defensive
    if (!symbols.length) return res.json({ quotes: [] });

    const rows = await getQuotes(symbols);
    const quotes = (rows || []).map(q => ({
      symbol: q.symbol,
      price:  q.regularMarketPrice ?? null,
      chg1d:  q.regularMarketChangePercent ?? null,
      ma50:   q.fiftyDayAverage ?? null,
      ma200:  q.twoHundredDayAverage ?? null,
      w52h:   q.fiftyTwoWeekHigh ?? null,
      w52l:   q.fiftyTwoWeekLow ?? null,
    }));
    res.json({ quotes, asOf: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Stock Brief — context drawer payload ───────────────────────────────
//
// GET /api/stock/:symbol/brief
//
// Aggregates Yahoo quote, profile, recommendation trend, earnings track
// record, and headline news (with a local catalyst classifier) into a
// single payload. No paid AI keys; 6h cached on the server.
router.get('/stock/:symbol/brief', async (req, res) => {
  try {
    const sym = String(req.params.symbol || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'symbol required' });
    const { getStockBrief } = require('../signals/stock-brief');
    const brief = await getStockBrief(sym);
    res.json(brief);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Upcoming US economic events (next N days) ─────────────────────────
//
// GET /api/market/economic-events?days=14
//
// Static schedule + Fed-published FOMC dates. No paid API. Surfaces NFP,
// CPI, PCE, FOMC, ISM, Retail Sales, etc. so the user can avoid sizing
// into a known binary print or clip risk before a high-importance event.
router.get('/market/economic-events', (req, res) => {
  try {
    const days = Math.max(1, Math.min(60, parseInt(req.query.days) || 14));
    // ET-anchored today (see comment in /upcoming-earnings).
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const end = new Date(Date.parse(today + 'T00:00:00Z') + days * 86400_000)
      .toISOString().slice(0, 10);
    const { getUpcomingEvents } = require('../signals/economic-calendar');
    const events = getUpcomingEvents(today, end);
    res.json({ events, count: events.length, days, fromDate: today, toDate: end });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/market/breadth-proxy ───────────────────────────────────────────
// Broader-market breadth signals derived from index quotes Yahoo DOES
// expose. Our universe-based breadth (in /api/breadth/early-warning) only
// covers ~360 leadership names — heavily tech-skewed. This endpoint
// returns INDEX-level proxies that reflect the full NYSE/NASDAQ tape:
//
//   - RSP/SPY ratio   — equal-weight vs cap-weight S&P 500. When RSP
//                       outperforms, breadth is broad (smaller stocks
//                       participating); when SPY outperforms, market is
//                       narrow / mega-cap-driven (canary for top-heavy
//                       rallies that have rolled over historically).
//   - ^RUT change     — Russell 2000 small caps. Strong small caps
//                       typically signal risk-on / broad participation.
//   - ^NYA change     — NYSE Composite (~2000 stocks) — broader than
//                       S&P 500 by 4×.
//   - ^MID change     — S&P 400 mid caps.
//   - ^GSPC change    — S&P 500 cap-weighted (the benchmark).
//   - EQAL change     — Russell 1000 equal-weight, additional confirmation.
//
// All sourced from a single getQuotes batch — cheap, no new providers.
router.get('/market/breadth-proxy', async (req, res) => {
  try {
    const { getQuotes } = require('../data/providers/manager');
    const symbols = ['RSP', 'SPY', 'EQAL', '^RUT', '^MID', '^NYA', '^GSPC', 'IWM', 'QQQ'];
    const quotes = await getQuotes(symbols);
    const byMap = {};
    for (const q of quotes) byMap[q.symbol] = q;

    const pct = (s) => byMap[s]?.regularMarketChangePercent ?? null;
    const px  = (s) => byMap[s]?.regularMarketPrice ?? null;

    // RSP/SPY ratio of TODAY's % change — positive = breadth broader
    // than cap-weight (good); negative = narrower (warning).
    const rspSpyDelta = (pct('RSP') != null && pct('SPY') != null)
      ? +(pct('RSP') - pct('SPY')).toFixed(2) : null;
    const eqalSpyDelta = (pct('EQAL') != null && pct('SPY') != null)
      ? +(pct('EQAL') - pct('SPY')).toFixed(2) : null;
    // Small-vs-large 1d differential: ^RUT - ^GSPC. Positive = small caps
    // participating; negative = flight to mega-cap quality.
    const smallVsLarge = (pct('^RUT') != null && pct('^GSPC') != null)
      ? +(pct('^RUT') - pct('^GSPC')).toFixed(2) : null;

    // Composition: count how many of [RSP, ^RUT, ^MID, ^NYA, EQAL] are
    // positive on the day. 5/5 = textbook broad rally; 0-1/5 = narrow tape.
    const broadCheck = ['RSP','^RUT','^MID','^NYA','EQAL'];
    const broadAdvancing = broadCheck.filter(s => (pct(s) ?? 0) > 0).length;
    const broadCount = broadCheck.length;

    res.json({
      asOf: new Date().toISOString(),
      indices: {
        SPY:    { price: px('SPY'),    change_pct: pct('SPY') },
        QQQ:    { price: px('QQQ'),    change_pct: pct('QQQ') },
        IWM:    { price: px('IWM'),    change_pct: pct('IWM') },
        RSP:    { price: px('RSP'),    change_pct: pct('RSP'), label: 'S&P 500 Equal-Weight' },
        EQAL:   { price: px('EQAL'),   change_pct: pct('EQAL'), label: 'Russell 1000 Equal-Weight' },
        '^RUT': { price: px('^RUT'),   change_pct: pct('^RUT'), label: 'Russell 2000 (small caps)' },
        '^MID': { price: px('^MID'),   change_pct: pct('^MID'), label: 'S&P 400 (mid caps)' },
        '^NYA': { price: px('^NYA'),   change_pct: pct('^NYA'), label: 'NYSE Composite' },
        '^GSPC':{ price: px('^GSPC'),  change_pct: pct('^GSPC'), label: 'S&P 500 cap-weight' },
      },
      breadth_signals: {
        rsp_minus_spy_pct: rspSpyDelta,            // +ve = broad participation
        eqal_minus_spy_pct: eqalSpyDelta,          // +ve = broad participation
        small_minus_large_pct: smallVsLarge,       // +ve = small cap risk-on
        broad_advancing: broadAdvancing,           // 0-5 of broad indices up
        broad_count: broadCount,
      },
      caveat: 'Index-level proxies, not raw NYSE A/D ticker. For NYSE A/D feed, configure POLYGON_API_KEY (paid).',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
