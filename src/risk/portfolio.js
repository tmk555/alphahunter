// ─── Portfolio Risk Management ───────────────────────────────────────────────
// Portfolio heat, sector exposure, correlation risk, drawdown circuit breaker

const DEFAULT_CONFIG = {
  accountSize: 100000,
  riskPerTrade: 1.5,       // % per trade
  maxPortfolioHeat: 8,     // % total risk across all positions
  maxSectorExposure: 25,   // % of account in any single sector
  maxIndustryPositions: 3, // max positions in same industry group
  maxPositionPct: 20,      // max single position as % of account
  drawdownLevels: {
    tighten: 3,            // -3% from peak: tighten stops
    reduce50: 5,           // -5% from peak: reduce to 50% cash
    reduce75: 8,           // -8% from peak: reduce to 25% cash
    fullCash: 10,          // -10% from peak: all cash
  },
  earningsBlackoutDays: 10,
};

let config = { ...DEFAULT_CONFIG };
let peakEquity = config.accountSize;

function getConfig() { return { ...config }; }

function updateConfig(updates) {
  config = { ...config, ...updates };
  if (updates.accountSize && updates.accountSize > peakEquity) {
    peakEquity = updates.accountSize;
  }
  return config;
}

// ─── Portfolio Heat ──────────────────────────────────────────────────────────
// Sum of dollar risk across all open positions as % of account
function getPortfolioHeat(openPositions) {
  if (!openPositions?.length) {
    return { heatPct: 0, totalDollarRisk: 0, positionCount: 0, details: [] };
  }

  let totalDollarRisk = 0;
  const details = [];

  for (const pos of openPositions) {
    const riskPerShare = pos.entry_price - (pos.stop_price || pos.entry_price * 0.95);
    const dollarRisk   = (pos.shares || 0) * riskPerShare;
    totalDollarRisk += dollarRisk;
    details.push({
      symbol: pos.symbol,
      shares: pos.shares,
      dollarRisk: +dollarRisk.toFixed(2),
      riskPct: +(dollarRisk / config.accountSize * 100).toFixed(2),
    });
  }

  const heatPct = +(totalDollarRisk / config.accountSize * 100).toFixed(2);

  return {
    heatPct,
    totalDollarRisk: +totalDollarRisk.toFixed(2),
    positionCount: openPositions.length,
    maxHeat: config.maxPortfolioHeat,
    withinLimits: heatPct <= config.maxPortfolioHeat,
    details,
  };
}

// ─── Sector Exposure ─────────────────────────────────────────────────────────
function getSectorExposure(openPositions, currentPrices = {}) {
  if (!openPositions?.length) return { sectors: {}, warnings: [] };

  const sectors = {};
  for (const pos of openPositions) {
    const price = currentPrices[pos.symbol] || pos.entry_price;
    const value = (pos.shares || 0) * price;
    const sector = pos.sector || 'Unknown';
    sectors[sector] = (sectors[sector] || 0) + value;
  }

  const warnings = [];
  for (const [sector, value] of Object.entries(sectors)) {
    const pct = +(value / config.accountSize * 100).toFixed(1);
    sectors[sector] = { value: +value.toFixed(2), pct };
    if (pct > config.maxSectorExposure) {
      warnings.push(`${sector} at ${pct}% (limit: ${config.maxSectorExposure}%)`);
    }
  }

  return { sectors, warnings };
}

// ─── Correlation Risk (sector-based proxy) ───────────────────────────────────
function getCorrelationRisk(candidate, openPositions) {
  if (!openPositions?.length) return { warnings: [], sameIndustryCount: 0 };

  const warnings = [];
  const sameSector = openPositions.filter(p => p.sector === candidate.sector);
  const sameIndustry = openPositions.filter(p =>
    p.industry && candidate.industry && p.industry === candidate.industry
  );

  if (sameSector.length >= 3) {
    warnings.push(`Already ${sameSector.length} positions in ${candidate.sector} — high concentration risk`);
  }
  if (sameIndustry.length >= config.maxIndustryPositions) {
    warnings.push(`Already ${sameIndustry.length} positions in ${candidate.industry} (max ${config.maxIndustryPositions})`);
  }

  return {
    warnings,
    sameSectorCount: sameSector.length,
    sameIndustryCount: sameIndustry.length,
    sameSectorTickers: sameSector.map(p => p.symbol),
  };
}

