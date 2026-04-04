// ─── Signal Replay / Backtest Engine (Tier 4) ───────────────────────────────
// Replays stored scan_results and rs_snapshots to evaluate strategy performance
const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Strategy Definitions ──────────────────────────────────────────────────

const BUILT_IN_STRATEGIES = {
  rs_momentum: {
    name: 'RS Momentum',
    description: 'Buy RS >= 80 with rising momentum, sell on RS drop below 50',
    defaults: { minRS: 80, minMomentum: 60, exitRS: 50, holdDays: 20 },
  },
  vcp_breakout: {
    name: 'VCP Breakout',
    description: 'Buy VCP forming stocks with high RS, sell at target or stop',
    defaults: { minRS: 70, minVCPContractions: 2, stopATR: 1.5, targetATR: 3.0, holdDays: 15 },
  },
  sepa_trend: {
    name: 'SEPA Trend Follow',
    description: 'Buy stocks passing 6+ SEPA rules, hold while structure intact',
    defaults: { minSEPA: 6, minRS: 70, exitSEPA: 3, holdDays: 30 },
  },
  rs_line_new_high: {
    name: 'RS Line New High',
    description: 'Buy on RS Line new highs near 52-week highs',
    defaults: { minRS: 75, maxDistFromHigh: 0.10, holdDays: 20 },
  },
  conviction: {
    name: 'Conviction Score',
    description: 'Buy top conviction-scored picks, sell after holding period',
    defaults: { minConviction: 60, topN: 5, holdDays: 20 },
  },
};

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

function loadSnapshotData(startDate, endDate) {
  return db().prepare(`
    SELECT date, symbol, rs_rank, swing_momentum, sepa_score, stage, price,
           vs_ma50, vs_ma200, volume_ratio, vcp_forming, rs_line_new_high
    FROM rs_snapshots
    WHERE type = 'stock' AND date >= ? AND date <= ?
    ORDER BY date, rs_rank DESC
  `).all(startDate, endDate);
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
      return true; // Handled by top-N selection

    default:
      return false;
  }
}

function evaluateExit(stock, entryStock, strategy, params, holdingDays) {
  // Max hold period
  if (holdingDays >= params.holdDays) return { exit: true, reason: 'max_hold' };

  switch (strategy) {
    case 'rs_momentum':
      if (stock.rs_rank <= params.exitRS) return { exit: true, reason: 'rs_dropped' };
      break;

    case 'vcp_breakout': {
      if (!entryStock.price || !stock.price) break;
      const atr = entryStock.price * 0.02; // approximate ATR as 2%
      const stopPrice = entryStock.price - (params.stopATR * atr);
      const targetPrice = entryStock.price + (params.targetATR * atr);
      if (stock.price <= stopPrice) return { exit: true, reason: 'stop_hit' };
      if (stock.price >= targetPrice) return { exit: true, reason: 'target_hit' };
      break;
    }

    case 'sepa_trend':
      if ((stock.sepa_score || 0) <= params.exitSEPA) return { exit: true, reason: 'sepa_degraded' };
      break;

    case 'rs_line_new_high':
      if (stock.vs_ma50 < -5) return { exit: true, reason: 'below_ma50' };
      break;

    case 'conviction':
      break; // Pure hold-period based
  }

  return { exit: false };
}

// ─── Replay Engine ─────────────────────────────────────────────────────────

