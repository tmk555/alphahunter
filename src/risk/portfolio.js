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

// ─── Two-Signal Confirmation Gate ────────────────────────────────────────────
// A single hot reading (e.g. RS alone) is noisy. Requiring ≥2 independent
// confirmations dramatically cuts false-positive stages. Signals evaluated:
//   1. rs_strong     — rs_rank ≥ 85 (top decile, not just top quintile)
//   2. stage_2       — Weinstein stage = 2 (actual uptrend, not base/topping)
//   3. revision_up   — earnings revisions trending up (fundamental confirm)
//   4. pattern       — vcp_forming OR rs_snapshots.pattern_type non-null
//   5. breadth_ok    — latest breadth regime not distribution/correction
//
// Data source: rs_snapshots (latest), revision_scores (latest), breadth_snapshots
// (latest). Fail-open when NO signal data exists at all (fresh DB, unseen symbol)
// — the caller can still override the block via `allowLowConfidence: true`.
function evaluateSignalConfirmation(symbol) {
  if (!symbol) return { count: 0, present: [], missing: [], hasData: false };
  const present = [];
  const missing = [];
  let hasData = false;

  try {
    const snap = db().prepare(`
      SELECT rs_rank, stage, vcp_forming, pattern_type
      FROM rs_snapshots WHERE symbol = ? AND type = 'stock'
      ORDER BY date DESC LIMIT 1
    `).get(symbol);
    if (snap) {
      hasData = true;
      if ((snap.rs_rank || 0) >= 85) present.push('rs_strong'); else missing.push('rs_strong');
      if (snap.stage === 2) present.push('stage_2'); else missing.push('stage_2');
      if (snap.vcp_forming || snap.pattern_type) present.push('pattern'); else missing.push('pattern');
    }
  } catch (_) {}

  try {
    const rev = db().prepare(`
      SELECT direction, revision_score FROM revision_scores
      WHERE symbol = ? ORDER BY date DESC LIMIT 1
    `).get(symbol);
    if (rev) {
      hasData = true;
      if (rev.direction === 'up' || (rev.revision_score || 0) > 0) present.push('revision_up');
      else missing.push('revision_up');
    }
  } catch (_) {}

  try {
    const breadth = db().prepare(`
      SELECT regime, composite_score FROM breadth_snapshots
      ORDER BY date DESC LIMIT 1
    `).get();
    if (breadth) {
      hasData = true;
      const healthy = breadth.regime && !/distribution|correction|bearish/i.test(breadth.regime)
        && (breadth.composite_score == null || breadth.composite_score >= 40);
      if (healthy) present.push('breadth_ok'); else missing.push('breadth_ok');
    }
  } catch (_) {}

  return { count: present.length, present, missing, hasData };
}

// ─── Pre-trade Validation ────────────────────────────────────────────────────
// Checks all rules before allowing a new position.
//
// @param {Object}  candidate         — { symbol, entryPrice, stopPrice, shares,
//                                        sector?, industry?, daysToEarnings?,
//                                        closesMap?, allowWashSale? }
//   `allowWashSale: true` on the candidate is the explicit override for the
//   wash-sale blocker (phase 2.10). The trader has seen the warning and
//   decided to take the tax hit anyway — typically because the setup quality
//   outweighs the lost deduction, or because they plan to harvest later.
// @param {Array}   openPositions
// @param {Object}  regime
// @param {Object}  currentPrices
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

  // 7. Two-signal confirmation (2026-04)
  // Require ≥2 of {rs_strong, stage_2, revision_up, pattern, breadth_ok}.
  // Single-signal entries (e.g. RS alone) slipped too many low-quality stages
  // through — this gate is the primary "quality filter" upstream of sizing.
  //
  // Fail-open rules:
  //   - No signal data for the symbol (fresh DB, unseen ticker) → pass with
  //     a visible "skipped" detail. We don't silently block every trade on a
  //     fresh install.
  //   - `allowLowConfidence: true` override → explicit bypass (same pattern
  //     as allowWashSale for the tax-hit override).
  const symbolForSignals = candidate.symbol || candidate.ticker;
  const sig = evaluateSignalConfirmation(symbolForSignals);
  if (!sig.hasData) {
    checks.push({
      rule: 'Two-Signal Confirmation',
      pass: true,
      detail: 'skipped (no signal data for symbol)',
    });
  } else if (sig.count >= 2) {
    checks.push({
      rule: 'Two-Signal Confirmation',
      pass: true,
      detail: `${sig.count}/5 signals confirm: ${sig.present.join(', ')}`,
    });
  } else if (candidate.allowLowConfidence) {
    checks.push({
      rule: 'Two-Signal Confirmation',
      pass: true,
      detail: `OVERRIDE: only ${sig.count}/5 signals (${sig.present.join(', ') || 'none'}) — trader accepted low confidence`,
    });
  } else {
    checks.push({
      rule: 'Two-Signal Confirmation',
      pass: false,
      detail: `Only ${sig.count}/5 signals confirm${sig.present.length ? ` (${sig.present.join(', ')})` : ''} — need ≥2. Missing: ${sig.missing.join(', ')}`,
    });
    approved = false;
  }

  // 8. Wash-sale blocker (Phase 2.10)
  // Checks tax_lots + trades for a recent loss on this symbol inside the
  // 30-day IRS §1091 window. Fires a BLOCKING check — approval flips to
  // false unless the caller passes `allowWashSale: true`, which is the
  // explicit "I've seen the warning, take the tax hit" override.
  //
  // Fail-open on query errors: tax_engine may be unavailable in some test
  // setups or during a schema migration. A wash-sale check that can't run
  // should NOT silently block every trade — log the skip and move on.
  try {
    const { checkWashSaleOnBuy } = require('./tax-engine');
    const symbol = candidate.symbol || candidate.ticker;
    if (symbol) {
      const wash = checkWashSaleOnBuy(symbol, candidate.entryDate || null);
      if (wash.isWashSale) {
        if (candidate.allowWashSale) {
          checks.push({
            rule: 'Wash Sale',
            pass: true,
            detail: `OVERRIDE: ${wash.message} (allowWashSale=true — trader accepted tax cost)`,
            washSale: wash,
          });
        } else {
          checks.push({
            rule: 'Wash Sale',
            pass: false,
            detail: wash.message,
            washSale: wash,
          });
          approved = false;
        }
      } else {
        checks.push({
          rule: 'Wash Sale',
          pass: true,
          detail: 'No recent loss sales in 30-day window',
        });
      }
    }
  } catch (e) {
    // Don't block trades if the tax engine is wedged — but leave a breadcrumb.
    checks.push({
      rule: 'Wash Sale',
      pass: true,
      detail: `skipped (tax engine unavailable: ${e.message})`,
    });
  }

  return { approved, checks };
}

module.exports = {
  getConfig, updateConfig,
  getPortfolioHeat, getSectorExposure, getCorrelationRisk,
  getDrawdownStatus, preTradeCheck,
};
