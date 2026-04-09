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
  short_breakdown: {
    name: 'Short Breakdown',
    description: 'Short Stage 4 stocks with RS <= 20, cover on RS recovery or stop',
    defaults: { maxRS: 20, maxSEPA: 2, exitRS: 40, stopATR: 1.5, holdDays: 15 },
    side: 'short',
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
           vs_ma50, vs_ma200, volume_ratio, vcp_forming, rs_line_new_high, atr_pct
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

    case 'short_breakdown':
      return stock.rs_rank <= params.maxRS &&
             (stock.sepa_score || 8) <= params.maxSEPA &&
             stock.stage === 4;

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
      // Use stored atrPct from snapshot if available, otherwise approximate at 2.5%
      const atrPct = entryStock.atr_pct || 2.5;
      const atr = entryStock.price * (atrPct / 100);
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

    case 'short_breakdown': {
      // Cover short if RS recovers (stock is strengthening)
      if (stock.rs_rank >= params.exitRS) return { exit: true, reason: 'rs_recovered' };
      // Stop-out: price moves against us (up)
      if (entryStock.price && stock.price) {
        const atrPct = entryStock.atr_pct || 2.5;
        const atr = entryStock.price * (atrPct / 100);
        const stopPrice = entryStock.price + (params.stopATR * atr);
        if (stock.price >= stopPrice) return { exit: true, reason: 'stop_hit' };
      }
      break;
    }
  }

  return { exit: false };
}

// ─── Execution Model ──────────────────────────────────────────────────────
// Realistic slippage and cost simulation

const DEFAULT_EXECUTION = {
  entrySlippageBps: 10,    // 10 basis points slippage on entries (buying into strength)
  exitSlippageBps: 5,      // 5 bps on exits (more orderly)
  commissionPerShare: 0,   // Most brokers are $0 commission now; set >0 if needed
  maxGapPct: 3.0,          // Skip entries where price gaps up >3% from prior close
};

function applySlippage(price, bps, side) {
  // Slippage always works against you:
  // Buying long / covering short = pay more
  // Selling long / shorting = receive less
  const slipMultiplier = side === 'buy' ? (1 + bps / 10000) : (1 - bps / 10000);
  return +(price * slipMultiplier).toFixed(4);
}

// ─── SPY Benchmark ────────────────────────────────────────────────────────

