// ─── Multi-Strategy Allocation Framework ─────────────────────────────────────
// Run multiple trading strategies simultaneously with separate P&L tracking,
// allocation limits, and combined risk management.

const DEFAULT_STRATEGIES = [
  {
    id: 'momentum_swing',
    name: 'RS Momentum Swing',
    type: 'momentum',
    allocation_pct: 40,
    max_positions: 6,
    max_heat_pct: 3.5,
    holding_period_min: 2,
    holding_period_max: 20,
    entry_rules: JSON.stringify({
      rs_min: 70,
      swing_momentum_min: 55,
      stage: [2],
      regime_allowed: ['CONFIRMED_UPTREND', 'UPTREND_PRESSURE'],
    }),
    exit_rules: JSON.stringify({
      trail_atr_mult: 2.5,
      time_stop_days: 20,
      rs_exit_below: 50,
    }),
    enabled: 1,
  },
  {
    id: 'vcp_breakout',
    name: 'VCP/Pattern Breakout',
    type: 'breakout',
    allocation_pct: 25,
    max_positions: 4,
    max_heat_pct: 2.5,
    holding_period_min: 5,
    holding_period_max: 40,
    entry_rules: JSON.stringify({
      vcp_forming: true,
      contraction_count_min: 2,
      volume_dry_up: true,
      stage: [2],
    }),
    exit_rules: JSON.stringify({
      trail_atr_mult: 3.0,
      time_stop_days: 40,
      volume_climax_exit: true,
    }),
    enabled: 1,
  },
  {
    id: 'sector_rotation',
    name: 'Sector ETF Rotation',
    type: 'rotation',
    allocation_pct: 20,
    max_positions: 4,
    max_heat_pct: 1.5,
    holding_period_min: 15,
    holding_period_max: 60,
    entry_rules: JSON.stringify({
      sector_rs_rank_top: 3,
      monthly_rebalance: true,
      regime_allowed: ['CONFIRMED_UPTREND', 'UPTREND_PRESSURE', 'RALLY_ATTEMPT'],
    }),
    exit_rules: JSON.stringify({
      sector_rs_exit_rank: 8,
      rebalance_interval_days: 30,
    }),
    enabled: 1,
  },
  {
    id: 'mean_reversion',
    name: 'Oversold Bounce Plays',
    type: 'mean_reversion',
    allocation_pct: 15,
    max_positions: 3,
    max_heat_pct: 1.5,
    holding_period_min: 1,
    holding_period_max: 10,
    entry_rules: JSON.stringify({
      rs_max: 30,
      rs_recovering: true,
      oversold_bounce: true,
      rsi_below: 30,
    }),
    exit_rules: JSON.stringify({
      profit_target_pct: 5,
      time_stop_days: 10,
      rs_exit_above: 50,
    }),
    enabled: 1,
  },
];

const MAX_CROSS_STRATEGY_HEAT_PCT = 8;

// ─── getStrategies ──────────────────────────────────────────────────────────
// Returns all configured strategies from the DB. Seeds defaults on first run.
function getStrategies(db) {
  const rows = db.prepare('SELECT * FROM strategies').all();
  if (rows.length > 0) {
    return rows.map(_parseStrategyRow);
  }
  // First run — seed defaults
  _seedDefaults(db);
  return db.prepare('SELECT * FROM strategies').all().map(_parseStrategyRow);
}

