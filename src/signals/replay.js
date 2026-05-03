// ─── Signal Replay / Backtest Engine (Tier 4) ───────────────────────────────
// Replays stored scan_results and rs_snapshots to evaluate strategy performance
const { getDB } = require('../data/database');
const {
  assessSignificance, calmarRatio: calmarFn,
} = require('./statistics');

function db() { return getDB(); }

// Lazy to avoid a circular import during module init and to keep backtests
// runnable on DBs that don't have the macro_series table yet.
function macroFred() { return require('./macro-fred'); }

/**
 * Point-in-time macro snapshot for a given trading day, via FRED data
 * imported by scripts/fetch-fred.js. Forward-fills monthly series so a
 * query in the middle of a month still gets the most recent observation.
 *
 * Returns an empty object when the macro_series table has no rows (e.g.
 * the user hasn't run fetch-fred yet) — callers should treat absent keys
 * as "unknown" rather than error out.
 *
 * Intended consumers: the walk-forward dashboard (Day 5-6) and any
 * future strategy that conditions on real macro rather than ETF proxies.
 *
 * @param {string} date           ISO 'YYYY-MM-DD'
 * @param {string[]=} seriesIds   Optional allow-list; default = every
 *                                distinct series_id in the table.
 * @returns {Object<string, number|null>}
 */
function getMacroSnapshotForDate(date, seriesIds = null) {
  if (!date) throw new Error('getMacroSnapshotForDate: date required');
  try {
    return macroFred().getMacroSnapshot(date, seriesIds);
  } catch (_) {
    // macro_series table missing, or macro-fred not loadable — backtests
    // should still run without macro context rather than die here.
    return {};
  }
}

// ─── Strategy Definitions ──────────────────────────────────────────────────

const BUILT_IN_STRATEGIES = {
  rs_momentum: {
    name: 'RS Momentum',
    description: 'Buy RS >= 80 with rising momentum, sell on RS drop below 50. Regime-aware: no new longs in CAUTION/CORRECTION.',
    defaults: { minRS: 80, minMomentum: 60, exitRS: 50, holdDays: 20 },
  },
  vcp_breakout: {
    name: 'VCP Breakout',
    description: 'Buy VCP forming stocks with high RS, sell at target or stop. Regime-aware: no new longs in CAUTION/CORRECTION.',
    defaults: { minRS: 70, minVCPContractions: 2, stopATR: 1.5, targetATR: 3.0, holdDays: 15 },
  },
  sepa_trend: {
    name: 'SEPA Trend Follow',
    description: 'Buy stocks passing 6+ SEPA rules, hold while structure intact. Regime-aware: no new longs in CAUTION/CORRECTION.',
    defaults: { minSEPA: 6, minRS: 70, exitSEPA: 3, holdDays: 30 },
  },
  rs_line_new_high: {
    name: 'RS Line New High',
    description: 'Buy on RS Line new highs near 52-week highs. Regime-aware: no new longs in CAUTION/CORRECTION.',
    defaults: { minRS: 75, maxDistFromHigh: 0.10, holdDays: 20 },
  },
  conviction: {
    name: 'Conviction Score',
    description: 'Buy top conviction-scored picks. Regime-aware: no new longs in CAUTION/CORRECTION, force-exit on risk-off. Matches Trade Setup tab behavior.',
    defaults: { minConviction: 60, topN: 5, holdDays: 20 },
  },
  short_breakdown: {
    name: 'Short Breakdown',
    description: 'Short Stage 4 stocks with RS <= 20, cover on RS recovery or stop. Not affected by regime gate (shorts thrive in CAUTION/CORRECTION).',
    defaults: { maxRS: 20, maxSEPA: 2, exitRS: 40, stopATR: 1.5, holdDays: 15 },
    side: 'short',
  },
  emerging_leader: {
    name: 'Emerging Leader',
    description: 'Buy RS 65-79 with 4-week RS acceleration >= +5. Catches leaders early before they hit RS 80+. Regime-aware: no new longs in CAUTION/CORRECTION.',
    defaults: { minRS: 65, maxRS: 79, minAccel: 5, exitRS: 50, holdDays: 25 },
  },
  deep_scan: {
    name: 'Deep Scan',
    description: 'Unified swing/position candidate filter + calcConviction-style ranking. Mirrors the live Deep Scan pipeline: RS≥70 + rising RS + above 50MA + (nearHigh OR volSurge OR strongMom). Ranks by a composite of RS / momentum / SEPA / pattern / institutional flow / revision tier / earnings drift. Regime-aware: no new longs in CAUTION/CORRECTION.',
    defaults: {
      tradeMode: 'both',          // 'swing' | 'position' | 'both' (both = whichever filter passes)
      minRS: 70,
      minSwingMomentum: 50,
      minConviction: 0,           // Rank-based selection; 0 = keep all candidates for ranking
      holdDays: 20,
      stopATR: 1.5, targetATR: 3.0,
      // Regime detection: use lenient MA-only rule, not strict distribution-day
      // overlay. Reasoning: deep_scan is a 20-day-hold position strategy; the
      // strict rule (3+ dist days in any rolling 25) flips to CAUTION routinely
      // even in healthy bull markets, force-exiting every long. Backtest across
      // 2016→2026 showed strict mode cost ~18% per bull window by whipsawing
      // winners before they developed. Users who want the strict filter can
      // still opt in via params: { strictRegime: true }.
      strictRegime: false,
    },
  },
  factor_combo: {
    name: 'Factor Combo',
    description: 'Generic signal-combo filter. Requires ALL signals in params.signals[] to fire. Signals: rs_strong (RS≥minRS), stage_2, vcp_forming, rs_line_nh, pattern (VCP or RS-line NH), breadth_ok, pattern_type:<name> (cupHandle/ascendingBase/powerPlay/highTightFlag, pipe-separated for OR). Ranks by RS+momentum.',
    defaults: {
      signals: ['rs_strong', 'pattern'],
      minRS: 85, holdDays: 20,
      stopATR: 1.5, targetATR: 3.0,
    },
  },
  regime_adaptive: {
    name: 'Regime Adaptive',
    description: 'Switches sub-strategy daily based on SPY regime: BULL→rs_momentum, NEUTRAL→sepa_trend, CAUTION→cash, CORRECTION→cash. New entries blocked outside risk-on regimes; existing positions force-exit when regime turns risk-off.',
    defaults: {
      bullStrategy:       'rs_momentum',
      neutralStrategy:    'sepa_trend',
      cautionStrategy:    'cash',
      correctionStrategy: 'cash',
      // Sub-strategy params (passed through to whichever sub is active)
      minRS: 80, minMomentum: 60, exitRS: 50,
      minSEPA: 6, exitSEPA: 3,
      maxRS: 20, maxSEPA: 2,
      stopATR: 1.5, targetATR: 3.0,
      maxDistFromHigh: 0.10,
      holdDays: 20,
      forceExitOnRiskOff: true,
    },
  },
};

// ─── Regime detection (point-in-time, from SPY snapshot) ───────────────────
// Pure-data version that uses SPY's vs_ma50 / vs_ma200 stored in rs_snapshots.
// No external API calls — works for any historical date in the snapshot table.
//   BULL:       SPY above both 50d & 200d                  → risk-on, momentum
//   NEUTRAL:    SPY above 200d but below 50d (pullback)    → risk-on, quality
//   CAUTION:    SPY below 200d but above 50d (recovery)    → flat, wait for FTD
//   CORRECTION: SPY below both                             → flat or short
// Historical regime detection for backtests — upgraded to use distribution
// days in addition to SPY vs MAs. Previously only used 2-factor MA check which
// let a backtest stay "BULL" during Q1 2025 while distribution days were
// spiking (institutions selling) — the live system would have flagged
// UPTREND_PRESSURE or early CORRECTION, blocking new trades.
//
// Distribution day rules (O'Neil canonical, approximated for snapshot data):
//   SPY down ≥ 0.2% day-over-day + volume_ratio > 1.0 (above 50-day avg)
//   → counts as a distribution day. (Raw volume vs prior-day would be ideal
//   but our snapshots only persist volume_ratio, so we use the avg-based proxy.)
//
// Count over rolling 25 sessions:
//   0-2 → healthy
//   3   → CAUTION (pressure building, tighten stops)
//   4+  → CORRECTION (institutions clearly selling)
function detectRegimeForDate(spyByDate, date, strict = true) {
  const spy = spyByDate[date];
  if (!spy || spy.vs_ma50 == null || spy.vs_ma200 == null) return 'NEUTRAL';
  const above50  = spy.vs_ma50  > 0;
  const above200 = spy.vs_ma200 > 0;

  // Non-strict mode: legacy MA-only regime (optimistic — matches old behavior
  // before distribution-day detection was added). Useful for edge-case
  // analysis and comparing against the strict default.
  if (!strict) {
    if (above50 && above200) return 'BULL';
    if (!above50 && above200) return 'NEUTRAL';
    if (above50 && !above200) return 'CAUTION';
    return 'CORRECTION';
  }

  // Strict mode (default): layer distribution-day analysis on top of MAs.
  // Matches live regime engine's institutional-selling detection.
  let distDays = 0;
  const allDates = Object.keys(spyByDate).sort();
  const idx = allDates.indexOf(date);
  if (idx >= 25) {
    const window = allDates.slice(idx - 25, idx + 1);
    for (let i = 1; i < window.length; i++) {
      const bar  = spyByDate[window[i]];
      const prev = spyByDate[window[i-1]];
      if (!bar?.price || !prev?.price) continue;
      const chg = (bar.price - prev.price) / prev.price;
      const volAboveAvg = (bar.volume_ratio || 0) > 1.0;
      if (chg <= -0.002 && volAboveAvg) distDays++;
    }
  }

  if (distDays >= 5) return 'CORRECTION';     // 5+ = institutions clearly selling
  if (distDays >= 4) return above50 ? 'CAUTION' : 'CORRECTION';
  if (distDays >= 3 && above50 && above200) return 'CAUTION';

  if (above50 && above200) return 'BULL';
  if (!above50 && above200) return 'NEUTRAL';
  if (above50 && !above200) return 'CAUTION';
  return 'CORRECTION';
}

function regimeToSubStrategy(regime, params) {
  if (regime === 'BULL')       return params.bullStrategy;
  if (regime === 'NEUTRAL')    return params.neutralStrategy;
  if (regime === 'CAUTION')    return params.cautionStrategy;
  return params.correctionStrategy;
}

// ─── Data Loading ──────────────────────────────────────────────────────────

function getAvailableDateRange() {
  const result = db().prepare(`
    SELECT MIN(date) as start_date, MAX(date) as end_date, COUNT(DISTINCT date) as trading_days
    FROM scan_results
  `).get();
  const snapRange = db().prepare(`
    SELECT MIN(date) as start_date, MAX(date) as end_date, COUNT(DISTINCT date) as trading_days
    FROM rs_snapshots WHERE type = 'stock'
  `).get();
  // Exclude today's market date — scan-generated snapshots use live/intraday
  // quotes, not verified daily closes. Replay should only use backfill dates.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const safeEnd = db().prepare(
    `SELECT MAX(date) as end_date FROM rs_snapshots WHERE type = 'stock' AND date < ?`
  ).get(today);
  if (snapRange) snapRange.safe_end_date = safeEnd?.end_date || snapRange?.end_date;
  return { scan_results: result, rs_snapshots: snapRange };
}

function loadScanData(startDate, endDate) {
  return db().prepare(`
    SELECT date, symbol, data, conviction_score
    FROM scan_results
    WHERE date >= ? AND date <= ?
    ORDER BY date, conviction_score DESC
  `).all(startDate, endDate).map(r => ({
    ...r,
    data: JSON.parse(r.data),
  }));
}

// Load pattern_detections rows keyed by (date → symbol → Set<pattern_type>)
// for the replay window. Used by factor_combo's pattern_type:<name> signal.
function loadPatternDetections(startDate, endDate) {
  const rows = db().prepare(`
    SELECT date, symbol, pattern_type
    FROM pattern_detections
    WHERE date >= ? AND date <= ?
  `).all(startDate, endDate);
  const byDate = {};
  for (const r of rows) {
    (byDate[r.date] ||= {});
    ((byDate[r.date][r.symbol] ||= new Set())).add(r.pattern_type);
  }
  return byDate;
}

function loadSnapshotData(startDate, endDate) {
  return db().prepare(`
    SELECT date, symbol, rs_rank, swing_momentum, sepa_score, stage, price,
           vs_ma50, vs_ma200, volume_ratio, vcp_forming, rs_line_new_high, atr_pct,
           rs_rank_weekly, rs_rank_monthly, rs_tf_alignment,
           up_down_ratio_50, accumulation_50,
           pattern_type, pattern_confidence
    FROM rs_snapshots
    WHERE type = 'stock' AND date >= ? AND date <= ?
    ORDER BY date, rs_rank DESC
  `).all(startDate, endDate);
}

// ─── Deep Scan factor loader ───────────────────────────────────────────────
// Pulls the three external factor tables that `calcConviction` consumes
// (institutional_flow, earnings_drift_snapshots, revision_scores) and returns
// lookup Maps keyed by `symbol|date`. Backfill coverage is sparse right now —
// callers must treat every factor as optional. A missing row simply means the
// bonus/penalty contribution for that factor is zero on that day.
function loadDeepScanFactors(startDate, endDate) {
  const inst = new Map();
  const drift = new Map();
  const rev = new Map();

  try {
    const rows = db().prepare(`
      SELECT symbol, date, flow_score, power_days, accum_days_20, dist_days_20, dark_pool_score
      FROM institutional_flow
      WHERE date >= ? AND date <= ?
    `).all(startDate, endDate);
    for (const r of rows) inst.set(`${r.symbol}|${r.date}`, r);
  } catch (_) { /* table may be missing on old DBs */ }

  try {
    const rows = db().prepare(`
      SELECT symbol, date, score, gap_pct, drift_pct, held_gains, strong
      FROM earnings_drift_snapshots
      WHERE date >= ? AND date <= ?
    `).all(startDate, endDate);
    for (const r of rows) drift.set(`${r.symbol}|${r.date}`, r);
  } catch (_) { /* table may be missing on old DBs */ }

  try {
    const rows = db().prepare(`
      SELECT symbol, date, revision_score, direction, tier
      FROM revision_scores
      WHERE date >= ? AND date <= ?
    `).all(startDate, endDate);
    for (const r of rows) rev.set(`${r.symbol}|${r.date}`, r);
  } catch (_) { /* table may be missing on old DBs */ }

  return { inst, drift, rev };
}

// ─── Moving Average computation for trail stops ─────────────────────────
//
// Pre-computes 13 EMA / 26 EMA / 50 SMA per symbol per day at engine load
// time, so evaluateExit() can do close-below-MA checks without re-walking
// the price history per trade.
//
// EMAs use the standard recursion EMA_t = price_t * k + EMA_{t-1} * (1 - k)
// with k = 2/(N+1). They're seeded with the first `N` prices' SMA so the
// first valid EMA value lands at index N-1.
//
// SMA50 needs at least 50 prior trading days; callers should preload that
// much history before the simulation startDate or the first ~50 days will
// have null sma50 values (which the trail logic correctly skips).

