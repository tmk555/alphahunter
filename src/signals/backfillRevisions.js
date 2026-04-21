// ─── Historical revision_scores Backfill ─────────────────────────────────────
// Yahoo's earningsTrend endpoint exposes an `epsTrend` series with 5 anchor
// points per period: current, 7daysAgo, 30daysAgo, 60daysAgo, 90daysAgo. For
// a single one-shot fetch we can therefore reconstruct 5 synthetic estimate
// snapshots per (symbol, quarter-of-year, quarter-of-next-year) and score 4
// consecutive transitions against each other — a real, honest backfill (not
// seeded dummy rows) of revision_scores going back ~90 days.
//
// This is not the same as having 90 days of *actual* fetch history — Yahoo's
// epsTrend is what analysts currently believe their prior-period estimate
// was. In practice it tracks the consensus evolution closely enough for the
// replay engine and conviction backfill to use it.

const { getDB } = require('../data/database');
const { pLimit } = require('../data/providers/manager');
const { getYahooCrumb, resetAuth } = require('../data/providers/yahoo');
const { scoreRevisions } = require('./earningsRevisions');

const fetch = require('node-fetch');

function db() { return getDB(); }

function rawVal(field) {
  if (field == null) return null;
  if (typeof field === 'object' && 'raw' in field) return field.raw;
  if (typeof field === 'number') return field;
  return null;
}

// Offsets in trading/calendar days. We store snapshots on calendar days
// because analyst estimates are calendar-paced (Yahoo labels them in days).
const OFFSETS = [
  { key: 'current',   days: 0 },
  { key: '7daysAgo',  days: 7 },
  { key: '30daysAgo', days: 30 },
  { key: '60daysAgo', days: 60 },
  { key: '90daysAgo', days: 90 },
];

function dateMinusDays(baseIso, days) {
  const d = new Date(baseIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

function quarterFor(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}Q${q}`;
}

// Pulls earningsTrend for one symbol and returns the 5-anchor history for
// both current-year (0y) and next-year (+1y) EPS estimates. Revenue isn't
// exposed in the trend series, so rev fields are null — revChg will be
// excluded from the scoring weight, not zeroed.
async function fetchTrendForSymbol(symbol) {
  const { crumb, cookie } = await getYahooCrumb();
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=earningsTrend&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      'Cookie': cookie,
      'Accept': 'application/json',
    },
  });
  if (r.status === 401 || r.status === 403) {
    resetAuth();
    throw new Error(`Yahoo auth expired (${r.status})`);
  }
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);

  const data = await r.json();
  const trend = data?.quoteSummary?.result?.[0]?.earningsTrend?.trend || [];
  const cy = trend.find(t => t.period === '0y');
  const ny = trend.find(t => t.period === '+1y');
  const cq = trend.find(t => t.period === '0q');

  const cyTrend = cy?.epsTrend || {};
  const nyTrend = ny?.epsTrend || {};
  const cqTrend = cq?.epsTrend || {};

  // Build 5 snapshots per OFFSET using rawVal. If a field is missing for
  // a given offset, leave it null — scoreRevisions tolerates nulls.
  return OFFSETS.map(o => ({
    offset: o,
    epsCurrentYear: rawVal(cyTrend[o.key]),
    epsNextYear:    rawVal(nyTrend[o.key]),
    epsCurrentQtr:  rawVal(cqTrend[o.key]),
    // Yahoo doesn't give us historical growth rates or revenue trend in this
    // endpoint. scoreRevisions will fall back to the pctChange-based accel
    // calc and skip revChg entirely.
    epsGrowthCurrentYear: null,
    revCurrentYear: null,
  }));
}

async function runRevisionsBackfill({
  symbols,
  concurrency = 3,
  onProgress = null,
} = {}) {
  if (!symbols || !symbols.length) throw new Error('symbols[] required');
  const t0 = Date.now();
  const errors = [];

  if (onProgress) onProgress({ stage: 'fetch', current: 0, total: symbols.length, message: `Fetching earningsTrend for ${symbols.length} symbols` });

  const today = new Date().toISOString().split('T')[0];
  let fetched = 0, estimateRowsWritten = 0, scoreRowsWritten = 0, withScores = 0;

  const insertEstimate = db().prepare(`
    INSERT OR REPLACE INTO earnings_estimates (
      symbol, quarter, eps_current_qtr, eps_current_year, eps_next_year,
      eps_growth_current_year, rev_current_year, fetched_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertScore = db().prepare(`
    INSERT OR REPLACE INTO revision_scores (
      symbol, date, revision_score, direction, tier,
      eps_current_yr_chg, eps_next_yr_chg, rev_chg, acceleration
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  await pLimit(symbols.map(sym => async () => {
    try {
      const series = await fetchTrendForSymbol(sym);
      if (!series || !series.length) { errors.push({ symbol: sym, error: 'no trend' }); return; }

      // Persist all 5 synthetic snapshots and score each consecutive pair
      // (90→60, 60→30, 30→7, 7→current). Snapshots are stored with fetched_at
      // = today - Ndays so future .loadPriorRevisions calls land the right row.
      const snapshots = series.map(s => ({
        ...s,
        date: dateMinusDays(today, s.offset.days),
      }));

      // Reverse so oldest is first (90daysAgo → current) for chronological scoring
      snapshots.reverse();

      const txn = db().transaction(() => {
        for (const s of snapshots) {
          const q = quarterFor(s.date);
          insertEstimate.run(
            sym, q, s.epsCurrentQtr, s.epsCurrentYear, s.epsNextYear,
            s.epsGrowthCurrentYear, s.revCurrentYear, s.date + 'T00:00:00Z',
          );
          estimateRowsWritten++;
        }

        // Score consecutive pairs
        for (let i = 1; i < snapshots.length; i++) {
          const prior   = snapshots[i - 1];
          const current = snapshots[i];
          if (current.epsCurrentYear == null || prior.epsCurrentYear == null) continue;

          const score = scoreRevisions(
            { epsCurrentYear: current.epsCurrentYear, epsNextYear: current.epsNextYear, epsCurrentQtr: current.epsCurrentQtr, revCurrentYear: null, epsGrowthCurrentYear: null },
            { epsCurrentYear: prior.epsCurrentYear,   epsNextYear: prior.epsNextYear,   epsCurrentQtr: prior.epsCurrentQtr,   revCurrentYear: null, epsGrowthCurrentYear: null },
          );
          if (!score) continue;

          insertScore.run(
            sym, current.date, score.revisionScore, score.direction, score.tier,
            score.epsCurrentYrChg, score.epsNextYrChg, score.revChg, score.acceleration,
          );
          scoreRowsWritten++;
          withScores++;
        }
      });
      txn();

      fetched++;
      if (onProgress && fetched % 10 === 0) {
        onProgress({ stage: 'fetch', current: fetched, total: symbols.length, message: `Fetched ${fetched}/${symbols.length}, ${scoreRowsWritten} scores` });
      }
      // Gentle rate-limit so Yahoo doesn't 429. Concurrency is already capped.
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      errors.push({ symbol: sym, error: e.message });
    }
  }), concurrency);

  return {
    symbolsRequested: symbols.length,
    symbolsFetched: fetched,
    estimateRowsWritten,
    scoreRowsWritten,
    withScores,
    durationMs: Date.now() - t0,
    errors: errors.slice(0, 50),
    errorCount: errors.length,
  };
}

module.exports = { runRevisionsBackfill };
