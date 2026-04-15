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

  // Calculate slippage
  const slippage = side === 'buy'
    ? fillPrice - intendedPrice    // paid more = negative (bad)
    : intendedPrice - fillPrice;   // received less = negative (bad)
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

  // Aggregate statistics
  const slippages = executions.map(e => e.slippage_pct).filter(s => s != null);
  const fillQualities = executions.map(e => e.fill_quality).filter(q => q != null);
  const shortfalls = executions.map(e => e.implementation_shortfall).filter(s => s != null);
  const timingDelays = executions.map(e => e.timing_delay_days).filter(d => d != null);

  const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const median = arr => {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  // Break down by order type
  const byOrderType = {};
  for (const exec of executions) {
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

  // Break down by side (buy vs sell)
  const bySide = { buy: [], sell: [] };
  for (const exec of executions) {
    if (exec.side && bySide[exec.side]) {
      bySide[exec.side].push(exec.slippage_pct);
    }
  }

  const totalShortfall = shortfalls.reduce((a, b) => a + b, 0);
  const totalNotional = executions.reduce((s, e) => s + (e.shares || 0) * (e.fill_price || 0), 0);

  // Grade the execution quality
  const avgSlippage = avg(slippages);
  let grade;
  if (avgSlippage == null) grade = 'N/A';
  else if (Math.abs(avgSlippage) < 0.05) grade = 'A';
  else if (Math.abs(avgSlippage) < 0.10) grade = 'B';
  else if (Math.abs(avgSlippage) < 0.20) grade = 'C';
  else if (Math.abs(avgSlippage) < 0.40) grade = 'D';
  else grade = 'F';

  const summary = {
    totalExecutions: executions.length,
    grade,
    slippage: {
      avg: avgSlippage != null ? +avgSlippage.toFixed(4) : null,
      median: median(slippages) != null ? +median(slippages).toFixed(4) : null,
      worst: slippages.length > 0 ? +Math.min(...slippages).toFixed(4) : null,
      best: slippages.length > 0 ? +Math.max(...slippages).toFixed(4) : null,
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

  // Warnings
  summary.warnings = [];
  if (avgSlippage != null && avgSlippage < -0.15) {
    summary.warnings.push(`Average slippage ${avgSlippage.toFixed(3)}% — consider using limit orders or TWAP`);
  }
  if (avg(timingDelays) > 2) {
    summary.warnings.push(`Average ${avg(timingDelays).toFixed(1)} day delay from signal to fill — speed up execution`);
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
// - Signs are in our standard "buyer paid MORE = negative" convention:
//     buy at 100.05 on intended 100.00 → slippage = -0.05 (bad)
//   So the function returns a NON-POSITIVE number (or 0) in decimal form.
//   Callers typically invert the sign and convert to bps.
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
    return {
      predictedSlippageBps: DEFAULT_SLIPPAGE_BPS[orderType] || DEFAULT_SLIPPAGE_BPS.default,
      predictedSlippagePct: -(DEFAULT_SLIPPAGE_BPS[orderType] || DEFAULT_SLIPPAGE_BPS.default) / 100,
      stressSlippageBps: (DEFAULT_SLIPPAGE_BPS[orderType] || DEFAULT_SLIPPAGE_BPS.default) * 2,
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
          predictedSlippagePct: -defaultBps / 100,
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

  // p90 stress — 90th weight-percentile slippage (most negative tail).
  // We re-sort ascending by slippage and walk the weights again from the
  // left until 10% of total weight remains above → that's the p90-worst.
  let p90 = weighted[0].slip;  // default to most negative if we fall through
  cum = 0;
  for (const x of weighted) {
    cum += x.w;
    if (cum >= totalW * 0.10) { p90 = x.slip; break; }
  }

  // Enforce "no improvement allowed" clamp. median > 0 means recent fills
  // were better than intended — which is either luck or a bug in the
  // logging pipeline. In either case, the sizer should plan for 0, not
  // a free lunch.
  if (median > 0) median = 0;
  if (p90 > 0) p90 = 0;

  // Convert to basis points (bps = % × 100). Sign: slippage_pct is already
  // signed with "paid more" = negative, so |slippage_pct| × 100 = bps cost.
  const bps = Math.ceil(Math.abs(median) * 100);
  const stressBps = Math.ceil(Math.abs(p90) * 100);

  if (tier === 'A') label = `symbol+orderType match (${rows.length} fills, recency-weighted)`;
  else if (tier === 'B') label = `symbol match across order types (${rows.length} fills)`;
  else label = `global ${side}-side slippage (${rows.length} fills — no symbol-specific data)`;

  return {
    predictedSlippageBps: bps,
    predictedSlippagePct: +median.toFixed(4),
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