function computeMAsForPriceSeries(prices) {
  // prices: array of { date, price } sorted ascending by date
  // returns: array of { date, ema13, ema26, sma50 } same length
  const N13 = 13, N26 = 26, N50 = 50;
  const k13 = 2 / (N13 + 1);
  const k26 = 2 / (N26 + 1);
  const out = [];
  let ema13 = null, ema26 = null;
  // Rolling sum + buffer for SMA50
  const last50 = [];
  let sum50 = 0;

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i].price;
    if (p == null || !Number.isFinite(p) || p <= 0) {
      out.push({ date: prices[i].date, ema13: null, ema26: null, sma50: null });
      continue;
    }

    // EMA13: seed at i = 12 with SMA of first 13 prices
    if (i === N13 - 1) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += prices[j].price || 0;
      ema13 = sum / N13;
    } else if (i > N13 - 1 && ema13 != null) {
      ema13 = p * k13 + ema13 * (1 - k13);
    }

    // EMA26: seed at i = 25 with SMA of first 26 prices
    if (i === N26 - 1) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += prices[j].price || 0;
      ema26 = sum / N26;
    } else if (i > N26 - 1 && ema26 != null) {
      ema26 = p * k26 + ema26 * (1 - k26);
    }

    // SMA50: rolling window
    last50.push(p);
    sum50 += p;
    if (last50.length > N50) sum50 -= last50.shift();
    const sma50 = last50.length === N50 ? sum50 / N50 : null;

    out.push({
      date: prices[i].date,
      ema13: i >= N13 - 1 ? ema13 : null,
      ema26: i >= N26 - 1 ? ema26 : null,
      sma50,
    });
  }
  return out;
}

// Annotate snapshot rows in-place with computed MAs. After this call each
// row has stock.ema13 / stock.ema26 / stock.sma50 (any can be null when not
// yet enough history).
//
// `extraPriceHistory` is an optional Map<symbol, [{date, price}]> of bars
// PRECEDING the simulation window (preloaded by the caller). Without those,
// the first 50 simulation days have no SMA50 because we have no warm-up.
function annotateSnapshotsWithMAs(snapshots, extraPriceHistory = null) {
  // Group snapshots by symbol, preserving date order
  const bySym = new Map();
  for (const s of snapshots) {
    if (!bySym.has(s.symbol)) bySym.set(s.symbol, []);
    bySym.get(s.symbol).push(s);
  }
  for (const [sym, rows] of bySym) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    // Combine warm-up history (if any) with simulation rows so the EMA/SMA
    // recursions have a valid seed by the time we hit the simulation start.
    const warmup = extraPriceHistory?.get(sym) || [];
    const combined = [
      ...warmup.map(p => ({ date: p.date, price: p.price })),
      ...rows.map(r => ({ date: r.date, price: r.price })),
    ];
    const mas = computeMAsForPriceSeries(combined);
    // Map MAs back onto the snapshot rows (skip the warm-up prefix)
    const offset = warmup.length;
    for (let i = 0; i < rows.length; i++) {
      const m = mas[offset + i];
      if (m) {
        rows[i].ema13 = m.ema13;
        rows[i].ema26 = m.ema26;
        rows[i].sma50 = m.sma50;
      }
    }
  }
}

// Load up to ~60 trading days of price history before `startDate` so the
// MA recursions are properly seeded by the time the simulation begins.
// Returns Map<symbol, [{date, price}]>.
function loadMAWarmupHistory(startDate, lookbackDays = 60) {
  const ds = new Date(startDate + 'T00:00:00Z');
  // 60 trading days ≈ 90 calendar days (weekends/holidays).
  ds.setUTCDate(ds.getUTCDate() - Math.ceil(lookbackDays * 1.45));
  const warmupStart = ds.toISOString().split('T')[0];
  const rows = db().prepare(`
    SELECT symbol, date, price
    FROM rs_snapshots
    WHERE type = 'stock' AND date >= ? AND date < ? AND price IS NOT NULL
    ORDER BY symbol, date
  `).all(warmupStart, startDate);
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push({ date: r.date, price: r.price });
  }
  return bySym;
}

// ─── Strategy Evaluators ───────────────────────────────────────────────────

function evaluateEntry(stock, strategy, params) {
  switch (strategy) {
    case 'rs_momentum':
      return stock.rs_rank >= params.minRS &&
             (stock.swing_momentum || 0) >= params.minMomentum;

    case 'vcp_breakout':
      return stock.rs_rank >= params.minRS &&
             stock.vcp_forming;

    case 'sepa_trend':
      return (stock.sepa_score || 0) >= params.minSEPA &&
             stock.rs_rank >= params.minRS;

    case 'rs_line_new_high':
      return stock.rs_rank >= params.minRS &&
             stock.rs_line_new_high;

    case 'conviction':
      // Minimum quality gate. Default RS≥60/Mom≥40 matches the daily-picks
      // filter, but `params.minRS` and `params.minMomentum` lift it when
      // set so users can tighten the entry bar from the UI without the
      // `topN` cap (which only affects ranking) silently being a no-op.
      return stock.rs_rank >= (params.minRS || 60) &&
             (stock.swing_momentum || 0) >= (params.minMomentum || 40);

    case 'emerging_leader':
      return stock.rs_rank >= params.minRS &&
             stock.rs_rank <= params.maxRS &&
             (stock._rs_accel_4w || 0) >= params.minAccel;

    case 'short_breakdown':
      return stock.rs_rank <= params.maxRS &&
             (stock.sepa_score || 8) <= params.maxSEPA &&
             stock.stage === 4;

    case 'deep_scan': {
      // Mirrors src/signals/candidates.js isSwingCandidate / isPositionCandidate
      // against stored snapshot fields. _rs_accel_4w stands in for rsTrend.vs1m
      // (same 20-trading-day lookback), _distFromHigh is the 252-day rolling
      // max derived in runReplay. When either is missing (early in the range
      // or brand-new symbol) we fail-closed — matches the live filter.
      const rsAccel = stock._rs_accel_4w || 0;
      const rsRising = rsAccel > 3;
      const distFromHigh = stock._distFromHigh;
      if (stock.rs_rank < (params.minRS || 70)) return false;
      if (!rsRising) return false;

      const mode = params.tradeMode || 'both';
      const passesSwing = () => {
        if ((stock.swing_momentum || 0) < (params.minSwingMomentum || 50)) return false;
        if ((stock.vs_ma50 || 0) <= 0) return false;
        if (distFromHigh == null) return false;
        const nearHigh = distFromHigh <= 0.12;
        const volumeSurge = (stock.volume_ratio || 0) >= 1.1;
        const strongMom = (stock.swing_momentum || 0) >= 65;
        return nearHigh || volumeSurge || strongMom;
      };
      const passesPosition = () => {
        if ((stock.vs_ma200 || 0) <= 0) return false;
        if (stock.vs_ma50 == null || stock.vs_ma50 > 5 || stock.vs_ma50 <= -15) return false;
        if (distFromHigh == null || distFromHigh > 0.30) return false;
        return true;
      };

      if (mode === 'swing')    return passesSwing();
      if (mode === 'position') return passesPosition();
      return passesSwing() || passesPosition();
    }

    case 'factor_combo': {
      // Every signal in params.signals[] must fire. Supported:
      //   rs_strong          — rs_rank ≥ params.minRS (default 85)
      //   stage_2            — stock.stage === 2
      //   vcp_forming        — stock.vcp_forming
      //   rs_line_nh         — stock.rs_line_new_high
      //   pattern            — vcp_forming OR rs_line_new_high
      //   breadth_ok         — day-level gate; see runReplay injection (stock._breadth_ok)
      //   pattern_type:A|B   — classical-pattern segmenter from pattern_detections.
      //                        Values: cupHandle, ascendingBase, powerPlay, highTightFlag.
      //                        Pipe-separated for OR (e.g. pattern_type:cupHandle|powerPlay).
      const sigs = Array.isArray(params.signals) ? params.signals : [];
      if (!sigs.length) return false;
      for (const sig of sigs) {
        if (sig === 'rs_strong')        { if (!(stock.rs_rank >= (params.minRS || 85))) return false; }
        else if (sig === 'stage_2')     { if (stock.stage !== 2) return false; }
        else if (sig === 'vcp_forming') { if (!stock.vcp_forming) return false; }
        else if (sig === 'rs_line_nh')  { if (!stock.rs_line_new_high) return false; }
        else if (sig === 'pattern')     { if (!(stock.vcp_forming || stock.rs_line_new_high)) return false; }
        else if (sig === 'breadth_ok')  { if (!stock._breadth_ok) return false; }
        else if (sig.startsWith('pattern_type:')) {
          const wanted = sig.slice('pattern_type:'.length).split('|').filter(Boolean);
          const pats = stock._patterns;
          if (!pats || !wanted.some(w => pats.has(w))) return false;
        }
        else return false;  // Unknown signal → conservative fail
      }
      return true;
    }

    default:
      return false;
  }
}

function evaluateExit(stock, entryStock, strategy, params, holdingDays, position) {
  // Max hold period — last resort
  if (holdingDays >= params.holdDays) return { exit: true, reason: 'max_hold' };

  // ─── ATR-based stop/target for ALL strategies (universal risk management) ──
  // Every strategy gets price-based exits. Strategy-specific signal exits below
  // can fire earlier, but these ensure no position runs away without a stop.
  const atrPct = entryStock.atr_pct || 2.5;
  const atr = entryStock.price * (atrPct / 100);
  const isShort = position?.isShort;

  // ─── MA TRAIL EXITS (let-the-winners-run framework) ──────────────────────
  //
  // Activates when params.trailType is set to one of:
  //   'fixed_ma13' / 'fixed_ma26' / 'fixed_ma50'
  //       single-MA close-below trail throughout the trade
  //   'staged_swing'
  //       1×ATR initial stop → 13 EMA close-below for the rest (10-day swing)
  //   'staged_position'
  //       1.5×ATR initial → 13 EMA at +5% gain or 10d → 26 EMA at +12% or 25d
  //                       → 50 SMA at +20% or 45d. The escalator.
  //
  // All trail exits require CLOSE BELOW the MA, not intraday touch. ATR
  // initial stop still applies during the "birth" stage to catch hard
  // breaks before the trade has earned space.
  //
  // Long-only: short_breakdown keeps its original ATR stop block below.
  if (!isShort && entryStock.price && stock.price && params.trailType && params.trailType !== 'atr') {
    const trailType = params.trailType;
    const gainPct = ((stock.price - entryStock.price) / entryStock.price) * 100;

    // Helper: which MA do we trail with at this stage?
    let trailMA = null;       // 'ema13' | 'ema26' | 'sma50' | null = use ATR floor
    let initialATRStop = null; // multiplier — null means no ATR floor

    if (trailType === 'fixed_ma13') trailMA = 'ema13';
    else if (trailType === 'fixed_ma26') trailMA = 'ema26';
    else if (trailType === 'fixed_ma50') trailMA = 'sma50';
    else if (trailType === 'staged_swing') {
      // Birth: ATR stop only. Adolescence (any time): 13 EMA close-below.
      // Birth is the period before the first daily close — ATR catches
      // entry-day catastrophic moves. After that, MA trail takes over.
      trailMA = 'ema13';
      if (holdingDays === 0) initialATRStop = params.stopATR || 1.0;
    }
    else if (trailType === 'staged_position') {
      // Stage escalator. Read maxGainPct from position state to ensure we
      // don't downgrade the trail after a pullback (once mature, stay mature).
      const stageGain = Math.max(gainPct, position?.maxGainPct || 0);
      if (stageGain >= 20 || holdingDays >= 45) trailMA = 'sma50';
      else if (stageGain >= 12 || holdingDays >= 25) trailMA = 'ema26';
      else if (stageGain >= 5 || holdingDays >= 10) trailMA = 'ema13';
      else {
        // Birth stage — ATR initial stop, no MA trail yet
        trailMA = null;
        initialATRStop = params.stopATR || 1.5;
      }
    }

    // Apply initial ATR stop (birth stage only, when defined)
    if (initialATRStop != null) {
      const stopPrice = entryStock.price - (initialATRStop * atr);
      if (stock.price <= stopPrice) return { exit: true, reason: 'birth_atr_stop' };
    }

    // Apply MA close-below trail. `stock.price` IS the closing price for
    // the day in our snapshot data, so direct comparison = close-below.
    if (trailMA) {
      const maValue = stock[trailMA];
      // null MA = not enough history yet (e.g. SMA50 needs 50 prior days).
      // In that case fall through to ATR exit below — better than running
      // unprotected.
      if (maValue != null && stock.price < maValue) {
        return { exit: true, reason: `trail_${trailMA}_close` };
      }
    }

    // When trailType is set, we OWN the stop logic. Skip the generic ATR
    // stop/target block below so we don't double-clip. Targets still fire
    // on staged paths if explicitly set via targetATR (defensive cap).
    if (params.targetATR && stock.price >= entryStock.price + (params.targetATR * atr)) {
      return { exit: true, reason: 'target_hit' };
    }
    // Update position's maxGainPct for next-day stage decisions
    if (position && gainPct > (position.maxGainPct || 0)) {
      position.maxGainPct = gainPct;
    }
    // Fallthrough: don't run the generic ATR block below — trail owns exits
    return { exit: false };
  }

  if (entryStock.price && stock.price && !isShort) {
    const stopATR = params.stopATR || 1.5;
    const targetATR = params.targetATR || 3.0;
    const stopPrice = entryStock.price - (stopATR * atr);
    const targetPrice = entryStock.price + (targetATR * atr);
    if (stock.price <= stopPrice) return { exit: true, reason: 'stop_hit' };
    // BUG FIX: when scaleOut is enabled, the 3.0×ATR generic target would fire
    // BEFORE scale-out T2 (3.5×ATR), collapsing Full→Scale to ~Full→Full. Skip
    // the generic target when scaleOut is on — let the T1/T2/trail ladder run.
    if (!params.scaleOut && stock.price >= targetPrice) return { exit: true, reason: 'target_hit' };
  }

  // ─── Scale-out logic (if enabled) ─────────────────────────────────────────
  // Partial exits: sell 1/3 at target1, move stop to breakeven, sell 1/3 at
  // target2, trail final 1/3 with 21EMA (approximated via vs_ma50 since we
  // don't have 21EMA in snapshots — conservative proxy).
  if (params.scaleOut && position && entryStock.price && stock.price && !isShort) {
    const target1ATR = params.target1ATR || 2.0;
    const target2ATR = params.target2ATR || 3.5;
    const target1Price = entryStock.price + (target1ATR * atr);
    const target2Price = entryStock.price + (target2ATR * atr);
    const tranche = position.tranche || 1;

    if (tranche === 1 && stock.price >= target1Price) {
      return { exit: true, reason: 'scale_out_t1', partial: true, sellFraction: 1/3, nextTranche: 2, moveStopToBreakeven: true };
    }
    if (tranche === 2 && stock.price >= target2Price) {
      return { exit: true, reason: 'scale_out_t2', partial: true, sellFraction: 1/2, nextTranche: 3 };
    }
    // Tranche 3: trail with MA — exit if stock drops below 50MA
    if (tranche === 3 && stock.vs_ma50 != null && stock.vs_ma50 < -2) {
      return { exit: true, reason: 'trail_stop_ma', partial: false };
    }
    // Tranche 2+: breakeven stop
    if (tranche >= 2 && stock.price <= entryStock.price) {
      return { exit: true, reason: 'breakeven_stop' };
    }
  }

  // ─── Strategy-specific signal exits ───────────────────────────────────────
  switch (strategy) {
    case 'rs_momentum':
      if (stock.rs_rank <= params.exitRS) return { exit: true, reason: 'rs_dropped' };
      break;

    case 'vcp_breakout':
      // ATR stop/target already handled above
      break;

    case 'sepa_trend':
      if ((stock.sepa_score || 0) <= params.exitSEPA) return { exit: true, reason: 'sepa_degraded' };
      break;

    case 'emerging_leader':
      // Exit if RS drops below threshold (thesis broken)
      if (stock.rs_rank <= params.exitRS) return { exit: true, reason: 'rs_dropped' };
      break;

    case 'rs_line_new_high':
      if (stock.vs_ma50 < -5) return { exit: true, reason: 'below_ma50' };
      break;

    case 'conviction':
      break; // Signal exits handled by ATR stop/target above

    case 'short_breakdown': {
      // Cover short if RS recovers (stock is strengthening)
      if (stock.rs_rank >= params.exitRS) return { exit: true, reason: 'rs_recovered' };
      // Stop-out: price moves against us (up)
      if (entryStock.price && stock.price) {
        const stopPrice = entryStock.price + ((params.stopATR || 1.5) * atr);
        if (stock.price >= stopPrice) return { exit: true, reason: 'stop_hit' };
      }
      break;
    }
  }

  return { exit: false };
}

