// ─── Systematic Hedging Framework ────────────────────────────────────────────
// Professional tail-risk management. Answers three questions:
//   1. How much should I hedge? (hedge ratio)
//   2. What instruments? (puts, inverse ETFs, VIX, collar)
//   3. What does it cost? (hedge budget as % of portfolio)
//
// Philosophy: hedging is insurance, not a profit center. The goal is to limit
// drawdowns to a tolerable level while preserving upside capture.

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Hedge Ratio Calculator ─────────────────────────────────────────────────
// Determines what % of portfolio to hedge based on:
//   - Portfolio beta (higher beta = more hedge needed)
//   - Market regime (breadth score, VIX level)
//   - Drawdown proximity (closer to circuit breaker = more hedge)
//   - Current hedge cost (don't overpay for protection)

function calculateHedgeRatio(params) {
  const {
    portfolioBeta = 1.0,
    breadthScore = 50,      // 0-100 from breadth engine
    vixLevel = 20,
    drawdownPct = 0,        // current drawdown from peak
    maxDrawdownTarget = 10, // what's the max drawdown you'd accept?
    portfolioValue,
    currentHedgeValue = 0,  // existing hedge notional
  } = params;

  // Base hedge ratio: portfolio beta tells us how much market risk we carry
  // A 1.3 beta portfolio needs 30% more hedge than a 1.0 beta
  let baseRatio = portfolioBeta * 0.10; // start at 10% of beta

  // Regime adjustment: poor breadth = more hedging needed
  if (breadthScore < 20) baseRatio *= 3.0;       // broken breadth: triple
  else if (breadthScore < 40) baseRatio *= 2.0;   // deteriorating: double
  else if (breadthScore < 60) baseRatio *= 1.5;   // mixed: 50% more
  else if (breadthScore >= 80) baseRatio *= 0.5;   // strong: halve

  // VIX adjustment: high VIX = hedges are expensive, but more needed
  // Trade-off: at VIX 35+, hedges cost too much — better to reduce exposure
  if (vixLevel > 35) baseRatio = Math.min(baseRatio, 0.15); // cap — reduce instead
  else if (vixLevel > 25) baseRatio *= 1.3;
  else if (vixLevel < 15) baseRatio *= 1.5; // cheap hedges — buy more protection

  // Drawdown proximity: closer to circuit breaker = more protection
  const drawdownBuffer = maxDrawdownTarget - drawdownPct;
  if (drawdownBuffer < 3) baseRatio *= 2.0;    // <3% to circuit breaker
  else if (drawdownBuffer < 5) baseRatio *= 1.5;

  // Account for existing hedges
  const currentHedgeRatio = portfolioValue > 0 ? currentHedgeValue / portfolioValue : 0;
  const additionalNeeded = Math.max(0, baseRatio - currentHedgeRatio);

  // Cap at reasonable levels
  const hedgeRatio = Math.min(0.30, Math.max(0, baseRatio)); // max 30% of portfolio

  return {
    recommendedHedgeRatio: +hedgeRatio.toFixed(3),
    currentHedgeRatio: +currentHedgeRatio.toFixed(3),
    additionalHedgeNeeded: +additionalNeeded.toFixed(3),
    hedgeDollars: +(hedgeRatio * portfolioValue).toFixed(2),
    additionalDollars: +(additionalNeeded * portfolioValue).toFixed(2),
    inputs: {
      portfolioBeta, breadthScore, vixLevel, drawdownPct,
      maxDrawdownTarget, portfolioValue, currentHedgeValue,
    },
    reasoning: buildHedgeReasoning(breadthScore, vixLevel, drawdownPct, hedgeRatio),
  };
}

