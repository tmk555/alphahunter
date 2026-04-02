// ─── Position Sizing Engine ──────────────────────────────────────────────────
// Fixed-fractional, Kelly, regime-adjusted position sizing

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

// Full position sizing calculation
function calculatePositionSize(params) {
  const {
    accountSize,
    riskPerTrade = 1.5,  // % of account risked per trade
    entryPrice,
    stopPrice,
    regimeMultiplier = 1.0,
    maxPositionPct = 20, // max % of account in single position
  } = params;

  const base = fixedFractional(accountSize, riskPerTrade, entryPrice, stopPrice);
  const adjusted = {
    ...base,
    shares: regimeAdjusted(base.shares, regimeMultiplier),
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
  return adjusted;
}

module.exports = { fixedFractional, kellyOptimal, regimeAdjusted, calculatePositionSize };
