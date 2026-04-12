// ─── Correlation-Aware Portfolio Construction ────────────────────────────────
// Goes beyond simple sector limits to measure ACTUAL position correlation,
// factor exposure, and portfolio concentration risk.
//
// Key concepts:
//   - Rolling pairwise correlation matrix
//   - Effective number of independent bets (diversification ratio)
//   - Factor exposure decomposition (what bets are you actually making?)
//   - Maximum portfolio correlation constraint
//   - Portfolio-level risk aggregation (not just sum of individual risks)

const { getDB } = require('../data/database');
const { calcBeta, calcCorrelationMatrix } = require('./position-sizer');

function db() { return getDB(); }

// ─── Portfolio Correlation Analysis ─────────────────────────────────────────
// Computes the real correlation structure of current positions.
// Returns actionable insights: which positions are redundant, what's the
// effective number of bets, and where concentration risk lurks.

function analyzePortfolioCorrelation(closesMap, positions) {
  if (!positions?.length || positions.length < 2) {
    return {
      effectiveBets: positions?.length || 0,
      avgCorrelation: 0,
      maxCorrelation: { pair: null, value: 0 },
      concentrationRisk: 'none',
      clusterCount: 0,
      clusters: [],
      warnings: [],
    };
  }

  // Filter to positions we have data for
  const symbols = positions.map(p => p.symbol).filter(s => closesMap[s]?.length >= 61);
  if (symbols.length < 2) {
    return { effectiveBets: symbols.length, avgCorrelation: 0, warnings: ['Insufficient price data for correlation'] };
  }

  const filteredMap = {};
  for (const s of symbols) filteredMap[s] = closesMap[s];
  const { matrix, warnings: corrWarnings } = calcCorrelationMatrix(filteredMap, 60);

  // Average pairwise correlation
  let totalCorr = 0, pairCount = 0;
  let maxCorr = { pair: null, value: -1 };
  const pairs = [];

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const c = matrix[symbols[i]]?.[symbols[j]];
      if (c != null) {
        totalCorr += c;
        pairCount++;
        pairs.push({ a: symbols[i], b: symbols[j], correlation: c });
        if (c > maxCorr.value) {
          maxCorr = { pair: [symbols[i], symbols[j]], value: c };
        }
      }
    }
  }

  const avgCorrelation = pairCount > 0 ? +(totalCorr / pairCount).toFixed(3) : 0;

  // Effective number of independent bets (diversification ratio)
  // Formula: N_eff = N / (1 + (N-1) * avg_corr)
  // With 5 positions at avg corr 0.8, you effectively have ~1.5 independent bets
  const N = symbols.length;
  const effectiveBets = avgCorrelation > 0
    ? +(N / (1 + (N - 1) * avgCorrelation)).toFixed(1)
    : N;

  // Hierarchical clustering — group highly correlated positions
  const clusters = clusterPositions(symbols, matrix, 0.6);

  // Concentration risk assessment
  let concentrationRisk;
  if (avgCorrelation > 0.7) concentrationRisk = 'critical';
  else if (avgCorrelation > 0.5) concentrationRisk = 'high';
  else if (avgCorrelation > 0.3) concentrationRisk = 'moderate';
  else concentrationRisk = 'low';

  // Generate actionable warnings
  const warnings = [...(corrWarnings || [])];
  if (avgCorrelation > 0.6) {
    warnings.push(`Average correlation ${avgCorrelation.toFixed(2)} — portfolio behaves like ${effectiveBets} positions, not ${N}`);
  }
  if (maxCorr.value > 0.85) {
    warnings.push(`${maxCorr.pair[0]}-${maxCorr.pair[1]} correlation ${maxCorr.value} — consider replacing one`);
  }
  if (effectiveBets < N * 0.4) {
    warnings.push(`Only ${effectiveBets} effective independent bets out of ${N} positions — severe concentration`);
  }

  // Identify redundant positions (corr > 0.8 with another position)
  const redundant = pairs.filter(p => p.correlation > 0.8).map(p => ({
    pair: [p.a, p.b],
    correlation: p.correlation,
    recommendation: `Consider closing one — they move together ${(p.correlation * 100).toFixed(0)}% of the time`,
  }));

  return {
    effectiveBets,
    totalPositions: N,
    avgCorrelation,
    maxCorrelation: maxCorr,
    concentrationRisk,
    clusters,
    clusterCount: clusters.length,
    redundantPairs: redundant,
    allPairs: pairs.sort((a, b) => b.correlation - a.correlation),
    warnings,
    diversificationRatio: +(effectiveBets / N).toFixed(2),
  };
}

