// ─── Market Breadth Internals Engine ─────────────────────────────────────────
// Breadth indicators that LEAD price by days/weeks.
// Computed from the scanned stock universe (~100-200 stocks).
//
// Phase 3.13: Advance/Decline now uses REAL daily price changes
// (close > prior close = advancing) instead of swing_momentum proxies.
// McClellan oscillator = EMA(19) - EMA(39) of the daily A/D difference,
// matching the real McClellan methodology (just on our universe, not NYSE).
//
// Indicators:
//   1. % of universe above 50MA / 200MA (participation breadth)
//   2. New 52-week highs vs lows (momentum breadth)
//   3. Advance/Decline — REAL daily price change (close vs prior close)
//   4. Up volume / down volume ratio (money flow)
//   5. VIX term structure (contango = calm, backwardation = stress)
//   6. Credit spread proxy via TLT/HYG ratio (risk appetite)
//   7. McClellan oscillator — EMA(19) - EMA(39) of daily A/D net

const { getDB } = require('../data/database');
const { cacheGet, cacheSet } = require('../data/cache');

function db() { return getDB(); }

const TTL_BREADTH = 5 * 60 * 1000; // 5 min cache

// ─── Compute breadth from RS snapshot data ──────────────────────────────────
// Uses stored rs_snapshots to calculate breadth without additional API calls.
// This gives us historical breadth for backtesting AND current breadth for live.