// ─── Execution Model ──────────────────────────────────────────────────────
// Realistic slippage and cost simulation.
//
// Phase 2.6 additions (realistic fills — closes the backtest/live gap):
//
//   • cashDragAnnualBps        Risk-free yield earned on idle cash. Without
//                              this, a backtest that spends 30% of its time
//                              in cash during CAUTION regimes looks worse
//                              vs live (where SHY yields ~4.5%) by the full
//                              yield × cash-fraction × years. Compounded,
//                              a 5-year backtest with 25% average cash is
//                              off by ~5.6% absolute return.
//
//   • dividendYieldAnnualBps   Dividends pulled during hold periods. The
//                              rs_snapshots table stores PRICE only, not
//                              total return — so every ex-div day looks
//                              like a loss. Adding the S&P average div
//                              yield back as a daily accrual on long
//                              positions corrects for this. Shorts pay
//                              the dividend instead of receiving it.
//
//   • nextDayOpenGapBps        Extra slippage on next-day entry fills to
//                              model the gap between prior-close (signal
//                              data) and next-open (actual fill). Free
//                              data only gives us closes, so we can't
//                              literally mark to next-day open — this BP
//                              penalty captures the average directional
//                              gap on momentum entries (~0.15% based on
//                              recent RS-70+ cohort studies).
//
// All three default to non-zero so backtests are realistic by default.
// Callers can zero them out for controlled comparisons with older results.

const DEFAULT_EXECUTION = {
  entrySlippageBps: 10,       // 10 basis points slippage on entries (buying into strength)
  exitSlippageBps: 5,         // 5 bps on exits (more orderly)
  commissionPerShare: 0,      // Most brokers are $0 commission now; set >0 if needed
  maxGapPct: 3.0,             // Skip entries where price gaps up >3% from prior close
  nextDayEntry: true,         // Signal on day D → fill at day D+1's price (realistic for manual traders)
  nextDayOpenGapBps: 15,      // Extra slippage when nextDayEntry fills — models open-vs-prior-close gap
  cashDragAnnualBps: 450,     // ~4.5% SHY-equivalent risk-free yield on idle cash
  dividendYieldAnnualBps: 150, // ~1.5% S&P 500 average dividend yield on long positions
};

// Trading days per year — used to convert annual rates into daily accrual.
// 252 is the standard US-equity count (≈365 - weekends - holidays).
const TRADING_DAYS_PER_YEAR = 252;

function applySlippage(price, bps, side) {
  // Slippage always works against you:
  // Buying long / covering short = pay more
  // Selling long / shorting = receive less
  const slipMultiplier = side === 'buy' ? (1 + bps / 10000) : (1 - bps / 10000);
  return +(price * slipMultiplier).toFixed(4);
}

// ─── Benchmark (SPY / QQQ / IWM / DIA / any ETF) ──────────────────────────
//
// Pre-fix this was hardcoded to SPY and read from rs_snapshots. The user
// (correctly) pointed out that beating SPY in a tech-heavy decade is a
// soft target — QQQ +480% over 2016-2026 vs SPY +229%, so a strategy
// that "beats SPY" can lose hard to QQQ. Now the caller picks a symbol;
// SPY still reads from rs_snapshots (back-compat); other symbols read
// from a benchmark_prices cache table that's lazily populated from
// Yahoo on first use. One Yahoo fetch per benchmark per server lifetime;
// subsequent reads are SQLite-fast.
function _ensureBenchmarkTable() {
  db().prepare(`
    CREATE TABLE IF NOT EXISTS benchmark_prices (
      symbol TEXT NOT NULL,
      date   TEXT NOT NULL,
      close  REAL NOT NULL,
      PRIMARY KEY (symbol, date)
    )
  `).run();
}

async function ensureBenchmarkLoaded(symbol) {
  if (symbol === 'SPY') return;  // SPY already in rs_snapshots
  _ensureBenchmarkTable();
  const cnt = db().prepare(
    'SELECT COUNT(*) AS c FROM benchmark_prices WHERE symbol = ?'
  ).get(symbol)?.c || 0;
  if (cnt > 100) return;  // cached enough — daily freshness comes from a cron we'll wire later
  // Pull from Yahoo (long history). Failure is a hard error — caller
  // needs to know the benchmark isn't available rather than silently
  // returning null and producing meaningless alpha numbers.
  const { yahooHistoryFull } = require('../data/providers/yahoo');
  const bars = await yahooHistoryFull(symbol);
  if (!Array.isArray(bars) || !bars.length) {
    throw new Error(`Benchmark ${symbol}: Yahoo returned no history`);
  }
  const ins = db().prepare(`
    INSERT OR REPLACE INTO benchmark_prices (symbol, date, close) VALUES (?, ?, ?)
  `);
  const tx = db().transaction((rows) => { for (const r of rows) ins.run(symbol, r.date.slice(0, 10), r.close); });
  tx(bars.filter(b => b.close != null));
}