// Simple single-linkage clustering
function clusterPositions(symbols, matrix, threshold) {
  const visited = new Set();
  const clusters = [];

  for (const sym of symbols) {
    if (visited.has(sym)) continue;
    const cluster = [sym];
    visited.add(sym);

    // Find all symbols correlated > threshold with any cluster member
    let changed = true;
    while (changed) {
      changed = false;
      for (const other of symbols) {
        if (visited.has(other)) continue;
        for (const member of cluster) {
          const c = matrix[member]?.[other];
          if (c != null && c > threshold) {
            cluster.push(other);
            visited.add(other);
            changed = true;
            break;
          }
        }
      }
    }
    if (cluster.length > 1) {
      clusters.push({ members: cluster, size: cluster.length });
    }
  }

  return clusters;
}

// ─── Factor Exposure Analysis ───────────────────────────────────────────────
// Decompose portfolio into factor bets: market (beta), momentum, size, sector.
// Answers "what risks am I actually taking?" vs what I think I'm taking.

function analyzeFactorExposure(positions, closesMap, benchmarkCloses) {
  if (!positions?.length) {
    return { factors: {}, totalExposure: 0, warnings: [] };
  }

  const factors = {
    market: { exposure: 0, description: 'Beta-weighted market exposure' },
    momentum: { exposure: 0, description: 'Net momentum factor tilt' },
    concentration: { exposure: 0, description: 'Single-stock concentration' },
    sector: { exposures: {}, description: 'Sector factor tilts' },
  };

  let totalValue = 0;
  const posDetails = [];

  for (const pos of positions) {
    const value = (pos.shares || 0) * (pos.currentPrice || pos.entry_price);
    totalValue += value;

    // Beta exposure
    const beta = closesMap[pos.symbol] && benchmarkCloses
      ? calcBeta(closesMap[pos.symbol], benchmarkCloses, 90) || 1.0
      : pos.beta || 1.0;

    // Momentum proxy (from RS rank if available)
    const momTilt = pos.rsRank ? (pos.rsRank - 50) / 50 : 0; // -1 to +1

    posDetails.push({
      symbol: pos.symbol,
      value,
      beta,
      momTilt,
      sector: pos.sector || 'Unknown',
      side: pos.side || 'long',
    });
  }

  if (totalValue === 0) return { factors, totalExposure: 0, warnings: [] };

  // Aggregate factor exposures (value-weighted)
  for (const p of posDetails) {
    const weight = p.value / totalValue;
    const sign = p.side === 'short' ? -1 : 1;

    factors.market.exposure += weight * p.beta * sign;
    factors.momentum.exposure += weight * p.momTilt * sign;

    const sector = p.sector;
    if (!factors.sector.exposures[sector]) factors.sector.exposures[sector] = 0;
    factors.sector.exposures[sector] += weight * sign;
  }

  // Concentration: Herfindahl index (sum of squared weights)
  // 1/N = perfectly diversified, 1.0 = single stock
  const herfindahl = posDetails.reduce((s, p) => s + (p.value / totalValue) ** 2, 0);
  factors.concentration.exposure = +herfindahl.toFixed(3);
  const effectiveN = +(1 / herfindahl).toFixed(1);

  // Round values
  factors.market.exposure = +factors.market.exposure.toFixed(2);
  factors.momentum.exposure = +factors.momentum.exposure.toFixed(2);

  for (const [k, v] of Object.entries(factors.sector.exposures)) {
    factors.sector.exposures[k] = +(v * 100).toFixed(1); // as percentage
  }

  // Warnings
  const warnings = [];
  if (factors.market.exposure > 1.3) {
    warnings.push(`Portfolio beta ${factors.market.exposure} — 30%+ more volatile than SPY. Consider reducing high-beta names.`);
  }
  if (factors.market.exposure < 0.5 && positions.length > 3) {
    warnings.push(`Portfolio beta only ${factors.market.exposure} — very defensive. May underperform in rallies.`);
  }
  if (herfindahl > 0.25) {
    warnings.push(`High concentration (Herfindahl ${herfindahl.toFixed(3)}) — effectively ${effectiveN} positions`);
  }

  // Find dominant sector
  const sectorEntries = Object.entries(factors.sector.exposures).sort((a, b) => b[1] - a[1]);
  if (sectorEntries[0] && sectorEntries[0][1] > 40) {
    warnings.push(`${sectorEntries[0][0]} at ${sectorEntries[0][1]}% — massive sector bet. Consider if intentional.`);
  }

  return {
    factors,
    totalValue: +totalValue.toFixed(2),
    effectivePositions: effectiveN,
    herfindahl: +herfindahl.toFixed(3),
    positionDetails: posDetails.map(p => ({
      symbol: p.symbol,
      weight: +((p.value / totalValue) * 100).toFixed(1),
      beta: p.beta,
      sector: p.sector,
    })),
    warnings,
  };
}

