// ─── Portfolio Risk Management ───────────────────────────────────────────────
// Portfolio heat, sector exposure, correlation risk, drawdown circuit breaker
// Peak equity and config are persisted to SQLite — survive server restarts.

const { getDB } = require('../data/database');

function db() { return getDB(); }

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

// ─── Persistent state helpers ───────────────────────────────────────────────

function _loadState(key, fallback) {
  try {
    const row = db().prepare('SELECT value FROM portfolio_state WHERE key = ?').get(key);
    if (row) return JSON.parse(row.value);
  } catch (_) {}
  return fallback;
}

function _saveState(key, value) {
  try {
    db().prepare(
      `INSERT OR REPLACE INTO portfolio_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
    ).run(key, JSON.stringify(value));
  } catch (_) {}
}

// ─── Config (persisted) ─────────────────────────────────────────────────────

let _configLoaded = false;
let config = { ...DEFAULT_CONFIG };

function _ensureConfig() {
  if (_configLoaded) return;
  const saved = _loadState('config', null);
  if (saved) {
    // Merge saved config with defaults (in case new fields were added)
    config = { ...DEFAULT_CONFIG, ...saved, drawdownLevels: { ...DEFAULT_CONFIG.drawdownLevels, ...(saved.drawdownLevels || {}) } };
  }
  _configLoaded = true;
}

function getConfig() {
  _ensureConfig();
  return { ...config };
}

function updateConfig(updates) {
  _ensureConfig();
  if (updates.drawdownLevels) {
    config.drawdownLevels = { ...config.drawdownLevels, ...updates.drawdownLevels };
    delete updates.drawdownLevels;
  }
  config = { ...config, ...updates };
  _saveState('config', config);

  // If accountSize increased past peak, update peak
  const peak = _loadPeakEquity();
  if (config.accountSize > peak) {
    _savePeakEquity(config.accountSize);
  }
  return config;
}

// ─── Peak Equity (persisted) ────────────────────────────────────────────────

function _loadPeakEquity() {
  const saved = _loadState('peakEquity', null);
  if (saved && typeof saved === 'number' && saved > 0) return saved;
  // First time: use accountSize from config
  _ensureConfig();
  return config.accountSize;
}

function _savePeakEquity(value) {
  _saveState('peakEquity', value);
}

// ─── Portfolio Heat ──────────────────────────────────────────────────────────
// Sum of dollar risk across all open positions as % of account
function getPortfolioHeat(openPositions) {
  _ensureConfig();
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
  _ensureConfig();
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
  _ensureConfig();
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
  _ensureConfig();
  let peakEquity = _loadPeakEquity();

  if (currentEquity > peakEquity) {
    peakEquity = currentEquity;
    _savePeakEquity(peakEquity);
  }

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
  _ensureConfig();
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

  // 3. Correlation risk (basic sector check)
  const correlation = getCorrelationRisk(candidate, openPositions);
  if (correlation.warnings.length > 0) {
    checks.push({ rule: 'Correlation Risk', pass: false, detail: correlation.warnings.join('; ') });
    approved = false;
  } else {
    checks.push({ rule: 'Correlation Risk', pass: true, detail: 'No concentration issues' });
  }

  // 3b. Enhanced correlation check (if price data available)
  if (candidate.closesMap && openPositions.length >= 2) {
    try {
      const { correlationAdjustedSize } = require('./correlation');
      const adjResult = correlationAdjustedSize(
        candidate.shares, candidate.symbol || candidate.ticker,
        candidate.closesMap, openPositions
      );
      if (adjResult.correlationPenalty < 0.7) {
        checks.push({
          rule: 'Return Correlation',
          pass: false,
          detail: `Avg ${(adjResult.avgCorrelationWithPortfolio * 100).toFixed(0)}% correlated with portfolio — size reduced to ${adjResult.adjustedShares} shares`,
        });
      } else {
        checks.push({ rule: 'Return Correlation', pass: true, detail: adjResult.reason });
      }
    } catch (_) {
      // Correlation module not available — skip
    }
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
