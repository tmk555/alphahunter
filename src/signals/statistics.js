// ─── Statistical Significance Layer (Phase 2.7) ────────────────────────────
//
// Closes one of the biggest foot-guns in the audit: "backtest shows 47% CAGR
// with a 2.3 Sharpe" — but if the sample is 12 trades over 3 months, that's
// indistinguishable from a lucky streak. This module adds the formal tests
// the dashboard needs to label a result "statistically significant" vs
// "insufficient sample" vs "noise":
//
//   1. sharpeTStat  — Lo (2002) correction: t = SR * sqrt(N)
//                     (accurate under i.i.d. returns; we keep it simple and
//                      do NOT attempt the Andrews-Monahan autocorrelation
//                      adjustment — that's a Phase 3 call).
//   2. sharpePValue — one-sided p-value via a normal approximation for the
//                     t-statistic. For N ≥ 30 (our gate) the t distribution
//                     is close enough to normal that the error is < 1%.
//   3. calmarRatio  — annualized return / max drawdown. A Sharpe-free way
//                     to compare strategies that have wildly different
//                     return distributions (fat tails wreck Sharpe, but
//                     Calmar still captures the "pain-adjusted" return).
//   4. bootstrapCI  — non-parametric confidence interval on ANY statistic
//                     of the trade returns. We use it to put an honest
//                     95% band around the mean return-per-trade, the
//                     win-rate, and the Sharpe — so a "23% win-rate" result
//                     comes with "(95% CI: 14%–34%)" not just a point est.
//   5. assessSignificance — one-call aggregator that packages all of the
//                     above plus sample-size gates into a single object
//                     the dashboard can just stringify.
//
// Design notes:
// - All inputs are plain arrays of numbers. No DB access. Pure math = trivial
//   to unit test and trivial to call from the replay engine, edge validator,
//   walk-forward runner, or any future consumer.
// - Returns can be either per-trade percent returns (e.g. 3.2 for +3.2%) or
//   daily equity-curve returns (e.g. 0.0045 for +0.45%). The functions take
//   a `periodsPerYear` param so the caller can annualize correctly. Default
//   to 252 (daily). For per-trade stats, callers should pass the average
//   trade frequency (trades/year) instead — typical swing setup ≈ 50–80.
// - No dependencies. Written to run in plain Node with just the math stdlib.

const TRADING_DAYS_PER_YEAR = 252;

// Minimum sample size below which we refuse to declare significance. 30 is
// the classical central-limit threshold and is ALSO the rough minimum where
// the Sharpe ratio's distribution is close to normal (Lo 2002 Fig 1). Below
// this, the "t-stat" is almost meaningless and we flag INSUFFICIENT_SAMPLE.
const MIN_TRADES_FOR_SIGNIFICANCE = 30;

// ─── Basic utilities ───────────────────────────────────────────────────────

