// ─── Edge Validation Engine ──────────────────────────────────────────────────
// Proves whether the trading edge is real: survivorship-bias-free backtesting,
// execution cost modeling, signal decay analysis, and conviction weight calibration.

const { getDB } = require('../data/database');
const { assessSignificance } = require('./statistics');

function db() { return getDB(); }

// ─── Execution Cost Model ───────────────────────────────────────────────────
// Models real-world trading friction that erodes theoretical edge.
// Components: commission + spread + slippage + market impact

function estimateExecutionCost(params) {
  const {
    shares,
    price,
    avgDailyVolume = 1000000,
    atrPct = 2.0,
    side = 'buy',       // buy entries get worse fills than sells at stop
    orderType = 'limit', // limit vs market
    urgency = 'normal',  // normal | high (breakout chase) | low (patient)
  } = params;

  const notional = shares * price;

  // 1. Commission (Alpaca = $0, IBKR = $0.005/share, assume $0.005 conservative)
  const commission = shares * 0.005;

  // 2. Spread cost: half-spread as immediate execution cost
  // Typical spread = f(price, volume, volatility)
  // Empirical: spread ~ 0.02% for mega-cap, 0.05% for mid-cap, 0.15% for small-cap
  let spreadPct;
  if (avgDailyVolume > 5000000) spreadPct = 0.02;
  else if (avgDailyVolume > 1000000) spreadPct = 0.05;
  else if (avgDailyVolume > 300000) spreadPct = 0.10;
  else spreadPct = 0.20;

  const spreadCost = notional * (spreadPct / 100) * 0.5; // half-spread

  // 3. Slippage: deviation from expected fill price
  // Higher on breakout entries (momentum chasers compete), stop exits (panic)
  let slippageMult = 1.0;
  if (urgency === 'high') slippageMult = 2.5;    // breakout chasing
  if (orderType === 'market') slippageMult *= 1.5; // market orders get worse fills
  if (side === 'buy') slippageMult *= 1.0;         // entry = controlled
  else slippageMult *= 1.3;                        // stop exit = adverse selection

  // Base slippage ~ 0.03% for liquid, scales with ATR and inverse volume
  const baseSlippage = 0.03;
  const volFactor = Math.max(1, atrPct / 2.0);    // high vol = more slippage
  const liqFactor = Math.max(1, 1000000 / avgDailyVolume); // low vol = more slippage
  const slippagePct = baseSlippage * volFactor * liqFactor * slippageMult;
  const slippageCost = notional * (slippagePct / 100);

  // 4. Market impact: large orders move the price
  // Almgren-Chriss simplified: impact ~ sigma * sqrt(shares / ADV)
  const participationRate = shares / avgDailyVolume;
  const impactPct = (atrPct / 100) * Math.sqrt(participationRate) * 100 * 0.5;
  const impactCost = notional * (impactPct / 100);

  const totalCost = commission + spreadCost + slippageCost + impactCost;
  const totalPct = (totalCost / notional) * 100;

  return {
    commission:   +commission.toFixed(2),
    spreadCost:   +spreadCost.toFixed(2),
    slippageCost: +slippageCost.toFixed(2),
    impactCost:   +impactCost.toFixed(2),
    totalCost:    +totalCost.toFixed(2),
    totalPct:     +totalPct.toFixed(4),
    // Per-share cost (useful for adjusting backtest fills)
    perShareCost: +(totalCost / shares).toFixed(4),
    // Components as % of notional
    breakdown: {
      commissionPct: +((commission / notional) * 100).toFixed(4),
      spreadPct:     +((spreadCost / notional) * 100).toFixed(4),
      slippagePct:   +slippagePct.toFixed(4),
      impactPct:     +impactPct.toFixed(4),
    },
    inputs: { shares, price, notional, avgDailyVolume, atrPct, side, orderType, urgency },
  };
}

// Round-trip cost: entry + exit for a complete trade
function roundTripCost(params) {
  const entryCost = estimateExecutionCost({ ...params, side: 'buy' });
  const exitCost = estimateExecutionCost({
    ...params,
    side: 'sell',
    urgency: params.exitUrgency || 'normal',
  });
  return {
    entry: entryCost,
    exit: exitCost,
    totalCost: +(entryCost.totalCost + exitCost.totalCost).toFixed(2),
    totalPct: +(entryCost.totalPct + exitCost.totalPct).toFixed(4),
  };
}

// ─── Survivorship Bias Detection ────────────────────────────────────────────
// Tracks universe composition over time to detect contamination.