function runReplay({ strategy, params = {}, startDate, endDate, maxPositions = 10, initialCapital = 100000 }) {
  const stratDef = BUILT_IN_STRATEGIES[strategy];
  if (!stratDef) throw new Error(`Unknown strategy: ${strategy}. Available: ${Object.keys(BUILT_IN_STRATEGIES).join(', ')}`);

  const mergedParams = { ...stratDef.defaults, ...params };

  // Load data
  const snapshots = loadSnapshotData(startDate, endDate);
  if (!snapshots.length) {
    return { error: 'No snapshot data in date range', strategy, startDate, endDate };
  }

  // Group by date
  const byDate = {};
  for (const s of snapshots) {
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  }
  const dates = Object.keys(byDate).sort();

  // Simulation state
  let capital = initialCapital;
  const positions = new Map(); // symbol -> { entryDate, entryPrice, entryStock, shares }
  const trades = [];
  const equityCurve = [{ date: dates[0], equity: capital, positions: 0 }];
  let totalWins = 0, totalLosses = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const dayStocks = byDate[date];
    const stockMap = {};
    for (const s of dayStocks) stockMap[s.symbol] = s;

    // Check exits first
    for (const [symbol, pos] of positions) {
      const stock = stockMap[symbol];
      if (!stock) continue;

      const holdingDays = dates.slice(dates.indexOf(pos.entryDate), i + 1).length;
      const exitCheck = evaluateExit(stock, pos.entryStock, strategy, mergedParams, holdingDays);

      if (exitCheck.exit && stock.price) {
        const pnl = (stock.price - pos.entryPrice) * pos.shares;
        const pnlPct = ((stock.price / pos.entryPrice) - 1) * 100;
        capital += pos.shares * stock.price;

        trades.push({
          symbol, entryDate: pos.entryDate, exitDate: date,
          entryPrice: pos.entryPrice, exitPrice: stock.price,
          shares: pos.shares, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
          holdingDays, exitReason: exitCheck.reason,
          entryRS: pos.entryStock.rs_rank, exitRS: stock.rs_rank,
        });

        if (pnl > 0) totalWins++; else totalLosses++;
        positions.delete(symbol);
      }
    }

    // Check entries (if we have capacity)
    if (positions.size < maxPositions) {
      const candidates = dayStocks
        .filter(s => !positions.has(s.symbol) && s.price > 0)
        .filter(s => evaluateEntry(s, strategy, mergedParams));

      // For conviction strategy, take top N
      if (strategy === 'conviction') {
        candidates.sort((a, b) => (b.rs_rank || 0) - (a.rs_rank || 0));
      }

      const slotsAvailable = maxPositions - positions.size;
      const positionSize = capital / maxPositions; // Equal-weight

      for (const stock of candidates.slice(0, slotsAvailable)) {
        if (positionSize < 100 || !stock.price) continue; // Min position size

        const shares = Math.floor(positionSize / stock.price);
        if (shares <= 0) continue;

        capital -= shares * stock.price;
        positions.set(stock.symbol, {
          entryDate: date,
          entryPrice: stock.price,
          entryStock: stock,
          shares,
        });
      }
    }

    // Record equity
    let positionValue = 0;
    for (const [symbol, pos] of positions) {
      const current = stockMap[symbol];
      positionValue += (current?.price || pos.entryPrice) * pos.shares;
    }
    equityCurve.push({ date, equity: +(capital + positionValue).toFixed(2), positions: positions.size });
  }

  // Close remaining positions at last known price
  const lastDate = dates[dates.length - 1];
  const lastDayStocks = byDate[lastDate] || [];
  const lastStockMap = {};
  for (const s of lastDayStocks) lastStockMap[s.symbol] = s;

  for (const [symbol, pos] of positions) {
    const stock = lastStockMap[symbol];
    const exitPrice = stock?.price || pos.entryPrice;
    const pnl = (exitPrice - pos.entryPrice) * pos.shares;
    const pnlPct = ((exitPrice / pos.entryPrice) - 1) * 100;
    capital += pos.shares * exitPrice;

    trades.push({
      symbol, entryDate: pos.entryDate, exitDate: lastDate,
      entryPrice: pos.entryPrice, exitPrice,
      shares: pos.shares, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
      holdingDays: dates.slice(dates.indexOf(pos.entryDate)).length,
      exitReason: 'end_of_period',
      entryRS: pos.entryStock.rs_rank, exitRS: stock?.rs_rank || null,
    });

    if (pnl > 0) totalWins++; else totalLosses++;
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

  // Average R-multiple (approx using 2% ATR as risk)
  const avgR = trades.length
    ? +(trades.reduce((a, t) => a + (t.pnlPct / 2), 0) / trades.length).toFixed(2) // 2% ATR approx
    : 0;

  // Sharpe ratio approximation (daily returns)
  const dailyReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    dailyReturns.push((equityCurve[i].equity / equityCurve[i - 1].equity) - 1);
  }
  const avgDailyReturn = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdDailyReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((a, r) => a + Math.pow(r - avgDailyReturn, 2), 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = stdDailyReturn > 0 ? +((avgDailyReturn / stdDailyReturn) * Math.sqrt(252)).toFixed(2) : 0;

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  // ─── Persist replay result ───────────────────────────────────────────────

  const replayId = db().prepare(`
    INSERT INTO replay_results (strategy, params, start_date, end_date, initial_capital,
      final_equity, total_return, total_trades, win_rate, profit_factor, max_drawdown, sharpe_ratio, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    strategy, JSON.stringify(mergedParams), startDate, endDate, initialCapital,
    finalEquity, +totalReturn.toFixed(2), trades.length, +winRate.toFixed(1),
    profitFactor, +maxDD.toFixed(2), sharpe,
    JSON.stringify({ trades, equityCurve, exitReasons })
  ).lastInsertRowid;

  return {
    id: replayId,
    strategy: stratDef.name,
    strategyKey: strategy,
    params: mergedParams,
    period: { startDate, endDate, tradingDays: dates.length },
    performance: {
      initialCapital, finalEquity: +finalEquity.toFixed(2),
      totalReturn: +totalReturn.toFixed(2),
      maxDrawdown: +maxDD.toFixed(2),
      sharpeRatio: sharpe,
      profitFactor,
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
  };
}

// ─── Compare Strategies ────────────────────────────────────────────────────

function compareStrategies({ strategies, startDate, endDate, maxPositions = 10, initialCapital = 100000 }) {
  const results = [];
  for (const { strategy, params } of strategies) {
    try {
      const result = runReplay({ strategy, params, startDate, endDate, maxPositions, initialCapital });
      results.push(result);
    } catch (e) {
      results.push({ strategy, error: e.message });
    }
  }

  // Rank by total return
  results.sort((a, b) => (b.performance?.totalReturn || -Infinity) - (a.performance?.totalReturn || -Infinity));
  return { comparisons: results, period: { startDate, endDate }, rankedBy: 'totalReturn' };
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

module.exports = {
  BUILT_IN_STRATEGIES,
  getAvailableDateRange,
  runReplay,
  compareStrategies,
  getReplayHistory,
  getReplayResult,
  deleteReplayResult,
};