function buildHedgeReasoning(breadthScore, vixLevel, drawdownPct, hedgeRatio) {
  const reasons = [];
  if (breadthScore < 40) reasons.push(`Breadth score ${breadthScore}/100 — deteriorating market internals`);
  if (vixLevel > 25) reasons.push(`VIX ${vixLevel} — elevated volatility, hedges expensive but needed`);
  if (vixLevel < 15) reasons.push(`VIX ${vixLevel} — options cheap, good time to add protection`);
  if (drawdownPct > 3) reasons.push(`Already ${drawdownPct}% below peak — protect remaining capital`);
  if (hedgeRatio > 0.20) reasons.push('Multiple risk factors elevated — maximum hedging recommended');
  if (hedgeRatio < 0.05) reasons.push('Low risk environment — minimal hedging sufficient');
  return reasons;
}

// ─── Hedge Instrument Recommendations ───────────────────────────────────────
// For each hedge type, calculate sizing, cost, and expected protection.

function recommendHedgeInstruments(params) {
  const {
    portfolioValue,
    portfolioBeta = 1.0,
    hedgeRatio,           // from calculateHedgeRatio
    vixLevel = 20,
    spyPrice = 450,
    qqqPrice = 380,
    timeHorizon = 30,     // days to next review
  } = params;

  const hedgeBudget = portfolioValue * hedgeRatio;
  const recommendations = [];

  // 1. SPY Put Spread (primary hedge for broad portfolio)
  // Buy 5% OTM put, sell 15% OTM put — defined risk, cheaper than naked put
  const putSpread = calculatePutSpread({
    underlyingPrice: spyPrice,
    portfolioValue,
    portfolioBeta,
    hedgeRatio,
    vixLevel,
    dte: Math.max(30, timeHorizon + 15), // add buffer beyond review
  });
  recommendations.push({
    type: 'SPY_PUT_SPREAD',
    priority: 1,
    ...putSpread,
  });

  // 2. QQQ Puts (if tech-heavy portfolio)
  const qqqPut = calculateSimplePut({
    underlyingPrice: qqqPrice,
    symbol: 'QQQ',
    portfolioValue: portfolioValue * 0.3, // assume 30% tech
    vixLevel,
    dte: Math.max(30, timeHorizon + 15),
  });
  recommendations.push({
    type: 'QQQ_PUT',
    priority: 2,
    condition: 'Use if tech exposure > 30% of portfolio',
    ...qqqPut,
  });

  // 3. VIX Calls (tail hedge — convex payoff in crashes)
  // Small allocation, big payout in black swan
  const vixHedge = calculateVIXHedge({
    portfolioValue,
    vixLevel,
    budgetPct: 0.003, // 0.3% of portfolio per month
  });
  recommendations.push({
    type: 'VIX_CALLS',
    priority: 3,
    ...vixHedge,
  });

  // 4. Collar strategy for concentrated single-stock positions
  const collarStrategy = {
    type: 'COLLAR',
    priority: 4,
    description: 'For single positions > 10% of portfolio: sell covered call, buy protective put',
    costEstimate: 'Near zero (call premium funds put purchase)',
    tradeoff: 'Caps upside at call strike in exchange for downside protection',
    when: 'Apply to any position > 10% of portfolio value',
  };
  recommendations.push(collarStrategy);

  // 5. Inverse ETF (only as last resort — daily reset decay)
  const inverseETF = calculateInverseETFHedge({
    portfolioValue,
    hedgeRatio: hedgeRatio * 0.3, // only 30% of hedge budget
    holdingDays: Math.min(5, timeHorizon), // max 5 days for inverse ETFs
  });
  recommendations.push({
    type: 'INVERSE_ETF',
    priority: 5,
    warning: 'Inverse ETFs suffer daily reset decay — use only for <5 day tactical hedges',
    ...inverseETF,
  });

  // Monthly hedge cost budget
  const monthlyCost = estimateMonthlyHedgeCost(recommendations, portfolioValue);

  return {
    recommendations,
    hedgeBudget: +hedgeBudget.toFixed(2),
    monthlyCost,
    summary: {
      totalProtection: `${(hedgeRatio * 100).toFixed(1)}% of portfolio hedged`,
      annualCost: `${(monthlyCost.totalPct * 12).toFixed(1)}% of portfolio/year`,
      maxDrawdownProtection: `Reduces max loss by ~${(hedgeRatio * 40).toFixed(0)}% in a 40% crash`,
    },
  };
}