function getUniverseHistory() {
  // Check universe_mgmt table for additions/removals
  const rows = db().prepare(`
    SELECT symbol, sector, added_date, removed_date, reason
    FROM universe_mgmt ORDER BY added_date
  `).all();
  return rows;
}

// Build point-in-time universe for a given date
function getUniverseAsOf(date, currentUniverse) {
  const mgmt = db().prepare(`
    SELECT symbol, sector, added_date, removed_date
    FROM universe_mgmt
    WHERE added_date <= ?
  `).all(date);

  if (mgmt.length === 0) {
    // No universe management data — flag survivorship risk
    return {
      symbols: currentUniverse,
      survivorshipWarning: true,
      message: 'No historical universe data — backtests use current universe (survivorship bias likely)',
    };
  }

  const active = mgmt.filter(r => !r.removed_date || r.removed_date > date);
  return {
    symbols: active.map(r => r.symbol),
    survivorshipWarning: false,
    totalTracked: mgmt.length,
    activeOnDate: active.length,
    removedBeforeDate: mgmt.length - active.length,
  };
}

// Record a universe change (stock added/removed)
function recordUniverseChange(symbol, sector, action, reason) {
  if (action === 'add') {
    db().prepare(`
      INSERT OR REPLACE INTO universe_mgmt (symbol, sector, added_date, reason, source)
      VALUES (?, ?, date('now'), ?, 'system')
    `).run(symbol, sector, reason);
  } else if (action === 'remove') {
    db().prepare(`
      UPDATE universe_mgmt SET removed_date = date('now'), reason = ?
      WHERE symbol = ? AND removed_date IS NULL
    `).run(reason, symbol);
  }
}

// Bulk-initialize universe tracking from current universe
function initializeUniverseTracking(currentUniverse, sectorMap) {
  const count = db().prepare('SELECT COUNT(*) as cnt FROM universe_mgmt').get();
  if (count.cnt > 0) return { status: 'already_initialized', count: count.cnt };

  const insert = db().prepare(`
    INSERT OR IGNORE INTO universe_mgmt (symbol, sector, added_date, reason, source)
    VALUES (?, ?, date('now'), 'initial_load', 'system')
  `);

  const txn = db().transaction(() => {
    for (const symbol of currentUniverse) {
      insert.run(symbol, sectorMap[symbol] || 'Unknown');
    }
  });
  txn();
  return { status: 'initialized', count: currentUniverse.length };
}

// ─── Signal Decay Analysis ──────────────────────────────────────────────────
// Measures how quickly a signal's predictive power fades after it fires.
// Critical for understanding optimal holding periods.