// ─── Correlation-Adjusted Position Sizing ───────────────────────────────────
// Adjusts new position size based on correlation with existing portfolio.
// High correlation = reduce size (you're adding to an existing bet).

function correlationAdjustedSize(baseShares, candidateSymbol, closesMap, existingPositions) {
  if (!existingPositions?.length || !closesMap[candidateSymbol]) {
    return { adjustedShares: baseShares, correlationPenalty: 1.0, reason: 'No existing positions or data' };
  }

  // Calculate average correlation of candidate with existing positions
  let totalCorr = 0, corrCount = 0;
  const candidateCloses = closesMap[candidateSymbol];

  for (const pos of existingPositions) {
    const posCloses = closesMap[pos.symbol];
    if (!posCloses || posCloses.length < 61 || candidateCloses.length < 61) continue;

    // Quick pairwise correlation
    const n = Math.min(posCloses.length, candidateCloses.length, 61);
    const sR = posCloses.slice(-n), cR = candidateCloses.slice(-n);
    const sRets = [], cRets = [];
    for (let i = 1; i < n; i++) {
      if (sR[i - 1] > 0 && cR[i - 1] > 0) {
        sRets.push(Math.log(sR[i] / sR[i - 1]));
        cRets.push(Math.log(cR[i] / cR[i - 1]));
      }
    }
    if (sRets.length < 20) continue;

    const meanS = sRets.reduce((a, b) => a + b, 0) / sRets.length;
    const meanC = cRets.reduce((a, b) => a + b, 0) / cRets.length;
    let cov = 0, varS = 0, varC = 0;
    for (let i = 0; i < sRets.length; i++) {
      cov += (sRets[i] - meanS) * (cRets[i] - meanC);
      varS += (sRets[i] - meanS) ** 2;
      varC += (cRets[i] - meanC) ** 2;
    }
    const corr = varS && varC ? cov / Math.sqrt(varS * varC) : 0;
    totalCorr += Math.abs(corr);
    corrCount++;
  }

  if (corrCount === 0) {
    return { adjustedShares: baseShares, correlationPenalty: 1.0, reason: 'No correlation data' };
  }

  const avgCorr = totalCorr / corrCount;

  // Penalty: reduce position size proportional to average correlation
  // 0.0 corr = 1.0x (no penalty), 0.5 corr = 0.75x, 0.8 corr = 0.5x, 1.0 corr = 0.3x
  const penalty = Math.max(0.3, 1 - avgCorr * 0.7);
  const adjustedShares = Math.floor(baseShares * penalty);

  return {
    adjustedShares,
    baseShares,
    correlationPenalty: +penalty.toFixed(2),
    avgCorrelationWithPortfolio: +avgCorr.toFixed(2),
    reason: avgCorr > 0.6
      ? `High correlation (${avgCorr.toFixed(2)}) with existing positions — size reduced ${((1 - penalty) * 100).toFixed(0)}%`
      : avgCorr > 0.3
        ? `Moderate correlation (${avgCorr.toFixed(2)}) — minor size reduction`
        : `Low correlation (${avgCorr.toFixed(2)}) — good diversifier, no penalty`,
  };
}

