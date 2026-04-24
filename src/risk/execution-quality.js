// ─── Execution Quality Tracker ───────────────────────────────────────────────
// Measures the gap between theoretical and actual trade execution.
// For a momentum strategy, execution cost is often the difference between
// a profitable system and a losing one.
//
// Tracks:
//   1. Slippage: intended price vs actual fill price
//   2. Fill quality: where in the day's range did you fill?
//   3. Execution cost: total friction per trade
//   4. Liquidity analysis: did your order move the market?
//   5. Timing cost: delay between signal and execution

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Log an Execution Event ─────────────────────────────────────────────────
// Called after every fill to record execution quality data.

function logExecution(params) {
  const {
    tradeId,
    symbol,
    side,                    // buy | sell
    intendedPrice,           // what we planned to trade at
    fillPrice,               // what we actually got
    shares,
    orderType,               // limit | market | stop | stop_limit
    signalDate,              // when the signal fired
    orderDate,               // when the order was placed
    fillDate,                // when the order filled
    dayHigh,                 // intraday high at fill time
    dayLow,                  // intraday low at fill time
    dayOpen,                 // day's open price
    dayClose,                // day's close price
    avgDailyVolume,
    dayVolume,
  } = params;

  // Slippage — cost convention: POSITIVE = bad (cost to me), NEGATIVE = favorable.
  //   buy  at 100.05 vs intent 100.00 → slippage = +0.05 (I paid MORE)
  //   sell at  99.95 vs intent 100.00 → slippage = +0.05 (I received LESS)
  // Everything downstream (predictSlippage, warnings, UI) must agree on this.
  // If you flip this, flip every consumer — there is no "both directions are fine."
  const slippage = side === 'buy'
    ? fillPrice - intendedPrice    // paid more = positive (bad)
    : intendedPrice - fillPrice;   // received less = positive (bad)
  const slippagePct = intendedPrice > 0 ? (slippage / intendedPrice) * 100 : 0;

  // Fill quality: where in the day's range did we fill?
  // 0% = worst (bought at high, sold at low), 100% = best
  let fillQuality = null;
  if (dayHigh && dayLow && dayHigh > dayLow) {
    if (side === 'buy') {
      fillQuality = ((dayHigh - fillPrice) / (dayHigh - dayLow)) * 100;
    } else {
      fillQuality = ((fillPrice - dayLow) / (dayHigh - dayLow)) * 100;
    }
    fillQuality = Math.max(0, Math.min(100, fillQuality));
  }

  // Timing cost: delay between signal and fill
  let timingDelayDays = null;
  if (signalDate && fillDate) {
    const signalMs = new Date(signalDate).getTime();
    const fillMs = new Date(fillDate).getTime();
    timingDelayDays = Math.round((fillMs - signalMs) / (1000 * 60 * 60 * 24));
  }

  // Market impact estimate (participation rate)
  const participationRate = avgDailyVolume > 0 ? shares / avgDailyVolume : null;

  // Implementation shortfall: total cost vs hypothetical "paper" trade at signal price
  const notional = shares * fillPrice;
  const theoreticalNotional = shares * intendedPrice;
  const implementationShortfall = side === 'buy'
    ? notional - theoreticalNotional
    : theoreticalNotional - notional;
  const implementationShortfallPct = theoreticalNotional > 0
    ? (implementationShortfall / theoreticalNotional) * 100 : 0;

  const record = {
    trade_id: tradeId,
    symbol,
    side,
    intended_price: intendedPrice,
    fill_price: fillPrice,
    shares,
    order_type: orderType,
    slippage: +slippage.toFixed(4),
    slippage_pct: +slippagePct.toFixed(4),
    fill_quality: fillQuality != null ? +fillQuality.toFixed(1) : null,
    timing_delay_days: timingDelayDays,
    participation_rate: participationRate != null ? +participationRate.toFixed(6) : null,
    implementation_shortfall: +implementationShortfall.toFixed(2),
    implementation_shortfall_pct: +implementationShortfallPct.toFixed(4),
    signal_date: signalDate,
    order_date: orderDate,
    fill_date: fillDate,
    day_high: dayHigh,
    day_low: dayLow,
    day_volume: dayVolume,
    avg_daily_volume: avgDailyVolume,
  };

  db().prepare(`
    INSERT INTO execution_log
    (trade_id, symbol, side, intended_price, fill_price, shares, order_type,
     slippage, slippage_pct, fill_quality, timing_delay_days, participation_rate,
     implementation_shortfall, implementation_shortfall_pct,
     signal_date, order_date, fill_date, day_high, day_low, day_volume, avg_daily_volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.trade_id, record.symbol, record.side,
    record.intended_price, record.fill_price, record.shares, record.order_type,
    record.slippage, record.slippage_pct, record.fill_quality,
    record.timing_delay_days, record.participation_rate,
    record.implementation_shortfall, record.implementation_shortfall_pct,
    record.signal_date, record.order_date, record.fill_date,
    record.day_high, record.day_low, record.day_volume, record.avg_daily_volume
  );

  return record;
}

// ─── Execution Quality Report ───────────────────────────────────────────────
// Aggregates execution quality across all trades for a given period.
//
// Sanity filter: any single fill with |slippage_pct| > SANITY_SLIPPAGE_LIMIT
// is treated as a bad-intent-price record (stale expected price captured
// hours/days before fill, failed ref-price lookup, or a market-dislocation
// single tick). These rows poison the mean and grade without reflecting
// actual execution — we count them but exclude from aggregates.
const SANITY_SLIPPAGE_LIMIT = 5.0;   // % — any single fill beyond this is suspect
const MIN_GRADABLE_SAMPLES  = 20;    // below this, grade is "N/A — insufficient samples"

function getExecutionReport(params = {}) {
  const { startDate, endDate, symbol, side } = params;

  let query = 'SELECT * FROM execution_log WHERE 1=1';
  const qp = [];
  if (startDate) { query += ' AND fill_date >= ?'; qp.push(startDate); }
  if (endDate) { query += ' AND fill_date <= ?'; qp.push(endDate); }
  if (symbol) { query += ' AND symbol = ?'; qp.push(symbol); }
  if (side) { query += ' AND side = ?'; qp.push(side); }
  query += ' ORDER BY fill_date DESC';

  const executions = db().prepare(query).all(...qp);
  if (executions.length === 0) return { executions: [], summary: null };

  // Partition rows into "trustworthy" vs "outlier" using the sanity filter.
  // All aggregates below operate on trustworthy rows only; the outlier count
  // is surfaced so the UI can say "5 of 55 fills flagged as bad-intent-price."
  const isOutlier = e => e.slippage_pct != null && Math.abs(e.slippage_pct) > SANITY_SLIPPAGE_LIMIT;
  const outlierRows    = executions.filter(isOutlier);
  const trustworthyRows = executions.filter(e => !isOutlier(e));

  // Aggregate statistics (trustworthy rows only)
  const slippages     = trustworthyRows.map(e => e.slippage_pct).filter(s => s != null);
  const fillQualities = trustworthyRows.map(e => e.fill_quality).filter(q => q != null);
  const shortfalls    = trustworthyRows.map(e => e.implementation_shortfall).filter(s => s != null);
  const timingDelays  = trustworthyRows.map(e => e.timing_delay_days).filter(d => d != null);

  const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const median = arr => {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  // Break down by order type (trustworthy rows only so the by-type grades
  // aren't skewed by the same bad-intent-price rows)
  const byOrderType = {};
  for (const exec of trustworthyRows) {
    const t = exec.order_type || 'unknown';
    if (!byOrderType[t]) byOrderType[t] = { count: 0, avgSlippage: [], avgFillQuality: [] };
    byOrderType[t].count++;
    if (exec.slippage_pct != null) byOrderType[t].avgSlippage.push(exec.slippage_pct);
    if (exec.fill_quality != null) byOrderType[t].avgFillQuality.push(exec.fill_quality);
  }
  for (const [type, data] of Object.entries(byOrderType)) {
    byOrderType[type] = {
      count: data.count,
      avgSlippage: avg(data.avgSlippage) != null ? +avg(data.avgSlippage).toFixed(4) : null,
      avgFillQuality: avg(data.avgFillQuality) != null ? +avg(data.avgFillQuality).toFixed(1) : null,
    };
  }

  // Break down by side (buy vs sell) — trustworthy rows only
  const bySide = { buy: [], sell: [] };
  for (const exec of trustworthyRows) {
    if (exec.side && bySide[exec.side] && exec.slippage_pct != null) {
      bySide[exec.side].push(exec.slippage_pct);
    }
  }

  const totalShortfall = shortfalls.reduce((a, b) => a + b, 0);
  const totalNotional = trustworthyRows.reduce((s, e) => s + (e.shares || 0) * (e.fill_price || 0), 0);

  // Grade the execution quality — requires a minimum sample size, otherwise
  // the aggregates aren't meaningful. Math.abs because slippage is signed
  // in the cost convention (positive = bad) and grade doesn't distinguish
  // "paid too much to buy" from "received too little on sell".
  const avgSlippage = avg(slippages);
  let grade, gradeNote;
  if (avgSlippage == null || slippages.length < MIN_GRADABLE_SAMPLES) {
    grade = 'N/A';
    gradeNote = `insufficient samples (${slippages.length} / ${MIN_GRADABLE_SAMPLES} required)`;
  } else if (Math.abs(avgSlippage) < 0.05) { grade = 'A'; }
  else if (Math.abs(avgSlippage) < 0.10)   { grade = 'B'; }
  else if (Math.abs(avgSlippage) < 0.20)   { grade = 'C'; }
  else if (Math.abs(avgSlippage) < 0.40)   { grade = 'D'; }
  else                                     { grade = 'F'; }

  const summary = {
    totalExecutions: executions.length,
    trustworthyCount: trustworthyRows.length,
    outlierCount: outlierRows.length,
    outliers: outlierRows.map(e => ({
      trade_id: e.trade_id, symbol: e.symbol, side: e.side,
      intended_price: e.intended_price, fill_price: e.fill_price,
      slippage_pct: e.slippage_pct, fill_date: e.fill_date,
    })),
    grade,
    gradeNote,   // present only when grade='N/A'; UI should show this instead of a misleading letter
    slippage: {
      // Cost convention: worst = MAX (highest cost), best = MIN (most favorable / negative).
      avg: avgSlippage != null ? +avgSlippage.toFixed(4) : null,
      median: median(slippages) != null ? +median(slippages).toFixed(4) : null,
      worst: slippages.length > 0 ? +Math.max(...slippages).toFixed(4) : null,
      best:  slippages.length > 0 ? +Math.min(...slippages).toFixed(4) : null,
    },
    fillQuality: {
      avg: avg(fillQualities) != null ? +avg(fillQualities).toFixed(1) : null,
      median: median(fillQualities) != null ? +median(fillQualities).toFixed(1) : null,
    },
    implementationShortfall: {
      totalDollars: +totalShortfall.toFixed(2),
      totalPct: totalNotional > 0 ? +((totalShortfall / totalNotional) * 100).toFixed(4) : null,
      annualized: executions.length > 0
        ? +((totalShortfall / totalNotional) * 100 * (252 / Math.max(1, executions.length))).toFixed(2)
        : null,
    },
    timingDelay: {
      avg: avg(timingDelays) != null ? +avg(timingDelays).toFixed(1) : null,
      median: median(timingDelays) != null ? +median(timingDelays).toFixed(1) : null,
    },
    byOrderType,
    bySide: {
      buy: { avgSlippage: avg(bySide.buy) != null ? +avg(bySide.buy).toFixed(4) : null, count: bySide.buy.length },
      sell: { avgSlippage: avg(bySide.sell) != null ? +avg(bySide.sell).toFixed(4) : null, count: bySide.sell.length },
    },
  };

  // Warnings — cost convention: POSITIVE average slippage = bad (paid/lost),
  // NEGATIVE = favorable. We warn on positive cost only.
  summary.warnings = [];
  if (avgSlippage != null && avgSlippage > 0.15) {
    summary.warnings.push(`Average slippage ${avgSlippage.toFixed(3)}% cost — consider using limit orders or TWAP`);
  }
  if (outlierRows.length > 0) {
    summary.warnings.push(`${outlierRows.length} fill(s) flagged as likely stale intended_price (|slippage| > ${SANITY_SLIPPAGE_LIMIT}%) and excluded from aggregates`);
  }
  const tdAvg = avg(timingDelays);
  if (tdAvg != null && tdAvg > 2) {
    summary.warnings.push(`Average ${tdAvg.toFixed(1)} day delay from signal to fill — speed up execution`);
  }
  if (totalShortfall > 1000) {
    summary.warnings.push(`$${totalShortfall.toFixed(0)} total implementation shortfall — review order routing`);
  }

  return { executions: executions.slice(0, 50), summary };
}

// ─── Liquidity Analysis ─────────────────────────────────────────────────────
// For a given position size, estimate whether the order is too large for
// the stock's liquidity. Rules of thumb from institutional trading.

function analyzeLiquidity(params) {
  const { shares, price, avgDailyVolume, avgDailyDollarVolume } = params;

  const orderValue = shares * price;
  const adv = avgDailyVolume || 0;
  const addv = avgDailyDollarVolume || (adv * price);

  const participationRate = adv > 0 ? shares / adv : null;
  const dollarParticipation = addv > 0 ? orderValue / addv : null;

  // Institutional rules of thumb
  let riskLevel, recommendation;
  if (participationRate == null) {
    riskLevel = 'unknown';
    recommendation = 'No volume data available';
  } else if (participationRate < 0.01) {
    riskLevel = 'negligible';
    recommendation = 'Order is <1% of daily volume — no impact expected';
  } else if (participationRate < 0.05) {
    riskLevel = 'low';
    recommendation = 'Order is 1-5% of daily volume — minimal impact, use limit order';
  } else if (participationRate < 0.15) {
    riskLevel = 'moderate';
    recommendation = 'Order is 5-15% of daily volume — split over 2-3 hours or use TWAP';
  } else if (participationRate < 0.30) {
    riskLevel = 'high';
    recommendation = 'Order is 15-30% of daily volume — split over full day, use iceberg orders';
  } else {
    riskLevel = 'extreme';
    recommendation = 'Order >30% of daily volume — split over 2+ days or reduce size';
  }

  // Estimated market impact (Almgren-Chriss simplified)
  const impactPct = participationRate != null
    ? +(Math.sqrt(participationRate) * 0.5 * 100).toFixed(3)
    : null;

  return {
    orderValue: +orderValue.toFixed(2),
    participationRate: participationRate != null ? +(participationRate * 100).toFixed(2) : null,
    dollarParticipation: dollarParticipation != null ? +(dollarParticipation * 100).toFixed(2) : null,
    estimatedImpactPct: impactPct,
    estimatedImpactDollars: impactPct != null ? +(orderValue * impactPct / 100).toFixed(2) : null,
    riskLevel,
    recommendation,
    rules: {
      maxSharesFor1Pct: Math.floor(adv * 0.01),
      maxSharesFor5Pct: Math.floor(adv * 0.05),
      suggestedMaxShares: Math.floor(adv * 0.02),
    },
  };
}

// ─── Slippage Prediction (Phase 2.9) ───────────────────────────────────────
//
// Learn trailing per-symbol slippage from the `execution_log` table and
// expose a `predictSlippage()` that other modules (position-sizer,
// edge-validator, risk preview) can call to get an honest "what will I
// actually pay" estimate BEFORE placing the order.
//
// The problem this fixes:
//   Every other sizing heuristic in this app assumes a theoretical fill at
//   the intended price. The audit called out that real fills consistently
//   lag that number — especially on breakout entries where the whole
//   market is chasing the same pivot. Without feeding realized slippage
//   back into the sizer, the user is compounding an optimism bias every
//   time they compute a "planned R multiple".
//
// Algorithm (intentionally boring):
//   1. Pull all execution_log rows for (symbol, side, order_type).
//      Fall back in tiers:
//         tier A: exact match   (≥ 5 rows)
//         tier B: same symbol, any order_type (≥ 5 rows)
//         tier C: same side, any symbol (the user's GLOBAL trailing bias)
//         tier D: hard-coded default based on orderType
//      Each tier reports its own confidence label so the caller can gate
//      how much to trust the number.
//   2. Aggregate: median slippage_pct is our point estimate (robust to
//      earnings-day outliers). p90 is the "stress bps" used for the
//      conservative position-sizing path.
//   3. Clamp: never return an "improvement" (positive slippage in the
//      buyer-paid-less direction) — if your last 5 fills were all above
//      intended, that's either lucky or a bad sign; the predictor should
//      assume zero benefit, not negative cost.
//   4. Apply a decay: older fills get less weight than recent ones. We
//      use a simple half-life of 30 days — matches the cadence most
//      swing traders see in their own behaviour drift.
//
// Design notes:
// - Signs follow the "cost-to-me" convention (POSITIVE = bad) used by
//   logExecution. A buy at 100.05 on intended 100.00 → slippage = +0.05 (paid
//   more). This function returns a NON-NEGATIVE predicted cost (or 0) in
//   decimal form. Callers convert to bps via |slippage_pct| × 100.
// - Returns a shape the sizer can log directly. The "bps" form is the
//   UI-friendly number, the "decimal" form is math-friendly.

const HALF_LIFE_DAYS = 30;                 // exponential decay half-life
const MIN_SAMPLE_TIER_A = 5;               // same-symbol + same-order-type
const MIN_SAMPLE_TIER_B = 5;               // same-symbol any-order-type
const MIN_SAMPLE_TIER_C = 10;              // same-side global

// Default slippage-in-bps by order type, applied when we have NO data at
// all (tier D). Calibrated from audit-era Alpaca fill logs on ~100 trades.
const DEFAULT_SLIPPAGE_BPS = {
  market:      25,
  stop:        30,
  stop_limit:  20,
  limit:       10,
  default:     15,
};

/**
 * Predict slippage for an order before it's placed.
 *
 * @param {Object} params
 * @param {string} params.symbol      Ticker to predict for.
 * @param {string} params.side        'buy' | 'sell'
 * @param {string} [params.orderType] 'market' | 'limit' | 'stop' | 'stop_limit'
 * @param {number} [params.now]       Unix ms epoch (test seam). Default now().
 * @param {number} [params.lookbackDays=365] Max age of fills to consider.
 * @returns {{
 *   predictedSlippageBps: number,   // Rounded up to 1 bps — UI-ready.
 *   predictedSlippagePct: number,   // Same number as %, signed (≤ 0).
 *   stressSlippageBps: number,      // p90 — worst-case expectation.
 *   sampleSize: number,             // How many historical fills were used.
 *   tier: 'A'|'B'|'C'|'D',          // Confidence tier (A = best).
 *   tierLabel: string,              // Human-readable tier description.
 *   basedOn: string                 // "symbol+orderType" | "symbol" | "side" | "default"
 * }}
 */
function predictSlippage({ symbol, side, orderType = 'limit', now, lookbackDays = 365 } = {}) {
  if (!symbol || !side) {
    const defaultBps = DEFAULT_SLIPPAGE_BPS[orderType] || DEFAULT_SLIPPAGE_BPS.default;
    return {
      predictedSlippageBps: defaultBps,
      predictedSlippagePct: +(defaultBps / 100).toFixed(4),   // positive = cost
      stressSlippageBps: defaultBps * 2,
      sampleSize: 0,
      tier: 'D',
      tierLabel: 'default — no symbol/side provided',
      basedOn: 'default',
    };
  }

  const nowMs = now != null ? now : Date.now();
  const cutoffIso = new Date(nowMs - lookbackDays * 86400000).toISOString().slice(0, 10);

  // Walk the fallback tiers. The CRITICAL invariant: only advance to the
  // next tier if the CURRENT tier didn't hit its own minimum. We cannot
  // reuse a single threshold check across tiers — tier C's min (10) is
  // higher than tier A's (5), and a 6-row tier-A match would otherwise
  // be wrongly demoted to tier D.
  let rows, tier, basedOn, label;

  // Tier A: same symbol, same side, same order type.
  const rowsA = db().prepare(`
    SELECT slippage_pct, fill_date FROM execution_log
    WHERE symbol = ? AND side = ? AND order_type = ?
      AND slippage_pct IS NOT NULL
      AND (fill_date IS NULL OR fill_date >= ?)
  `).all(symbol, side, orderType, cutoffIso);

  if (rowsA.length >= MIN_SAMPLE_TIER_A) {
    rows = rowsA;
    tier = 'A';
    basedOn = 'symbol+orderType';
  } else {
    // Tier B: same symbol, same side, any order type.
    const rowsB = db().prepare(`
      SELECT slippage_pct, fill_date FROM execution_log
      WHERE symbol = ? AND side = ?
        AND slippage_pct IS NOT NULL
        AND (fill_date IS NULL OR fill_date >= ?)
    `).all(symbol, side, cutoffIso);

    if (rowsB.length >= MIN_SAMPLE_TIER_B) {
      rows = rowsB;
      tier = 'B';
      basedOn = 'symbol';
    } else {
      // Tier C: same side, any symbol — the trader's global slippage bias.
      const rowsC = db().prepare(`
        SELECT slippage_pct, fill_date FROM execution_log
        WHERE side = ?
          AND slippage_pct IS NOT NULL
          AND (fill_date IS NULL OR fill_date >= ?)
      `).all(side, cutoffIso);

      if (rowsC.length >= MIN_SAMPLE_TIER_C) {
        rows = rowsC;
        tier = 'C';
        basedOn = 'side';
      } else {
        // Tier D: no data — fall back to the hard-coded default table.
        // Report the SIZE of the tier we most recently failed so callers
        // can distinguish "zero data" from "not quite enough".
        const defaultBps = DEFAULT_SLIPPAGE_BPS[orderType] || DEFAULT_SLIPPAGE_BPS.default;
        return {
          predictedSlippageBps: defaultBps,
          predictedSlippagePct: +(defaultBps / 100).toFixed(4),
          stressSlippageBps: defaultBps * 2,
          sampleSize: rowsC.length,
          tier: 'D',
          tierLabel: `default — only ${rowsC.length} historical fills (need ≥ ${MIN_SAMPLE_TIER_C})`,
          basedOn: 'default',
        };
      }
    }
  }

  // Weight by recency using an exponential half-life of HALF_LIFE_DAYS.
  // Fills missing a fill_date get weight 1.0 so synthetic fixtures don't
  // silently decay to zero in tests.
  const weighted = rows.map(r => {
    if (!r.fill_date) return { slip: r.slippage_pct, w: 1.0 };
    const ageDays = (nowMs - new Date(r.fill_date).getTime()) / 86400000;
    const w = Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
    return { slip: r.slippage_pct, w };
  });

  // Weighted median (robust to outliers) computed by sorting + picking
  // the 50th weight-percentile point.
  weighted.sort((a, b) => a.slip - b.slip);
  let totalW = 0;
  for (const x of weighted) totalW += x.w;
  let cum = 0;
  let median = weighted[weighted.length - 1].slip;
  for (const x of weighted) {
    cum += x.w;
    if (cum >= totalW / 2) { median = x.slip; break; }
  }

  // p90 stress — 90th weight-percentile slippage cost (most POSITIVE tail,
  // since cost = positive in this module's convention). We walk from the HIGH
  // end until 10% of weight remains above → that's the p90-worst cost.
  let p90 = weighted[weighted.length - 1].slip;  // default to worst if we fall through
  cum = 0;
  for (let i = weighted.length - 1; i >= 0; i--) {
    cum += weighted[i].w;
    if (cum >= totalW * 0.10) { p90 = weighted[i].slip; break; }
  }

  // Enforce "no improvement allowed" clamp. In the cost convention,
  // improvement = NEGATIVE (paid less than intended). Don't let the sizer
  // plan for a free lunch — floor at 0.
  if (median < 0) median = 0;
  if (p90 < 0) p90 = 0;

  // Convert to basis points (bps = % × 100). slippage_pct is already in
  // cost-positive units, so Math.abs is belt-and-suspenders.
  const bps = Math.ceil(Math.abs(median) * 100);
  const stressBps = Math.ceil(Math.abs(p90) * 100);

  if (tier === 'A') label = `symbol+orderType match (${rows.length} fills, recency-weighted)`;
  else if (tier === 'B') label = `symbol match across order types (${rows.length} fills)`;
  else label = `global ${side}-side slippage (${rows.length} fills — no symbol-specific data)`;

  return {
    predictedSlippageBps: bps,
    predictedSlippagePct: +median.toFixed(4),   // positive = expected cost
    stressSlippageBps: stressBps,
    sampleSize: rows.length,
    tier,
    tierLabel: label,
    basedOn,
  };
}

/**
 * Convenience: apply a predicted slippage to an intended price and return
 * the expected fill. Used by position-sizer to adjust the effective entry
 * before computing shares-at-risk.
 *
 * @param {number} intendedPrice
 * @param {string} side
 * @param {Object} prediction — return value of predictSlippage()
 * @returns {number} The expected fill price (buy → higher, sell → lower).
 */
function applyPredictedSlippage(intendedPrice, side, prediction) {
  if (!intendedPrice || !prediction) return intendedPrice;
  const bps = prediction.predictedSlippageBps || 0;
  const factor = bps / 10000;
  return side === 'buy'
    ? intendedPrice * (1 + factor)   // buyer pays MORE
    : intendedPrice * (1 - factor);  // seller gets LESS
}

module.exports = {
  logExecution,
  getExecutionReport,
  analyzeLiquidity,
  // Phase 2.9 — slippage prediction from historical fills
  predictSlippage,
  applyPredictedSlippage,
  DEFAULT_SLIPPAGE_BPS,
  HALF_LIFE_DAYS,
};