// ─── Drawdown Circuit Breaker ────────────────────────────────────────────────
function getDrawdownStatus(currentEquity) {
  if (currentEquity > peakEquity) peakEquity = currentEquity;

  const drawdownPct = +((peakEquity - currentEquity) / peakEquity * 100).toFixed(2);
  const levels = config.drawdownLevels;

  let action, severity;
  if (drawdownPct >= levels.fullCash) {
    action = 'FULL CASH — close all positions, regroup';
    severity = 'critical';
  } else if (drawdownPct >= levels.reduce75) {
    action = 'REDUCE TO 25% — only cleanest setups';
    severity = 'severe';
  } else if (drawdownPct >= levels.reduce50) {
    action = 'REDUCE TO 50% — cut weakest positions';
    severity = 'high';
  } else if (drawdownPct >= levels.tighten) {
    action = 'TIGHTEN STOPS — move to breakeven where possible';
    severity = 'moderate';
  } else {
    action = 'NORMAL — risk within tolerance';
    severity = 'ok';
  }

  return {
    drawdownPct,
    peakEquity,
    currentEquity,
    action,
    severity,
    levels,
  };
}

// ─── Pre-trade Validation ────────────────────────────────────────────────────
// Checks all rules before allowing a new position
function preTradeCheck(candidate, openPositions, regime, currentPrices = {}) {
  const checks = [];
  let approved = true;

  // 1. Portfolio heat (uses exposure ramp ceiling when available from cycle detection)
  const heat = getPortfolioHeat(openPositions);
  const candidateRisk = (candidate.entryPrice - candidate.stopPrice) * candidate.shares;
  const newHeat = heat.heatPct + (candidateRisk / config.accountSize * 100);
  const effectiveMaxHeat = regime?.exposureRamp?.maxHeatPct || config.maxPortfolioHeat;
  const rampNote = regime?.exposureRamp ? ` [${regime.exposureRamp.exposureLevel} — rally day ${regime.exposureRamp.rallyDay}]` : '';
  if (newHeat > effectiveMaxHeat) {
    checks.push({ rule: 'Portfolio Heat', pass: false, detail: `Would bring heat to ${newHeat.toFixed(1)}% (max ${effectiveMaxHeat}%${rampNote})` });
    approved = false;
  } else {
    checks.push({ rule: 'Portfolio Heat', pass: true, detail: `${newHeat.toFixed(1)}% after trade (max ${effectiveMaxHeat}%${rampNote})` });
  }

  // 2. Sector exposure
  const exposure = getSectorExposure(openPositions, currentPrices);
  if (exposure.warnings.length > 0) {
    checks.push({ rule: 'Sector Exposure', pass: false, detail: exposure.warnings.join('; ') });
    approved = false;
  } else {
    checks.push({ rule: 'Sector Exposure', pass: true, detail: 'Within limits' });
  }

  // 3. Correlation risk
  const correlation = getCorrelationRisk(candidate, openPositions);
  if (correlation.warnings.length > 0) {
    checks.push({ rule: 'Correlation Risk', pass: false, detail: correlation.warnings.join('; ') });
    approved = false;
  } else {
    checks.push({ rule: 'Correlation Risk', pass: true, detail: 'No concentration issues' });
  }

  // 4. Earnings blackout
  if (candidate.daysToEarnings != null && candidate.daysToEarnings >= 0 &&
      candidate.daysToEarnings <= config.earningsBlackoutDays) {
    checks.push({ rule: 'Earnings Blackout', pass: false, detail: `Earnings in ${candidate.daysToEarnings} days (blackout: ${config.earningsBlackoutDays} days)` });
    approved = false;
  } else {
    checks.push({ rule: 'Earnings Blackout', pass: true, detail: 'Clear of earnings' });
  }

  // 5. Regime check
  if (regime?.sizeMultiplier === 0) {
    checks.push({ rule: 'Market Regime', pass: false, detail: `${regime.regime} — no new longs` });
    approved = false;
  } else {
    checks.push({ rule: 'Market Regime', pass: true, detail: `${regime?.regime || 'UNKNOWN'} — ${regime?.sizeMultiplier || 1}x sizing` });
  }

  // 6. Single position size
  const posValue = (candidate.shares || 0) * candidate.entryPrice;
  const posPct = posValue / config.accountSize * 100;
  if (posPct > config.maxPositionPct) {
    checks.push({ rule: 'Position Size', pass: false, detail: `${posPct.toFixed(1)}% of account (max ${config.maxPositionPct}%)` });
    approved = false;
  } else {
    checks.push({ rule: 'Position Size', pass: true, detail: `${posPct.toFixed(1)}% of account` });
  }

  return { approved, checks };
}

module.exports = {
  getConfig, updateConfig,
  getPortfolioHeat, getSectorExposure, getCorrelationRisk,
  getDrawdownStatus, preTradeCheck,
};
