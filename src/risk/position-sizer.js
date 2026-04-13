// ─── Position Sizing Engine ──────────────────────────────────────────────────
// Fixed-fractional, Kelly, regime-adjusted, beta-adjusted position sizing

// Beta adjustment: high-beta stocks contribute more risk per dollar than the
// account model assumes (which is calibrated to SPY=1.0). Scale inversely so
// that beta-weighted exposure stays constant across the book.
//   beta 1.0  → 1.00x  (no change)
//   beta 1.5  → 0.67x
//   beta 0.7  → 1.43x  (capped at +50%)
function betaAdjustment(beta) {
  if (!beta || beta <= 0) return 1.0;
  // Cap the upside to avoid over-sizing low-beta names
  return Math.min(1.5, Math.max(0.4, 1 / beta));
}

// Volatility (ATR%) adjustment: chops position size when realized volatility
// is elevated. ATR% is the more honest measure of intraday risk than beta.
//   atr% 2  → ~1.0x   (typical large cap)
//   atr% 4  → ~0.5x
//   atr% 6+ → 0.33x
function volatilityAdjustment(atrPct) {
  if (!atrPct || atrPct <= 0) return 1.0;
  if (atrPct <= 2) return 1.0;
  return Math.max(0.33, 2 / atrPct);
}

// Fixed fractional: risk X% of account per trade
function fixedFractional(accountSize, riskPct, entryPrice, stopPrice) {
  if (!accountSize || !entryPrice || !stopPrice || entryPrice <= stopPrice) {
    return { shares: 0, dollarRisk: 0, positionValue: 0, portfolioPct: 0 };
  }
  const riskPerShare = entryPrice - stopPrice;
  const dollarRisk   = accountSize * (riskPct / 100);
  const shares       = Math.floor(dollarRisk / riskPerShare);
  const positionValue = shares * entryPrice;
  const portfolioPct  = +(positionValue / accountSize * 100).toFixed(1);

  return {
    shares,
    dollarRisk:    +dollarRisk.toFixed(2),
    riskPerShare:  +riskPerShare.toFixed(2),
    positionValue: +positionValue.toFixed(2),
    portfolioPct,
    riskPctActual: +(shares * riskPerShare / accountSize * 100).toFixed(2),
  };
}

// Kelly Criterion: optimal bet size based on historical win rate
function kellyOptimal(winRate, avgWinPct, avgLossPct) {
  if (!winRate || !avgWinPct || !avgLossPct || avgLossPct === 0) return 0;
  const W = winRate;
  const R = avgWinPct / Math.abs(avgLossPct); // win/loss ratio
  const kelly = W - ((1 - W) / R);
  // Use half-Kelly for safety (full Kelly is too aggressive)
  return Math.max(0, +(kelly * 0.5 * 100).toFixed(1));
}

// Regime-adjusted sizing
function regimeAdjusted(baseShares, regimeMultiplier) {
  return Math.floor(baseShares * regimeMultiplier);
}

// ─── Factor Concentration Penalty ──────────────────────────────────────────
// Reduces position size when adding this stock would breach concentration limits.
// Checks: sector weight, portfolio beta, average correlation.
function factorConcentrationPenalty(candidateSector, existingPositions, closesMap, benchmarkCloses) {
  if (!existingPositions?.length) return { penalty: 1.0, reasons: [] };

  const reasons = [];
  let penalty = 1.0;

  // 1. Sector concentration check
  if (candidateSector && existingPositions.length >= 2) {
    const sectorCount = existingPositions.filter(p => p.sector === candidateSector).length;
    const sectorWeight = sectorCount / existingPositions.length;
    if (sectorWeight > 0.40) {
      penalty *= 0.6;
      reasons.push(`Sector ${candidateSector} at ${(sectorWeight * 100).toFixed(0)}% — heavy concentration`);
    } else if (sectorWeight > 0.30) {
      penalty *= 0.8;
      reasons.push(`Sector ${candidateSector} at ${(sectorWeight * 100).toFixed(0)}% — moderate concentration`);
    }
  }

  // 2. Portfolio beta check
  if (closesMap && benchmarkCloses && existingPositions.length >= 2) {
    let totalBeta = 0, betaCount = 0;
    for (const pos of existingPositions) {
      const beta = closesMap[pos.symbol] ? calcBeta(closesMap[pos.symbol], benchmarkCloses, 90) : null;
      if (beta != null) { totalBeta += beta; betaCount++; }
    }
    if (betaCount > 0) {
      const avgBeta = totalBeta / betaCount;
      if (avgBeta > 1.3) {
        penalty *= 0.8;
        reasons.push(`Portfolio beta ${avgBeta.toFixed(2)} — over-leveraged to market`);
      } else if (avgBeta > 1.5) {
        penalty *= 0.6;
        reasons.push(`Portfolio beta ${avgBeta.toFixed(2)} — dangerously high beta`);
      }
    }
  }

  return { penalty: Math.max(0.3, penalty), reasons };
}