function mean(xs) {
  if (!xs || xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stddev(xs, { ddof = 1 } = {}) {
  // Sample std by default (ddof=1). Pass ddof=0 for population std.
  if (!xs || xs.length <= ddof) return 0;
  const mu = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - mu) * (x - mu);
  return Math.sqrt(ss / (xs.length - ddof));
}

// ─── Sharpe ratio & significance ───────────────────────────────────────────

/**
 * Annualized Sharpe ratio.
 *
 * @param {number[]} returns       Array of period returns (e.g. daily decimal
 *                                 or per-trade decimal).
 * @param {number}   periodsPerYear  How many of these periods fit in a year.
 *                                 252 for daily, ~50 for typical swing trades.
 * @param {number}   riskFreeRate Annual risk-free rate as decimal. We subtract
 *                                 (rfr / periodsPerYear) from each return
 *                                 before computing μ, σ. Default 0 to match
 *                                 most retail backtests.
 * @returns {number} Annualized Sharpe. Returns 0 on empty/zero-variance input
 *                   instead of NaN/Infinity — safer for dashboard numerics.
 */
function sharpeRatio(returns, periodsPerYear = TRADING_DAYS_PER_YEAR, riskFreeRate = 0) {
  if (!returns || returns.length < 2) return 0;
  const rfPerPeriod = riskFreeRate / periodsPerYear;
  const excess = returns.map(r => r - rfPerPeriod);
  const mu = mean(excess);
  const sigma = stddev(excess, { ddof: 1 });
  if (sigma === 0) return 0;
  return (mu / sigma) * Math.sqrt(periodsPerYear);
}

/**
 * Sharpe ratio t-statistic — Lo (2002).
 *
 * The null hypothesis is "true Sharpe = 0" (no edge). Under i.i.d. returns
 * the estimator SR_hat has stderr ≈ 1/sqrt(N) when annualized appropriately,
 * so the z-statistic is SR_annual × sqrt(N / periodsPerYear) = SR_period × sqrt(N).
 *
 * We always return the simple form t = SR_annual * sqrt(years), i.e. the
 * t-statistic of the ANNUALIZED Sharpe on the effective number of years of
 * observations. This is what most practitioners report and matches the
 * "Bailey & Lopez de Prado 2014" convention.
 *
 * @param {number[]} returns
 * @param {number}   periodsPerYear
 * @returns {number} t-stat. |t| > 2 is roughly p < 0.05; > 2.6 is p < 0.01.
 */
function sharpeTStat(returns, periodsPerYear = TRADING_DAYS_PER_YEAR) {
  if (!returns || returns.length < 2) return 0;
  const sr = sharpeRatio(returns, periodsPerYear);
  const years = returns.length / periodsPerYear;
  if (years <= 0) return 0;
  return sr * Math.sqrt(years);
}

/**
 * One-sided p-value for a Sharpe t-stat, using a normal approximation.
 *
 * We deliberately use the standard normal (not Student's t) because:
 *   (a) at N ≥ 30 the difference is < 1% and the extra complexity buys
 *       no practical accuracy;
 *   (b) it avoids shipping a Student-t CDF implementation, which is
 *       surprisingly fiddly to get right without a numeric library.
 *
 * One-sided because we're testing "is Sharpe > 0", not "is Sharpe ≠ 0" —
 * nobody cares about a strategy with a statistically-significantly
 * negative Sharpe in the "what's my edge" direction.
 *
 * @param {number} tStat
 * @returns {number} p-value in [0, 1]. A tStat of 1.96 → p ≈ 0.025.
 */
function sharpePValue(tStat) {
  if (Number.isNaN(tStat)) return 1;            // safe default on garbage input
  if (tStat === Infinity)  return 0;            // infinite positive edge → p=0
  if (tStat === -Infinity) return 1;            // infinite negative edge → p=1
  // 1 - Φ(t) via the Abramowitz-Stegun 7.1.26 approximation for erf.
  // Max absolute error ~1.5e-7 — more than enough for a significance flag.
  const z = tStat / Math.SQRT2;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  const cdf = 0.5 * (1 + sign * erf); // Φ(tStat)
  return 1 - cdf;
}

// ─── Drawdown + Calmar ────────────────────────────────────────────────────

/**
 * Max drawdown from an equity curve.
 *
 * @param {Array<{equity:number}>|number[]} curve Either an array of points
 *        with an `equity` field (matches replay.js) or a raw number array.
 * @returns {number} Max drawdown as a positive decimal (0.17 = 17%). Zero
 *                   on empty/monotone-up curves, never negative.
 */
function maxDrawdown(curve) {
  if (!curve || curve.length === 0) return 0;
  const getEq = typeof curve[0] === 'number'
    ? (p) => p
    : (p) => p.equity;

  let peak = getEq(curve[0]);
  let maxDd = 0;
  for (const p of curve) {
    const eq = getEq(p);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/**
 * Calmar ratio = CAGR / |max drawdown|.
 *
 * We compute CAGR from start/end equity and the covered period in days.
 * Using decimals throughout (0.17 not 17) so callers don't have to guess.
 * On zero drawdown we return Infinity when the return was positive, 0 when
 * it was negative — a Calmar of Infinity on a no-drawdown winner is
 * technically correct and dashboards know to display it as "∞".
 *
 * @param {number} totalReturnPct   Total return over the period, as a
 *                                  PERCENT (17.3 not 0.173). Matches the
 *                                  replay engine's output convention.
 * @param {number} maxDrawdownPct   Max drawdown over the period, as a
 *                                  PERCENT (23.1 not 0.231).
 * @param {number} days             Calendar days covered by the backtest.
 */
function calmarRatio(totalReturnPct, maxDrawdownPct, days) {
  if (!days || days <= 0) return 0;
  // Convert to decimal, annualize, divide by drawdown.
  const totalReturn = totalReturnPct / 100;
  const maxDd = Math.abs(maxDrawdownPct) / 100;
  const years = days / 365.25;
  if (years <= 0) return 0;
  // CAGR: (1 + R)^(1/years) - 1. Guard against 1+R <= 0 (wipeout).
  const base = 1 + totalReturn;
  const cagr = base > 0 ? Math.pow(base, 1 / years) - 1 : -1;
  if (maxDd === 0) return cagr > 0 ? Infinity : 0;
  return cagr / maxDd;
}

// ─── Bootstrap confidence intervals ────────────────────────────────────────

// Seeded PRNG so tests (and CI) are reproducible. mulberry32 — 1 line, full
// period, passes PractRand smoke tests; good enough for resampling-flavoured
// randomness.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Non-parametric bootstrap confidence interval.
 *
 * Resamples the input array WITH replacement `iterations` times, computes
 * `statFn` on each resample, and returns the [lower, upper] percentiles
 * that bracket the chosen confidence level.
 *
 * @param {number[]}  xs          The sample — any numeric array.
 * @param {Function}  statFn      Statistic to compute, e.g. `mean` or a
 *                                 closure over `sharpeRatio`. Called as
 *                                 `statFn(resample)`.
 * @param {Object}    [options]
 * @param {number}    [options.iterations=1000]  How many bootstrap draws.
 * @param {number}    [options.confidence=0.95]  Confidence level in (0,1).
 * @param {number}    [options.seed=42]          PRNG seed for reproducibility.
 * @returns {{lower:number, upper:number, mean:number, iterations:number}}
 */
function bootstrapCI(xs, statFn, {
  iterations = 1000,
  confidence = 0.95,
  seed = 42,
} = {}) {
  if (!xs || xs.length === 0) {
    return { lower: 0, upper: 0, mean: 0, iterations: 0 };
  }
  const rng = mulberry32(seed);
  const stats = new Array(iterations);
  const n = xs.length;
  for (let it = 0; it < iterations; it++) {
    const resample = new Array(n);
    for (let i = 0; i < n; i++) {
      resample[i] = xs[Math.floor(rng() * n)];
    }
    stats[it] = statFn(resample);
  }
  stats.sort((a, b) => a - b);
  const alpha = 1 - confidence;
  const loIdx = Math.max(0, Math.floor(iterations * (alpha / 2)));
  const hiIdx = Math.min(iterations - 1, Math.floor(iterations * (1 - alpha / 2)));
  return {
    lower: stats[loIdx],
    upper: stats[hiIdx],
    mean: mean(stats),
    iterations,
  };
}

// ─── Aggregated significance report ────────────────────────────────────────

/**
 * Combined significance assessment for a backtest trade sequence.
 *
 * This is the main entry point the replay engine and edge-validator call.
 * It bundles every check the dashboard wants to show next to a backtest
 * result, plus a single `verdict` string the UI can gate on:
 *
 *   - 'insufficient_sample' — N < MIN_TRADES_FOR_SIGNIFICANCE
 *   - 'not_significant'     — p-value ≥ 0.05
 *   - 'significant'         — p-value < 0.05
 *   - 'highly_significant'  — p-value < 0.01
 *
 * @param {number[]} tradeReturns  Per-trade percent returns (e.g. [3.2, -1.4, 5.1]).
 * @param {Object}   [options]
 * @param {number}   [options.tradesPerYear=50]  Used to annualize Sharpe
 *                                                from per-trade returns.
 *                                                50 ≈ typical swing turnover.
 * @param {number}   [options.totalReturnPct]    For Calmar. If omitted we
 *                                                recover it from the trade
 *                                                returns (compounded).
 * @param {number}   [options.maxDrawdownPct]    For Calmar. Required if you
 *                                                want a Calmar (we cannot
 *                                                infer MDD from per-trade
 *                                                returns alone).
 * @param {number}   [options.days]              Calendar span of the backtest.
 * @param {number}   [options.bootstrapIters=1000] 0 to skip the bootstrap
 *                                                  (fast path for tight loops).
 * @returns {Object}  A fully decorated report — see inline shape below.
 */
function assessSignificance(tradeReturns, {
  tradesPerYear = 50,
  totalReturnPct,
  maxDrawdownPct,
  days,
  bootstrapIters = 1000,
  confidence = 0.95,
} = {}) {
  const n = tradeReturns?.length || 0;

  // Convert percent returns (3.2) → decimal (0.032) once so ALL downstream
  // math uses decimals. The Sharpe ratio is unit-agnostic but the bootstrap
  // CI reports would silently be in % if we didn't normalize.
  const decimalReturns = (tradeReturns || []).map(r => r / 100);

  // Sharpe + t-stat (annualized to the caller's trades-per-year convention).
  const sharpe = sharpeRatio(decimalReturns, tradesPerYear);
  const tStat = sharpeTStat(decimalReturns, tradesPerYear);
  const pValue = sharpePValue(tStat);

  // Calmar — only if caller gave us the inputs we need.
  const calmar = (totalReturnPct != null && maxDrawdownPct != null && days)
    ? calmarRatio(totalReturnPct, maxDrawdownPct, days)
    : null;

  // Bootstrap 95% CI on per-trade mean return. Cheap — ~1ms for N=100, it=1000.
  let bootstrapMeanReturn = null;
  let bootstrapWinRate = null;
  if (n > 0 && bootstrapIters > 0) {
    bootstrapMeanReturn = bootstrapCI(
      tradeReturns, mean,
      { iterations: bootstrapIters, confidence, seed: 42 },
    );
    bootstrapWinRate = bootstrapCI(
      tradeReturns, (xs) => xs.filter(r => r > 0).length / xs.length * 100,
      { iterations: bootstrapIters, confidence, seed: 43 },
    );
  }

  // Verdict — the single flag the dashboard will use.
  let verdict;
  if (n < MIN_TRADES_FOR_SIGNIFICANCE) {
    verdict = 'insufficient_sample';
  } else if (pValue < 0.01) {
    verdict = 'highly_significant';
  } else if (pValue < 0.05) {
    verdict = 'significant';
  } else {
    verdict = 'not_significant';
  }

  const reason =
    verdict === 'insufficient_sample'
      ? `Need ≥${MIN_TRADES_FOR_SIGNIFICANCE} trades for a meaningful t-test (have ${n})`
      : verdict === 'not_significant'
        ? `Sharpe t-stat=${tStat.toFixed(2)}, p=${pValue.toFixed(3)} — cannot reject "no edge" at 5%`
        : verdict === 'significant'
          ? `Sharpe t-stat=${tStat.toFixed(2)}, p=${pValue.toFixed(3)} — edge is real at 5%`
          : `Sharpe t-stat=${tStat.toFixed(2)}, p=${pValue.toFixed(4)} — edge is rock-solid at 1%`;

  return {
    sampleSize: n,
    minSampleForSignificance: MIN_TRADES_FOR_SIGNIFICANCE,
    sharpeRatio: +sharpe.toFixed(3),
    tStat: +tStat.toFixed(3),
    pValue: +pValue.toFixed(4),
    calmarRatio: calmar == null ? null : (Number.isFinite(calmar) ? +calmar.toFixed(3) : calmar),
    bootstrapMeanReturn,  // {lower, upper, mean, iterations} in PERCENT units
    bootstrapWinRate,     // {lower, upper, mean, iterations} in PERCENT units
    confidenceLevel: confidence,
    verdict,              // 'insufficient_sample' | 'not_significant' | 'significant' | 'highly_significant'
    isSignificant: verdict === 'significant' || verdict === 'highly_significant',
    reason,
  };
}

module.exports = {
  // utilities
  mean,
  stddev,
  maxDrawdown,
  // core stats
  sharpeRatio,
  sharpeTStat,
  sharpePValue,
  calmarRatio,
  bootstrapCI,
  // high-level aggregator
  assessSignificance,
  // constants
  MIN_TRADES_FOR_SIGNIFICANCE,
  TRADING_DAYS_PER_YEAR,
};