function _parseStrategyRow(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    allocationPct: row.allocation_pct,
    maxPositions: row.max_positions,
    maxHeatPct: row.max_heat_pct,
    holdingPeriod: { min: row.holding_period_min, max: row.holding_period_max },
    entryRules: _safeJsonParse(row.entry_rules, {}),
    exitRules: _safeJsonParse(row.exit_rules, {}),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function _safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function _seedDefaults(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO strategies
      (id, name, type, allocation_pct, max_positions, max_heat_pct,
       holding_period_min, holding_period_max, entry_rules, exit_rules, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const txn = db.transaction(() => {
    for (const s of DEFAULT_STRATEGIES) {
      insert.run(
        s.id, s.name, s.type, s.allocation_pct, s.max_positions, s.max_heat_pct,
        s.holding_period_min, s.holding_period_max, s.entry_rules, s.exit_rules, s.enabled
      );
    }
  });
  txn();
}

// ─── getStrategyPerformance ─────────────────────────────────────────────────
// Computes strategy P&L metrics from the trades table.
function getStrategyPerformance(db, strategyId, startDate, endDate) {
  let query = `SELECT * FROM trades WHERE strategy = ?`;
  const params = [strategyId];

  if (startDate) {
    query += ' AND entry_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    query += ' AND (exit_date <= ? OR exit_date IS NULL)';
    params.push(endDate);
  }
  query += ' ORDER BY entry_date ASC';

  const trades = db.prepare(query).all(...params);

  if (!trades.length) {
    return {
      strategyId,
      trades: 0,
      winRate: 0,
      profitFactor: 0,
      totalReturn: 0,
      maxDrawdown: 0,
      sharpe: 0,
      avgR: 0,
      equityCurve: [],
    };
  }

  const closedTrades = trades.filter(t => t.exit_date && t.pnl_dollars != null);
  const wins = closedTrades.filter(t => t.pnl_dollars > 0);
  const losses = closedTrades.filter(t => t.pnl_dollars <= 0);

  const totalWin = wins.reduce((s, t) => s + t.pnl_dollars, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_dollars, 0));

  const winRate = closedTrades.length > 0
    ? +(wins.length / closedTrades.length * 100).toFixed(1)
    : 0;

  const profitFactor = totalLoss > 0
    ? +(totalWin / totalLoss).toFixed(2)
    : totalWin > 0 ? Infinity : 0;

  const avgWin = wins.length > 0
    ? +(totalWin / wins.length).toFixed(2)
    : 0;
  const avgLoss = losses.length > 0
    ? +(totalLoss / losses.length).toFixed(2)
    : 0;

  const totalReturn = +(totalWin - totalLoss).toFixed(2);

  // R-multiple stats
  const rMultiples = closedTrades
    .filter(t => t.r_multiple != null)
    .map(t => t.r_multiple);
  const avgR = rMultiples.length > 0
    ? +(rMultiples.reduce((s, r) => s + r, 0) / rMultiples.length).toFixed(2)
    : 0;

  // Equity curve + max drawdown
  const equityCurve = [];
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const returns = [];

  for (const t of closedTrades) {
    equity += t.pnl_dollars;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? +((peak - equity) / peak * 100).toFixed(2) : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    const prevEquity = equity - t.pnl_dollars;
    if (prevEquity !== 0) {
      returns.push(t.pnl_dollars / Math.abs(prevEquity || 1));
    }

    equityCurve.push({
      date: t.exit_date,
      equity: +equity.toFixed(2),
    });
  }

  // Sharpe ratio (annualized, using daily proxy from trade returns)
  let sharpe = 0;
  if (returns.length >= 5) {
    const meanRet = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      // Approximate annualization assuming ~50 trades/year
      const tradesPerYear = Math.min(returns.length, 50);
      sharpe = +((meanRet / stdDev) * Math.sqrt(tradesPerYear)).toFixed(2);
    }
  }

  return {
    strategyId,
    trades: closedTrades.length,
    openTrades: trades.length - closedTrades.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    totalReturn,
    maxDrawdown: +maxDrawdown.toFixed(2),
    sharpe,
    avgR,
    equityCurve,
  };
}

