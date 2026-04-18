// ─── Edge Telemetry — Calibration Analytics ──────────────────────────────────
// Reads resolved rows from signal_outcomes and answers the questions the
// trader actually cares about:
//   1. Is the LLM's stated confidence calibrated? (Brier score, reliability curve)
//   2. Which strategies / sources are actually making money?    (Sharpe, expectancy, profit factor)
//   3. Has a strategy's edge decayed recently?                  (rolling hit rate vs baseline)
//
// All functions are pure readers — no writes. Intended to be called from
// route handlers and ad-hoc analysis. Heavy aggregation stays in SQL; fancy
// statistics happen in JS over already-filtered rows.

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Core helpers ───────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stdev(arr, m) {
  if (arr.length < 2) return 0;
  const avg = m ?? mean(arr);
  let s = 0;
  for (const v of arr) s += (v - avg) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * sortedAsc.length)));
  return sortedAsc[idx];
}

// Load resolved signals with optional filters.
function loadResolved({ since, source, strategy, symbol } = {}) {
  const where = ["status = 'resolved'"];
  const params = [];
  if (since)    { where.push('emission_date >= ?'); params.push(since); }
  if (source)   { where.push('source = ?');         params.push(source); }
  if (strategy) { where.push('strategy = ?');       params.push(strategy); }
  if (symbol)   { where.push('symbol = ?');         params.push(String(symbol).toUpperCase()); }
  return db().prepare(
    `SELECT * FROM signal_outcomes WHERE ${where.join(' AND ')} ORDER BY emission_date ASC, id ASC`
  ).all(...params);
}

// ─── Brier score + calibration curve ───────────────────────────────────────
//
// Binary outcome: `isWin` = outcome_label == 'winner'.
// Prob: confidence_prob (0..1) from edge-telemetry.CONFIDENCE_PROB mapping.
// Brier = mean((prob - outcome)^2) — lower is better. 0.25 = random.
//
// Rows without confidence_prob are excluded (can't score what wasn't predicted).

function brierScore(rows) {
  const scored = rows.filter(r => r.confidence_prob != null && r.outcome_label != null);
  if (scored.length === 0) return { score: null, sampleSize: 0 };
  let s = 0;
  for (const r of scored) {
    const outcome = r.outcome_label === 'winner' ? 1 : 0;
    s += (r.confidence_prob - outcome) ** 2;
  }
  return { score: s / scored.length, sampleSize: scored.length };
}

// Reliability curve: bucket by stated confidence tier, compute realized hit rate.
// Output is per-tier so miscalibration is obvious at a glance:
//   { high: { predicted: 0.75, realized: 0.52, n: 40 }, medium: {...}, low: {...} }
function calibrationByConfidenceTier(rows) {
  const out = {};
  for (const tier of ['high', 'medium', 'low']) {
    const bucket = rows.filter(r => r.confidence === tier && r.outcome_label != null);
    if (bucket.length === 0) {
      out[tier] = { predicted: null, realized: null, n: 0, brier: null };
      continue;
    }
    const predicted = bucket[0].confidence_prob; // all rows in bucket share the same prior
    const winners = bucket.filter(r => r.outcome_label === 'winner').length;
    const realized = winners / bucket.length;
    let s = 0;
    for (const r of bucket) {
      const o = r.outcome_label === 'winner' ? 1 : 0;
      s += (r.confidence_prob - o) ** 2;
    }
    out[tier] = {
      predicted,
      realized,
      n: bucket.length,
      winners,
      losers: bucket.filter(r => r.outcome_label === 'loser').length,
      brier: s / bucket.length,
      gap: predicted != null ? +(predicted - realized).toFixed(3) : null,
    };
  }
  return out;
}

// ─── Strategy / source metrics ──────────────────────────────────────────────
//
// For a set of rows (already filtered), produces:
//   n, hitRate, avgRet20 (mean 20d return), medianRet20, expectancy,
//   profitFactor, sharpe (annualized from 20d returns), avgMFE, avgMAE,
//   stopHitRate, targetHitRate, avgR (R-multiple).
//
// annualized sharpe: treats each signal's ret_20d as a non-overlapping period
// return and scales by sqrt(252/20) ≈ 3.55. This over-counts when signals
// overlap in time — fine for directional comparison between strategies, not
// a substitute for portfolio-level Sharpe from alpha-tracker.