// ─── Put Spread Sizing ──────────────────────────────────────────────────────
function calculatePutSpread(params) {
  const { underlyingPrice, portfolioValue, portfolioBeta, hedgeRatio, vixLevel, dte } = params;

  // Strike selection: buy 5% OTM, sell 15% OTM
  const longStrike = Math.round(underlyingPrice * 0.95);
  const shortStrike = Math.round(underlyingPrice * 0.85);
  const spreadWidth = longStrike - shortStrike;

  // Rough Black-Scholes pricing (simplified for estimation)
  // Put premium ~ VIX/100 * sqrt(DTE/365) * strike * moneyness_factor
  const volFactor = (vixLevel / 100) * Math.sqrt(dte / 365);
  const longPutPremium = underlyingPrice * volFactor * 0.35; // 5% OTM
  const shortPutPremium = underlyingPrice * volFactor * 0.12; // 15% OTM
  const spreadCost = Math.max(0.50, longPutPremium - shortPutPremium);

  // Number of contracts needed to hedge portfolio
  const hedgeNotional = portfolioValue * hedgeRatio * portfolioBeta;
  const contractMultiplier = 100; // 100 shares per contract
  const contracts = Math.max(1, Math.round(hedgeNotional / (spreadWidth * contractMultiplier)));

  const totalCost = contracts * spreadCost * contractMultiplier;
  const maxProtection = contracts * spreadWidth * contractMultiplier;

  return {
    instrument: `SPY ${longStrike}/${shortStrike} put spread`,
    longStrike,
    shortStrike,
    dte,
    contracts,
    estimatedCost: +totalCost.toFixed(2),
    costPct: +((totalCost / portfolioValue) * 100).toFixed(3),
    maxProtection: +maxProtection.toFixed(2),
    protectionPct: +((maxProtection / portfolioValue) * 100).toFixed(1),
    breakeven: `SPY below ${longStrike} (${((1 - longStrike / underlyingPrice) * 100).toFixed(1)}% drop)`,
    payoffRatio: +(maxProtection / totalCost).toFixed(1),
  };
}

function calculateSimplePut(params) {
  const { underlyingPrice, symbol, portfolioValue, vixLevel, dte } = params;

  const strike = Math.round(underlyingPrice * 0.93); // 7% OTM
  const volFactor = (vixLevel / 100) * Math.sqrt(dte / 365);
  const premium = underlyingPrice * volFactor * 0.25;
  const contracts = Math.max(1, Math.round(portfolioValue / (underlyingPrice * 100)));
  const totalCost = contracts * premium * 100;

  return {
    instrument: `${symbol} ${strike} put`,
    strike,
    dte,
    contracts,
    estimatedCost: +totalCost.toFixed(2),
    costPct: +((totalCost / portfolioValue) * 100).toFixed(3),
  };
}

function calculateVIXHedge(params) {
  const { portfolioValue, vixLevel, budgetPct } = params;

  const budget = portfolioValue * budgetPct;
  // VIX call strikes: buy 20% above current for crash insurance
  const strike = Math.round(vixLevel * 1.2);
  // VIX call premium is typically $1-3 for OTM near-month
  const estimatedPremium = Math.max(0.50, vixLevel * 0.08);
  const contracts = Math.max(1, Math.floor(budget / (estimatedPremium * 100)));
  const totalCost = contracts * estimatedPremium * 100;

  return {
    instrument: `VIX ${strike} call`,
    strike,
    contracts,
    estimatedCost: +totalCost.toFixed(2),
    costPct: +((totalCost / portfolioValue) * 100).toFixed(3),
    description: 'Convex payoff: small cost, large payout in a market crash',
    expectedPayoff: `In a -20% SPY crash, VIX typically spikes to 40-60 → ${strike} calls would be worth $${(Math.max(0, 50 - strike) * contracts * 100).toFixed(0)}+`,
  };
}