// ─── getStrategyAllocation ──────────────────────────────────────────────────
// Returns current allocation state for all strategies vs target.
function getStrategyAllocation(db, accountSize) {
  const strategies = getStrategies(db);
  const openPositions = db.prepare(
    `SELECT symbol, shares, entry_price, stop_price, strategy FROM trades WHERE exit_date IS NULL`
  ).all();

  let totalAllocated = 0;
  let totalHeat = 0;

  const strategyDetails = strategies.map(strat => {
    const targetDollars = +(accountSize * strat.allocationPct / 100).toFixed(2);

    // Positions belonging to this strategy
    const stratPositions = openPositions.filter(p => p.strategy === strat.id);
    const currentDollars = stratPositions.reduce(
      (sum, p) => sum + (p.shares || 0) * (p.entry_price || 0), 0
    );

    // Heat: sum of dollar risk as % of strategy allocation
    let heatDollars = 0;
    for (const p of stratPositions) {
      const risk = (p.entry_price - (p.stop_price || p.entry_price * 0.95)) * (p.shares || 0);
      heatDollars += risk;
    }
    const heatUsed = targetDollars > 0
      ? +(heatDollars / accountSize * 100).toFixed(2)
      : 0;

    const availableDollars = +Math.max(0, targetDollars - currentDollars).toFixed(2);
    const utilizationPct = targetDollars > 0
      ? +(currentDollars / targetDollars * 100).toFixed(1)
      : 0;

    totalAllocated += currentDollars;
    totalHeat += heatDollars;

    return {
      ...strat,
      targetDollars,
      currentDollars: +currentDollars.toFixed(2),
      availableDollars,
      heatUsed,
      heatMax: strat.maxHeatPct,
      positionsOpen: stratPositions.length,
      positionsMax: strat.maxPositions,
      utilizationPct,
    };
  });

  const crossStrategyHeat = accountSize > 0
    ? +(totalHeat / accountSize * 100).toFixed(2)
    : 0;

  return {
    strategies: strategyDetails,
    totalAllocated: +totalAllocated.toFixed(2),
    totalAvailable: +(accountSize - totalAllocated).toFixed(2),
    crossStrategyHeat,
    crossStrategyHeatMax: MAX_CROSS_STRATEGY_HEAT_PCT,
    withinLimits: crossStrategyHeat <= MAX_CROSS_STRATEGY_HEAT_PCT,
  };
}