// Full position sizing calculation
function calculatePositionSize(params) {
  const {
    accountSize,
    riskPerTrade = 1.5,  // % of account risked per trade
    entryPrice,
    stopPrice,
    regimeMultiplier = 1.0,
    convictionOverride,  // optional — from evaluateConvictionOverride()
    maxPositionPct = 20, // max % of account in single position
    beta,                // optional — stock beta vs SPY
    atrPct,              // optional — ATR as % of price (volatility-aware sizing)
    // Phase 1: Correlation-aware sizing
    existingPositions,   // optional — array of {symbol, sector, shares, currentPrice, entry_price}
    closesMap,           // optional — {symbol: [closes]} for correlation calc
    benchmarkCloses,     // optional — SPY closes for factor analysis
    candidateSymbol,     // optional — symbol being sized
    candidateSector,     // optional — sector of candidate
  } = params;

  const base = fixedFractional(accountSize, riskPerTrade, entryPrice, stopPrice);

  // Use conviction-adjusted multiplier if stock qualifies for override
  const effectiveRegimeMult = convictionOverride?.override
    ? convictionOverride.adjustedMultiplier
    : regimeMultiplier;

  const betaMult = betaAdjustment(beta);
  const volMult  = volatilityAdjustment(atrPct);

  // Phase 1: Correlation-aware sizing
  let correlationMult = 1.0;
  let correlationDetails = null;
  if (existingPositions?.length && closesMap && candidateSymbol) {
    try {
      const { correlationAdjustedSize } = require('./correlation');
      const corrResult = correlationAdjustedSize(100, candidateSymbol, closesMap, existingPositions);
      correlationMult = corrResult.correlationPenalty;
      correlationDetails = {
        penalty: corrResult.correlationPenalty,
        avgCorrelation: corrResult.avgCorrelationWithPortfolio,
        reason: corrResult.reason,
      };
    } catch (_) {}
  }

  // Factor concentration penalty (sector, beta)
  let factorMult = 1.0;
  let factorDetails = null;
  if (existingPositions?.length >= 2) {
    const factorResult = factorConcentrationPenalty(candidateSector, existingPositions, closesMap, benchmarkCloses);
    factorMult = factorResult.penalty;
    if (factorResult.reasons.length) {
      factorDetails = { penalty: factorResult.penalty, reasons: factorResult.reasons };
    }
  }

  // Combined risk multiplier: regime × beta × vol × correlation × factor (capped at 1.5x ceiling)
  const totalMult = Math.min(1.5, effectiveRegimeMult * betaMult * volMult * correlationMult * factorMult);

  const adjusted = {
    ...base,
    shares: Math.floor(base.shares * totalMult),
  };
  adjusted.positionValue = +(adjusted.shares * entryPrice).toFixed(2);
  adjusted.portfolioPct  = +(adjusted.positionValue / accountSize * 100).toFixed(1);

  // Cap at max position size
  const maxShares = Math.floor(accountSize * (maxPositionPct / 100) / entryPrice);
  if (adjusted.shares > maxShares) {
    adjusted.shares = maxShares;
    adjusted.positionValue = +(maxShares * entryPrice).toFixed(2);
    adjusted.portfolioPct  = +(adjusted.positionValue / accountSize * 100).toFixed(1);
    adjusted.cappedReason  = `Capped at ${maxPositionPct}% max position size`;
  }

  adjusted.regimeMultiplier = regimeMultiplier;
  adjusted.effectiveRegimeMult = +effectiveRegimeMult.toFixed(2);
  adjusted.convictionOverride = convictionOverride || null;
  adjusted.betaMultiplier     = +betaMult.toFixed(2);
  adjusted.volMultiplier      = +volMult.toFixed(2);
  adjusted.correlationMultiplier = +correlationMult.toFixed(2);
  adjusted.correlationDetails = correlationDetails;
  adjusted.factorMultiplier   = +factorMult.toFixed(2);
  adjusted.factorDetails      = factorDetails;
  adjusted.totalMultiplier    = +totalMult.toFixed(2);
  adjusted.beta               = beta || null;
  adjusted.atrPct             = atrPct || null;
  return adjusted;
}

