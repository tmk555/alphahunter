// ─── Decision Quality Metrics ────────────────────────────────────────────────
// Separates PROCESS quality from OUTCOME quality.
// A good trade can lose money (bad luck). A bad trade can make money (good luck).
// Over time, process quality is what compounds — not individual outcomes.
//
// Tracks:
//   1. System adherence: did you follow the rules or override?
//   2. Entry quality: was the setup valid when you entered?
//   3. Exit quality: did you exit per plan or emotionally?
//   4. Sizing quality: was the position sized correctly?
//   5. Timing quality: was the regime appropriate for the trade?
//   6. Overall process score: composite quality metric

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Score a Trade's Decision Quality ───────────────────────────────────────
// Evaluates a completed trade against the system rules that should have governed it.
// Returns a 0-100 process quality score independent of P&L outcome.

function scoreTrade(trade, context = {}) {
  const {
    regimeAtEntry,           // market regime when trade was opened
    rsAtEntry,               // RS rank at entry
    momentumAtEntry,         // swing momentum at entry
    sepaAtEntry,             // SEPA score at entry
    portfolioHeatAtEntry,    // portfolio heat when trade was opened
    wasSystemSignal,         // true if the system generated this trade
    followedSizingRules,     // true if position sized per risk engine
    exitReason,              // stop | target | manual | regime_change
    plannedStop,             // the stop price at entry
    actualExit,              // actual exit price
    holdingDays,
    rMultiple,
  } = context;

  const scores = {};
  const notes = [];

  // 1. Entry Quality (25 points)
  // Was the trade taken in the right conditions?
  let entryScore = 0;
  if (rsAtEntry >= 70) entryScore += 8;
  else if (rsAtEntry >= 50) entryScore += 4;
  else { entryScore += 0; notes.push('Entered with weak RS (<50)'); }

  if (momentumAtEntry >= 60) entryScore += 5;
  else if (momentumAtEntry >= 45) entryScore += 3;
  else notes.push('Entered with weak momentum (<45)');

  if (sepaAtEntry >= 5) entryScore += 7;
  else if (sepaAtEntry >= 3) entryScore += 4;
  else notes.push('SEPA structure incomplete');

  // Was it a system signal or discretionary override?
  if (wasSystemSignal) entryScore += 5;
  else { entryScore += 0; notes.push('Discretionary override — not a system signal'); }

  scores.entry = Math.min(25, entryScore);

  // 2. Regime Compliance (20 points)
  // Did the market regime support this trade type?
  let regimeScore = 0;
  const regime = regimeAtEntry || 'UNKNOWN';
  if (trade.side === 'long') {
    if (regime === 'BULL / RISK ON' || regime === 'BULL') regimeScore = 20;
    else if (regime === 'NEUTRAL') regimeScore = 15;
    else if (regime === 'CAUTION') { regimeScore = 5; notes.push('Entered long in CAUTION regime'); }
    else { regimeScore = 0; notes.push('Entered long in BEAR regime — rule violation'); }
  } else {
    // Shorts are appropriate in CAUTION/BEAR
    if (regime === 'CAUTION' || regime === 'HIGH RISK / BEAR' || regime === 'CORRECTION') regimeScore = 20;
    else if (regime === 'NEUTRAL') regimeScore = 10;
    else regimeScore = 5;
  }
  scores.regime = regimeScore;

  // 3. Position Sizing (20 points)
  let sizingScore = 0;
  if (followedSizingRules === true) sizingScore = 15;
  else if (followedSizingRules === false) { sizingScore = 0; notes.push('Position sizing rules not followed'); }
  else sizingScore = 10; // unknown

  // Heat check: was portfolio heat within limits?
  if (portfolioHeatAtEntry != null) {
    if (portfolioHeatAtEntry <= 8) sizingScore += 5;
    else if (portfolioHeatAtEntry <= 12) { sizingScore += 2; notes.push('Portfolio heat elevated at entry'); }
    else { sizingScore += 0; notes.push('Portfolio heat exceeded limits at entry'); }
  } else {
    sizingScore += 3; // unknown
  }
  scores.sizing = Math.min(20, sizingScore);

  // 4. Exit Quality (25 points)
  // Did you exit according to plan?
  let exitScore = 0;
  const reason = exitReason || trade.exit_reason;

  if (reason === 'target1' || reason === 'target2') {
    exitScore = 25; // Perfect — hit target
  } else if (reason === 'stop') {
    // Stopped out is fine IF the stop was honored (not moved)
    if (plannedStop && actualExit) {
      const slippage = Math.abs(actualExit - plannedStop) / plannedStop;
      if (slippage < 0.02) exitScore = 20; // stopped out near plan
      else { exitScore = 12; notes.push(`Stop slippage: exited ${(slippage * 100).toFixed(1)}% away from planned stop`); }
    } else {
      exitScore = 18; // stopped out, can't verify exact level
    }
  } else if (reason === 'regime_change') {
    exitScore = 22; // Systematic exit — following the rules
  } else if (reason === 'manual') {
    // Manual exits need scrutiny
    if (rMultiple != null) {
      if (rMultiple > 0) { exitScore = 10; notes.push('Manual exit with profit — why not use targets?'); }
      else { exitScore = 5; notes.push('Manual exit at a loss — emotional or information-based?'); }
    } else {
      exitScore = 8;
    }
  } else if (reason === 'time') {
    exitScore = 15; // Time-based exit is systematic
  } else {
    exitScore = 10; // unknown exit reason
  }
  scores.exit = Math.min(25, exitScore);

  // 5. Risk Management (10 points)
  let riskScore = 0;
  if (trade.stop_price && trade.entry_price) {
    const riskPct = Math.abs(trade.entry_price - trade.stop_price) / trade.entry_price * 100;
    if (riskPct >= 1 && riskPct <= 5) riskScore += 5; // appropriate stop distance
    else if (riskPct > 5 && riskPct <= 8) { riskScore += 3; notes.push('Wide stop (>5%)'); }
    else if (riskPct > 8) { riskScore += 0; notes.push('Stop too wide (>8%) — risk too large'); }
    else { riskScore += 2; notes.push('Stop too tight (<1%) — likely to get shaken out'); }
  } else {
    riskScore += 0;
    notes.push('No stop price set — naked risk');
  }

  // R-multiple assessment
  if (rMultiple != null) {
    if (rMultiple >= 2) riskScore += 5;
    else if (rMultiple >= 1) riskScore += 4;
    else if (rMultiple >= 0) riskScore += 3;
    else if (rMultiple >= -1) riskScore += 2; // controlled loss
    else riskScore += 0; // loss exceeded 1R — stop not honored
  } else {
    riskScore += 2;
  }
  scores.risk = Math.min(10, riskScore);

  // Total process quality score
  const totalScore = scores.entry + scores.regime + scores.sizing + scores.exit + scores.risk;

  // Determine if outcome correlated with process
  const pnl = trade.pnl_percent || trade.pnl_dollars;
  let outcomeAlignment;
  if (pnl > 0 && totalScore >= 70) outcomeAlignment = 'deserved_win';
  else if (pnl > 0 && totalScore < 50) outcomeAlignment = 'lucky_win';
  else if (pnl <= 0 && totalScore >= 70) outcomeAlignment = 'unlucky_loss';
  else if (pnl <= 0 && totalScore < 50) outcomeAlignment = 'deserved_loss';
  else outcomeAlignment = 'mixed';

  return {
    processScore: totalScore,
    scores,
    outcomeAlignment,
    grade: totalScore >= 85 ? 'A' : totalScore >= 70 ? 'B' : totalScore >= 55 ? 'C' : totalScore >= 40 ? 'D' : 'F',
    notes,
    tradeId: trade.id,
    symbol: trade.symbol,
    pnlPercent: trade.pnl_percent,
    rMultiple: rMultiple || trade.r_multiple,
  };
}