function analyzeSignalDecay(signalName, params = {}) {
  const {
    minRS = 80,
    minMomentum = 60,
    lookforwardDays = [5, 10, 20, 40, 60],
    startDate,
    endDate,
  } = params;

  // Get all dates with snapshot data
  let dateQuery = `SELECT DISTINCT date FROM rs_snapshots WHERE type = 'stock'`;
  const queryParams = [];
  if (startDate) { dateQuery += ' AND date >= ?'; queryParams.push(startDate); }
  if (endDate) { dateQuery += ' AND date <= ?'; queryParams.push(endDate); }
  dateQuery += ' ORDER BY date';
  const dates = db().prepare(dateQuery).all(queryParams).map(r => r.date);

  if (dates.length < 30) {
    return { error: 'Insufficient data — need at least 30 trading days of snapshots' };
  }

  // Build date index for look-forward
  const dateIndex = {};
  dates.forEach((d, i) => { dateIndex[d] = i; });

  // For each signal firing, track forward returns at each horizon
  const results = {};
  for (const horizon of lookforwardDays) {
    results[`${horizon}d`] = { returns: [], count: 0, avgReturn: 0, hitRate: 0 };
  }

  // Signal-specific firing conditions
  const signalQuery = buildSignalQuery(signalName, { minRS, minMomentum });
  if (!signalQuery) return { error: `Unknown signal: ${signalName}` };

  const firings = db().prepare(signalQuery.sql).all(...(signalQuery.params || []));

  for (const firing of firings) {
    const dateIdx = dateIndex[firing.date];
    if (dateIdx == null) continue;

    for (const horizon of lookforwardDays) {
      const futureIdx = dateIdx + horizon;
      if (futureIdx >= dates.length) continue;
      const futureDate = dates[futureIdx];

      // Get the same stock's price on the future date
      const futureSnap = db().prepare(`
        SELECT price FROM rs_snapshots
        WHERE date = ? AND symbol = ? AND type = 'stock'
      `).get(futureDate, firing.symbol);

      if (futureSnap?.price && firing.price) {
        const fwdReturn = ((futureSnap.price / firing.price) - 1) * 100;
        results[`${horizon}d`].returns.push(fwdReturn);
      }
    }
  }

  // Compute statistics for each horizon
  const decay = {};
  for (const horizon of lookforwardDays) {
    const key = `${horizon}d`;
    const rets = results[key].returns;
    if (rets.length === 0) {
      decay[key] = { count: 0, avgReturn: null, hitRate: null, sharpe: null };
      continue;
    }
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const positive = rets.filter(r => r > 0).length;
    const std = Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / rets.length);
    const sharpe = std > 0 ? (avg / std) * Math.sqrt(252 / horizon) : 0;

    // Percentiles
    const sorted = [...rets].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.10)];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p50 = sorted[Math.floor(sorted.length * 0.50)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const p90 = sorted[Math.floor(sorted.length * 0.90)];

    // Phase 2.7: Significance for THIS horizon. We treat each firing as a
    // "trade" (a look-forward observation) and ask whether the mean forward
    // return at this horizon is statistically distinguishable from zero.
    // Skip the bootstrap on huge samples (> 2000 firings) to keep decay
    // reports fast — at that size the normal t-stat is already decisive.
    const iters = rets.length >= 30 && rets.length < 2000 ? 500 : 0;
    const periodsPerYear = 252 / horizon; // forward-return period length
    const sig = assessSignificance(rets, {
      tradesPerYear: periodsPerYear,
      bootstrapIters: iters,
      confidence: 0.95,
    });

    decay[key] = {
      count: rets.length,
      avgReturn: +avg.toFixed(2),
      hitRate: +(positive / rets.length * 100).toFixed(1),
      sharpe: +sharpe.toFixed(2),
      stdDev: +std.toFixed(2),
      percentiles: {
        p10: +p10.toFixed(2), p25: +p25.toFixed(2), p50: +p50.toFixed(2),
        p75: +p75.toFixed(2), p90: +p90.toFixed(2),
      },
      maxGain: +Math.max(...rets).toFixed(2),
      maxLoss: +Math.min(...rets).toFixed(2),
      // Phase 2.7: significance block (t-stat, p-value, verdict, CIs).
      // Consumers can gate on `significance.isSignificant` to hide
      // noise-flavoured horizons from the decay chart.
      significance: {
        verdict: sig.verdict,
        isSignificant: sig.isSignificant,
        tStat: sig.tStat,
        pValue: sig.pValue,
        confidenceInterval: sig.bootstrapMeanReturn,  // null when iters=0
        reason: sig.reason,
      },
    };
  }

  // Find optimal holding period (highest risk-adjusted return)
  let optimalHorizon = null, bestSharpe = -Infinity;
  for (const [key, stats] of Object.entries(decay)) {
    if (stats.sharpe != null && stats.sharpe > bestSharpe) {
      bestSharpe = stats.sharpe;
      optimalHorizon = key;
    }
  }

  return {
    signal: signalName,
    params: { minRS, minMomentum },
    totalFireings: firings.length,
    decay,
    optimalHorizon,
    bestSharpe: +bestSharpe.toFixed(2),
    dateRange: { start: dates[0], end: dates[dates.length - 1], tradingDays: dates.length },
  };
}

function buildSignalQuery(signalName, params) {
  switch (signalName) {
    case 'rs_high':
      return {
        sql: `SELECT date, symbol, price, rs_rank FROM rs_snapshots
              WHERE type = 'stock' AND rs_rank >= ? AND price > 0 ORDER BY date`,
        params: [params.minRS],
      };
    case 'momentum_high':
      return {
        sql: `SELECT date, symbol, price, swing_momentum FROM rs_snapshots
              WHERE type = 'stock' AND swing_momentum >= ? AND price > 0 ORDER BY date`,
        params: [params.minMomentum],
      };
    case 'rs_and_momentum':
      return {
        sql: `SELECT date, symbol, price, rs_rank, swing_momentum FROM rs_snapshots
              WHERE type = 'stock' AND rs_rank >= ? AND swing_momentum >= ? AND price > 0 ORDER BY date`,
        params: [params.minRS, params.minMomentum],
      };
    case 'vcp':
      return {
        sql: `SELECT date, symbol, price FROM rs_snapshots
              WHERE type = 'stock' AND vcp_forming = 1 AND rs_rank >= 70 AND price > 0 ORDER BY date`,
        params: [],
      };
    case 'rs_line_new_high':
      return {
        sql: `SELECT date, symbol, price FROM rs_snapshots
              WHERE type = 'stock' AND rs_line_new_high = 1 AND rs_rank >= 75 AND price > 0 ORDER BY date`,
        params: [],
      };
    case 'sepa_strong':
      return {
        sql: `SELECT date, symbol, price, sepa_score FROM rs_snapshots
              WHERE type = 'stock' AND sepa_score >= 6 AND rs_rank >= 70 AND price > 0 ORDER BY date`,
        params: [],
      };
    default:
      return null;
  }
}

