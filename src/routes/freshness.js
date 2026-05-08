// ─── /api/freshness route ────────────────────────────────────────────────
// Single source of truth for "how stale is the data on this page?"
//
// Replaces a scattering of per-tab status strings ("244/1598 CS6",
// "fundamentals refreshing", "revision data unavailable", "as of pit_membership")
// with one banner the UI can render at the top of the dashboard.
//
// Each section reports BOTH a count/coverage metric AND a recency timestamp,
// so the user can tell "we have a lot of data but it's stale" apart from
// "data's fresh but coverage is partial".

const express = require('express');
const router = express.Router();
const { getDB } = require('../data/database');

// minutes since timestamp string (UTC ISO or sqlite datetime)
function ageMinutes(ts) {
  if (!ts) return null;
  const t = Date.parse(ts.replace(' ', 'T') + (ts.includes('T') ? '' : 'Z'));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

// Return one of: 'fresh' | 'recent' | 'stale' | 'missing'
// Thresholds tuned per data type — RS scan should be daily, fundamentals
// hourly-ish during refresh window, revisions/macro daily.
function bucket(ageMin, freshMin, staleMin) {
  if (ageMin == null) return 'missing';
  if (ageMin <= freshMin) return 'fresh';
  if (ageMin <= staleMin) return 'recent';
  return 'stale';
}

router.get('/freshness', (req, res) => {
  try {
    const db = getDB();

    // ── Universe size (denominator for coverage %) ──────────────────────
    const universeCount = db.prepare('SELECT COUNT(*) as n FROM universe_mgmt').get().n;

    // ── RS snapshot: most recent scan date + how many symbols it covered ─
    // We use rs_snapshots.created_at when available (per-row write time)
    // and fall back to MAX(date) for the cohort. The scanner re-runs the
    // whole universe in one shot, so cohort recency = scan recency.
    const rsRow = db.prepare(`
      SELECT MAX(date) as last_date, COUNT(*) as n
        FROM rs_snapshots
       WHERE type='stock' AND date = (SELECT MAX(date) FROM rs_snapshots WHERE type='stock')
    `).get();
    // Treat the latest scan's `date` as a market close — convert to a
    // reasonable timestamp for age calc.
    const rsAgeMin = rsRow?.last_date ? ageMinutes(rsRow.last_date + 'T20:00:00Z') : null;

    // ── Fundamentals coverage: how many symbols have a snapshot in the
    //    last 7 days, and when was the most recent write? ────────────────
    const fundsRow = db.prepare(`
      SELECT COUNT(*) as covered, MAX(fetched_at) as last_fetch
        FROM fundamentals_snapshot
       WHERE fetched_at >= datetime('now', '-7 days')
    `).get();

    // ── Revisions: count symbols with a recent revision_scores row +
    //    when the latest scan finished. ────────────────────────────────────
    const revRow = db.prepare(`
      SELECT COUNT(DISTINCT symbol) as n, MAX(date) as last_date
        FROM revision_scores
       WHERE date >= date('now', '-7 days')
    `).get();

    // ── Macro / breadth ────────────────────────────────────────────────
    const macroRow = db.prepare(`
      SELECT MAX(date) as last_date FROM macro_snapshots
    `).get();
    const breadthRow = db.prepare(`
      SELECT MAX(date) as last_date FROM breadth_snapshots
    `).get();

    // ── Open positions count (handy as a quick pulse) ─────────────────
    const openTradesCount = db.prepare(`
      SELECT COUNT(*) as n FROM trades WHERE exit_date IS NULL
    `).get().n;

    res.json({
      universeCount,
      rsScan: {
        lastDate: rsRow?.last_date || null,
        covered:  rsRow?.n || 0,
        ageMin:   rsAgeMin,
        status:   bucket(rsAgeMin, 24*60, 3*24*60),  // fresh<24hr, stale>3d
      },
      fundamentals: {
        lastFetch: fundsRow?.last_fetch || null,
        covered:   fundsRow?.covered || 0,
        total:     universeCount,
        coveragePct: universeCount ? +((fundsRow?.covered || 0) / universeCount * 100).toFixed(0) : 0,
        ageMin:    ageMinutes(fundsRow?.last_fetch),
        status:    bucket(ageMinutes(fundsRow?.last_fetch), 60, 12*60),
      },
      revisions: {
        lastDate:  revRow?.last_date || null,
        covered:   revRow?.n || 0,
        ageMin:    revRow?.last_date ? ageMinutes(revRow.last_date + 'T17:00:00Z') : null,
        status:    bucket(revRow?.last_date ? ageMinutes(revRow.last_date + 'T17:00:00Z') : null, 24*60, 3*24*60),
      },
      macro: {
        lastDate:  macroRow?.last_date || null,
        ageMin:    macroRow?.last_date ? ageMinutes(macroRow.last_date + 'T20:00:00Z') : null,
        status:    bucket(macroRow?.last_date ? ageMinutes(macroRow.last_date + 'T20:00:00Z') : null, 24*60, 3*24*60),
      },
      breadth: {
        lastDate:  breadthRow?.last_date || null,
        ageMin:    breadthRow?.last_date ? ageMinutes(breadthRow.last_date + 'T20:00:00Z') : null,
        status:    bucket(breadthRow?.last_date ? ageMinutes(breadthRow.last_date + 'T20:00:00Z') : null, 24*60, 3*24*60),
      },
      openTrades: openTradesCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/market/pulse — index pulse banner data ─────────────────────────
//
// Persistent header strip data: SPY / QQQ / IWM 1d + 1m % change, vs50MA,
// breadth (% above 50MA / % above 200MA), regime, VIX. One endpoint so
// the UI doesn't have to fan out 4-5 calls on every page load.
//
// Cached in-process for 60s — the underlying data updates ~1-5 min on
// market hours and once daily off-hours. No need to hit Yahoo each time
// the user clicks a tab.

const { getHistory } = require('../data/providers/manager');

let _pulseCache = { data: null, ts: 0 };
const PULSE_TTL_MS = 60_000;

router.get('/market/pulse', async (req, res) => {
  try {
    if (_pulseCache.data && (Date.now() - _pulseCache.ts) < PULSE_TTL_MS) {
      return res.json({ ..._pulseCache.data, fromCache: true, ageSec: Math.round((Date.now() - _pulseCache.ts) / 1000) });
    }

    const { getQuotes } = require('../data/providers/manager');
    const symbols = ['SPY', 'QQQ', 'IWM', '^VIX'];
    const [quotes, histResults] = await Promise.all([
      getQuotes(symbols),
      Promise.all(['SPY', 'QQQ', 'IWM'].map(s => getHistory(s).catch(() => null))),
    ]);

    const indices = ['SPY', 'QQQ', 'IWM'].map((sym, i) => {
      const q    = (quotes || []).find(x => x.symbol === sym) || {};
      const hist = histResults[i];
      // 4-week return = today vs ~20 trading days ago.
      let chg1m = null;
      if (Array.isArray(hist) && hist.length >= 21) {
        const today    = hist[hist.length - 1];
        const t4wAgo   = hist[hist.length - 21];
        if (today != null && t4wAgo != null && t4wAgo !== 0) {
          chg1m = +(((today - t4wAgo) / t4wAgo) * 100).toFixed(2);
        }
      }
      const price = q.regularMarketPrice ?? null;
      const ma50  = q.fiftyDayAverage ?? null;
      const ma200 = q.twoHundredDayAverage ?? null;
      return {
        symbol:  sym,
        price,
        chg1d:   q.regularMarketChangePercent ?? null,
        chg1m,                                                // ≈ "vs4w"
        vsMA50:  (price != null && ma50  != null && ma50  !== 0) ? +(((price - ma50)  / ma50)  * 100).toFixed(2) : null,
        vsMA200: (price != null && ma200 != null && ma200 !== 0) ? +(((price - ma200) / ma200) * 100).toFixed(2) : null,
      };
    });

    const vixQuote = (quotes || []).find(x => x.symbol === '^VIX') || {};
    const vix = {
      price:   vixQuote.regularMarketPrice ?? null,
      chg1d:   vixQuote.regularMarketChangePercent ?? null,
    };

    // Breadth from the daily breadth_snapshots table.
    const db = getDB();
    const breadthRow = db.prepare(`
      SELECT date, pct_above_50ma, pct_above_200ma, new_highs, new_lows,
             ad_ratio, regime, composite_score
        FROM breadth_snapshots
       ORDER BY date DESC LIMIT 1
    `).get();
    const breadth = breadthRow ? {
      date:           breadthRow.date,
      pctAbove50ma:   breadthRow.pct_above_50ma,
      pctAbove200ma:  breadthRow.pct_above_200ma,
      newHighs:       breadthRow.new_highs,
      newLows:        breadthRow.new_lows,
      adRatio:        breadthRow.ad_ratio,
      regime:         breadthRow.regime,
      compositeScore: breadthRow.composite_score,
    } : null;

    const out = {
      asOf:    new Date().toISOString(),
      indices,
      vix,
      breadth,
    };
    _pulseCache = { data: out, ts: Date.now() };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