function computeBreadthFromSnapshots(date, opts = {}) {
  const snapshots = db().prepare(`
    SELECT symbol, price, vs_ma50, vs_ma200, rs_rank, swing_momentum, stage,
           volume_ratio, rs_line_new_high, vcp_forming,
           dist_from_high, dist_from_low
    FROM rs_snapshots
    WHERE date = ? AND type = 'stock' AND price > 0
  `).all(date);

  if (snapshots.length < 20) return null;

  const total = snapshots.length;

  // ── Data-quality gate ─────────────────────────────────────────────────
  // The breadth job (4:50 PM weekdays) runs 20 min after rs_scan_daily
  // (4:30 PM). When rs_scan is slow OR a manual /api/rs-scan call earlier
  // wrote partial rows (rs_rank only — see store.js:saveHistory), most
  // stocks have NULL rs_line_new_high and NULL stage. The filters below
  // (`s.rs_line_new_high` truthy, `s.stage === 4`) silently treat NULL as
  // 0, so newHighs / newLows / stage% all collapse to garbage zeros.
  //
  // Once persisted, the c308835 idempotency guard locks the bad row in
  // place forever. User saw H/L ratio stuck at 0/20 across 4 days
  // (04-20 → 04-24) because of exactly this — the rows show new_highs=0
  // even though current rs_snapshots for those dates has 11-20 stocks
  // with rs_line_new_high=1.
  //
  // Gate: refuse to compute if >20% of rows are missing the rich fields
  // that breadth math needs. We check `stage` and `vs_ma50` because those
  // are stored as actual NULL when the row was inserted via the partial
  // /api/rs-scan path (saveHistory in store.js writes only rs_rank).
  //
  // We do NOT check rs_line_new_high — scanner.js coerces missing values
  // via `r.rsLineNewHigh ? 1 : 0` so the field is stored as 0 not NULL,
  // which makes it useless as a partial-data signal. `stage` and `vs_ma50`
  // use `r.stage ?? null` and `r.vsMA50 ?? null` and DO reach NULL when
  // the row was a partial write — that's our reliable indicator.
  //
  // Caller can opt out via { ignoreDataQualityGate: true } for backfill
  // scripts that intentionally process partial historical data.
  const completeStage = snapshots.filter(s => s.stage !== null && s.stage !== undefined).length;
  const completeMa50  = snapshots.filter(s => s.vs_ma50 !== null && s.vs_ma50 !== undefined).length;
  const minComplete = Math.min(completeStage, completeMa50);
  const completenessPct = +(minComplete / total * 100).toFixed(1);
  if (!opts.ignoreDataQualityGate && completenessPct < 80) {
    return {
      error: 'data-quality-gate',
      reason: `rs_snapshots for ${date} is only ${completenessPct}% complete (stage+vs_ma50). Likely cause: rs_scan_daily hasn't filled rich fields yet, or a partial /api/rs-scan call left only rs_rank populated. Refusing to compute breadth against partial data — would silently produce H/L ratio = 0 and lock it in via idempotency.`,
      date,
      total,
      completenessPct,
    };
  }

  // 1. % above 50MA / 200MA
  const above50 = snapshots.filter(s => s.vs_ma50 > 0).length;
  const above200 = snapshots.filter(s => s.vs_ma200 > 0).length;
  const pctAbove50 = +(above50 / total * 100).toFixed(1);
  const pctAbove200 = +(above200 / total * 100).toFixed(1);

  // 2. New highs / new lows — true 52-week price-extreme count (NYSE-style)
  //
  // Pre-fix: counted s.rs_line_new_high (RS line outperformance vs SPY) for
  // newHighs and "stage 4 + RS<=20" for newLows — neither matched what the
  // user expects from "new highs/new lows" breadth (the daily NYSE/NASDAQ
  // figure published as advance-decline data). Result: GOOGL at $385 with
  // its 52w high at $385.83 was invisible to the count, breadth_snapshots
  // showed 0 new highs every day for weeks while the actual market had
  // plenty of leaders printing fresh highs.
  //
  // Now: dist_from_high < 0.005 (within 0.5% of 52w high) → new high.
  // 0.5% threshold absorbs the day's wiggle so a stock that touched the
  // high intraday and pulled back 30bps still counts. Mirror for new lows.
  // Legacy fallback: rows that pre-date the dist_from_high column have
  // dist_from_high == null and won't be counted — that's correct (we
  // can't classify without the data).
  const NEAR_EXTREME = 0.005;
  const newHighs = snapshots.filter(s =>
    s.dist_from_high != null && s.dist_from_high <= NEAR_EXTREME
  ).length;
  const newLows = snapshots.filter(s =>
    s.dist_from_low != null && s.dist_from_low <= NEAR_EXTREME
  ).length;
  const hlDiff = newHighs - newLows;
  const hlRatio = newLows > 0 ? +(newHighs / newLows).toFixed(2) : (newHighs > 0 ? 99 : 1);

  // 3. Advance/Decline — REAL daily price change (Phase 3.13)
  //    Advancing = close > prior snapshot close. Declining = close < prior close.
  //    This replaces the swing_momentum proxy which was a fabricated signal.
  //    Falls back to swing_momentum only when prior snapshot is unavailable.
  const priorDate = db().prepare(
    `SELECT MAX(date) as date FROM rs_snapshots WHERE date < ? AND type = 'stock'`
  ).get(date)?.date;

  let advancing, declining, neutral;
  if (priorDate) {
    // Build price map for prior date
    const priorPrices = {};
    const priorRows = db().prepare(
      `SELECT symbol, price FROM rs_snapshots WHERE date = ? AND type = 'stock' AND price > 0`
    ).all(priorDate);
    for (const r of priorRows) priorPrices[r.symbol] = r.price;

    advancing = 0; declining = 0; neutral = 0;
    for (const s of snapshots) {
      const prior = priorPrices[s.symbol];
      if (prior && prior > 0) {
        if (s.price > prior) advancing++;
        else if (s.price < prior) declining++;
        else neutral++;
      } else {
        // No prior price — classify by swing_momentum as last resort
        if (s.swing_momentum >= 55) advancing++;
        else if (s.swing_momentum <= 45) declining++;
        else neutral++;
      }
    }
  } else {
    // No prior date available — fall back to swing_momentum (first scan date only)
    advancing = snapshots.filter(s => s.swing_momentum >= 55).length;
    declining = snapshots.filter(s => s.swing_momentum <= 45).length;
    neutral = total - advancing - declining;
  }
  const adRatio = declining > 0 ? +(advancing / declining).toFixed(2) : (advancing > 0 ? 99 : 1);

  // 4. Volume thrust proxy (% of stocks with above-average volume in uptrend)
  const volThrust = snapshots.filter(s =>
    s.volume_ratio > 1.2 && s.vs_ma50 > 0
  ).length;
  const volThrustPct = +(volThrust / total * 100).toFixed(1);

  // 5. Stage distribution (health of the market)
  const stages = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const s of snapshots) {
    if (s.stage >= 1 && s.stage <= 4) stages[s.stage]++;
  }
  const stagePcts = {};
  for (const [k, v] of Object.entries(stages)) {
    stagePcts[`stage${k}Pct`] = +(v / total * 100).toFixed(1);
  }

  // 6. RS distribution (concentration of strength)
  const rs80plus = snapshots.filter(s => s.rs_rank >= 80).length;
  const rs20minus = snapshots.filter(s => s.rs_rank <= 20).length;
  const rsBreadth = +(rs80plus / total * 100).toFixed(1);
  const rsWeakness = +(rs20minus / total * 100).toFixed(1);

  return {
    date,
    stockCount: total,
    pctAbove50MA: pctAbove50,
    pctAbove200MA: pctAbove200,
    newHighs,
    newLows,
    hlDiff,
    hlRatio,
    advancing,
    declining,
    neutral,
    adRatio,
    volThrustPct,
    ...stagePcts,
    rsBreadthPct: rsBreadth,
    rsWeaknessPct: rsWeakness,
  };
}

// ─── McClellan Breadth Oscillator ───────────────────────────────────────────
// Real McClellan methodology: EMA(19) - EMA(39) of daily (advancing - declining).
// Phase 3.13: A/D now uses actual price changes (close > prior close), not
// swing_momentum proxies. Computed over the scanned universe (~100-200 stocks),
// not the full NYSE (~3000). The math is correct McClellan; the universe is
// narrower than institutional-grade but representative of the liquid names
// this system actually trades.

