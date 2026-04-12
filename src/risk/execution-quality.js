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

module.exports = {
  logExecution,
  getExecutionReport,
  analyzeLiquidity,
};