// ─── Conviction Weight Optimizer ────────────────────────────────────────────
// Walk-forward optimization of conviction scoring weights.
// Tests whether the hand-tuned weights in conviction.js actually predict
// forward returns better than alternatives.

function optimizeConvictionWeights(params = {}) {
  const {
    startDate,
    endDate,
    trainDays = 120,
    testDays = 60,
    forwardHorizon = 20, // days to measure forward return
    metric = 'sharpe',   // optimize for: sharpe | hitRate | avgReturn
  } = params;

  // Load all scan_results with conviction components
  let query = `SELECT date, symbol, data, conviction_score FROM scan_results`;
  const qp = [];
  if (startDate) { query += ' WHERE date >= ?'; qp.push(startDate); }
  if (endDate) { query += (qp.length ? ' AND' : ' WHERE') + ' date <= ?'; qp.push(endDate); }
  query += ' ORDER BY date';

  const rows = db().prepare(query).all(...qp);
  if (rows.length < 100) {
    return { error: 'Insufficient scan_results data for optimization' };
  }

  // Group by date
  const byDate = {};
  for (const row of rows) {
    if (!byDate[row.date]) byDate[row.date] = [];
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    byDate[row.date].push({ symbol: row.symbol, data, conviction: row.conviction_score });
  }

  const dates = Object.keys(byDate).sort();
  const dateIndex = {};
  dates.forEach((d, i) => { dateIndex[d] = i; });

  // Weight grid search
  const weightCombinations = generateWeightGrid();
  const windowResults = [];

  // Walk-forward windows
  for (let winStart = 0; winStart + trainDays + testDays <= dates.length; winStart += testDays) {
    const trainStart = dates[winStart];
    const trainEnd = dates[winStart + trainDays - 1];
    const testStart = dates[winStart + trainDays];
    const testEndIdx = Math.min(winStart + trainDays + testDays - 1, dates.length - 1);
    const testEnd = dates[testEndIdx];

    // Train: find best weights on training data
    let bestWeights = null, bestMetric = -Infinity;

    for (const weights of weightCombinations) {
      const trainScore = evaluateWeights(weights, byDate, dates, dateIndex,
        winStart, winStart + trainDays, forwardHorizon);
      if (trainScore[metric] != null && trainScore[metric] > bestMetric) {
        bestMetric = trainScore[metric];
        bestWeights = weights;
      }
    }

    if (!bestWeights) continue;

    // Test: evaluate best weights out-of-sample
    const testScore = evaluateWeights(bestWeights, byDate, dates, dateIndex,
      winStart + trainDays, testEndIdx + 1, forwardHorizon);

    windowResults.push({
      trainPeriod: { start: trainStart, end: trainEnd },
      testPeriod: { start: testStart, end: testEnd },
      bestWeights,
      trainMetric: bestMetric,
      testMetric: testScore[metric],
      testStats: testScore,
    });
  }

  if (windowResults.length === 0) {
    return { error: 'No complete walk-forward windows available' };
  }

  // Aggregate out-of-sample results
  const oosMetrics = windowResults.map(w => w.testMetric).filter(m => m != null);
  const avgOOS = oosMetrics.reduce((a, b) => a + b, 0) / oosMetrics.length;

  // Most common best weights across windows
  const weightFreq = {};
  for (const w of windowResults) {
    const key = JSON.stringify(w.bestWeights);
    weightFreq[key] = (weightFreq[key] || 0) + 1;
  }
  const mostStable = Object.entries(weightFreq).sort((a, b) => b[1] - a[1])[0];

  return {
    windows: windowResults.length,
    avgOutOfSample: +avgOOS.toFixed(3),
    metric,
    mostStableWeights: JSON.parse(mostStable[0]),
    stabilityCount: mostStable[1],
    windowDetails: windowResults,
  };
}

function generateWeightGrid() {
  // Reduced grid — test meaningful variations of conviction weights
  const grids = [];
  const rsWeights = [0.15, 0.25, 0.35];
  const momWeights = [0.10, 0.20, 0.30];
  const sepaWeights = [1.5, 2.5, 3.5];
  const sectorWeights = [0.05, 0.10, 0.15];

  for (const rs of rsWeights) {
    for (const mom of momWeights) {
      for (const sepa of sepaWeights) {
        for (const sec of sectorWeights) {
          grids.push({ rsWeight: rs, momWeight: mom, sepaWeight: sepa, sectorWeight: sec });
        }
      }
    }
  }
  return grids;
}