function computeMcClellanOscillator(days = 60) {
  const dates = db().prepare(`
    SELECT DISTINCT date FROM rs_snapshots WHERE type = 'stock'
    ORDER BY date DESC LIMIT ?
  `).all(days).map(r => r.date).reverse();

  if (dates.length < 40) return null;

  // Compute daily A/D ratio for each date
  const adData = [];
  for (const date of dates) {
    const breadth = computeBreadthFromSnapshots(date);
    if (breadth) {
      adData.push({
        date,
        adDiff: breadth.advancing - breadth.declining,
        adRatio: breadth.adRatio,
      });
    }
  }

  if (adData.length < 40) return null;

  // Compute EMAs
  const ema19 = computeEMA(adData.map(d => d.adDiff), 19);
  const ema39 = computeEMA(adData.map(d => d.adDiff), 39);

  const oscillator = [];
  for (let i = 0; i < adData.length; i++) {
    if (ema19[i] != null && ema39[i] != null) {
      oscillator.push({
        date: adData[i].date,
        value: +(ema19[i] - ema39[i]).toFixed(2),
        ema19: +ema19[i].toFixed(2),
        ema39: +ema39[i].toFixed(2),
        adDiff: adData[i].adDiff,
      });
    }
  }

  // McClellan Summation Index (cumulative oscillator)
  let summation = 0;
  const summationSeries = oscillator.map(o => {
    summation += o.value;
    return { date: o.date, summation: +summation.toFixed(2), oscillator: o.value };
  });

  const latest = oscillator[oscillator.length - 1];
  const prev = oscillator[oscillator.length - 2];
  const currentSummation = summationSeries[summationSeries.length - 1]?.summation || 0;

  // Percentile rank against the last ~252 trading days (1y) of persisted history.
  // Classical +500/+3000 Summation benchmarks don't apply here — this is a 60-day
  // window on a ~350-stock universe, so the natural range is much tighter.
  // Rank lets the UI caption the raw number against the system's own history.
  const pct = computePercentileFromHistory(currentSummation, 'summation_index', 252);
  const oscPct = computePercentileFromHistory(latest?.value || 0, 'mcclellan_osc', 252);

  return {
    current: latest?.value || 0,
    previous: prev?.value || 0,
    trend: latest && prev ? (latest.value > prev.value ? 'improving' : 'deteriorating') : 'unknown',
    summationIndex: currentSummation,
    summationPct: pct,              // e.g. 65 → "65th percentile over last ~1y"
    oscillatorPct: oscPct,
    series: oscillator.slice(-30), // last 30 days
    summationSeries: summationSeries.slice(-30),
  };
}

// Percentile rank of `value` against the last N trading days in breadth_snapshots.
// Returns null when there's not enough history to be meaningful (< ~20 samples).
function computePercentileFromHistory(value, column, lookback) {
  try {
    const rows = db().prepare(
      `SELECT ${column} AS v FROM breadth_snapshots WHERE ${column} IS NOT NULL ORDER BY date DESC LIMIT ?`
    ).all(lookback);
    if (!rows || rows.length < 20) return null;
    const below = rows.filter(r => r.v < value).length;
    return Math.round((below / rows.length) * 100);
  } catch (_) { return null; }
}

function computeEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = new Array(data.length).fill(null);

  // SMA seed for first period
  if (data.length < period) return ema;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  ema[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// ─── VIX Term Structure ─────────────────────────────────────────────────────
// Contango (VIX < VIX futures) = calm, mean-reverting vol
// Backwardation (VIX > VIX futures) = stress, panic hedging
// We approximate using VIX vs VIXM (mid-term VIX ETF) or VIX vs 20-day SMA

function assessVIXTermStructure(vixPrice, vixHistory) {
  if (!vixPrice || !vixHistory || vixHistory.length < 21) {
    return { structure: 'unknown', signal: 'neutral' };
  }

  // VIX 20-day SMA as proxy for "expected" VIX level
  const sma20 = vixHistory.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ratio = vixPrice / sma20;

  // Historical VIX percentile (where is current VIX vs last year)
  const sorted = [...vixHistory].sort((a, b) => a - b);
  const rank = sorted.findIndex(v => v >= vixPrice);
  const percentile = +((rank / sorted.length) * 100).toFixed(0);

  let structure, signal;
  if (ratio < 0.85) {
    structure = 'deep_contango';
    signal = 'very_calm';
  } else if (ratio < 0.95) {
    structure = 'contango';
    signal = 'calm';
  } else if (ratio <= 1.05) {
    structure = 'flat';
    signal = 'neutral';
  } else if (ratio <= 1.20) {
    structure = 'backwardation';
    signal = 'stress';
  } else {
    structure = 'deep_backwardation';
    signal = 'panic';
  }

  return {
    structure,
    signal,
    vixCurrent: +vixPrice.toFixed(2),
    vix20SMA: +sma20.toFixed(2),
    ratio: +ratio.toFixed(3),
    percentile,
    interpretation: signal === 'panic'
      ? 'VIX spiking above recent norms — hedge or reduce exposure'
      : signal === 'stress'
        ? 'VIX elevated — tighten stops, reduce new entries'
        : signal === 'very_calm'
          ? 'VIX compressed — complacency risk, tail hedges are cheap'
          : 'VIX within normal range',
  };
}

// ─── Credit Spread Proxy ────────────────────────────────────────────────────
// TLT (treasuries) vs HYG (high yield) ratio tracks risk appetite.
// Rising ratio = flight to safety (bearish equities)
// Falling ratio = risk appetite (bullish equities)
// More predictive than VIX for sustained moves.

function assessCreditSpread(tltPrice, hygPrice, tltHistory, hygHistory) {
  if (!tltPrice || !hygPrice) {
    return { signal: 'unknown', spread: null };
  }

  const currentRatio = tltPrice / hygPrice;

  // Calculate 20-day trend if history available
  let trend = 'unknown', ratioChange = 0;
  if (tltHistory?.length >= 20 && hygHistory?.length >= 20) {
    const prev20Ratio = tltHistory[tltHistory.length - 20] / hygHistory[hygHistory.length - 20];
    ratioChange = ((currentRatio / prev20Ratio) - 1) * 100;
    if (ratioChange > 2) trend = 'widening';       // flight to safety
    else if (ratioChange < -2) trend = 'tightening'; // risk-on
    else trend = 'stable';
  }

  let signal;
  if (trend === 'widening') signal = 'risk_off';
  else if (trend === 'tightening') signal = 'risk_on';
  else signal = 'neutral';

  return {
    signal,
    tltHygRatio: +currentRatio.toFixed(4),
    ratioChange20d: +ratioChange.toFixed(2),
    trend,
    interpretation: signal === 'risk_off'
      ? 'Credit spreads widening — institutional risk reduction in progress'
      : signal === 'risk_on'
        ? 'Credit spreads tightening — risk appetite healthy'
        : 'Credit environment stable',
  };
}

// ─── Composite Breadth Regime Score ─────────────────────────────────────────
// Combines all breadth indicators into a single 0-100 score.
// 80-100 = strong breadth (add exposure)
// 60-80  = healthy (maintain)
// 40-60  = mixed (tighten stops)
// 20-40  = deteriorating (reduce exposure)
// 0-20   = broken (defensive)

function computeCompositeBreadthScore(breadthData, vixStructure, creditSpread) {
  if (!breadthData) {
    // Fall back to last known breadth snapshot — reconstruct components from stored fields
    const last = db().prepare(
      'SELECT * FROM breadth_snapshots WHERE composite_score IS NOT NULL ORDER BY date DESC LIMIT 1'
    ).get();
    if (last) {
      const score = last.composite_score;
      let regime = last.regime, sizeMultiplier, color;
      if (score >= 80) { regime = regime || 'STRONG BREADTH'; sizeMultiplier = 1.0; color = '#00e676'; }
      else if (score >= 60) { regime = regime || 'HEALTHY'; sizeMultiplier = 0.85; color = '#8bc34a'; }
      else if (score >= 40) { regime = regime || 'MIXED'; sizeMultiplier = 0.60; color = '#f0a500'; }
      else if (score >= 20) { regime = regime || 'DETERIORATING'; sizeMultiplier = 0.30; color = '#ff8c00'; }
      else { regime = regime || 'BROKEN'; sizeMultiplier = 0.0; color = '#ff3d57'; }

      // Reconstruct component breakdown from stored snapshot fields
      const components = [];
      if (last.pct_above_50ma != null) {
        const v = last.pct_above_50ma;
        const s = Math.min(25, Math.max(0, v > 70 ? 25 : v > 50 ? 15 + (v-50)*0.5 : v > 30 ? 5 + (v-30)*0.5 : v*0.17));
        components.push({ name: '% Above 50MA', value: v, score: +s.toFixed(1), weight: 25 });
      }
      if (last.pct_above_200ma != null) {
        const v = last.pct_above_200ma;
        const s = Math.min(15, Math.max(0, v > 65 ? 15 : v > 45 ? 8 + (v-45)*0.35 : v*0.18));
        components.push({ name: '% Above 200MA', value: v, score: +s.toFixed(1), weight: 15 });
      }
      if (last.new_highs != null && last.new_lows != null) {
        // Match the live-recompute branch above: use 5-day rolling average
        // to keep this row consistent with the Market Pulse warning panel,
        // which also reads breadth_snapshots history. Falls back to
        // single-day when fewer than 2 rows exist.
        let ratio;
        let labelSuffix = '';
        try {
          const recent = db().prepare(`
            SELECT new_highs, new_lows FROM breadth_snapshots
            ORDER BY date DESC LIMIT 5
          `).all();
          if (recent.length >= 2) {
            const avgH = recent.reduce((s, r) => s + (r.new_highs || 0), 0) / recent.length;
            const avgL = recent.reduce((s, r) => s + (r.new_lows  || 0), 0) / recent.length;
            ratio = avgL > 0 ? +(avgH / avgL).toFixed(2) : (avgH > 0 ? 10 : 1);
            labelSuffix = recent.length >= 5 ? ' (5d avg)' : ` (${recent.length}d avg)`;
          } else {
            ratio = last.new_lows > 0 ? last.new_highs / last.new_lows : (last.new_highs > 0 ? 10 : 1);
          }
        } catch (_) {
          ratio = last.new_lows > 0 ? last.new_highs / last.new_lows : (last.new_highs > 0 ? 10 : 1);
        }
        const s = Math.min(20, Math.max(0, ratio >= 3 ? 20 : ratio >= 1.5 ? 12 + (ratio-1.5)*5.3 : ratio >= 0.5 ? (ratio-0.5)*12 : 0));
        components.push({ name: 'Highs/Lows Ratio' + labelSuffix, value: +ratio.toFixed(2), score: +s.toFixed(1), weight: 20 });
      }
      if (last.ad_ratio != null) {
        const v = last.ad_ratio;
        const s = Math.min(15, Math.max(0, v >= 2.0 ? 15 : v >= 1.0 ? 8 + (v-1.0)*7 : v*8));
        components.push({ name: 'A/D Ratio', value: v, score: +s.toFixed(1), weight: 15 });
      }
      components.push({ name: 'VIX Structure', value: 'cached', score: 8, weight: 15 });
      components.push({ name: 'Credit Spread', value: 'cached', score: 5, weight: 10 });

      return { score, regime, sizeMultiplier, color, components, detail: 'From cached breadth snapshot' };
    }
    return { score: 50, regime: 'UNKNOWN', components: [], detail: 'No breadth data' };
  }

  let score = 0;
  const components = [];

  // 1. % above 50MA (25% weight) — most important leading indicator
  // 70%+ = healthy, 50-70% = ok, 30-50% = weakening, <30% = broken
  const ma50Score = Math.min(25, Math.max(0,
    breadthData.pctAbove50MA > 70 ? 25 :
    breadthData.pctAbove50MA > 50 ? 15 + (breadthData.pctAbove50MA - 50) * 0.5 :
    breadthData.pctAbove50MA > 30 ? 5 + (breadthData.pctAbove50MA - 30) * 0.5 :
    breadthData.pctAbove50MA * 0.17
  ));
  score += ma50Score;
  components.push({ name: '% Above 50MA', value: breadthData.pctAbove50MA, score: +ma50Score.toFixed(1), weight: 25 });

  // 2. % above 200MA (15% weight) — slower but more structural
  const ma200Score = Math.min(15, Math.max(0,
    breadthData.pctAbove200MA > 65 ? 15 :
    breadthData.pctAbove200MA > 45 ? 8 + (breadthData.pctAbove200MA - 45) * 0.35 :
    breadthData.pctAbove200MA * 0.18
  ));
  score += ma200Score;
  components.push({ name: '% Above 200MA', value: breadthData.pctAbove200MA, score: +ma200Score.toFixed(1), weight: 15 });

  // 3. New highs vs lows (20% weight) — momentum breadth.
  // Use the 5-day rolling average to match what evaluateBreadthWarning
  // surfaces on the Market Pulse panel. Single-day H/L is too noisy and
  // produced confusing inconsistencies — Market Pulse showed 0.28 (5-day
  // avg) while Analytics showed 0.1 (today only) under the same label.
  // The rolling avg falls back to single-day when fewer than 5 prior
  // breadth_snapshots rows exist.
  let hlForScoring = breadthData.hlRatio;
  let hlLabelSuffix = '';
  try {
    const recent = db().prepare(`
      SELECT new_highs, new_lows FROM breadth_snapshots
      ORDER BY date DESC LIMIT 5
    `).all();
    if (recent.length >= 2) {
      const avgH = recent.reduce((s, r) => s + (r.new_highs || 0), 0) / recent.length;
      const avgL = recent.reduce((s, r) => s + (r.new_lows  || 0), 0) / recent.length;
      hlForScoring = avgL > 0 ? +(avgH / avgL).toFixed(2) : (avgH > 0 ? 99 : 1);
      hlLabelSuffix = recent.length >= 5 ? ' (5d avg)' : ` (${recent.length}d avg)`;
    }
  } catch (_) { /* table missing or recompute path — fall back to single-day */ }
  const hlScore = Math.min(20, Math.max(0,
    hlForScoring >= 3 ? 20 :
    hlForScoring >= 1.5 ? 12 + (hlForScoring - 1.5) * 5.3 :
    hlForScoring >= 0.5 ? (hlForScoring - 0.5) * 12 :
    0
  ));
  score += hlScore;
  components.push({ name: 'Highs/Lows Ratio' + hlLabelSuffix, value: hlForScoring, score: +hlScore.toFixed(1), weight: 20 });

  // 4. A/D ratio (15% weight)
  const adScore = Math.min(15, Math.max(0,
    breadthData.adRatio >= 2.0 ? 15 :
    breadthData.adRatio >= 1.0 ? 8 + (breadthData.adRatio - 1.0) * 7 :
    breadthData.adRatio * 8
  ));
  score += adScore;
  components.push({ name: 'A/D Ratio', value: breadthData.adRatio, score: +adScore.toFixed(1), weight: 15 });

  // 5. VIX structure (15% weight)
  if (vixStructure) {
    const vixMap = { very_calm: 13, calm: 15, neutral: 10, stress: 3, panic: 0 };
    const vixScore = vixMap[vixStructure.signal] ?? 8;
    score += vixScore;
    components.push({ name: 'VIX Structure', value: vixStructure.signal, score: vixScore, weight: 15 });
  } else {
    score += 8; // neutral default
    components.push({ name: 'VIX Structure', value: 'unknown', score: 8, weight: 15 });
  }

  // 6. Credit spread (10% weight)
  if (creditSpread) {
    const creditMap = { risk_on: 10, neutral: 6, risk_off: 1, unknown: 5 };
    const creditScore = creditMap[creditSpread.signal] ?? 5;
    score += creditScore;
    components.push({ name: 'Credit Spread', value: creditSpread.signal, score: creditScore, weight: 10 });
  } else {
    score += 5;
    components.push({ name: 'Credit Spread', value: 'unknown', score: 5, weight: 10 });
  }

  score = Math.min(100, Math.max(0, Math.round(score)));

  // Map score to regime
  let regime, sizeMultiplier, color;
  if (score >= 80) {
    regime = 'STRONG BREADTH'; sizeMultiplier = 1.0; color = '#00e676';
  } else if (score >= 60) {
    regime = 'HEALTHY'; sizeMultiplier = 0.85; color = '#8bc34a';
  } else if (score >= 40) {
    regime = 'MIXED'; sizeMultiplier = 0.60; color = '#f0a500';
  } else if (score >= 20) {
    regime = 'DETERIORATING'; sizeMultiplier = 0.30; color = '#ff8c00';
  } else {
    regime = 'BROKEN'; sizeMultiplier = 0.0; color = '#ff3d57';
  }

  return {
    score,
    regime,
    sizeMultiplier,
    color,
    components,
    interpretation: buildInterpretation(score, components, breadthData),
  };
}

function buildInterpretation(score, components, breadthData) {
  const warnings = [];
  const strengths = [];

  if (breadthData.pctAbove50MA < 40) warnings.push(`Only ${breadthData.pctAbove50MA}% above 50MA — weak participation`);
  if (breadthData.pctAbove50MA > 70) strengths.push(`${breadthData.pctAbove50MA}% above 50MA — broad participation`);

  if (breadthData.hlRatio < 0.5) warnings.push('New lows > 2x new highs — market is breaking down');
  if (breadthData.hlRatio > 3) strengths.push('New highs dominating — strong momentum breadth');

  if (breadthData.adRatio < 0.7) warnings.push('Declining stocks outnumber advancing 1.4:1');
  if (breadthData.stage4Pct > 25) warnings.push(`${breadthData.stage4Pct}% in Stage 4 — broad weakness`);
  if (breadthData.stage2Pct > 50) strengths.push(`${breadthData.stage2Pct}% in Stage 2 — healthy uptrend`);

  return { warnings, strengths };
}

// ─── Breadth Divergence Detection ───────────────────────────────────────────
// Most powerful breadth signal: price makes new high but breadth doesn't confirm.
// This leads corrections by 2-8 weeks historically.

function detectBreadthDivergence(days = 60) {
  const dates = db().prepare(`
    SELECT DISTINCT date FROM rs_snapshots WHERE type = 'stock'
    ORDER BY date DESC LIMIT ?
  `).all(days).map(r => r.date).reverse();

  if (dates.length < 20) return { divergence: false, message: 'Insufficient data' };

  // Get SPY prices and breadth for each date
  // SPY may be stored as type='sector' OR type='stock' — try both
  const series = [];
  for (const date of dates) {
    let spy = db().prepare(
      `SELECT price FROM rs_snapshots WHERE date = ? AND symbol = 'SPY' AND type = 'sector'`
    ).get(date);
    if (!spy?.price) {
      spy = db().prepare(
        `SELECT price FROM rs_snapshots WHERE date = ? AND symbol = 'SPY' AND type = 'stock'`
      ).get(date);
    }

    // Try live computation first, fall back to cached breadth_snapshots (populated by backfill)
    let breadth = computeBreadthFromSnapshots(date);
    if (!breadth) {
      const cached = db().prepare(
        `SELECT pct_above_50ma, new_highs, new_lows FROM breadth_snapshots WHERE date = ?`
      ).get(date);
      if (cached) {
        breadth = {
          pctAbove50MA: cached.pct_above_50ma,
          hlDiff: (cached.new_highs || 0) - (cached.new_lows || 0),
        };
      }
    }

    if (spy?.price && breadth) {
      series.push({ date, spyPrice: spy.price, pctAbove50: breadth.pctAbove50MA, hlDiff: breadth.hlDiff });
    }
  }

  if (series.length < 20) return { divergence: false, message: 'Insufficient breadth history' };

  // Check last 20 days: is SPY near highs but breadth declining?
  const recent = series.slice(-20);
  const spyHigh = Math.max(...recent.map(s => s.spyPrice));
  const spyNow = recent[recent.length - 1].spyPrice;
  const spyNearHigh = spyNow / spyHigh > 0.98;

  // Breadth trend: compare last 5 days avg vs prior 15 days avg
  const breadthRecent = recent.slice(-5).reduce((s, d) => s + d.pctAbove50, 0) / 5;
  const breadthPrior = recent.slice(0, 15).reduce((s, d) => s + d.pctAbove50, 0) / 15;

  const divergence = spyNearHigh && breadthRecent < breadthPrior - 5;

  return {
    divergence,
    type: divergence ? 'bearish' : 'none',
    spyNearHigh,
    spyVsHigh: +((spyNow / spyHigh) * 100).toFixed(2),
    breadthRecent: +breadthRecent.toFixed(1),
    breadthPrior: +breadthPrior.toFixed(1),
    breadthDelta: +(breadthRecent - breadthPrior).toFixed(1),
    message: divergence
      ? `BEARISH DIVERGENCE: SPY within 2% of highs but breadth dropped ${Math.abs(breadthRecent - breadthPrior).toFixed(1)} pts — corrections typically follow in 2-8 weeks`
      : spyNearHigh
        ? 'SPY near highs with breadth confirming — no divergence'
        : 'SPY not near highs — divergence check not applicable',
    series: series.slice(-20),
  };
}

// ─── Historical Breadth Snapshots ───────────────────────────────────────────
// Store breadth data for backtesting the breadth regime model itself.

function saveBreadthSnapshot(date, data, opts = {}) {
  // Idempotency on `date` + composite_score:
  // Skip the write when a non-null composite already exists for this date,
  // unless the caller explicitly opts in with `{ force: true }`.
  //
  // Why: getFullBreadthDashboard pulls LIVE ^VIX/TLT/HYG quotes and writes
  // back via this function. If the dashboard runs again for the same date
  // (catch-up runner on a Saturday, /api/breadth re-hit after cache miss,
  // manual runJobNow), the live-quote variance (provider cascade, off-hours
  // last-trade staleness) gives a slightly different composite — and
  // INSERT OR REPLACE silently overwrites the authoritative row. That's
  // how the user's composite breadth moved 48 → 51 between Friday close
  // and Saturday morning on a market with zero trading activity.
  //
  // The first write of a day still happens (existing.composite_score IS NULL
  // → guard passes). Re-runs no-op. Backfill (`backfillBreadthHistory`) does
  // its own date-set pre-filter so it never reaches this guard.
  if (opts.force !== true) {
    const existing = db().prepare(
      'SELECT composite_score FROM breadth_snapshots WHERE date = ?'
    ).get(date);
    if (existing && existing.composite_score != null) {
      return { saved: false, reason: 'idempotent-skip', date };
    }
  }

  db().prepare(`
    INSERT OR REPLACE INTO breadth_snapshots
    (date, pct_above_50ma, pct_above_200ma, new_highs, new_lows, ad_ratio,
     vol_thrust_pct, stage2_pct, stage4_pct, composite_score, regime,
     mcclellan_osc, summation_index, stock_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date, data.pctAbove50MA, data.pctAbove200MA, data.newHighs, data.newLows,
    data.adRatio, data.volThrustPct, data.stage2Pct, data.stage4Pct,
    data.compositeScore || null, data.regime || null,
    data.mcclellanOsc || null, data.summationIndex || null,
    data.stockCount || null
  );
  return { saved: true, date };
}

function getBreadthHistory(days = 90) {
  return db().prepare(`
    SELECT * FROM breadth_snapshots ORDER BY date DESC LIMIT ?
  `).all(days).reverse();
}

// ─── Full Breadth Dashboard ─────────────────────────────────────────────────
// Assembles all breadth indicators into a single response.

async function getFullBreadthDashboard(quotes) {
  const cached = cacheGet('breadth_dashboard', TTL_BREADTH);
  if (cached) return cached;

  // Get the most recent snapshot date
  const latestDate = db().prepare(`
    SELECT MAX(date) as date FROM rs_snapshots WHERE type = 'stock'
  `).get()?.date;

  if (!latestDate) return { error: 'No snapshot data available' };

  // Core breadth — refuses partial data via the data-quality gate.
  // When gated, we walk back to the most recent date with complete data
  // so the dashboard still renders SOMETHING useful (yesterday's
  // composite) rather than a blank panel. The UI's stale-snapshot
  // badge already warns the user when the served date isn't today.
  let breadth = computeBreadthFromSnapshots(latestDate);
  let dataQualityWarning = null;
  if (breadth?.error === 'data-quality-gate') {
    dataQualityWarning = {
      latestDate,
      completenessPct: breadth.completenessPct,
      reason: breadth.reason,
    };
    // Walk back up to 5 trading days looking for complete rs_snapshots.
    const fallbackDates = db().prepare(
      `SELECT DISTINCT date FROM rs_snapshots WHERE type = 'stock' AND date < ? ORDER BY date DESC LIMIT 5`
    ).all(latestDate).map(r => r.date);
    breadth = null;
    for (const fbDate of fallbackDates) {
      const candidate = computeBreadthFromSnapshots(fbDate);
      if (candidate && !candidate.error) {
        breadth = candidate;
        dataQualityWarning.servedDate = fbDate;
        break;
      }
    }
    if (!breadth) {
      return {
        error: 'No complete rs_snapshots data in the last 5 trading days. rs_scan_daily likely hasn\'t run successfully — check scheduler logs.',
        latestDate,
        completenessPct: dataQualityWarning.completenessPct,
      };
    }
  }

  // McClellan oscillator
  const mcclellan = computeMcClellanOscillator(60);

  // VIX term structure (from quotes if available)
  let vixStructure = null;
  if (quotes) {
    const vix = quotes.find(q => q.symbol === '^VIX' || q.symbol === 'VIX');
    if (vix?.regularMarketPrice) {
      // Get VIX history from snapshots
      const vixHistory = db().prepare(`
        SELECT price FROM rs_snapshots WHERE symbol = '^VIX' AND type = 'sector' AND price > 0
        ORDER BY date DESC LIMIT 252
      `).all().map(r => r.price).reverse();
      vixStructure = assessVIXTermStructure(vix.regularMarketPrice, vixHistory);
    }
  }

  // Credit spread proxy
  let creditSpread = null;
  if (quotes) {
    const tlt = quotes.find(q => q.symbol === 'TLT');
    const hyg = quotes.find(q => q.symbol === 'HYG');
    if (tlt?.regularMarketPrice && hyg?.regularMarketPrice) {
      creditSpread = assessCreditSpread(tlt.regularMarketPrice, hyg.regularMarketPrice);
    }
  }

  // Composite score
  const composite = computeCompositeBreadthScore(breadth, vixStructure, creditSpread);

  // Divergence detection
  const divergence = detectBreadthDivergence(60);

  // Save snapshot — only persist for the actual `breadth.date` (which may
  // be a fallback date when latestDate's data was incomplete). Avoids
  // overwriting a complete prior-day row with the same data, and avoids
  // creating a partial-data row for the latest date.
  if (breadth && !dataQualityWarning) {
    saveBreadthSnapshot(latestDate, {
      ...breadth,
      compositeScore: composite.score,
      regime: composite.regime,
      mcclellanOsc: mcclellan?.current || null,
      summationIndex: mcclellan?.summationIndex || null,
    });
  }

  const dashboard = {
    date: latestDate,
    servedDate: breadth?.date || latestDate,  // may differ from `date` when fallback fired
    dataQualityWarning,                        // null when input was complete
    breadth,
    composite,
    mcclellan,
    vixStructure,
    creditSpread,
    divergence,
    history: getBreadthHistory(30),
  };

  cacheSet('breadth_dashboard', dashboard);
  return dashboard;
}

// ─── Backfill Breadth History ─────────────────────────────────────────────
// Retroactively compute and save breadth snapshots for all dates that have
// rs_snapshots data. This builds the divergence history in one shot.

function backfillBreadthHistory() {
  // Get all distinct dates that have stock-type RS snapshots
  const dates = db().prepare(`
    SELECT DISTINCT date FROM rs_snapshots WHERE type = 'stock'
    ORDER BY date ASC
  `).all().map(r => r.date);

  // Phase 1: backfill basic breadth + composite for missing dates
  const existing = new Set(
    db().prepare('SELECT DISTINCT date FROM breadth_snapshots').all().map(r => r.date)
  );

  let saved = 0;
  let skipped = 0;
  for (const date of dates) {
    if (existing.has(date)) { skipped++; continue; }

    const breadth = computeBreadthFromSnapshots(date);
    if (!breadth) continue;

    const composite = computeCompositeBreadthScore(breadth, null, null);
    saveBreadthSnapshot(date, {
      ...breadth,
      compositeScore: composite.score,
      regime: composite.regime,
    });
    saved++;
  }

  // Phase 2: compute McClellan oscillator across ALL dates and update rows
  // McClellan requires a running EMA, so we must walk dates chronologically.
  let mcUpdated = 0;
  if (dates.length >= 40) {
    // Compute daily A/D diff for each date
    const adSeries = [];
    for (const date of dates) {
      const breadth = computeBreadthFromSnapshots(date);
      if (breadth) {
        adSeries.push({ date, adDiff: breadth.advancing - breadth.declining });
      }
    }

    if (adSeries.length >= 40) {
      const adDiffs = adSeries.map(d => d.adDiff);
      const ema19 = computeEMA(adDiffs, 19);
      const ema39 = computeEMA(adDiffs, 39);

      // Build oscillator + summation series
      let summation = 0;
      const updateStmt = db().prepare(
        'UPDATE breadth_snapshots SET mcclellan_osc = ?, summation_index = ? WHERE date = ?'
      );
      const updateMany = db().transaction((updates) => {
        for (const u of updates) updateStmt.run(u.osc, u.sum, u.date);
      });

      const updates = [];
      for (let i = 0; i < adSeries.length; i++) {
        if (ema19[i] != null && ema39[i] != null) {
          const osc = +(ema19[i] - ema39[i]).toFixed(2);
          summation += osc;
          updates.push({ date: adSeries[i].date, osc, sum: +summation.toFixed(2) });
        }
      }

      if (updates.length > 0) {
        updateMany(updates);
        mcUpdated = updates.length;
      }
    }
  }

  return {
    totalDates: dates.length,
    alreadyExisted: skipped,
    newlySaved: saved,
    mcClellanUpdated: mcUpdated,
    message: `Backfilled ${saved} breadth snapshots, updated McClellan for ${mcUpdated} dates`,
  };
}

module.exports = {
  computeBreadthFromSnapshots,
  computeMcClellanOscillator,
  assessVIXTermStructure,
  assessCreditSpread,
  computeCompositeBreadthScore,
  detectBreadthDivergence,
  saveBreadthSnapshot,
  getBreadthHistory,
  getFullBreadthDashboard,
  backfillBreadthHistory,
};