function calcSPYBenchmark(startDate, endDate) {
  // Load SPY snapshots for the same period
  const spySnaps = db().prepare(`
    SELECT date, price FROM rs_snapshots
    WHERE symbol = 'SPY' AND type = 'stock' AND date >= ? AND date <= ? AND price > 0
    ORDER BY date
  `).all(startDate, endDate);

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

// ─── Point-in-Time Universe Filter ────────────────────────────────────────
// Excludes stocks that were removed from the universe before a given date
// to reduce survivorship bias. Only effective if universe_mgmt is populated.

function getActiveUniverse(date) {
  try {
    const removed = db().prepare(`
      SELECT symbol FROM universe_mgmt
      WHERE removed_date IS NOT NULL AND removed_date <= ?
    `).all(date).map(r => r.symbol);
    return new Set(removed);
  } catch (_) {
    return new Set(); // No universe tracking = can't filter
  }
}

// ─── Replay Engine ─────────────────────────────────────────────────────────

function runReplay({ strategy, params = {}, startDate, endDate, maxPositions = 10, initialCapital = 100000, execution = {} }) {
  const stratDef = BUILT_IN_STRATEGIES[strategy];
  if (!stratDef) throw new Error(`Unknown strategy: ${strategy}. Available: ${Object.keys(BUILT_IN_STRATEGIES).join(', ')}`);

  const mergedParams = { ...stratDef.defaults, ...params };
  const exec = { ...DEFAULT_EXECUTION, ...execution };

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
  const isShort = stratDef.side === 'short';
  let capital = initialCapital;
  let totalSlippageCost = 0;
  let skippedGaps = 0;
  let skippedSurvivorship = 0;
  const positions = new Map();
  const trades = [];
  const equityCurve = [{ date: dates[0], equity: capital, positions: 0 }];
  let totalWins = 0, totalLosses = 0;

  // Build prior-day price map for gap detection
  const priorPriceMap = {};

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const dayStocks = byDate[date];
    const stockMap = {};
    for (const s of dayStocks) stockMap[s.symbol] = s;

    // Survivorship filter: skip stocks removed from universe before this date
    const removedSymbols = getActiveUniverse(date);

    // Check exits first
    for (const [symbol, pos] of positions) {
      const stock = stockMap[symbol];
      if (!stock) continue;

      const holdingDays = dates.slice(dates.indexOf(pos.entryDate), i + 1).length;
      const exitCheck = evaluateExit(stock, pos.entryStock, strategy, mergedParams, holdingDays);

      if (exitCheck.exit && stock.price) {
        // Apply exit slippage
        const rawExitPrice = stock.price;
        const exitPrice = isShort
          ? applySlippage(rawExitPrice, exec.exitSlippageBps, 'buy')    // Cover = buy
          : applySlippage(rawExitPrice, exec.exitSlippageBps, 'sell');
        const slippageCost = Math.abs(rawExitPrice - exitPrice) * pos.shares;
        totalSlippageCost += slippageCost;

        const pnl = isShort
          ? (pos.entryPrice - exitPrice) * pos.shares
          : (exitPrice - pos.entryPrice) * pos.shares;
        const pnlPct = isShort
          ? ((pos.entryPrice / exitPrice) - 1) * 100
          : ((exitPrice / pos.entryPrice) - 1) * 100;

        capital += pos.collateral + pnl;

        trades.push({
          symbol, side: isShort ? 'short' : 'long',
          entryDate: pos.entryDate, exitDate: date,
          entryPrice: pos.entryPrice, exitPrice: +exitPrice.toFixed(2),
          shares: pos.shares, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
          atrPct: pos.entryStock.atr_pct || null,
          slippageCost: +slippageCost.toFixed(2),
          holdingDays, exitReason: exitCheck.reason,
          entryRS: pos.entryStock.rs_rank, exitRS: stock.rs_rank,
        });

        if (pnl > 0) totalWins++; else totalLosses++;
        positions.delete(symbol);
      }
    }

    // Check entries (if we have capacity)
    if (positions.size < maxPositions) {
      let candidates = dayStocks
        .filter(s => !positions.has(s.symbol) && s.price > 0)
        .filter(s => !removedSymbols.has(s.symbol))  // Survivorship filter
        .filter(s => evaluateEntry(s, strategy, mergedParams));

      // For conviction strategy, take top N; for shorts, take weakest RS
      if (strategy === 'conviction') {
        candidates.sort((a, b) => (b.rs_rank || 0) - (a.rs_rank || 0));
      } else if (isShort) {
        candidates.sort((a, b) => (a.rs_rank || 99) - (b.rs_rank || 99));
      }

      const slotsAvailable = maxPositions - positions.size;
      // Use AVAILABLE capital, not total — prevents implicit leverage
      const availableCapital = Math.max(0, capital);
      const positionSize = availableCapital / Math.max(1, slotsAvailable);

      for (const stock of candidates.slice(0, slotsAvailable)) {
        if (positionSize < 100 || !stock.price) continue;

        // Gap filter: skip if price gapped up >maxGapPct from prior close
        const priorPrice = priorPriceMap[stock.symbol];
        if (!isShort && priorPrice && stock.price > 0) {
          const gapPct = ((stock.price / priorPrice) - 1) * 100;
          if (gapPct > exec.maxGapPct) {
            skippedGaps++;
            continue; // Missed the breakout — don't chase
          }
        }

        // Apply entry slippage
        const rawEntryPrice = stock.price;
        const entryPrice = isShort
          ? applySlippage(rawEntryPrice, exec.entrySlippageBps, 'sell')   // Short = sell
          : applySlippage(rawEntryPrice, exec.entrySlippageBps, 'buy');
        const shares = Math.floor(positionSize / entryPrice);
        if (shares <= 0) continue;

        const slippageCost = Math.abs(rawEntryPrice - entryPrice) * shares;
        totalSlippageCost += slippageCost;

        const collateral = shares * entryPrice;
        capital -= collateral;

        positions.set(stock.symbol, {
          entryDate: date,
          entryPrice: +entryPrice.toFixed(4),
          entryStock: stock,
          shares,
          collateral,
        });
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
      if (isShort) {
        positionValue += pos.collateral + (pos.entryPrice - currentPrice) * pos.shares;
      } else {
        positionValue += currentPrice * pos.shares;
      }
    }
    equityCurve.push({ date, equity: +(capital + positionValue).toFixed(2), positions: positions.size });
  }

  // Close remaining positions at last known price (with exit slippage)
  const lastDate = dates[dates.length - 1];
  const lastDayStocks = byDate[lastDate] || [];
  const lastStockMap = {};
  for (const s of lastDayStocks) lastStockMap[s.symbol] = s;

  for (const [symbol, pos] of positions) {
    const stock = lastStockMap[symbol];
    const rawExitPrice = stock?.price || pos.entryPrice;
    const exitPrice = isShort
      ? applySlippage(rawExitPrice, exec.exitSlippageBps, 'buy')
      : applySlippage(rawExitPrice, exec.exitSlippageBps, 'sell');
    const pnl = isShort
      ? (pos.entryPrice - exitPrice) * pos.shares
      : (exitPrice - pos.entryPrice) * pos.shares;
    const pnlPct = isShort
      ? ((pos.entryPrice / exitPrice) - 1) * 100
      : ((exitPrice / pos.entryPrice) - 1) * 100;
    capital += pos.collateral + pnl;

    trades.push({
      symbol, side: isShort ? 'short' : 'long',
      entryDate: pos.entryDate, exitDate: lastDate,
      entryPrice: pos.entryPrice, exitPrice: +exitPrice.toFixed(2),
      shares: pos.shares, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
      atrPct: pos.entryStock.atr_pct || null,
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

  // Average R-multiple (approx using per-trade risk — entry to stop distance)
  const avgR = trades.length
    ? +(trades.reduce((a, t) => {
        // Use actual ATR% from snapshot if available, fallback to 2.5%
        const riskPct = t.atrPct || 2.5;
        return a + (t.pnlPct / riskPct);
      }, 0) / trades.length).toFixed(2)
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

  // ─── SPY Benchmark ─────────────────────────────────────────────────────────
  const spyBenchmark = calcSPYBenchmark(startDate, endDate);
  const alpha = spyBenchmark
    ? +(totalReturn - spyBenchmark.totalReturn).toFixed(2)
    : null;

  // ─── Persist replay result ───────────────────────────────────────────────

  const replayId = db().prepare(`
    INSERT INTO replay_results (strategy, params, start_date, end_date, initial_capital,
      final_equity, total_return, total_trades, win_rate, profit_factor, max_drawdown, sharpe_ratio, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    strategy, JSON.stringify(mergedParams), startDate, endDate, initialCapital,
    finalEquity, +totalReturn.toFixed(2), trades.length, +winRate.toFixed(1),
    profitFactor, +maxDD.toFixed(2), sharpe,
    JSON.stringify({ trades, equityCurve, exitReasons, spyBenchmark })
  ).lastInsertRowid;

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
      profitFactor,
      alpha,
    },
    benchmark: spyBenchmark ? {
      spyReturn: spyBenchmark.totalReturn,
      spyMaxDrawdown: spyBenchmark.maxDrawdown,
      spySharpe: spyBenchmark.sharpeRatio,
      outperformed: totalReturn > spyBenchmark.totalReturn,
      spyEquityCurve: spyBenchmark.equityCurve,
    } : null,
    executionCosts: {
      totalSlippage: +totalSlippageCost.toFixed(2),
      slippageAsReturnDrag: +(totalSlippageCost / initialCapital * 100).toFixed(3),
      skippedGaps,
      skippedSurvivorship,
      entrySlippageBps: exec.entrySlippageBps,
      exitSlippageBps: exec.exitSlippageBps,
      maxGapPct: exec.maxGapPct,
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