function evaluateWeights(weights, byDate, dates, dateIndex, startIdx, endIdx, forwardHorizon) {
  const returns = [];

  for (let i = startIdx; i < endIdx && i < dates.length; i++) {
    const date = dates[i];
    const futureIdx = i + forwardHorizon;
    if (futureIdx >= dates.length) break;

    const candidates = byDate[date];
    if (!candidates?.length) continue;

    // Re-score with test weights and pick top 5
    const scored = candidates.map(c => {
      const d = c.data;
      const score = (d.rsRank || 0) * weights.rsWeight
        + (d.swingMomentum || 0) * weights.momWeight
        + (d.sepaScore || 0) * weights.sepaWeight
        + (d.sectorRsRank || 50) * weights.sectorWeight;
      return { ...c, testScore: score };
    }).sort((a, b) => b.testScore - a.testScore).slice(0, 5);

    // Measure forward returns
    const futureDate = dates[futureIdx];
    for (const pick of scored) {
      const futureSnap = db().prepare(`
        SELECT price FROM rs_snapshots WHERE date = ? AND symbol = ? AND type = 'stock'
      `).get(futureDate, pick.symbol);
      if (futureSnap?.price && pick.data.price) {
        returns.push(((futureSnap.price / pick.data.price) - 1) * 100);
      }
    }
  }

  if (returns.length === 0) return { sharpe: null, hitRate: null, avgReturn: null };

  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length);
  const positive = returns.filter(r => r > 0).length;

  return {
    avgReturn: +avg.toFixed(3),
    hitRate: +(positive / returns.length * 100).toFixed(1),
    sharpe: std > 0 ? +((avg / std) * Math.sqrt(252 / forwardHorizon)).toFixed(3) : 0,
    tradeCount: returns.length,
  };
}

// ─── Edge Summary Report ────────────────────────────────────────────────────
// Comprehensive edge assessment combining all validation tools.

function generateEdgeReport(currentUniverse, sectorMap) {
  const report = {
    generated: new Date().toISOString(),
    sections: {},
  };

  // 1. Survivorship assessment
  const univHistory = getUniverseHistory();
  report.sections.survivorship = {
    tracked: univHistory.length,
    removed: univHistory.filter(r => r.removed_date).length,
    warning: univHistory.length === 0
      ? 'NO UNIVERSE TRACKING — all backtests suffer survivorship bias'
      : univHistory.filter(r => r.removed_date).length === 0
        ? 'No stocks removed — bias risk is moderate (no delistings captured)'
        : 'Universe changes tracked — survivorship-adjusted backtests available',
    severity: univHistory.length === 0 ? 'critical' : 'low',
  };

  // 2. Execution cost estimate for typical trade
  const typicalTrade = roundTripCost({
    shares: 100, price: 150, avgDailyVolume: 2000000, atrPct: 2.5,
  });
  report.sections.executionCosts = {
    typicalRoundTrip: typicalTrade.totalPct,
    annualizedAt200Trades: +(typicalTrade.totalPct * 200).toFixed(2),
    note: 'Must subtract from backtest returns to get realistic P&L',
  };

  // 3. Data quality
  const snapCount = db().prepare('SELECT COUNT(DISTINCT date) as days FROM rs_snapshots WHERE type = \'stock\'').get();
  const scanCount = db().prepare('SELECT COUNT(DISTINCT date) as days FROM scan_results').get();
  report.sections.dataQuality = {
    snapshotDays: snapCount?.days || 0,
    scanResultDays: scanCount?.days || 0,
    minimumForValidation: 252,
    sufficient: (snapCount?.days || 0) >= 252,
  };

  // 4. Signal count summary
  const signals = ['rs_high', 'momentum_high', 'vcp', 'rs_line_new_high', 'sepa_strong'];
  const signalCounts = {};
  for (const sig of signals) {
    const q = buildSignalQuery(sig, { minRS: 80, minMomentum: 60 });
    if (q) {
      const cnt = db().prepare(`SELECT COUNT(*) as cnt FROM (${q.sql})`).get(...(q.params || []));
      signalCounts[sig] = cnt?.cnt || 0;
    }
  }
  report.sections.signalVolume = signalCounts;

  return report;
}

module.exports = {
  estimateExecutionCost,
  roundTripCost,
  getUniverseHistory,
  getUniverseAsOf,
  recordUniverseChange,
  initializeUniverseTracking,
  analyzeSignalDecay,
  optimizeConvictionWeights,
  generateEdgeReport,
};