// ─── Log Decision Quality ───────────────────────────────────────────────────
function logDecisionQuality(tradeId, quality) {
  db().prepare(`
    INSERT OR REPLACE INTO decision_log
    (trade_id, process_score, entry_score, regime_score, sizing_score, exit_score,
     risk_score, grade, outcome_alignment, notes, was_system_signal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tradeId, quality.processScore,
    quality.scores.entry, quality.scores.regime, quality.scores.sizing,
    quality.scores.exit, quality.scores.risk,
    quality.grade, quality.outcomeAlignment,
    JSON.stringify(quality.notes),
    quality.notes.includes('Discretionary override') ? 0 : 1
  );
}

// ─── Aggregate Decision Analytics ───────────────────────────────────────────
// Portfolio-level decision quality over time.

function getDecisionAnalytics(params = {}) {
  const { startDate, endDate } = params;

  let query = `
    SELECT d.*, t.symbol, t.pnl_percent, t.pnl_dollars, t.r_multiple, t.exit_reason, t.side
    FROM decision_log d
    LEFT JOIN trades t ON d.trade_id = t.id
    WHERE 1=1
  `;
  const qp = [];
  if (startDate) { query += ' AND t.exit_date >= ?'; qp.push(startDate); }
  if (endDate) { query += ' AND t.exit_date <= ?'; qp.push(endDate); }

  const decisions = db().prepare(query).all(...qp);
  if (decisions.length === 0) return { decisions: [], summary: null };

  const systemTrades = decisions.filter(d => d.was_system_signal);
  const discretionary = decisions.filter(d => !d.was_system_signal);

  const avgScore = arr => arr.length > 0
    ? +(arr.reduce((s, d) => s + d.process_score, 0) / arr.length).toFixed(1) : null;
  const avgPnl = arr => arr.length > 0
    ? +(arr.reduce((s, d) => s + (d.pnl_percent || 0), 0) / arr.length).toFixed(2) : null;
  const winRate = arr => {
    const wins = arr.filter(d => (d.pnl_percent || 0) > 0).length;
    return arr.length > 0 ? +(wins / arr.length * 100).toFixed(1) : null;
  };

  // Alignment distribution
  const alignments = {};
  for (const d of decisions) {
    alignments[d.outcome_alignment] = (alignments[d.outcome_alignment] || 0) + 1;
  }

  // Grade distribution
  const grades = {};
  for (const d of decisions) {
    grades[d.grade] = (grades[d.grade] || 0) + 1;
  }

  // Component averages
  const componentAvgs = {
    entry: +(decisions.reduce((s, d) => s + (d.entry_score || 0), 0) / decisions.length).toFixed(1),
    regime: +(decisions.reduce((s, d) => s + (d.regime_score || 0), 0) / decisions.length).toFixed(1),
    sizing: +(decisions.reduce((s, d) => s + (d.sizing_score || 0), 0) / decisions.length).toFixed(1),
    exit: +(decisions.reduce((s, d) => s + (d.exit_score || 0), 0) / decisions.length).toFixed(1),
    risk: +(decisions.reduce((s, d) => s + (d.risk_score || 0), 0) / decisions.length).toFixed(1),
  };

  // Find weakest component
  const weakest = Object.entries(componentAvgs)
    .map(([name, avg]) => ({ name, avg, maxPossible: name === 'entry' ? 25 : name === 'exit' ? 25 : name === 'regime' ? 20 : name === 'sizing' ? 20 : 10 }))
    .map(c => ({ ...c, pct: +(c.avg / c.maxPossible * 100).toFixed(0) }))
    .sort((a, b) => a.pct - b.pct)[0];

  return {
    totalDecisions: decisions.length,
    summary: {
      avgProcessScore: avgScore(decisions),
      avgPnlPercent: avgPnl(decisions),
      winRate: winRate(decisions),
      systemVsDiscretionary: {
        system: {
          count: systemTrades.length,
          avgScore: avgScore(systemTrades),
          avgPnl: avgPnl(systemTrades),
          winRate: winRate(systemTrades),
        },
        discretionary: {
          count: discretionary.length,
          avgScore: avgScore(discretionary),
          avgPnl: avgPnl(discretionary),
          winRate: winRate(discretionary),
        },
        verdict: systemTrades.length > 5 && discretionary.length > 5
          ? (avgPnl(systemTrades) > avgPnl(discretionary)
            ? 'System trades outperform discretionary — trust the system more'
            : 'Discretionary trades outperform — your judgment adds value')
          : 'Need more trades to compare',
      },
      outcomeAlignment: alignments,
      gradeDistribution: grades,
      componentAverages: componentAvgs,
      weakestArea: weakest ? {
        component: weakest.name,
        score: `${weakest.avg}/${weakest.maxPossible} (${weakest.pct}%)`,
        recommendation: getComponentRecommendation(weakest.name, weakest.pct),
      } : null,
    },
  };
}

function getComponentRecommendation(component, pct) {
  const recs = {
    entry: pct < 50
      ? 'Entry quality low — too many trades with weak RS/momentum. Wait for better setups.'
      : 'Entry quality moderate — focus on SEPA >=5 and RS >=70 for entries.',
    regime: pct < 50
      ? 'Regime compliance poor — taking trades against the market environment. Check regime before every entry.'
      : 'Regime compliance moderate — occasionally trading in unfavorable conditions.',
    sizing: pct < 50
      ? 'Position sizing inconsistent — use the risk engine for every trade, no exceptions.'
      : 'Sizing mostly correct — minor heat management improvements needed.',
    exit: pct < 50
      ? 'Exit quality poor — too many manual/emotional exits. Set stops and targets at entry, then hands off.'
      : 'Exit quality moderate — some manual exits. Consider automating stop execution.',
    risk: pct < 50
      ? 'Risk management weak — stops too wide or not set. Every trade needs a defined stop.'
      : 'Risk management adequate — tighten stops when ahead, honor stops when wrong.',
  };
  return recs[component] || 'Review this component for improvement opportunities.';
}

// ─── Process Score Trend ────────────────────────────────────────────────────
// Track whether decision quality is improving over time.

function getProcessTrend(windowSize = 20) {
  const decisions = db().prepare(`
    SELECT d.trade_id, d.process_score, d.grade, d.was_system_signal,
           t.exit_date, t.pnl_percent
    FROM decision_log d
    LEFT JOIN trades t ON d.trade_id = t.id
    WHERE t.exit_date IS NOT NULL
    ORDER BY t.exit_date ASC
  `).all();

  if (decisions.length < windowSize * 2) {
    return { trend: 'insufficient_data', message: `Need ${windowSize * 2} scored trades` };
  }

  // Rolling average
  const series = [];
  for (let i = windowSize - 1; i < decisions.length; i++) {
    const window = decisions.slice(i - windowSize + 1, i + 1);
    const avgScore = window.reduce((s, d) => s + d.process_score, 0) / windowSize;
    const winRate = window.filter(d => (d.pnl_percent || 0) > 0).length / windowSize;
    series.push({
      date: decisions[i].exit_date,
      avgProcessScore: +avgScore.toFixed(1),
      winRate: +(winRate * 100).toFixed(1),
    });
  }

  // Trend: compare last window to first window
  const first = series.slice(0, 5).reduce((s, d) => s + d.avgProcessScore, 0) / 5;
  const last = series.slice(-5).reduce((s, d) => s + d.avgProcessScore, 0) / 5;
  const trend = last > first + 3 ? 'improving' : last < first - 3 ? 'deteriorating' : 'stable';

  return {
    trend,
    firstPeriodAvg: +first.toFixed(1),
    lastPeriodAvg: +last.toFixed(1),
    change: +(last - first).toFixed(1),
    series,
    message: trend === 'improving'
      ? `Process quality improving: ${first.toFixed(0)} → ${last.toFixed(0)} (+${(last - first).toFixed(0)} pts)`
      : trend === 'deteriorating'
        ? `Process quality declining: ${first.toFixed(0)} → ${last.toFixed(0)} (${(last - first).toFixed(0)} pts) — review recent decisions`
        : `Process quality stable around ${last.toFixed(0)}/100`,
  };
}

module.exports = {
  scoreTrade,
  logDecisionQuality,
  getDecisionAnalytics,
  getProcessTrend,
};