// ─── Portfolio-Level VaR (Value at Risk) ────────────────────────────────────
// Historical VaR using actual return distribution, accounting for correlation.
// Tells you: "What's the worst daily loss at 95%/99% confidence?"

function calculatePortfolioVaR(closesMap, positions, confidence = 0.95, days = 252) {
  if (!positions?.length) return null;

  const symbols = positions.map(p => p.symbol).filter(s => closesMap[s]?.length > days);
  if (symbols.length === 0) return null;

  // Calculate portfolio returns (weighted sum of individual returns)
  const totalValue = positions.reduce((s, p) => s + (p.shares || 0) * (p.currentPrice || p.entry_price), 0);
  if (totalValue === 0) return null;

  const weights = {};
  for (const pos of positions) {
    if (!closesMap[pos.symbol]) continue;
    weights[pos.symbol] = ((pos.shares || 0) * (pos.currentPrice || pos.entry_price)) / totalValue;
  }

  // Compute daily portfolio returns
  const minLen = Math.min(...symbols.map(s => closesMap[s].length));
  const lookback = Math.min(minLen - 1, days);
  const portfolioReturns = [];

  for (let i = 1; i <= lookback; i++) {
    let dayReturn = 0;
    for (const sym of symbols) {
      const closes = closesMap[sym];
      const idx = closes.length - lookback + i;
      if (idx > 0 && closes[idx - 1] > 0) {
        const ret = (closes[idx] / closes[idx - 1]) - 1;
        dayReturn += (weights[sym] || 0) * ret;
      }
    }
    portfolioReturns.push(dayReturn);
  }

  if (portfolioReturns.length < 30) return null;

  // Sort returns (ascending — worst first)
  const sorted = [...portfolioReturns].sort((a, b) => a - b);
  const idx95 = Math.floor(sorted.length * (1 - 0.95));
  const idx99 = Math.floor(sorted.length * (1 - 0.99));

  const avgReturn = portfolioReturns.reduce((a, b) => a + b, 0) / portfolioReturns.length;
  const stdDev = Math.sqrt(portfolioReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / portfolioReturns.length);

  return {
    var95: {
      daily: +(sorted[idx95] * 100).toFixed(2),
      dailyDollars: +(sorted[idx95] * totalValue).toFixed(2),
      weekly: +(sorted[idx95] * Math.sqrt(5) * 100).toFixed(2),
    },
    var99: {
      daily: +(sorted[idx99] * 100).toFixed(2),
      dailyDollars: +(sorted[idx99] * totalValue).toFixed(2),
      weekly: +(sorted[idx99] * Math.sqrt(5) * 100).toFixed(2),
    },
    expectedDailyReturn: +(avgReturn * 100).toFixed(3),
    dailyVolatility: +(stdDev * 100).toFixed(3),
    annualizedVol: isFinite(stdDev) ? +(stdDev * Math.sqrt(252) * 100).toFixed(1) : 0,
    sharpeRatio: stdDev > 0 ? +((avgReturn / stdDev) * Math.sqrt(252)).toFixed(2) : 0,
    portfolioValue: +totalValue.toFixed(2),
    daysAnalyzed: portfolioReturns.length,
    worstDay: +(Math.min(...portfolioReturns) * 100).toFixed(2),
    bestDay: +(Math.max(...portfolioReturns) * 100).toFixed(2),
  };
}

module.exports = {
  analyzePortfolioCorrelation,
  analyzeFactorExposure,
  correlationAdjustedSize,
  calculatePortfolioVaR,
};