function metricsOverRows(rows) {
  const resolved = rows.filter(r => r.outcome_label != null && r.ret_20d != null);
  const n = resolved.length;
  if (n === 0) {
    return {
      n: 0, hitRate: null, avgRet20: null, medianRet20: null,
      expectancy: null, profitFactor: null, sharpe: null,
      avgMFE: null, avgMAE: null, stopHitRate: null,
      targetHitRate: null, avgR: null,
    };
  }

  const rets = resolved.map(r => r.ret_20d);
  const winners = resolved.filter(r => r.outcome_label === 'winner');
  const losers = resolved.filter(r => r.outcome_label === 'loser');

  const hitRate = winners.length / n;
  const avgRet20 = mean(rets);
  const sortedRets = [...rets].sort((a, b) => a - b);
  const medianRet20 = percentile(sortedRets, 0.5);
  const sd = stdev(rets, avgRet20);
  const sharpe = sd > 0 ? (avgRet20 / sd) * Math.sqrt(252 / 20) : null;

  // Expectancy = avg(winner_ret) * hitRate + avg(loser_ret) * (1 - hitRate)
  // Guards against empty winners/losers buckets.
  const wRets = winners.map(r => r.ret_20d);
  const lRets = losers.map(r => r.ret_20d);
  const neutralRets = resolved.filter(r => r.outcome_label === 'neutral').map(r => r.ret_20d);

  const avgWin = wRets.length ? mean(wRets) : 0;
  const avgLoss = lRets.length ? mean(lRets) : 0;
  // Expectancy uses n-weighted mean of all buckets so neutrals aren't dropped
  const expectancy = (avgWin * winners.length
                    + avgLoss * losers.length
                    + (neutralRets.length ? mean(neutralRets) : 0) * neutralRets.length) / n;

  // Profit factor = sum(gains) / |sum(losses)|. Gains and losses taken from
  // the ret_20d distribution directly (not bucketed) so neutrals contribute.
  let gains = 0, lossAbs = 0;
  for (const r of rets) {
    if (r > 0) gains += r;
    else if (r < 0) lossAbs += -r;
  }
  const profitFactor = lossAbs > 0 ? gains / lossAbs : (gains > 0 ? Infinity : null);

  const mfes = resolved.map(r => r.max_favorable).filter(v => v != null);
  const maes = resolved.map(r => r.max_adverse).filter(v => v != null);
  const rs = resolved.map(r => r.realized_r).filter(v => v != null);

  return {
    n,
    hitRate,
    winners: winners.length,
    losers: losers.length,
    neutrals: resolved.length - winners.length - losers.length,
    avgRet20,
    medianRet20,
    expectancy,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
    sharpe,
    avgMFE: mfes.length ? mean(mfes) : null,
    avgMAE: maes.length ? mean(maes) : null,
    stopHitRate: resolved.filter(r => r.hit_stop).length / n,
    targetHitRate: resolved.filter(r => r.hit_target1).length / n,
    avgR: rs.length ? mean(rs) : null,
  };
}

// Build a per-strategy + per-source table. Empty buckets are omitted.
function strategyMetrics({ since, source } = {}) {
  const rows = loadResolved({ since, source });
  const byStrategy = groupBy(rows, r => r.strategy || 'unknown');
  const out = {};
  for (const [key, subset] of Object.entries(byStrategy)) {
    out[key] = metricsOverRows(subset);
  }
  return out;
}

function sourceMetrics({ since } = {}) {
  const rows = loadResolved({ since });
  const bySource = groupBy(rows, r => r.source);
  const out = {};
  for (const [key, subset] of Object.entries(bySource)) {
    out[key] = metricsOverRows(subset);
  }
  return out;
}

function groupBy(arr, keyFn) {
  const out = {};
  for (const r of arr) {
    const k = keyFn(r);
    (out[k] ||= []).push(r);
  }
  return out;
}

// ─── Degradation detection ─────────────────────────────────────────────────
//
// For each strategy: compare rolling-N hit rate vs long-term baseline.
// Output a multiplier clamped to [minMult, maxMult]:
//   multiplier = clamp(rollingHitRate / baselineHitRate, minMult, maxMult)
// if baseline < minSample the strategy is "unproven" — multiplier = null.
//
// This is the number the position sizer would consult in a future pass
// (Layer 3) to throttle degraded strategies. For Layer 1 we just compute and
// expose; no automatic behavior change.

const DEFAULT_ROLLING = 50;
const DEFAULT_MIN_SAMPLE = 30;

function degradationMultipliers({
  rolling = DEFAULT_ROLLING,
  minSample = DEFAULT_MIN_SAMPLE,
  minMult = 0.25,
  maxMult = 1.25,
  since,
} = {}) {
  const rows = loadResolved({ since });
  const byStrategy = groupBy(rows, r => r.strategy || 'unknown');
  const out = {};

  for (const [strategy, subset] of Object.entries(byStrategy)) {
    // Keep chronological order so "last N" is meaningful
    subset.sort((a, b) => a.id - b.id);

    const resolved = subset.filter(r => r.outcome_label != null);
    if (resolved.length < minSample) {
      out[strategy] = {
        status: 'unproven',
        sampleSize: resolved.length,
        required: minSample,
        multiplier: null,
        note: `Need ${minSample - resolved.length} more resolved signals before scoring`,
      };
      continue;
    }

    const baseline = resolved.filter(r => r.outcome_label === 'winner').length / resolved.length;
    const recent = resolved.slice(-rolling);
    const recentHitRate = recent.filter(r => r.outcome_label === 'winner').length / recent.length;

    const rawMult = baseline > 0 ? recentHitRate / baseline : 1;
    const multiplier = Math.max(minMult, Math.min(maxMult, rawMult));

    let status = 'stable';
    if (multiplier < 0.75) status = 'degraded';
    else if (multiplier > 1.10) status = 'hot';

    out[strategy] = {
      status,
      sampleSize: resolved.length,
      rollingWindow: recent.length,
      baselineHitRate: baseline,
      recentHitRate,
      multiplier,
      rawMultiplier: rawMult,
    };
  }

  return out;
}

// ─── Top-level report ──────────────────────────────────────────────────────
//
// One call, one object. Used by the route handler to hydrate the telemetry
// dashboard in a single round trip.

function fullReport({ since, source, rolling = DEFAULT_ROLLING } = {}) {
  const rows = loadResolved({ since, source });
  return {
    generatedAt: new Date().toISOString(),
    filters: { since: since || null, source: source || null, rolling },
    overall: metricsOverRows(rows),
    calibration: {
      brier: brierScore(rows),
      byTier: calibrationByConfidenceTier(rows),
    },
    byStrategy: strategyMetrics({ since, source }),
    bySource: sourceMetrics({ since }),
    degradation: degradationMultipliers({ rolling, since }),
    sampleSize: rows.length,
  };
}

module.exports = {
  loadResolved,
  metricsOverRows,
  brierScore,
  calibrationByConfidenceTier,
  strategyMetrics,
  sourceMetrics,
  degradationMultipliers,
  fullReport,
  // internals exposed for tests
  mean, stdev, percentile, groupBy,
};
