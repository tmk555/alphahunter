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

module.exports = router;