function calcBenchmark(startDate, endDate, symbol = 'SPY') {
  let snaps;
  if (symbol === 'SPY') {
    snaps = db().prepare(`
      SELECT date, price AS close FROM rs_snapshots
      WHERE symbol = 'SPY' AND type = 'stock' AND date >= ? AND date <= ? AND price > 0
      ORDER BY date
    `).all(startDate, endDate);
  } else {
    snaps = db().prepare(`
      SELECT date, close FROM benchmark_prices
      WHERE symbol = ? AND date >= ? AND date <= ? AND close > 0
      ORDER BY date
    `).all(symbol, startDate, endDate);
  }
  if (snaps.length < 2) return null;
  // Keep the rest of the function generic — variable named spySnaps below
  // for diff hygiene; it's actually 'snaps' for whatever benchmark.
  const spySnaps = snaps.map(s => ({ date: s.date, price: s.close }));
  if (spySnaps.length < 2) return null;

  const startPrice = spySnaps[0].price;
  const endPrice = spySnaps[spySnaps.length - 1].price;
  const totalReturn = +((endPrice / startPrice - 1) * 100).toFixed(2);

  // SPY equity curve for comparison
  const equityCurve = spySnaps.map(s => ({
    date: s.date,
    equity: +(100000 * (s.price / startPrice)).toFixed(2),  // Normalized to 100K
  }));

  // SPY max drawdown
  let peak = 100000, maxDD = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = ((peak - point.equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // SPY Sharpe
  const dailyReturns = [];
  for (let i = 1; i < spySnaps.length; i++) {
    dailyReturns.push(spySnaps[i].price / spySnaps[i - 1].price - 1);
  }
  const avgDR = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdDR = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((a, r) => a + (r - avgDR) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = stdDR > 0 ? +((avgDR / stdDR) * Math.sqrt(252)).toFixed(2) : 0;

  return {
    totalReturn,
    maxDrawdown: +maxDD.toFixed(2),
    sharpeRatio: sharpe,
    startPrice: +startPrice.toFixed(2),
    endPrice: +endPrice.toFixed(2),
    equityCurve: equityCurve.filter((_, i) =>
      i % Math.max(1, Math.floor(equityCurve.length / 100)) === 0 || i === equityCurve.length - 1
    ),
  };
}

// ─── Point-in-Time Universe Filter (Phase 1 — Survivorship Bias Fix) ──────
// Uses universe-tracker module for proper point-in-time universe membership.
// Excludes stocks that were removed from the universe before a given date AND
// stocks that were added AFTER the given date (prevents look-ahead bias).
// Falls back to basic universe_mgmt check if tracker module unavailable.
//
// `indexName` is the external index to resolve against (SP500, RUSSELL1000,
// NDX, etc.). Passed through to pit-universe; when no PIT data exists for
// the index, falls through to the legacy universe_mgmt / rs_snapshots paths.

function getActiveUniverse(date, indexName = 'SP500') {
  try {
    // Phase 1: use universe-tracker for comprehensive filtering
    const { getActiveUniverseForDate } = require('./universe-tracker');
    const activeSymbols = getActiveUniverseForDate(date, indexName);
    if (activeSymbols && activeSymbols.length > 0) {
      // Return a Set of REMOVED symbols (for backward compat with existing filter)
      // Any symbol NOT in the active universe is effectively "removed"
      return { activeSet: new Set(activeSymbols), mode: 'tracker' };
    }
  } catch (_) {
    // universe-tracker not available — fall back
  }

  // Legacy fallback: basic removed-date check
  try {
    const removed = db().prepare(`
      SELECT symbol FROM universe_mgmt
      WHERE removed_date IS NOT NULL AND removed_date <= ?
    `).all(date).map(r => r.symbol);
    return { removedSet: new Set(removed), mode: 'legacy' };
  } catch (_) {
    return { removedSet: new Set(), mode: 'none' };
  }
}

// Check if a symbol passes the universe filter for a given date
function isInUniverse(symbol, universeFilter) {
  if (!universeFilter) return true;
  if (universeFilter.mode === 'tracker' && universeFilter.activeSet) {
    return universeFilter.activeSet.has(symbol);
  }
  if (universeFilter.removedSet) {
    return !universeFilter.removedSet.has(symbol);
  }
  return true;
}

// ─── Replay Engine ─────────────────────────────────────────────────────────

// Swing vs Position mode overrides — position trades hold longer, use wider stops,
// and require pullback to 50MA. Swing trades are tighter, shorter hold.
//
// Position preset tuned from scripts/run-mode-comparison.js sweep on the
// backfilled 10-year universe (2016-10→2026-04):
//   Mode D (pyramid-in + scale-out ladder 3.5/7.0) posted 277% return /
//   12.9% MDD / 1.05 Sharpe / +49% alpha on the Full window, winning 3 of
//   4 regime windows vs the FULL→FULL and FULL→SCALE variants.
const MODE_OVERRIDES = {
  swing:    { holdDays: 10, stopATR: 1.0, targetATR: 2.0, target1ATR: 1.5, target2ATR: 2.5 },
  position: { holdDays: 40, stopATR: 2.5, targetATR: 7.0, scaleOut: true, target1ATR: 3.5, target2ATR: 7.0, pyramidEntry: true },
};

function runReplay({ strategy, tradeMode, params = {}, startDate, endDate, maxPositions = 10, initialCapital = 100000, execution = {}, persistResult = true, indexName = 'SP500', benchmark = 'SPY' }) {
  const stratDef = BUILT_IN_STRATEGIES[strategy];
  if (!stratDef) throw new Error(`Unknown strategy: ${strategy}. Available: ${Object.keys(BUILT_IN_STRATEGIES).join(', ')}`);

  const modeOverrides = tradeMode && MODE_OVERRIDES[tradeMode] ? MODE_OVERRIDES[tradeMode] : {};
  const mergedParams = { ...stratDef.defaults, ...modeOverrides, ...params };
  const exec = { ...DEFAULT_EXECUTION, ...execution };

  // Load data
  const snapshots = loadSnapshotData(startDate, endDate);
  if (!snapshots.length) {
    return { error: 'No snapshot data in date range', strategy, startDate, endDate };
  }

  // Annotate snapshots with 13 EMA / 26 EMA / 50 SMA so the trail logic in
  // evaluateExit can do close-below-MA checks. Only computed when at least
  // one trail mode requires MAs (avoids the cost on pure-ATR runs).
  const trailType = mergedParams.trailType || 'atr';
  const needsMAs = trailType !== 'atr';
  if (needsMAs) {
    const warmup = loadMAWarmupHistory(startDate, 60);
    annotateSnapshotsWithMAs(snapshots, warmup);
  }

  // Group by date
  const byDate = {};
  for (const s of snapshots) {
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  }
  const dates = Object.keys(byDate).sort();

  // ─── factor_combo day-level lookups ─────────────────────────────────────
  // Pre-compute breadth_ok (day-level) and pattern_detections (per symbol)
  // so evaluateEntry reads them off the stock row via _breadth_ok / _patterns.
  const combosNeedBreadth = strategy === 'factor_combo' &&
    Array.isArray(params.signals) && params.signals.includes('breadth_ok');
  const combosNeedPatterns = strategy === 'factor_combo' &&
    Array.isArray(params.signals) && params.signals.some(s => typeof s === 'string' && s.startsWith('pattern_type:'));

  const breadthOkByDate = {};
  if (combosNeedBreadth) {
    const rows = db().prepare(`
      SELECT date, regime, composite_score
      FROM breadth_snapshots
      WHERE date >= ? AND date <= ?
    `).all(startDate, endDate);
    for (const r of rows) {
      breadthOkByDate[r.date] = (r.regime === 'UPTREND') || ((r.composite_score || 0) >= 60);
    }
  }

  const patternsByDate = combosNeedPatterns ? loadPatternDetections(startDate, endDate) : null;

  // ─── RS acceleration lookup (for emerging_leader + deep_scan strategies) ─
  // Build per-symbol RS rank history so we can compute 4-week RS change.
  // rsHistory[symbol] = [{date, rs_rank}, ...] sorted by date.
  // We PRELOAD ~30 trading days before startDate so the first 20 simulation
  // days have a valid 4-week accel reference — otherwise any short-range
  // replay starts with `_rs_accel_4w=0` everywhere and rising-RS filters
  // block every candidate for the first month.
  const isEmerging = strategy === 'emerging_leader' ||
    (strategy === 'regime_adaptive' && Object.values(mergedParams).includes('emerging_leader'));
  const isDeepScan = strategy === 'deep_scan';
  const needsRsAccel = isEmerging || isDeepScan;
  let rsHistory = {};
  if (needsRsAccel) {
    // Preload ~45 calendar days (~30 trading days) before startDate
    const preloadStart = new Date(startDate + 'T00:00:00Z');
    preloadStart.setUTCDate(preloadStart.getUTCDate() - 45);
    const preloadStartIso = preloadStart.toISOString().split('T')[0];
    const preloadRows = db().prepare(`
      SELECT date, symbol, rs_rank
      FROM rs_snapshots
      WHERE type = 'stock' AND date >= ? AND date < ?
      ORDER BY date
    `).all(preloadStartIso, startDate);
    for (const s of preloadRows) {
      if (s.symbol === 'SPY') continue;
      if (!rsHistory[s.symbol]) rsHistory[s.symbol] = [];
      rsHistory[s.symbol].push({ date: s.date, rs: s.rs_rank });
    }
    for (const s of snapshots) {
      if (s.symbol === 'SPY') continue;
      if (!rsHistory[s.symbol]) rsHistory[s.symbol] = [];
      rsHistory[s.symbol].push({ date: s.date, rs: s.rs_rank });
    }
  }

  function computeRsAccel4w(symbol, date) {
    const hist = rsHistory[symbol];
    if (!hist) return 0;
    const dateIdx = hist.findIndex(h => h.date === date);
    if (dateIdx < 0) return 0;
    // Look back ~20 trading days (≈ 4 calendar weeks)
    const lookback = dateIdx - 20;
    if (lookback < 0) return 0;
    return hist[dateIdx].rs - hist[lookback].rs;
  }

  // ─── Deep-scan factor + distFromHigh lookups ───────────────────────────
  // Deep scan needs: (a) the 3 external factor tables joined on (symbol,date),
  // and (b) a 252-day rolling max so `_distFromHigh` mirrors the live scan's
  // 52-week high proximity filter. Everything below is only built when the
  // strategy actually needs it to keep the hot path fast for other strategies.
  let deepFactors = { inst: new Map(), drift: new Map(), rev: new Map() };
  const distFromHighByKey = new Map();  // `symbol|date` → fraction below 252d high
  if (isDeepScan) {
    deepFactors = loadDeepScanFactors(startDate, endDate);

    // Preload ~400 calendar days of prices before startDate so the 252-day
    // rolling max is honest from day 1 (otherwise early-window entries all
    // look near-high and the distFromHigh filter is effectively disabled).
    const preloadStart = new Date(startDate + 'T00:00:00Z');
    preloadStart.setUTCDate(preloadStart.getUTCDate() - 400);
    const preloadStartIso = preloadStart.toISOString().split('T')[0];
    const pricePreload = db().prepare(`
      SELECT date, symbol, price
      FROM rs_snapshots
      WHERE type = 'stock' AND date >= ? AND date < ? AND price > 0
      ORDER BY date
    `).all(preloadStartIso, startDate);

    const priceHistory = {};
    for (const r of pricePreload) {
      if (r.symbol === 'SPY') continue;
      if (!priceHistory[r.symbol]) priceHistory[r.symbol] = [];
      priceHistory[r.symbol].push({ date: r.date, price: r.price });
    }
    for (const s of snapshots) {
      if (!s.price || s.symbol === 'SPY') continue;
      if (!priceHistory[s.symbol]) priceHistory[s.symbol] = [];
      priceHistory[s.symbol].push({ date: s.date, price: s.price });
    }

    // Walk forward maintaining a rolling 252-day max per symbol. Stored
    // under `symbol|date` so the daily loop just does one lookup per stock.
    for (const [sym, series] of Object.entries(priceHistory)) {
      for (let i = 0; i < series.length; i++) {
        const windowStart = Math.max(0, i - 251);
        let hi = 0;
        for (let j = windowStart; j <= i; j++) {
          if (series[j].price > hi) hi = series[j].price;
        }
        if (hi > 0) {
          const distFromHigh = (hi - series[i].price) / hi;
          distFromHighByKey.set(`${sym}|${series[i].date}`, distFromHigh);
        }
      }
    }
  }

  // ─── Deep-scan composite ranker (approximates calcConviction) ──────────
  // Stand-alone so it's cheap to reason about and easy to tweak without
  // touching the daily loop. Returns a numeric score; callers sort desc.
  function scoreDeepScan(s) {
    let score = (s.rs_rank || 0) * 0.25
              + (s.swing_momentum || 0) * 0.20
              + (s.sepa_score || 0) * 2.5;
    const accel = s._rs_accel_4w || 0;
    score += Math.min(Math.max(accel, 0), 20) * 1.25;

    if (s.rs_line_new_high) score += 8;
    if (s.vcp_forming)      score += 6;
    if ((s.volume_ratio || 0) >= 1.5) score += 5;

    const tfAlign = s.rs_tf_alignment || 0;
    if (tfAlign >= 3)      score += 8;
    else if (tfAlign >= 2) score += 4;

    // up/down volume profile (IBD accumulation) — stored as TEXT grade
    if ((s.up_down_ratio_50 || 0) >= 1.5)      score += 9;   // grade A equivalent
    else if ((s.up_down_ratio_50 || 0) >= 1.2) score += 6;   // grade B+
    else if ((s.up_down_ratio_50 || 0) < 0.8)  score -= 8;   // distribution

    // Pattern bonus (only fires when pattern backfill has populated the row)
    if (s.pattern_type) {
      if (s.pattern_type === 'highTightFlag')   score += 12;
      else if (s.pattern_type === 'cupHandle')  score += 9;
      else if (s.pattern_type === 'ascendingBase') score += 8;
      else if (s.pattern_type === 'powerPlay')  score += 7;
    }

    // Institutional flow (from institutional_flow table, LEFT JOINed)
    const inst = s._inst;
    if (inst) {
      const fs = inst.flow_score || 50;
      if (fs >= 70)      score += 10;
      else if (fs >= 60) score += 5;
      else if (fs <= 30) score -= 5;
      else if (fs <= 20) score -= 10;
      if ((inst.power_days || 0) >= 2) score += 4;
    }

    // Revision tier
    const rev = s._rev;
    if (rev?.tier) {
      if (rev.tier === 'strong_upgrade' && (s.rs_rank || 0) >= 80) score += 12;
      else if (rev.tier === 'strong_upgrade')                       score += 8;
      else if (rev.tier === 'upgrade' && (s.rs_rank || 0) >= 70)    score += 6;
      else if (rev.tier === 'upgrade')                              score += 4;
      else if (rev.tier === 'downgrade')                            score -= 8;
      else if (rev.tier === 'strong_downgrade')                     score -= 15;
    }

    // Earnings drift (PEAD)
    const drift = s._drift;
    if (drift) {
      score += (drift.score || 0) * 0.10;
      if (drift.strong) score += 6;
    }

    // Stage penalties/bonuses
    if (s.stage === 2)      score += 5;
    else if (s.stage === 3) score -= 8;
    else if (s.stage === 4) score -= 15;

    // Far-from-high penalty (extended moves are risky)
    if ((s._distFromHigh || 0) > 0.15) score -= 10;

    return score;
  }

  // ─── Regime setup (ALL strategies) ──────────────────────────────────────
  // Every long strategy respects market regime: no new longs in CAUTION/CORRECTION,
  // force-exit when regime turns risk-off. This matches the Trade Setup tab's
  // "NO NEW LONGS" gate. Short strategies are unaffected by the regime gate.
  const isAdaptive = strategy === 'regime_adaptive';
  let spyByDate = {};
  const regimeStats = { BULL: 0, NEUTRAL: 0, CAUTION: 0, CORRECTION: 0 };
  for (const s of snapshots) {
    if (s.symbol === 'SPY') spyByDate[s.date] = s;
  }
  // Preload ~30 trading days of SPY before startDate so distribution-day
  // rolling-25 detection has enough history on the very first replay day.
  // Without this, every backtest's first ~25 days fall back to MA-only
  // regime classification, which biases early-period results vs late-period.
  if (mergedParams.strictRegime !== false) {
    const preloadStart = new Date(startDate + 'T00:00:00Z');
    preloadStart.setUTCDate(preloadStart.getUTCDate() - 45);
    const preloadIso = preloadStart.toISOString().split('T')[0];
    try {
      const preRows = db().prepare(`
        SELECT date, price, vs_ma50, vs_ma200, volume_ratio
        FROM rs_snapshots
        WHERE symbol = 'SPY' AND type = 'stock' AND date >= ? AND date < ?
        ORDER BY date
      `).all(preloadIso, startDate);
      for (const r of preRows) {
        if (!spyByDate[r.date]) spyByDate[r.date] = r;
      }
    } catch (_) { /* preload failure → fall back to in-window only */ }
  }

  // Resolves the sub-strategy for a given date. Returns null when the active
  // regime maps to "cash" (no entries). The sub-strategy definition is needed
  // to know whether to filter long or short candidates and which exit logic
  // to apply.
  function resolveSub(date) {
    // Always detect the day's regime — non-adaptive strategies still tag
    // each trade's entryRegime so the per-regime breakdown works across
    // the full Compare All, not just the adaptive path. Strict flag from
    // params.strictRegime (default true = dist-days + MA, false = MA only).
    const regime = detectRegimeForDate(spyByDate, date, mergedParams.strictRegime !== false);
    regimeStats[regime]++;
    if (!isAdaptive) return { key: strategy, def: stratDef, regime };
    const subKey = regimeToSubStrategy(regime, mergedParams);
    if (!subKey || subKey === 'cash') return { key: null, def: null, regime };
    const def = BUILT_IN_STRATEGIES[subKey];
    if (!def) return { key: null, def: null, regime };
    return { key: subKey, def, regime };
  }

  // Simulation state
  // For adaptive, isShort flips per-position based on the sub-strategy at
  // entry; the top-level isShort stays false.
  const isShort = stratDef.side === 'short';
  let capital = initialCapital;
  let totalSlippageCost = 0;
  let totalCommissionCost = 0;
  let skippedGaps = 0;
  let skippedSurvivorship = 0;
  // Per-share commission (default 0). Charged on every trade leg — pilot
  // entry, pyramid adds, partial exits, full exits, and end-of-period
  // closures. Previously the default value lived in DEFAULT_EXECUTION but
  // no code consumed it, silently dropping the cost for any user who set
  // it.
  const commissionPerShare = +exec.commissionPerShare || 0;
  function chargeCommission(shares) {
    if (commissionPerShare <= 0 || shares <= 0) return 0;
    const c = commissionPerShare * shares;
    capital -= c;
    totalCommissionCost += c;
    return c;
  }
  const positions = new Map();
  const trades = [];
  // Equity curve is built inside the daily loop (one point per day, end-of-day
  // mark-to-market). Previously we also pushed an "initial capital" point
  // before the loop, which produced a duplicate entry for dates[0] — fine
  // for stats (peak still seeds at initialCapital below) but messy for
  // chart overlays. Initial capital is implicit in the maxDD seed.
  const equityCurve = [];
  let totalWins = 0, totalLosses = 0;

  // Build prior-day price map for gap detection
  const priorPriceMap = {};

  // Next-day entry queue: signal on day D → fill at day D+1's price.
  // Each pending entry stores the candidate info from the signal day.
  let pendingEntries = [];  // [{ symbol, signalStock, subStrategy, isShort }]
  let skippedNextDay = 0;   // Count of pending entries that couldn't fill (symbol missing next day)

  // Pre-compute per-day accrual multipliers (Phase 2.6) — cheaper than
  // recomputing every iteration and makes the daily loop readable.
  const cashDragDaily   = (exec.cashDragAnnualBps     || 0) / 10000 / TRADING_DAYS_PER_YEAR;
  const divAccrualDaily = (exec.dividendYieldAnnualBps || 0) / 10000 / TRADING_DAYS_PER_YEAR;
  let totalCashInterest = 0;   // Reporting only
  let totalDividends    = 0;   // Reporting only

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const dayStocks = byDate[date];
    const stockMap = {};
    const dayBreadthOk = combosNeedBreadth ? !!breadthOkByDate[date] : true;
    const dayPatterns  = combosNeedPatterns ? (patternsByDate[date] || {}) : null;
    for (const s of dayStocks) {
      stockMap[s.symbol] = s;
      // 4-week RS acceleration — emerging_leader entry gate + deep_scan ranker
      if (needsRsAccel) s._rs_accel_4w = computeRsAccel4w(s.symbol, date);
      if (combosNeedBreadth)  s._breadth_ok = dayBreadthOk;
      if (combosNeedPatterns) s._patterns   = dayPatterns[s.symbol] || null;
      if (isDeepScan) {
        const key = `${s.symbol}|${date}`;
        s._inst         = deepFactors.inst.get(key)  || null;
        s._drift        = deepFactors.drift.get(key) || null;
        s._rev          = deepFactors.rev.get(key)   || null;
        s._distFromHigh = distFromHighByKey.get(key);
      }
    }

    // ─── Daily accruals (Phase 2.6) ─────────────────────────────────────
    // Skip day 0 so we don't double-count the initial capital before it's
    // had time to earn anything. Subsequent days accrue on yesterday's
    // closing capital + position state.
    if (i > 0 && cashDragDaily > 0) {
      const interest = capital * cashDragDaily;
      capital += interest;
      totalCashInterest += interest;
    }
    if (i > 0 && divAccrualDaily > 0) {
      // Dividends flow as cash to the account (modeled). Longs receive,
      // shorts pay — matching the real brokerage mechanic where the short
      // seller owes the dividend on ex-div day.
      for (const [sym, pos] of positions) {
        const mark = stockMap[sym]?.price || pos.entryPrice;
        const positionNotional = mark * pos.shares;
        const div = positionNotional * divAccrualDaily;
        if (pos.isShort) {
          capital -= div;
          totalDividends -= div;
        } else {
          capital += div;
          totalDividends += div;
        }
      }
    }

    // Survivorship filter: skip stocks not in the universe on this date.
    // Resolves against the chosen index (default SP500) via PIT membership.
    const universeFilter = getActiveUniverse(date, indexName);

    // For adaptive strategies, resolve today's sub-strategy + regime context.
    // Non-adaptive strategies see { key: strategy, def: stratDef, regime: null }.
    const sub = resolveSub(date);
    const todayRegime = sub.regime || null;

    // ─── Pyramid add-on entries (before exit checks) ───────────────────────
    // For positions opened with pyramidEntry=true, the initial fill was only
    // 1/3 of the intended size. Each subsequent day, check if price hit the
    // add1 (+2%) or add2 (+4%) trigger and buy the next 1/3 at that day's
    // price. This simulates staggered entry on breakout confirmation.
    //
    // Adds are charged the same entry slippage as the pilot fill — without
    // this, pyramid backtests systematically beat full-size single fills
    // because the add legs got a free no-slippage execution while every
    // comparison strategy ate slippage on every share.
    if (mergedParams.pyramidEntry) {
      for (const [symbol, pos] of positions) {
        if (!pos.pyramidEntryTranche || pos.pyramidEntryTranche >= 3) continue;
        if (pos.isShort) continue;  // pyramid only for longs
        const stock = stockMap[symbol];
        if (!stock?.price) continue;

        const addTriggerPct = pos.pyramidEntryTranche === 1 ? 0.02 : 0.04;
        const addTrigger = pos.pyramidPilotPrice * (1 + addTriggerPct);
        if (stock.price < addTrigger) continue;

        // Volume gate: daily volume ratio must be >= 1.1x for confirmation
        if (stock.volume_ratio != null && stock.volume_ratio < 1.1) continue;

        // Gap filter on the add: if the bar gapped above maxGapPct vs prior
        // close, the add chases extension — skip and try again tomorrow.
        const priorPrice = priorPriceMap[symbol];
        if (priorPrice && priorPrice > 0) {
          const gapPct = ((stock.price / priorPrice) - 1) * 100;
          if (gapPct > exec.maxGapPct) {
            skippedGaps++;
            continue;
          }
        }

        // Buy another 1/3 worth at this day's price (entry slippage applied,
        // matching the pilot's cost basis treatment)
        const addShares = Math.floor(pos.pyramidTargetShares / 3);
        if (addShares <= 0) continue;
        const rawAddPrice = stock.price;
        const addPrice = applySlippage(rawAddPrice, exec.entrySlippageBps, 'buy');
        const addCost = addShares * addPrice;
        if (addCost > capital) continue;  // out of capital
        const addSlippage = Math.abs(rawAddPrice - addPrice) * addShares;
        totalSlippageCost += addSlippage;

        capital -= addCost;
        chargeCommission(addShares);
        pos.shares += addShares;
        pos.collateral += addCost;
        pos.pyramidEntryTranche += 1;
        // Blend entry price (weighted avg) so R-multiples are honest
        pos.entryPrice = +((pos.entryPrice * (pos.shares - addShares) + addPrice * addShares) / pos.shares).toFixed(4);
      }
    }

    // Check exits first
    for (const [symbol, pos] of positions) {
      const stock = stockMap[symbol];
      if (!stock) continue;

      const holdingDays = dates.slice(dates.indexOf(pos.entryDate), i + 1).length;
      // Use the sub-strategy that was active at entry — exit logic must
      // match the entry rationale, not whatever the regime is today.
      const posStrategy = pos.subStrategy || strategy;
      const posIsShort  = !!pos.isShort;
      let exitCheck = evaluateExit(stock, pos.entryStock, posStrategy, mergedParams, holdingDays, pos);

      // Force-exit longs when regime turns risk-off (all long strategies).
      // Default ON for every strategy. `forceExitOnRiskOff: false` (set
      // via params, e.g. for buy-and-hold-style backtests that should
      // ride out regime drawdowns) skips the force-exit and lets the
      // strategy's own exit signals run.
      if (!exitCheck.exit && !posIsShort && mergedParams.forceExitOnRiskOff !== false) {
        const regimeForExit = todayRegime || detectRegimeForDate(spyByDate, date, mergedParams.strictRegime !== false);
        if (regimeForExit === 'CAUTION' || regimeForExit === 'CORRECTION') {
          exitCheck = { exit: true, reason: `regime_${regimeForExit.toLowerCase()}` };
        }
      }

      if (exitCheck.exit && stock.price) {
        // ─── Partial exit (scale-out) ──────────────────────────────────
        if (exitCheck.partial && exitCheck.sellFraction && exitCheck.sellFraction < 1) {
          const sellShares = Math.max(1, Math.floor(pos.shares * exitCheck.sellFraction));
          const remainShares = pos.shares - sellShares;
          const rawExitPrice = stock.price;
          const exitPrice = applySlippage(rawExitPrice, exec.exitSlippageBps, 'sell');
          const slippageCost = Math.abs(rawExitPrice - exitPrice) * sellShares;
          totalSlippageCost += slippageCost;

          const pnl = (exitPrice - pos.entryPrice) * sellShares;
          const pnlPct = ((exitPrice / pos.entryPrice) - 1) * 100;
          const partialCollateral = pos.collateral * (sellShares / pos.shares);
          capital += partialCollateral + pnl;
          const partialCommission = chargeCommission(sellShares);

          trades.push({
            symbol, side: 'long',
            entryDate: pos.entryDate, exitDate: date,
            entryPrice: pos.entryPrice, exitPrice: +exitPrice.toFixed(2),
            shares: sellShares, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
            atrPct: pos.entryStock.atr_pct || null,
            slippageCost: +slippageCost.toFixed(2),
            commissionCost: +partialCommission.toFixed(2),
            holdingDays, exitReason: exitCheck.reason,
            entryRS: pos.entryStock.rs_rank, exitRS: stock.rs_rank,
            subStrategy: pos.subStrategy || null,
            entryRegime: pos.entryRegime || null,
          });
          if (pnl > 0) totalWins++; else totalLosses++;

          // Update position with remaining shares
          pos.shares = remainShares;
          pos.collateral -= partialCollateral;
          pos.tranche = exitCheck.nextTranche || (pos.tranche || 1) + 1;
          if (remainShares <= 0) positions.delete(symbol);
          continue;
        }

        // ─── Full exit ──────────────────────────────────────────────────
        const rawExitPrice = stock.price;
        const exitPrice = posIsShort
          ? applySlippage(rawExitPrice, exec.exitSlippageBps, 'buy')    // Cover = buy
          : applySlippage(rawExitPrice, exec.exitSlippageBps, 'sell');
        const slippageCost = Math.abs(rawExitPrice - exitPrice) * pos.shares;
        totalSlippageCost += slippageCost;

        const pnl = posIsShort
          ? (pos.entryPrice - exitPrice) * pos.shares
          : (exitPrice - pos.entryPrice) * pos.shares;
        const pnlPct = posIsShort
          ? ((pos.entryPrice / exitPrice) - 1) * 100
          : ((exitPrice / pos.entryPrice) - 1) * 100;

        capital += pos.collateral + pnl;
        const exitCommission = chargeCommission(pos.shares);

        trades.push({
          symbol, side: posIsShort ? 'short' : 'long',
          entryDate: pos.entryDate, exitDate: date,
          entryPrice: pos.entryPrice, exitPrice: +exitPrice.toFixed(2),
          shares: pos.shares, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
          atrPct: pos.entryStock.atr_pct || null,
          slippageCost: +slippageCost.toFixed(2),
          commissionCost: +exitCommission.toFixed(2),
          holdingDays, exitReason: exitCheck.reason,
          entryRS: pos.entryStock.rs_rank, exitRS: stock.rs_rank,
          subStrategy: pos.subStrategy || null,
          entryRegime: pos.entryRegime || null,
        });

        if (pnl > 0) totalWins++; else totalLosses++;
        positions.delete(symbol);
      }
    }

    // ─── Fill pending entries from yesterday's signals (next-day entry mode) ─
    // When nextDayEntry is on, yesterday's signal candidates are filled at
    // today's price — modeling "see signal after close, buy next morning".
    if (exec.nextDayEntry && pendingEntries.length > 0) {
      const slotsForPending = maxPositions - positions.size;
      const availCapPending = Math.max(0, capital);
      const posSizePending = availCapPending / Math.max(1, slotsForPending);
      let filled = 0;

      for (const pe of pendingEntries) {
        if (filled >= slotsForPending) break;
        if (positions.has(pe.symbol)) continue;  // Already in a position

        const stock = stockMap[pe.symbol];
        if (!stock || !stock.price || stock.price <= 0) {
          skippedNextDay++;
          continue;  // Symbol not in today's snapshot
        }

        // Gap filter: skip if today's price gapped up >maxGapPct from signal day's close
        if (!pe.isShort && pe.signalPrice > 0) {
          const gapPct = ((stock.price / pe.signalPrice) - 1) * 100;
          if (gapPct > exec.maxGapPct) {
            skippedGaps++;
            continue;
          }
        }

        // Regime re-check: ensure regime is still favorable on fill day
        const fillRegime = detectRegimeForDate(spyByDate, date, mergedParams.strictRegime !== false);
        if (!pe.isShort && (fillRegime === 'CAUTION' || fillRegime === 'CORRECTION')) continue;

        // Phase 2.6: pile `nextDayOpenGapBps` on top of regular slippage so
        // the fill price models the prior-close→next-open gap. Free snapshot
        // data only has closes, so we can't literally mark to the next-day
        // open — this bp penalty is the best-effort proxy.
        const totalEntryBps = exec.entrySlippageBps + (exec.nextDayOpenGapBps || 0);
        const rawEntryPrice = stock.price;
        const entryPrice = pe.isShort
          ? applySlippage(rawEntryPrice, totalEntryBps, 'sell')
          : applySlippage(rawEntryPrice, totalEntryBps, 'buy');
        const posSize = Math.max(0, capital) / Math.max(1, maxPositions - positions.size);
        const targetShares = Math.floor(posSize / entryPrice);
        if (targetShares <= 0 || posSize < 100) continue;

        // Pyramid mode: only buy 1/3 initially. Adds fire on +2%/+4% confirmation
        // via the pyramid-entry block in the day loop.
        const pyramidOn = mergedParams.pyramidEntry && !pe.isShort && targetShares >= 3;
        const shares = pyramidOn ? Math.floor(targetShares / 3) : targetShares;

        const slippageCost = Math.abs(rawEntryPrice - entryPrice) * shares;
        totalSlippageCost += slippageCost;
        const collateral = shares * entryPrice;
        capital -= collateral;
        chargeCommission(shares);

        positions.set(pe.symbol, {
          entryDate: date,
          entryPrice: +entryPrice.toFixed(4),
          entryStock: stock,   // Use today's snapshot (fill-day data) for stop/target calc
          shares,
          collateral,
          subStrategy: pe.subStrategy,
          isShort: pe.isShort,
          entryRegime: pe.entryRegime,
          ...(pyramidOn && {
            pyramidEntryTranche: 1,
            pyramidPilotPrice: +entryPrice.toFixed(4),
            pyramidTargetShares: targetShares,
          }),
        });
        filled++;
      }
      pendingEntries = [];  // Clear queue regardless of how many filled
    }

    // ─── Generate new entry signals ──────────────────────────────────────────
    // Adaptive: handled by sub-strategy mapping (CAUTION/CORRECTION→cash).
    // All other long strategies: block new entries in CAUTION/CORRECTION.
    // `regime` here reuses the value already computed by resolveSub() above —
    // calling detectRegimeForDate twice was 2x work AND double-counted
    // regimeStats for non-adaptive strategies (resolveSub increments once,
    // then this block incremented again).
    const cashToday = isAdaptive && !sub.def;
    const regime = sub.regime;
    const regimeBlocked = !isAdaptive && !isShort && (regime === 'CAUTION' || regime === 'CORRECTION');
    if (!cashToday && !regimeBlocked && positions.size < maxPositions) {
      const todayStrategy = sub.key;
      const todayDef      = sub.def;
      const todayIsShort  = todayDef.side === 'short';

      let candidates = dayStocks
        .filter(s => !positions.has(s.symbol) && s.price > 0)
        .filter(s => s.symbol !== 'SPY')
        .filter(s => isInUniverse(s.symbol, universeFilter))  // Survivorship filter
        .filter(s => evaluateEntry(s, todayStrategy, mergedParams));

      // Position mode: require pullback to 50MA (vsMA50 between -2% and +5%)
      if (tradeMode === 'position') {
        candidates = candidates.filter(s => s.vs_ma50 != null && s.vs_ma50 >= -2 && s.vs_ma50 <= 5);
      }
      // Swing mode: require momentum >= 55 (hot stocks moving NOW)
      if (tradeMode === 'swing') {
        candidates = candidates.filter(s => (s.swing_momentum || 0) >= 55);
      }

      // Rank candidates by each strategy's core thesis — keep sorts simple
      // and distinct so strategies don't converge toward the same picks.
      // Conviction is the only "kitchen sink" ranker by design.
      if (todayStrategy === 'emerging_leader') {
        // Highest RS acceleration first — fastest rising relative strength
        candidates.sort((a, b) => (b._rs_accel_4w || 0) - (a._rs_accel_4w || 0));
      } else if (todayStrategy === 'rs_momentum') {
        // RS + momentum equally — the two signals in the strategy name
        candidates.sort((a, b) =>
          ((b.rs_rank || 0) + (b.swing_momentum || 0)) - ((a.rs_rank || 0) + (a.swing_momentum || 0)));
      } else if (todayStrategy === 'vcp_breakout') {
        // Volume dry-up in base = tightest pattern = best breakout
        candidates.sort((a, b) => (a.volume_ratio || 1) - (b.volume_ratio || 1));
      } else if (todayStrategy === 'sepa_trend') {
        // Highest SEPA score = strongest trend template
        candidates.sort((a, b) => (b.sepa_score || 0) - (a.sepa_score || 0));
      } else if (todayStrategy === 'rs_line_new_high') {
        // Strongest RS rank — RS line new high is already the entry gate
        candidates.sort((a, b) => (b.rs_rank || 0) - (a.rs_rank || 0));
      } else if (todayStrategy === 'factor_combo') {
        // RS + momentum composite — combo filter has already gated candidates.
        candidates.sort((a, b) =>
          ((b.rs_rank || 0) + (b.swing_momentum || 0)) - ((a.rs_rank || 0) + (a.swing_momentum || 0)));
      } else if (todayStrategy === 'deep_scan') {
        // Composite conviction-style ranker. Filter by minConviction when set,
        // then sort desc so the top N fills open slots. Precompute the score
        // once per stock so the comparator is stable and cheap.
        for (const c of candidates) c._deepScore = scoreDeepScan(c);
        const minC = mergedParams.minConviction || 0;
        candidates = candidates.filter(c => c._deepScore >= minC);
        candidates.sort((a, b) => (b._deepScore || 0) - (a._deepScore || 0));
      } else if (todayStrategy === 'conviction') {
        // Multi-factor composite matching calcConviction weights
        candidates.sort((a, b) => {
          const score = s => (s.rs_rank || 0) * 0.25 + (s.swing_momentum || 0) * 0.20
            + (s.sepa_score || 0) * 2.5 + (s.rs_line_new_high ? 8 : 0)
            + (s.vcp_forming ? 6 : 0) + ((s.rs_tf_alignment || 0) >= 3 ? 8 : (s.rs_tf_alignment || 0) >= 2 ? 4 : 0)
            + ((s.accumulation_50 || 0) >= 1.2 ? 6 : 0);
          return score(b) - score(a);
        });
      } else if (todayIsShort) {
        candidates.sort((a, b) => (a.rs_rank || 99) - (b.rs_rank || 99));
      }

      const slotsAvailable = maxPositions - positions.size;

      if (exec.nextDayEntry) {
        // Queue candidates for next-day fill instead of entering today
        pendingEntries = candidates.slice(0, slotsAvailable).map(stock => ({
          symbol: stock.symbol,
          signalPrice: stock.price,
          signalStock: stock,
          subStrategy: todayStrategy,
          isShort: todayIsShort,
          entryRegime: todayRegime,
        }));
      } else {
        // Same-day entry (original behavior)
        const availableCapital = Math.max(0, capital);
        const positionSize = availableCapital / Math.max(1, slotsAvailable);

        for (const stock of candidates.slice(0, slotsAvailable)) {
          if (positionSize < 100 || !stock.price) continue;

          // Gap filter: skip if price gapped up >maxGapPct from prior close
          const priorPrice = priorPriceMap[stock.symbol];
          if (!todayIsShort && priorPrice && stock.price > 0) {
            const gapPct = ((stock.price / priorPrice) - 1) * 100;
            if (gapPct > exec.maxGapPct) {
              skippedGaps++;
              continue; // Missed the breakout — don't chase
            }
          }

          // Apply entry slippage
          const rawEntryPrice = stock.price;
          const entryPrice = todayIsShort
            ? applySlippage(rawEntryPrice, exec.entrySlippageBps, 'sell')   // Short = sell
            : applySlippage(rawEntryPrice, exec.entrySlippageBps, 'buy');
          const targetShares = Math.floor(positionSize / entryPrice);
          if (targetShares <= 0) continue;

          // Pyramid mode: only buy 1/3 at signal — adds fire on +2%/+4% confirmation
          const pyramidOn = mergedParams.pyramidEntry && !todayIsShort && targetShares >= 3;
          const shares = pyramidOn ? Math.floor(targetShares / 3) : targetShares;
          if (shares <= 0) continue;

          const slippageCost = Math.abs(rawEntryPrice - entryPrice) * shares;
          totalSlippageCost += slippageCost;

          const collateral = shares * entryPrice;
          capital -= collateral;
          chargeCommission(shares);

          positions.set(stock.symbol, {
            entryDate: date,
            entryPrice: +entryPrice.toFixed(4),
            entryStock: stock,
            shares,
            collateral,
            subStrategy: todayStrategy,
            isShort: todayIsShort,
            entryRegime: todayRegime,
            ...(pyramidOn && {
              pyramidEntryTranche: 1,
              pyramidPilotPrice: +entryPrice.toFixed(4),
              pyramidTargetShares: targetShares,
            }),
          });
        }
      }
    }

    // Update prior price map for next day's gap detection
    for (const s of dayStocks) {
      if (s.price > 0) priorPriceMap[s.symbol] = s.price;
    }

    // Record equity
    let positionValue = 0;
    for (const [symbol, pos] of positions) {
      const current = stockMap[symbol];
      const currentPrice = current?.price || pos.entryPrice;
      if (pos.isShort) {
        positionValue += pos.collateral + (pos.entryPrice - currentPrice) * pos.shares;
      } else {
        positionValue += currentPrice * pos.shares;
      }
    }
    equityCurve.push({ date, equity: +(capital + positionValue).toFixed(2), positions: positions.size });
  }

  // Close remaining positions at last known price (with exit slippage).
  // If the last date has NULL price, walk backwards to find the most recent
  // valid price — avoids distorted P&L from falling back to entry price.
  const lastDate = dates[dates.length - 1];
  const lastDayStocks = byDate[lastDate] || [];
  const lastStockMap = {};
  for (const s of lastDayStocks) lastStockMap[s.symbol] = s;

  // Build a lookup of last valid price per symbol across all dates
  const lastValidPrice = {};
  for (let d = dates.length - 1; d >= 0; d--) {
    const dayStocks = byDate[dates[d]] || [];
    for (const s of dayStocks) {
      if (s.price > 0 && !lastValidPrice[s.symbol]) {
        lastValidPrice[s.symbol] = s.price;
      }
    }
    // Stop once we've found prices for all open positions
    if ([...positions.keys()].every(sym => lastValidPrice[sym])) break;
  }

  let eopClosedAny = false;
  let eopSlippageCost = 0;
  for (const [symbol, pos] of positions) {
    const stock = lastStockMap[symbol];
    const rawExitPrice = stock?.price || lastValidPrice[symbol] || pos.entryPrice;
    const posIsShort = !!pos.isShort;
    const exitPrice = posIsShort
      ? applySlippage(rawExitPrice, exec.exitSlippageBps, 'buy')
      : applySlippage(rawExitPrice, exec.exitSlippageBps, 'sell');
    const slippageCost = Math.abs(rawExitPrice - exitPrice) * pos.shares;
    totalSlippageCost += slippageCost;
    eopSlippageCost  += slippageCost;
    const pnl = posIsShort
      ? (pos.entryPrice - exitPrice) * pos.shares
      : (exitPrice - pos.entryPrice) * pos.shares;
    const pnlPct = posIsShort
      ? ((pos.entryPrice / exitPrice) - 1) * 100
      : ((exitPrice / pos.entryPrice) - 1) * 100;
    capital += pos.collateral + pnl;
    const eopCommission = chargeCommission(pos.shares);
    eopClosedAny = true;

    trades.push({
      symbol, side: posIsShort ? 'short' : 'long',
      entryDate: pos.entryDate, exitDate: lastDate,
      entryPrice: pos.entryPrice, exitPrice: +exitPrice.toFixed(2),
      shares: pos.shares, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
      atrPct: pos.entryStock.atr_pct || null,
      slippageCost: +slippageCost.toFixed(2),
      commissionCost: +eopCommission.toFixed(2),
      holdingDays: dates.slice(dates.indexOf(pos.entryDate)).length,
      exitReason: 'end_of_period',
      entryRS: pos.entryStock.rs_rank, exitRS: stock?.rs_rank || null,
      subStrategy: pos.subStrategy || null,
      entryRegime: pos.entryRegime || null,
    });

    if (pnl > 0) totalWins++; else totalLosses++;
  }
  positions.clear();

  // Final equity-curve point: reflects the post-EOP-close cash. Without
  // this, finalEquity used the LAST in-loop mark-to-market value, which
  // ignored exit slippage and commissions paid at EOP — small overstatement
  // of total return for any backtest that ended with open positions.
  if (eopClosedAny && equityCurve.length > 0) {
    equityCurve[equityCurve.length - 1] = { date: lastDate, equity: +capital.toFixed(2), positions: 0 };
  }

  // ─── Calculate Stats ─────────────────────────────────────────────────────

  const finalEquity = equityCurve[equityCurve.length - 1]?.equity || initialCapital;
  const totalReturn = ((finalEquity / initialCapital) - 1) * 100;

  const winningTrades = trades.filter(t => t.pnl > 0);
  const losingTrades = trades.filter(t => t.pnl <= 0);
  const avgWin = winningTrades.length ? winningTrades.reduce((a, t) => a + t.pnlPct, 0) / winningTrades.length : 0;
  const avgLoss = losingTrades.length ? losingTrades.reduce((a, t) => a + t.pnlPct, 0) / losingTrades.length : 0;
  const winRate = trades.length ? (totalWins / trades.length) * 100 : 0;

  // Max drawdown
  let peak = initialCapital, maxDD = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = ((peak - point.equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Profit factor
  const grossProfit = winningTrades.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? Infinity : 0;

  // Average R-multiple (approx using per-trade risk — entry to stop distance)
  const avgR = trades.length
    ? +(trades.reduce((a, t) => {
        // Use actual ATR% from snapshot if available, fallback to 2.5%
        const riskPct = t.atrPct || 2.5;
        return a + (t.pnlPct / riskPct);
      }, 0) / trades.length).toFixed(2)
    : 0;

  // Sharpe ratio approximation (daily returns).
  // First daily return is day 0 EOD vs initial capital — without this seed,
  // dropping the synthetic day-0 point above would silently exclude the
  // first day's return from Sharpe calc.
  const dailyReturns = [];
  if (equityCurve.length > 0) {
    dailyReturns.push((equityCurve[0].equity / initialCapital) - 1);
  }
  for (let i = 1; i < equityCurve.length; i++) {
    dailyReturns.push((equityCurve[i].equity / equityCurve[i - 1].equity) - 1);
  }
  const avgDailyReturn = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdDailyReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((a, r) => a + Math.pow(r - avgDailyReturn, 2), 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = stdDailyReturn > 0 ? +((avgDailyReturn / stdDailyReturn) * Math.sqrt(252)).toFixed(2) : 0;

  // ─── Phase 2.7: Statistical significance + Calmar ────────────────────────
  // Assess whether this backtest's edge is real or a lucky streak. The
  // replay engine has always reported Sharpe/winRate/avgReturn as point
  // estimates — but without a t-stat or confidence interval, a user
  // cannot tell a 20-trade streak from a 200-trade track record. The
  // `significance` block below gives the dashboard everything it needs to
  // stamp the result "significant" / "insufficient sample" / "not sig".
  //
  // Annualization convention: pass `tradesPerYear` as (trades / span),
  // NOT 252 — the input to assessSignificance is per-trade returns, not
  // daily returns. For swing setups with ~1 month hold this lands around
  // 50–100 trades/year, matching typical swing-momentum cadence.
  const spanDays = dates.length;
  const spanYears = Math.max(0.01, spanDays / 252);
  const tradesPerYear = trades.length > 0 ? trades.length / spanYears : 50;
  const perTradePctReturns = trades.map(t => t.pnlPct || 0);
  const significance = assessSignificance(perTradePctReturns, {
    tradesPerYear,
    totalReturnPct: totalReturn,
    maxDrawdownPct: maxDD,
    days: spanDays,
    bootstrapIters: perTradePctReturns.length >= 10 ? 1000 : 0,
    confidence: 0.95,
  });

  // Standalone Calmar ratio on the full backtest — even when there aren't
  // enough trades for t-stat significance, Calmar is still a meaningful
  // ratio because it's computed from the equity curve (which always has
  // enough points). Dashboards show it next to Sharpe as a sanity check.
  const calmar = calmarFn(totalReturn, maxDD, spanDays);

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  // ─── Benchmark (SPY by default; QQQ / IWM / DIA when caller picks) ──────
  // Variable kept named spyBenchmark for diff hygiene with the rest of
  // the function; the symbol it represents is whatever the caller asked
  // for. The result.benchmark field below carries the symbol explicitly.
  const spyBenchmark = calcBenchmark(startDate, endDate, benchmark);
  const alpha = spyBenchmark
    ? +(totalReturn - spyBenchmark.totalReturn).toFixed(2)
    : null;

  // ─── Macro context (FRED) ───────────────────────────────────────────────
  // Attach a regime-tagged summary of the macro environment that actually
  // prevailed over the replay window. Pure diagnostic — it does NOT feed into
  // trade selection (the replay already happened), but it lets the UI surface
  // "you optimized against a 2020 crash, not a 2023 bull run" before the user
  // acts on these numbers. Fails soft on DBs without the macro_series table.
  let macroContext = null;
  try {
    macroContext = macroFred().getMacroContextForRange(startDate, endDate);
  } catch (_) { /* no macro table or out-of-coverage window — UI hides the card */ }

  // ─── Per-regime performance breakdown (2026-04) ─────────────────────────
  // Segment closed trades by the macro regime on their entry date. A blended
  // "win rate = 48%" across all regimes hides the truth that most strategies
  // crush in BULL and bleed in NEUTRAL/CAUTION. This table exposes that so the
  // user can pick strategies conditionally on the regime the system forecasts.
  //
  // Win rate, expectancy, PF, and avg R are computed on the slice of trades
  // whose entryRegime matches each bucket. Buckets with zero trades are still
  // returned (with n:0) so the UI can render a stable 4-column table.
  const regimePerf = (() => {
    const buckets = { BULL: [], NEUTRAL: [], CAUTION: [], CORRECTION: [], UNKNOWN: [] };
    for (const t of trades) {
      const key = (t.entryRegime || 'UNKNOWN').toUpperCase();
      (buckets[key] || (buckets.UNKNOWN)).push(t);
    }
    const out = {};
    for (const [regime, group] of Object.entries(buckets)) {
      if (!group.length) { out[regime] = { n: 0, winRate: 0, avgR: 0, expectancy: 0, profitFactor: 0, totalPnl: 0 }; continue; }
      const wins    = group.filter(t => t.pnl > 0);
      const losses  = group.filter(t => t.pnl <= 0);
      const winSum  = wins.reduce((a, t) => a + t.pnl, 0);
      const lossSum = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
      const pfVal   = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? Infinity : 0);
      const avgWin  = wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
      const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;
      const wr      = group.length ? wins.length / group.length : 0;
      const expct   = wr * avgWin + (1 - wr) * avgLoss;
      const rSum    = group.reduce((a, t) => a + ((t.pnlPct || 0) / (t.atrPct || 2.5)), 0);
      out[regime] = {
        n: group.length,
        winRate: +(wr * 100).toFixed(1),
        avgWin: +avgWin.toFixed(2),
        avgLoss: +avgLoss.toFixed(2),
        expectancy: +expct.toFixed(2),
        profitFactor: Number.isFinite(pfVal) ? +pfVal.toFixed(2) : pfVal,
        avgR: +(rSum / group.length).toFixed(2),
        totalPnl: +group.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2),
      };
    }
    return out;
  })();

  // ─── Persist replay result ───────────────────────────────────────────────

  let replayId = null;
  if (persistResult) {
    // Persist enough of the result blob that the history "VIEW" button can
    // reconstruct the SAME panels a fresh run shows — previously the blob
    // omitted executionCosts / regimeBreakdown / regimeDayCounts / side, so
    // viewing a replay from history silently dropped 4 panels and showed
    // any short replay with side='long' (the UI default fallback).
    const persistBlob = {
      trades, equityCurve, exitReasons, spyBenchmark, macroContext, significance,
      side: isShort ? 'short' : 'long',
      regimeBreakdown: regimePerf,
      regimeDayCounts: regimeStats,
      performance: {
        calmarRatio: Number.isFinite(calmar) ? +calmar.toFixed(3) : null,
        calmarRatioInfinite: !Number.isFinite(calmar) && totalReturn > 0 && maxDD === 0,
      },
      executionCosts: {
        totalSlippage: +totalSlippageCost.toFixed(2),
        slippageAsReturnDrag: +(totalSlippageCost / initialCapital * 100).toFixed(3),
        totalCommission: +totalCommissionCost.toFixed(2),
        commissionAsReturnDrag: +(totalCommissionCost / initialCapital * 100).toFixed(3),
        commissionPerShare,
        skippedGaps, skippedSurvivorship, skippedNextDay,
        entrySlippageBps: exec.entrySlippageBps,
        exitSlippageBps:  exec.exitSlippageBps,
        maxGapPct:        exec.maxGapPct,
        nextDayEntry:     exec.nextDayEntry,
        nextDayOpenGapBps:      exec.nextDayOpenGapBps,
        cashDragAnnualBps:      exec.cashDragAnnualBps,
        dividendYieldAnnualBps: exec.dividendYieldAnnualBps,
        totalCashInterest: +totalCashInterest.toFixed(2),
        totalDividends:    +totalDividends.toFixed(2),
        cashInterestAsReturnBoost: +(totalCashInterest / initialCapital * 100).toFixed(3),
        dividendsAsReturnBoost:    +(totalDividends   / initialCapital * 100).toFixed(3),
      },
    };
    replayId = db().prepare(`
      INSERT INTO replay_results (strategy, params, start_date, end_date, initial_capital,
        final_equity, total_return, total_trades, win_rate, profit_factor, max_drawdown, sharpe_ratio, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategy, JSON.stringify(mergedParams), startDate, endDate, initialCapital,
      finalEquity, +totalReturn.toFixed(2), trades.length, +winRate.toFixed(1),
      profitFactor, +maxDD.toFixed(2), sharpe,
      JSON.stringify(persistBlob)
    ).lastInsertRowid;
  }

  return {
    id: replayId,
    strategy: stratDef.name,
    strategyKey: strategy,
    params: mergedParams,
    side: isShort ? 'short' : 'long',
    period: { startDate, endDate, tradingDays: dates.length },
    performance: {
      initialCapital, finalEquity: +finalEquity.toFixed(2),
      totalReturn: +totalReturn.toFixed(2),
      maxDrawdown: +maxDD.toFixed(2),
      sharpeRatio: sharpe,
      // Phase 2.7: Calmar as a Sharpe-free pain-adjusted return ratio.
      // Express's res.json serializes JS Infinity as `null`, so a separate
      // boolean signals zero-drawdown winners — the UI renders ∞ when this
      // is true. Without the flag, every infinite-Calmar run silently
      // displayed as "N/A" because the UI's `=== Infinity` check never
      // matched the post-serialization null.
      calmarRatio: Number.isFinite(calmar) ? +calmar.toFixed(3) : null,
      calmarRatioInfinite: !Number.isFinite(calmar) && totalReturn > 0 && maxDD === 0,
      profitFactor,
      alpha,
    },
    // Phase 2.7: full significance report — t-stat, p-value, bootstrap CIs,
    // verdict flag. The UI gates the "significant" badge on
    // `significance.isSignificant` and shows `significance.reason` on hover.
    significance,
    benchmark: spyBenchmark ? {
      symbol: benchmark,
      // Field names kept as `spy*` for back-compat with the existing UI;
      // the `symbol` field disambiguates when benchmark != SPY.
      spyReturn: spyBenchmark.totalReturn,
      spyMaxDrawdown: spyBenchmark.maxDrawdown,
      spySharpe: spyBenchmark.sharpeRatio,
      outperformed: totalReturn > spyBenchmark.totalReturn,
      spyEquityCurve: spyBenchmark.equityCurve,
    } : null,
    executionCosts: {
      totalSlippage: +totalSlippageCost.toFixed(2),
      slippageAsReturnDrag: +(totalSlippageCost / initialCapital * 100).toFixed(3),
      // Per-share commission cost — defaults to 0 (most retail brokers).
      // Surface even when zero so the UI can render the column predictably.
      totalCommission: +totalCommissionCost.toFixed(2),
      commissionAsReturnDrag: +(totalCommissionCost / initialCapital * 100).toFixed(3),
      commissionPerShare,
      skippedGaps,
      skippedSurvivorship,
      skippedNextDay,
      entrySlippageBps: exec.entrySlippageBps,
      exitSlippageBps: exec.exitSlippageBps,
      maxGapPct: exec.maxGapPct,
      nextDayEntry: exec.nextDayEntry,
      // Phase 2.6 reporting — each of these is a dollar delta that
      // the backtest engine applied to capital during the simulation.
      // Positive = tailwind (cash interest, long dividends received),
      // negative = headwind (short dividends paid).
      nextDayOpenGapBps: exec.nextDayOpenGapBps,
      cashDragAnnualBps: exec.cashDragAnnualBps,
      dividendYieldAnnualBps: exec.dividendYieldAnnualBps,
      totalCashInterest: +totalCashInterest.toFixed(2),
      totalDividends: +totalDividends.toFixed(2),
      cashInterestAsReturnBoost: +(totalCashInterest / initialCapital * 100).toFixed(3),
      dividendsAsReturnBoost: +(totalDividends / initialCapital * 100).toFixed(3),
    },
    trades: {
      total: trades.length,
      wins: totalWins,
      losses: totalLosses,
      winRate: +winRate.toFixed(1),
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      avgR,
      exitReasons,
    },
    tradeLog: trades,
    equityCurve: equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 100)) === 0 || i === equityCurve.length - 1),
    regimeBreakdown: regimePerf,
    regimeDayCounts: regimeStats,
    macroContext,
  };
}

// ─── Walk-Forward Optimization ────────────────────────────────────────────
// Splits the date range into rolling train/test windows. For each window:
//   1. Sweep paramGrid on the train slice, pick the params that maximize the
//      chosen metric (sharpe / totalReturn / profitFactor).
//   2. Apply those "best" params to the next test slice — pure out-of-sample.
//   3. Roll forward by testDays.
// Final OOS stats concatenate the test trades from every window so you see
// what the strategy would have *actually* produced if you re-tuned on a
// schedule. Also reports parameter stability across windows — high churn in
// the winning params is a red flag for overfitting.

function cartesianProduct(grid) {
  const keys = Object.keys(grid);
  if (!keys.length) return [{}];
  const values = keys.map(k => Array.isArray(grid[k]) ? grid[k] : [grid[k]]);
  const out = [];
  function recurse(idx, acc) {
    if (idx === keys.length) { out.push({ ...acc }); return; }
    for (const v of values[idx]) {
      acc[keys[idx]] = v;
      recurse(idx + 1, acc);
    }
  }
  recurse(0, {});
  return out;
}

const WF_VALID_METRICS = ['sharpeRatio', 'totalReturn', 'profitFactor'];
const WF_MAX_COMBOS = 256;

async function runWalkForward({
  strategy,
  startDate,
  endDate,
  trainDays = 120,
  testDays = 60,
  paramGrid = {},
  optimizeMetric = 'sharpeRatio',
  maxPositions = 10,
  initialCapital = 100000,
  execution = {},
  // Forwarded to runReplay so the form-level Mode dropdown (swing/position)
  // applies to walk-forward windows. Without this, the engine ran every
  // window in default mode regardless of UI selection.
  tradeMode,
}) {
  const stratDef = BUILT_IN_STRATEGIES[strategy];
  if (!stratDef) throw new Error(`Unknown strategy: ${strategy}`);
  if (!WF_VALID_METRICS.includes(optimizeMetric)) {
    throw new Error(`optimizeMetric must be one of: ${WF_VALID_METRICS.join(', ')}`);
  }

  const combos = cartesianProduct(paramGrid);
  if (combos.length > WF_MAX_COMBOS) {
    throw new Error(`Param grid produces ${combos.length} combinations (max ${WF_MAX_COMBOS}). Reduce the grid.`);
  }

  // Use rs_snapshots dates as the calendar (replay engine reads from there)
  const allDates = db().prepare(`
    SELECT DISTINCT date FROM rs_snapshots
    WHERE type = 'stock' AND date >= ? AND date <= ?
    ORDER BY date
  `).all(startDate, endDate).map(r => r.date);

  if (allDates.length < trainDays + testDays) {
    throw new Error(`Not enough data: ${allDates.length} trading days available, need at least ${trainDays + testDays}`);
  }

  // Build rolling windows
  const windows = [];
  let cursor = 0;
  while (cursor + trainDays + testDays <= allDates.length) {
    windows.push({
      trainStart: allDates[cursor],
      trainEnd:   allDates[cursor + trainDays - 1],
      testStart:  allDates[cursor + trainDays],
      testEnd:    allDates[cursor + trainDays + testDays - 1],
    });
    cursor += testDays;
  }

  if (!windows.length) {
    throw new Error('No walk-forward windows could be built from the given range and window sizes');
  }

  const windowResults = [];
  const allTestTrades = [];
  let runEquity = initialCapital;
  const oosEquityCurve = [{ date: windows[0].testStart, equity: runEquity }];

  // Each window evaluates `combos.length` training replays + 1 test replay.
  // A single replay = 100-500ms of synchronous CPU. Without yields, a 5-window
  // × 9-combo WF blocks the event loop for ~25s solid — long enough to break
  // node-cron (1s missed-tick threshold) and freeze the UI for any tab the
  // user navigates to. Yield between every combo to keep the server live.
  let comboCounter = 0;
  for (const w of windows) {
    let best = null;
    const trainScores = [];

    for (const params of combos) {
      let trainResult;
      try {
        trainResult = runReplay({
          strategy, tradeMode, params,
          startDate: w.trainStart, endDate: w.trainEnd,
          maxPositions, initialCapital, execution,
          persistResult: false,
        });
      } catch (e) {
        trainScores.push({ params, error: e.message });
        continue;
      }
      const score = trainResult.performance?.[optimizeMetric];
      const safeScore = Number.isFinite(score) ? score : -Infinity;
      trainScores.push({ params, score: safeScore, trades: trainResult.trades?.total || 0 });
      if (!best || safeScore > best.score) {
        best = { score: safeScore, params, trainResult };
      }
      if ((++comboCounter % 2) === 0) await new Promise(r => setImmediate(r));
    }

    if (!best) {
      windowResults.push({ ...w, error: 'No valid params produced a result on training window' });
      continue;
    }

    // Apply the winning params to the held-out test window
    const testResult = runReplay({
      strategy, tradeMode, params: best.params,
      startDate: w.testStart, endDate: w.testEnd,
      maxPositions, initialCapital, execution,
      persistResult: false,
    });
    await new Promise(r => setImmediate(r));

    if (testResult.tradeLog?.length) allTestTrades.push(...testResult.tradeLog);

    // Compound running OOS equity using the window's return
    const winReturnPct = testResult.performance?.totalReturn || 0;
    runEquity = runEquity * (1 + winReturnPct / 100);
    oosEquityCurve.push({ date: w.testEnd, equity: +runEquity.toFixed(2) });

    windowResults.push({
      trainStart: w.trainStart, trainEnd: w.trainEnd,
      testStart:  w.testStart,  testEnd:  w.testEnd,
      bestParams: best.params,
      trainScore: +Number(best.score).toFixed(3),
      // Full training-score surface for this window — every combo that was
      // evaluated, with its score on the training slice. Used by the UI
      // heatmap to reveal the shape of the optimizer's search, not just
      // the single winning point. Small — O(combos) per window, and combos
      // is already capped at WF_MAX_COMBOS = 256.
      trainScores: trainScores.map(ts => ({
        params: ts.params,
        score:  Number.isFinite(ts.score) ? +ts.score.toFixed(3) : null,
        trades: ts.trades ?? null,
        error:  ts.error || null,
      })),
      testReturn:    testResult.performance?.totalReturn ?? null,
      testSharpe:    testResult.performance?.sharpeRatio ?? null,
      testMaxDD:     testResult.performance?.maxDrawdown ?? null,
      testTrades:    testResult.trades?.total ?? 0,
      testWinRate:   testResult.trades?.winRate ?? null,
      testAlpha:     testResult.performance?.alpha ?? null,
    });
  }

  // Per-window macro regime annotation — runs AFTER the main loop so the
  // hot path stays untouched. We call getMacroContextForRange once per
  // test window, which is one sqlite read per daily series. Fail-soft: on
  // any error the window just doesn't get a regime and the UI hides the
  // color swatch for that bar.
  for (const wr of windowResults) {
    if (!wr.testStart || !wr.testEnd) continue;
    try {
      const ctx = macroFred().getMacroContextForRange(wr.testStart, wr.testEnd);
      if (ctx && ctx.regime) wr.regime = ctx.regime;
    } catch (_) { /* macro_series missing — leave regime undefined */ }
  }

  // ─── Aggregate out-of-sample stats ───────────────────────────────────────
  const finalReturn = ((runEquity / initialCapital) - 1) * 100;
  const wins = allTestTrades.filter(t => t.pnl > 0).length;
  const losses = allTestTrades.length - wins;
  const winRate = allTestTrades.length ? (wins / allTestTrades.length) * 100 : 0;
  const avgWin = wins
    ? allTestTrades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnlPct, 0) / wins
    : 0;
  const avgLoss = losses
    ? allTestTrades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnlPct, 0) / losses
    : 0;
  const grossProfit = allTestTrades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(allTestTrades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? Infinity : 0;

  // OOS max drawdown (across compounded window curve)
  let peak = initialCapital, maxDD = 0;
  for (const p of oosEquityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = ((peak - p.equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // OOS Sharpe — derived from the compounded per-window equity curve.
  // Without this, both the engine response and the WF history table left
  // sharpe undefined/null. Window-level returns aren't daily, so we
  // annualize using sqrt(testWindowsPerYear) where testWindowsPerYear =
  // 252 / testDays, matching how each window's totalReturn is generated.
  const oosWindowReturns = [];
  for (let i = 1; i < oosEquityCurve.length; i++) {
    const prev = oosEquityCurve[i - 1].equity;
    const cur  = oosEquityCurve[i].equity;
    if (prev > 0) oosWindowReturns.push((cur / prev) - 1);
  }
  const oosAvgRet = oosWindowReturns.length
    ? oosWindowReturns.reduce((a, b) => a + b, 0) / oosWindowReturns.length
    : 0;
  const oosStdRet = oosWindowReturns.length > 1
    ? Math.sqrt(oosWindowReturns.reduce((a, r) => a + (r - oosAvgRet) ** 2, 0) / (oosWindowReturns.length - 1))
    : 0;
  const windowsPerYear = testDays > 0 ? 252 / testDays : 0;
  const oosSharpe = oosStdRet > 0 && windowsPerYear > 0
    ? +((oosAvgRet / oosStdRet) * Math.sqrt(windowsPerYear)).toFixed(2)
    : 0;

  // Parameter stability — how often did each param combo win?
  const stability = {};
  for (const w of windowResults) {
    if (!w.bestParams) continue;
    const key = JSON.stringify(w.bestParams);
    stability[key] = (stability[key] || 0) + 1;
  }
  const stabilityList = Object.entries(stability)
    .map(([k, count]) => ({ params: JSON.parse(k), windows: count, share: +(count / windows.length * 100).toFixed(1) }))
    .sort((a, b) => b.windows - a.windows);

  // SPY benchmark over the *out-of-sample* span (first test start → last test end)
  const oosStart = windows[0].testStart;
  const oosEnd = windows[windows.length - 1].testEnd;
  const spy = calcBenchmark(oosStart, oosEnd, 'SPY');
  const alpha = spy ? +(finalReturn - spy.totalReturn).toFixed(2) : null;

  // Macro context across the OOS span (NOT the full train+test range — the
  // OOS equity curve is what the user evaluates, and that's the window that
  // should be tagged with the prevailing regime).
  let macroContext = null;
  try {
    macroContext = macroFred().getMacroContextForRange(oosStart, oosEnd);
  } catch (_) { /* no macro table — UI hides the card */ }

  return {
    strategy,
    strategyName: stratDef.name,
    config: {
      startDate, endDate,
      trainDays, testDays,
      paramGrid, optimizeMetric,
      combos: combos.length,
      windowsTested: windows.length,
      maxPositions, initialCapital,
    },
    outOfSample: {
      startDate: oosStart,
      endDate: oosEnd,
      finalEquity: +runEquity.toFixed(2),
      totalReturn: +finalReturn.toFixed(2),
      maxDrawdown: +maxDD.toFixed(2),
      // OOS Sharpe is computed from the compounded per-window equity curve
      // above. Previously the engine returned this as undefined and
      // saveWFResult silently bound NULL into oos_sharpe — every WF history
      // row showed an empty Sharpe column.
      sharpeRatio: oosSharpe,
      profitFactor,
      tradeCount: allTestTrades.length,
      winRate: +winRate.toFixed(1),
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      alpha,
      spyReturn: spy?.totalReturn ?? null,
      outperformedSPY: spy ? finalReturn > spy.totalReturn : null,
      // Full SPY equity curve over the OOS span, normalized to the same
      // initialCapital as the strategy run so the UI can overlay it
      // directly on top of oosEquityCurve without rescaling.
      spyEquityCurve: spy?.equityCurve
        ? spy.equityCurve.map(p => ({
            date: p.date,
            equity: +(initialCapital * (p.equity / 100000)).toFixed(2),
          }))
        : null,
    },
    windows: windowResults,
    parameterStability: stabilityList,
    oosEquityCurve,
    oosTrades: allTestTrades,
    macroContext,
  };
}

// ─── Monte Carlo Simulation ───────────────────────────────────────────────
// Takes a list of trades (or a stored replayId) and resamples to reveal how
// much of the headline result was order-dependent vs structural edge.
//
//   permutation = shuffle the actual trades; same edge, different sequence
//                 → answers "how much did luck of ordering shape my drawdown?"
//   bootstrap   = sample with replacement from the pnlPct distribution
//                 → answers "given this distribution, what's the range of
//                   plausible outcomes if I rerun this strategy 1000 times?"
//
// Each trade is applied as fraction `positionFraction` of current equity using
// its pnlPct. This deliberately ignores the original capital allocation
// because we want to compare *sequences* of returns, not re-derive sizing.

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function runMonteCarlo({
  replayId = null,
  trades = null,
  iterations = 1000,
  method = 'permutation',
  positionFraction = 0.10,
  initialCapital = 100000,
}) {
  if (!['permutation', 'bootstrap'].includes(method)) {
    throw new Error(`method must be 'permutation' or 'bootstrap'`);
  }
  if (iterations < 50 || iterations > 10000) {
    throw new Error('iterations must be between 50 and 10000');
  }
  if (positionFraction <= 0 || positionFraction > 1) {
    throw new Error('positionFraction must be in (0, 1]');
  }

  // Resolve trade list (and the date range that produced it, so we can tag
  // the MC result with the same macro context the original replay was run
  // under).
  let tradeList = trades;
  let mcStartDate = null;
  let mcEndDate = null;
  if (replayId != null) {
    const saved = getReplayResult(replayId);
    if (!saved) throw new Error(`Replay ${replayId} not found`);
    tradeList = saved.result?.trades || [];
    mcStartDate = saved.start_date || null;
    mcEndDate   = saved.end_date   || null;
  }
  if (!Array.isArray(tradeList) || tradeList.length === 0) {
    throw new Error('No trades available to simulate');
  }
  // If caller passed `trades` directly (no replayId), infer the window from
  // the trade log itself — min entry → max exit. Lets `trades: […]` callers
  // get a macro card without having to also pass dates.
  if (!mcStartDate || !mcEndDate) {
    const entries = tradeList.map(t => t.entryDate).filter(Boolean).sort();
    const exits   = tradeList.map(t => t.exitDate).filter(Boolean).sort();
    if (entries.length) mcStartDate = mcStartDate || entries[0];
    if (exits.length)   mcEndDate   = mcEndDate   || exits[exits.length - 1];
  }

  const pnlPcts = tradeList
    .map(t => t.pnlPct)
    .filter(v => Number.isFinite(v));

  if (pnlPcts.length < 5) {
    throw new Error(`Need at least 5 trades for Monte Carlo (got ${pnlPcts.length})`);
  }

  // Originating "as-actually-traded" curve for reference
  function simulate(sequence) {
    let equity = initialCapital;
    let peak = equity;
    let maxDD = 0;
    let consecutiveLosses = 0, maxConsecutiveLosses = 0;
    const tradeReturns = [];
    for (const pct of sequence) {
      const change = equity * positionFraction * (pct / 100);
      const prev = equity;
      equity += change;
      tradeReturns.push((equity - prev) / prev);
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
      if (pct <= 0) {
        consecutiveLosses++;
        if (consecutiveLosses > maxConsecutiveLosses) maxConsecutiveLosses = consecutiveLosses;
      } else {
        consecutiveLosses = 0;
      }
    }
    const finalReturn = ((equity / initialCapital) - 1) * 100;
    const avg = tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length;
    const variance = tradeReturns.reduce((a, r) => a + (r - avg) ** 2, 0) / Math.max(1, tradeReturns.length - 1);
    const stdev = Math.sqrt(variance);
    const sharpe = stdev > 0 ? (avg / stdev) * Math.sqrt(tradeReturns.length) : 0;
    return { finalReturn, maxDD, sharpe, maxConsecutiveLosses };
  }

  // Baseline (original ordering)
  const baseline = simulate(pnlPcts);

  // Run iterations
  const finals = [], dds = [], sharpes = [], streaks = [];
  for (let it = 0; it < iterations; it++) {
    let sample;
    if (method === 'bootstrap') {
      sample = new Array(pnlPcts.length);
      for (let i = 0; i < pnlPcts.length; i++) {
        sample[i] = pnlPcts[Math.floor(Math.random() * pnlPcts.length)];
      }
    } else {
      // Fisher–Yates shuffle
      sample = pnlPcts.slice();
      for (let i = sample.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sample[i], sample[j]] = [sample[j], sample[i]];
      }
    }
    const r = simulate(sample);
    finals.push(r.finalReturn);
    dds.push(r.maxDD);
    sharpes.push(r.sharpe);
    streaks.push(r.maxConsecutiveLosses);
  }

  finals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  sharpes.sort((a, b) => a - b);
  streaks.sort((a, b) => a - b);

  function summarize(sorted, decimals = 2) {
    const round = v => +Number(v).toFixed(decimals);
    return {
      p5:   round(percentile(sorted, 0.05)),
      p25:  round(percentile(sorted, 0.25)),
      p50:  round(percentile(sorted, 0.50)),
      p75:  round(percentile(sorted, 0.75)),
      p95:  round(percentile(sorted, 0.95)),
      mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      min:  round(sorted[0]),
      max:  round(sorted[sorted.length - 1]),
    };
  }

  // Where does the original (as-traded) result land in the distribution?
  function rankIn(sorted, value) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < value) lo = mid + 1; else hi = mid;
    }
    return +(lo / sorted.length * 100).toFixed(1);
  }

  // Note: under PERMUTATION, finalReturn and per-trade Sharpe are
  // order-invariant (compounding is commutative; mean/std of returns is
  // unchanged by reordering). Only path-dependent metrics — max drawdown
  // and longest losing streak — meaningfully vary. We surface this so the
  // UI can hide the degenerate distribution rather than mislead.
  const finalReturnIsDeterministic = method === 'permutation';

  // Macro context for the MC source window (whichever we were able to
  // resolve above). Same fail-soft contract as runReplay/runWalkForward.
  let macroContext = null;
  if (mcStartDate && mcEndDate) {
    try {
      macroContext = macroFred().getMacroContextForRange(mcStartDate, mcEndDate);
    } catch (_) { /* UI hides the card */ }
  }

  return {
    method,
    iterations,
    positionFraction,
    initialCapital,
    tradeCount: pnlPcts.length,
    sourceReplayId: replayId,
    finalReturnIsDeterministic,
    baseline: {
      finalReturn: +baseline.finalReturn.toFixed(2),
      maxDrawdown: +baseline.maxDD.toFixed(2),
      sharpe: +baseline.sharpe.toFixed(3),
      maxConsecutiveLosses: baseline.maxConsecutiveLosses,
    },
    baselinePercentile: {
      finalReturn: finalReturnIsDeterministic ? null : rankIn(finals, baseline.finalReturn),
      maxDrawdown: rankIn(dds, baseline.maxDD),
    },
    finalReturn:   summarize(finals),
    maxDrawdown:   summarize(dds),
    sharpe:        summarize(sharpes, 3),
    losingStreak:  summarize(streaks, 0),
    profitableScenariosPct: +(finals.filter(v => v > 0).length / finals.length * 100).toFixed(1),
    macroContext,
    // Sub-sampled equity curves for plotting (5 representative paths)
    samplePaths: (() => {
      const paths = [];
      for (let i = 0; i < 5; i++) {
        const sample = pnlPcts.slice();
        for (let j = sample.length - 1; j > 0; j--) {
          const k = Math.floor(Math.random() * (j + 1));
          [sample[j], sample[k]] = [sample[k], sample[j]];
        }
        let eq = initialCapital;
        const curve = [eq];
        for (const pct of sample) {
          eq += eq * positionFraction * (pct / 100);
          curve.push(+eq.toFixed(2));
        }
        paths.push(curve);
      }
      return paths;
    })(),
  };
}

// ─── Compare Strategies ────────────────────────────────────────────────────

function compareStrategies({ strategies, startDate, endDate, maxPositions = 10, initialCapital = 100000, tradeMode }) {
  const results = [];
  for (const { strategy, params } of strategies) {
    try {
      const result = runReplay({ strategy, tradeMode, params, startDate, endDate, maxPositions, initialCapital });
      results.push(result);
    } catch (e) {
      results.push({ strategy, error: e.message });
    }
  }

  // Rank by total return
  results.sort((a, b) => (b.performance?.totalReturn || -Infinity) - (a.performance?.totalReturn || -Infinity));

  // Cross-strategy regime winner table — for each regime, which strategy had
  // the highest expectancy on trades entered during that regime? This is the
  // answer to "which strategy should I lean on in a CAUTION tape?"
  const REGIMES = ['BULL', 'NEUTRAL', 'CAUTION', 'CORRECTION'];
  const regimeWinners = {};
  for (const regime of REGIMES) {
    const ranked = results
      .filter(r => r?.regimeBreakdown?.[regime]?.n > 0)
      .map(r => ({
        strategy:    r.strategy,
        strategyKey: r.strategyKey,
        n:           r.regimeBreakdown[regime].n,
        winRate:     r.regimeBreakdown[regime].winRate,
        expectancy:  r.regimeBreakdown[regime].expectancy,
        profitFactor: r.regimeBreakdown[regime].profitFactor,
        avgR:        r.regimeBreakdown[regime].avgR,
      }))
      .sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity));
    regimeWinners[regime] = ranked;
  }

  return {
    comparisons: results,
    period: { startDate, endDate },
    tradeMode: tradeMode || 'all',
    rankedBy: 'totalReturn',
    regimeWinners,
  };
}

// ─── Replay History ────────────────────────────────────────────────────────

function getReplayHistory(limit = 20) {
  return db().prepare(`
    SELECT id, strategy, params, start_date, end_date, initial_capital,
      final_equity, total_return, total_trades, win_rate, profit_factor,
      max_drawdown, sharpe_ratio, created_at
    FROM replay_results
    ORDER BY created_at DESC LIMIT ?
  `).all(limit).map(r => ({ ...r, params: JSON.parse(r.params) }));
}

function getReplayResult(id) {
  const row = db().prepare('SELECT * FROM replay_results WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    params: JSON.parse(row.params),
    result: JSON.parse(row.result),
  };
}

function deleteReplayResult(id) {
  db().prepare('DELETE FROM replay_results WHERE id = ?').run(id);
}

// ─── Monte Carlo Persistence ─────────────────────────────────────────────

function saveMCResult(replayId, mcResult) {
  const strategy = mcResult.strategyName || null;
  return db().prepare(`
    INSERT INTO mc_results (replay_id, strategy, method, iterations, trade_count,
      baseline_return, baseline_drawdown, median_return, median_drawdown, profitable_pct, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    replayId, strategy, mcResult.method, mcResult.iterations, mcResult.tradeCount,
    mcResult.baseline?.finalReturn, mcResult.baseline?.maxDrawdown,
    mcResult.finalReturn?.p50 ?? mcResult.baseline?.finalReturn,
    mcResult.maxDrawdown?.p50, mcResult.profitableScenariosPct,
    JSON.stringify(mcResult)
  ).lastInsertRowid;
}

function getMCHistory(limit = 10) {
  return db().prepare(`
    SELECT mc.id, mc.replay_id, mc.strategy, mc.method, mc.iterations, mc.trade_count,
      mc.baseline_return, mc.baseline_drawdown, mc.median_return, mc.median_drawdown,
      mc.profitable_pct, mc.created_at,
      rr.start_date, rr.end_date
    FROM mc_results mc
    LEFT JOIN replay_results rr ON mc.replay_id = rr.id
    ORDER BY mc.created_at DESC LIMIT ?
  `).all(limit);
}

function getMCResult(id) {
  const row = db().prepare('SELECT * FROM mc_results WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, result: JSON.parse(row.result) };
}

function deleteMCResult(id) {
  db().prepare('DELETE FROM mc_results WHERE id = ?').run(id);
}

// ─── Walk-Forward Persistence ────────────────────────────────────────────

function saveWFResult(wfResult) {
  return db().prepare(`
    INSERT INTO wf_results (strategy, start_date, end_date, train_days, test_days,
      optimize_metric, oos_return, oos_max_dd, oos_sharpe, oos_trades, oos_win_rate,
      alpha, windows_tested, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    wfResult.strategyName, wfResult.config?.startDate || '', wfResult.config?.endDate || '',
    wfResult.config?.trainDays, wfResult.config?.testDays, wfResult.config?.optimizeMetric,
    wfResult.outOfSample?.totalReturn, wfResult.outOfSample?.maxDrawdown,
    wfResult.outOfSample?.sharpeRatio, wfResult.outOfSample?.tradeCount,
    wfResult.outOfSample?.winRate, wfResult.outOfSample?.alpha,
    wfResult.config?.windowsTested, JSON.stringify(wfResult)
  ).lastInsertRowid;
}

function getWFHistory(limit = 10) {
  return db().prepare(`
    SELECT id, strategy, start_date, end_date, train_days, test_days, optimize_metric,
      oos_return, oos_max_dd, oos_sharpe, oos_trades, oos_win_rate, alpha,
      windows_tested, created_at
    FROM wf_results ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

function getWFResult(id) {
  const row = db().prepare('SELECT * FROM wf_results WHERE id = ?').get(id);
  if (!row) return null;
  // Return the saved result payload with the DB id attached, matching the
  // shape returned by runWalkForward() so the UI can re-render identically
  // whether loading from history or viewing a fresh run. Previously this
  // returned { ...row, result: parsed } which nested the payload inside
  // .result and broke the UI (wfResult.outOfSample was undefined).
  let payload = {};
  try { payload = JSON.parse(row.result); } catch (_) {}
  return { ...payload, id: row.id, savedAt: row.created_at };
}

function deleteWFResult(id) {
  db().prepare('DELETE FROM wf_results WHERE id = ?').run(id);
}

module.exports = {
  BUILT_IN_STRATEGIES,
  computeMAsForPriceSeries,    // exported for unit testing
  getAvailableDateRange,
  getMacroSnapshotForDate,
  runReplay,
  runWalkForward,
  runMonteCarlo,
  compareStrategies,
  ensureBenchmarkLoaded,
  calcBenchmark,
  getReplayHistory,
  getReplayResult,
  deleteReplayResult,
  saveMCResult,
  getMCHistory,
  getMCResult,
  deleteMCResult,
  saveWFResult,
  getWFHistory,
  getWFResult,
  deleteWFResult,
};