function calculateInverseETFHedge(params) {
  const { portfolioValue, hedgeRatio, holdingDays } = params;

  const hedgeAmount = portfolioValue * hedgeRatio;

  // Daily reset decay estimate
  // For SH (1x inverse), decay ~ 0.01% per day in normal vol
  // For SQQQ (3x inverse), decay ~ 0.05% per day
  const instruments = [
    {
      symbol: 'SH',
      leverage: -1,
      dailyDecay: 0.01,
      shares: Math.round(hedgeAmount / 40), // approximate SH price
      holdingCost: +(hedgeAmount * 0.01 / 100 * holdingDays).toFixed(2),
    },
    {
      symbol: 'SQQQ',
      leverage: -3,
      dailyDecay: 0.05,
      shares: Math.round(hedgeAmount * 0.3 / 15), // 30% allocation, approx price
      holdingCost: +(hedgeAmount * 0.3 * 0.05 / 100 * holdingDays).toFixed(2),
      warning: '3x leverage + daily reset = severe decay beyond 3 days',
    },
  ];

  return {
    hedgeAmount: +hedgeAmount.toFixed(2),
    maxHoldingDays: holdingDays,
    instruments,
    totalDecayCost: +instruments.reduce((s, i) => s + parseFloat(i.holdingCost), 0).toFixed(2),
  };
}

function estimateMonthlyHedgeCost(recommendations, portfolioValue) {
  let totalMonthlyCost = 0;
  for (const rec of recommendations) {
    if (rec.estimatedCost) {
      // Options expire — full cost is the monthly expense
      totalMonthlyCost += rec.estimatedCost;
    }
  }
  return {
    totalDollars: +totalMonthlyCost.toFixed(2),
    totalPct: +((totalMonthlyCost / portfolioValue) * 100).toFixed(3),
  };
}

// ─── Hedge Effectiveness Tracking ───────────────────────────────────────────
// Track how well hedges performed during drawdowns.

function logHedgeAction(action) {
  db().prepare(`
    INSERT INTO hedge_log (date, action_type, instrument, notional, cost, notes)
    VALUES (date('now'), ?, ?, ?, ?, ?)
  `).run(action.type, action.instrument, action.notional, action.cost, action.notes || '');
}

function getHedgeHistory(days = 90) {
  return db().prepare(`
    SELECT * FROM hedge_log ORDER BY date DESC LIMIT ?
  `).all(days);
}

function hedgePerformanceSummary(startDate, endDate) {
  const hedges = db().prepare(`
    SELECT * FROM hedge_log WHERE date >= ? AND date <= ? ORDER BY date
  `).all(startDate, endDate);

  const totalCost = hedges.filter(h => h.action_type === 'open').reduce((s, h) => s + (h.cost || 0), 0);
  const totalRecovered = hedges.filter(h => h.action_type === 'close').reduce((s, h) => s + (h.notional || 0), 0);

  return {
    period: { start: startDate, end: endDate },
    hedgesOpened: hedges.filter(h => h.action_type === 'open').length,
    hedgesClosed: hedges.filter(h => h.action_type === 'close').length,
    totalCost: +totalCost.toFixed(2),
    totalRecovered: +totalRecovered.toFixed(2),
    netCost: +(totalCost - totalRecovered).toFixed(2),
    effectiveness: totalCost > 0 ? +((totalRecovered / totalCost) * 100).toFixed(1) : 0,
    hedges,
  };
}

module.exports = {
  calculateHedgeRatio,
  recommendHedgeInstruments,
  logHedgeAction,
  getHedgeHistory,
  hedgePerformanceSummary,
};