// ─── Beta calculation from price history ────────────────────────────────────
// Computes 90-day rolling beta of stock vs benchmark (typically SPY).
// Uses daily log returns for stability.
function calcBeta(stockCloses, benchCloses, periods = 90) {
  if (!stockCloses || !benchCloses) return null;
  const n = Math.min(stockCloses.length, benchCloses.length);
  if (n < periods + 1) return null;

  const stockSlice = stockCloses.slice(-periods - 1);
  const benchSlice = benchCloses.slice(-periods - 1);
  const stockRets = [];
  const benchRets = [];
  for (let i = 1; i < stockSlice.length; i++) {
    if (stockSlice[i - 1] > 0 && benchSlice[i - 1] > 0) {
      stockRets.push(Math.log(stockSlice[i] / stockSlice[i - 1]));
      benchRets.push(Math.log(benchSlice[i] / benchSlice[i - 1]));
    }
  }
  if (stockRets.length < 30) return null;

  const meanS = stockRets.reduce((a, b) => a + b, 0) / stockRets.length;
  const meanB = benchRets.reduce((a, b) => a + b, 0) / benchRets.length;

  let cov = 0, varB = 0;
  for (let i = 0; i < stockRets.length; i++) {
    cov  += (stockRets[i] - meanS) * (benchRets[i] - meanB);
    varB += (benchRets[i] - meanB) ** 2;
  }
  if (varB === 0) return null;
  return +(cov / varB).toFixed(2);
}

// ─── Correlation matrix for open positions ──────────────────────────────────
// Computes pairwise return correlation. Used to flag concentrated risk.
function calcCorrelationMatrix(closesMap, periods = 60) {
  const symbols = Object.keys(closesMap).filter(s => closesMap[s]?.length >= periods + 1);
  const returnsMap = {};
  for (const sym of symbols) {
    const closes = closesMap[sym].slice(-periods - 1);
    const rets = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    returnsMap[sym] = rets;
  }

  const matrix = {};
  for (const a of symbols) {
    matrix[a] = {};
    for (const b of symbols) {
      if (a === b) { matrix[a][b] = 1; continue; }
      const ra = returnsMap[a], rb = returnsMap[b];
      const m = Math.min(ra.length, rb.length);
      if (m < 30) { matrix[a][b] = null; continue; }
      const meanA = ra.slice(-m).reduce((s,x)=>s+x,0) / m;
      const meanB = rb.slice(-m).reduce((s,x)=>s+x,0) / m;
      let cov = 0, varA = 0, varB = 0;
      for (let i = 0; i < m; i++) {
        const da = ra[ra.length - m + i] - meanA;
        const db = rb[rb.length - m + i] - meanB;
        cov += da * db; varA += da * da; varB += db * db;
      }
      matrix[a][b] = (varA && varB) ? +(cov / Math.sqrt(varA * varB)).toFixed(2) : null;
    }
  }

  // Find concentration warnings: pairs with corr > 0.8
  const warnings = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const c = matrix[symbols[i]][symbols[j]];
      if (c != null && c > 0.8) {
        warnings.push({ a: symbols[i], b: symbols[j], correlation: c });
      }
    }
  }

  return { matrix, symbols, warnings };
}

module.exports = {
  fixedFractional, kellyOptimal, regimeAdjusted, calculatePositionSize,
  betaAdjustment, volatilityAdjustment, calcBeta, calcCorrelationMatrix,
  factorConcentrationPenalty,
};