// ─── validateTradeForStrategy ───────────────────────────────────────────────
// Pre-trade validation against strategy allocation, heat, and position limits.
function validateTradeForStrategy(db, strategyId, trade, accountSize) {
  const reasons = [];
  const strategies = getStrategies(db);
  const strategy = strategies.find(s => s.id === strategyId);

  if (!strategy) {
    return { allowed: false, reasons: [`Strategy "${strategyId}" not found`], adjustedSize: null };
  }
  if (!strategy.enabled) {
    return { allowed: false, reasons: [`Strategy "${strategy.name}" is disabled`], adjustedSize: null };
  }

  const allocation = getStrategyAllocation(db, accountSize);
  const stratAlloc = allocation.strategies.find(s => s.id === strategyId);

  const entryPrice = trade.entry || trade.entryPrice || trade.entry_price;
  const stopPrice = trade.stop || trade.stopPrice || trade.stop_price;
  const shares = trade.shares || trade.qty;

  if (!entryPrice || !stopPrice || !shares) {
    return { allowed: false, reasons: ['Missing entry, stop, or shares in trade'], adjustedSize: null };
  }

  const tradeValue = shares * entryPrice;
  const tradeRisk = (entryPrice - stopPrice) * shares;

  // 1. Check allocation limit
  if (tradeValue > stratAlloc.availableDollars) {
    const maxShares = Math.floor(stratAlloc.availableDollars / entryPrice);
    reasons.push(
      `Trade value $${tradeValue.toFixed(0)} exceeds available allocation $${stratAlloc.availableDollars.toFixed(0)} — max ${maxShares} shares`
    );
  }

  // 2. Check position count
  if (stratAlloc.positionsOpen >= stratAlloc.positionsMax) {
    reasons.push(
      `Strategy at max positions (${stratAlloc.positionsOpen}/${stratAlloc.positionsMax})`
    );
  }

  // 3. Check strategy-level heat
  const newHeat = stratAlloc.heatUsed + (tradeRisk / accountSize * 100);
  if (newHeat > strategy.maxHeatPct) {
    reasons.push(
      `Strategy heat would reach ${newHeat.toFixed(2)}% (max ${strategy.maxHeatPct}%)`
    );
  }

  // 4. Check cross-strategy portfolio heat
  const newCrossHeat = allocation.crossStrategyHeat + (tradeRisk / accountSize * 100);
  if (newCrossHeat > MAX_CROSS_STRATEGY_HEAT_PCT) {
    reasons.push(
      `Cross-strategy heat would reach ${newCrossHeat.toFixed(2)}% (max ${MAX_CROSS_STRATEGY_HEAT_PCT}%)`
    );
  }

  // 5. Check holding period compatibility (estimate from trade setup)
  if (trade.holdingPeriod || trade.expectedDays) {
    const expected = trade.holdingPeriod || trade.expectedDays;
    const { min, max } = strategy.holdingPeriod;
    if (expected < min || expected > max) {
      reasons.push(
        `Expected hold ${expected}d outside strategy range ${min}-${max}d`
      );
    }
  }

  // Calculate adjusted size if trade exceeds limits
  let adjustedSize = null;
  if (reasons.length > 0) {
    const maxByAllocation = stratAlloc.availableDollars > 0
      ? Math.floor(stratAlloc.availableDollars / entryPrice)
      : 0;
    const maxByHeat = strategy.maxHeatPct > stratAlloc.heatUsed && (entryPrice - stopPrice) > 0
      ? Math.floor(((strategy.maxHeatPct - stratAlloc.heatUsed) / 100 * accountSize) / (entryPrice - stopPrice))
      : 0;
    const maxByCrossHeat = MAX_CROSS_STRATEGY_HEAT_PCT > allocation.crossStrategyHeat && (entryPrice - stopPrice) > 0
      ? Math.floor(((MAX_CROSS_STRATEGY_HEAT_PCT - allocation.crossStrategyHeat) / 100 * accountSize) / (entryPrice - stopPrice))
      : 0;

    const adjusted = Math.min(
      maxByAllocation > 0 ? maxByAllocation : Infinity,
      maxByHeat > 0 ? maxByHeat : Infinity,
      maxByCrossHeat > 0 ? maxByCrossHeat : Infinity,
    );
    if (adjusted > 0 && adjusted !== Infinity && stratAlloc.positionsOpen < stratAlloc.positionsMax) {
      adjustedSize = adjusted;
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    adjustedSize,
  };
}

// ─── rebalanceStrategies ────────────────────────────────────────────────────
// Compares current allocation to target and flags strategies needing rebalance.
function rebalanceStrategies(db, accountSize) {
  const allocation = getStrategyAllocation(db, accountSize);
  const REBALANCE_THRESHOLD_PCT = 5; // flag when >5% over/under target

  const actions = [];
  for (const strat of allocation.strategies) {
    if (!strat.enabled) continue;

    const currentPct = accountSize > 0
      ? +(strat.currentDollars / accountSize * 100).toFixed(1)
      : 0;
    const targetPct = strat.allocationPct;
    const deviation = currentPct - targetPct;

    if (Math.abs(deviation) > REBALANCE_THRESHOLD_PCT) {
      actions.push({
        strategy: strat.id,
        name: strat.name,
        action: deviation > 0 ? 'reduce' : 'increase',
        amount: +Math.abs(strat.currentDollars - strat.targetDollars).toFixed(2),
        currentPct,
        targetPct,
        deviationPct: +deviation.toFixed(1),
      });
    }
  }

  return {
    needsRebalance: actions.length > 0,
    actions,
    totalAllocated: allocation.totalAllocated,
    totalAvailable: allocation.totalAvailable,
    timestamp: new Date().toISOString(),
  };
}

// ─── assignStrategy ─────────────────────────────────────────────────────────
// Auto-classifies a trade into the best-matching strategy based on
// trade characteristics (RS, VCP, sector ETF, etc.).
function assignStrategy(trade) {
  const reasons = [];
  let strategy = null;
  let confidence = 0;

  const rs = trade.rs_rank || trade.rs || trade.rsRank || 0;
  const swing = trade.swing_momentum || trade.swingMomentum || 0;
  const holdDays = trade.holdingPeriod || trade.expectedDays || trade.holding_period || 0;
  const vcpForming = trade.vcp_forming || trade.vcpForming || false;
  const patternDetected = trade.pattern || trade.patternDetected || false;
  const isSectorEtf = trade.isSectorEtf || trade.is_sector_etf || false;
  const symbol = (trade.symbol || '').toUpperCase();

  // Check sector ETF by common symbols
  const SECTOR_ETFS = ['XLK','XLF','XLV','XLE','XLI','XLP','XLU','XLB','XLC','XLRE','XLY',
    'SMH','IBB','IYR','IYT','KBE','KRE','XHB','XBI','XOP','GDX','TAN','ARKK'];
  const isSectorSymbol = isSectorEtf || SECTOR_ETFS.includes(symbol);

  // Priority 1: Sector ETF rotation
  if (isSectorSymbol) {
    strategy = 'sector_rotation';
    confidence = 90;
    reasons.push('Sector ETF detected');
    return { strategy, confidence, reasons };
  }

  // Priority 2: VCP/pattern breakout
  if (vcpForming || patternDetected) {
    strategy = 'vcp_breakout';
    confidence = 85;
    reasons.push(vcpForming ? 'VCP pattern forming' : 'Chart pattern detected');
    if (rs >= 70) { confidence += 5; reasons.push(`Strong RS (${rs})`); }
    return { strategy, confidence, reasons };
  }

  // Priority 3: Mean reversion (oversold bounce)
  if (rs > 0 && rs < 30) {
    strategy = 'mean_reversion';
    confidence = 75;
    reasons.push(`Low RS rank (${rs}) — potential oversold bounce`);
    if (trade.rs_recovering || trade.rsRecovering) {
      confidence += 10;
      reasons.push('RS recovering from trough');
    }
    if (holdDays > 0 && holdDays <= 10) {
      confidence += 5;
      reasons.push(`Short hold period (${holdDays}d) matches mean reversion`);
    }
    return { strategy, confidence, reasons };
  }

  // Priority 4: Momentum swing (default for strong RS stocks)
  if (rs >= 70 && swing >= 55) {
    strategy = 'momentum_swing';
    confidence = 80;
    reasons.push(`RS ${rs} + Swing Momentum ${swing}`);
    if (holdDays > 0 && holdDays <= 20) {
      confidence += 10;
      reasons.push(`Hold period ${holdDays}d matches swing timeframe`);
    }
    return { strategy, confidence, reasons };
  }

  // Fallback: classify by hold period or default to momentum
  if (rs >= 50) {
    strategy = 'momentum_swing';
    confidence = 50;
    reasons.push(`Moderate RS (${rs}) — defaulting to momentum swing`);
  } else {
    strategy = 'mean_reversion';
    confidence = 40;
    reasons.push(`Below-average RS (${rs}) — classified as mean reversion`);
  }

  return { strategy, confidence, reasons };
}

// ─── getCorrelatedRisk ──────────────────────────────────────────────────────
// Analyzes cross-strategy correlation risk to measure diversification benefit.
function getCorrelatedRisk(db, accountSize) {
  const allocation = getStrategyAllocation(db, accountSize);
  const openPositions = db.prepare(
    `SELECT symbol, shares, entry_price, strategy, sector FROM trades WHERE exit_date IS NULL`
  ).all();

  if (openPositions.length < 2) {
    return {
      crossCorrelation: 0,
      effectiveStrategies: openPositions.length > 0 ? 1 : 0,
      diversificationBenefit: 1.0,
      details: [],
    };
  }

  // Group positions by strategy
  const strategyGroups = {};
  for (const pos of openPositions) {
    const strat = pos.strategy || 'unclassified';
    if (!strategyGroups[strat]) strategyGroups[strat] = [];
    strategyGroups[strat].push(pos);
  }

  const activeStrategies = Object.keys(strategyGroups);
  const strategyCount = activeStrategies.length;

  // Strategy-pair type-based correlation estimates
  // Momentum and mean reversion are naturally inversely correlated
  const TYPE_CORRELATIONS = {
    'momentum_momentum': 0.7,
    'momentum_breakout': 0.5,
    'momentum_rotation': 0.3,
    'momentum_mean_reversion': -0.2,
    'breakout_breakout': 0.6,
    'breakout_rotation': 0.25,
    'breakout_mean_reversion': -0.1,
    'rotation_rotation': 0.5,
    'rotation_mean_reversion': 0.1,
    'mean_reversion_mean_reversion': 0.5,
  };

  // Compute sector overlap between strategies as additional correlation factor
  const details = [];
  let totalCorrelation = 0;
  let pairCount = 0;

  const strategyTypes = {};
  const allStrategies = getStrategies(db);
  for (const s of allStrategies) strategyTypes[s.id] = s.type;

  for (let i = 0; i < activeStrategies.length; i++) {
    for (let j = i + 1; j < activeStrategies.length; j++) {
      const s1 = activeStrategies[i];
      const s2 = activeStrategies[j];
      const type1 = strategyTypes[s1] || 'momentum';
      const type2 = strategyTypes[s2] || 'momentum';

      // Look up type-based correlation (order-independent)
      const key1 = `${type1}_${type2}`;
      const key2 = `${type2}_${type1}`;
      const typeCorr = TYPE_CORRELATIONS[key1] ?? TYPE_CORRELATIONS[key2] ?? 0.3;

      // Sector overlap bonus: shared sectors increase effective correlation
      const sectors1 = new Set(strategyGroups[s1].map(p => p.sector).filter(Boolean));
      const sectors2 = new Set(strategyGroups[s2].map(p => p.sector).filter(Boolean));
      let overlap = 0;
      for (const sec of sectors1) {
        if (sectors2.has(sec)) overlap++;
      }
      const overlapPct = (sectors1.size + sectors2.size) > 0
        ? overlap / Math.max(sectors1.size, sectors2.size)
        : 0;

      const effectiveCorr = +(typeCorr + overlapPct * 0.2).toFixed(2);
      totalCorrelation += effectiveCorr;
      pairCount++;

      details.push({ strategy1: s1, strategy2: s2, correlation: effectiveCorr, sectorOverlap: overlap });
    }
  }

  const avgCorrelation = pairCount > 0 ? +(totalCorrelation / pairCount).toFixed(2) : 0;

  // Effective strategies: adjusted count accounting for correlation
  // If all perfectly correlated = 1, if all uncorrelated = strategyCount
  const effectiveStrategies = avgCorrelation >= 1
    ? 1
    : +(strategyCount / (1 + (strategyCount - 1) * Math.max(0, avgCorrelation))).toFixed(1);

  // Diversification benefit: ratio of effective to actual strategies
  const diversificationBenefit = strategyCount > 0
    ? +(effectiveStrategies / strategyCount).toFixed(2)
    : 0;

  return {
    crossCorrelation: avgCorrelation,
    effectiveStrategies,
    diversificationBenefit,
    activeStrategies: strategyCount,
    details,
  };
}

module.exports = {
  getStrategies,
  getStrategyPerformance,
  getStrategyAllocation,
  validateTradeForStrategy,
  rebalanceStrategies,
  assignStrategy,
  getCorrelatedRisk,
  DEFAULT_STRATEGIES,
  MAX_CROSS_STRATEGY_HEAT_PCT,
};
