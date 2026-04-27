// ─── Short / Hedge Signal Generation ─────────────────────────────────────────
// Generates short candidates and hedge recommendations based on market regime.
// This is the mirror image of the long-only momentum system.

// ─── Inverse ETFs for hedging (don't need to borrow shares) ─────────────────
const HEDGE_INSTRUMENTS = {
  // Broad market hedges
  SH:    { name: 'ProShares Short S&P500',         leverage: -1, tracks: 'SPY',  type: 'broad' },
  SDS:   { name: 'ProShares UltraShort S&P500',    leverage: -2, tracks: 'SPY',  type: 'broad' },
  SPXS:  { name: 'Direxion Daily S&P500 Bear 3x',  leverage: -3, tracks: 'SPY',  type: 'broad' },
  PSQ:   { name: 'ProShares Short QQQ',            leverage: -1, tracks: 'QQQ',  type: 'broad' },
  SQQQ:  { name: 'ProShares UltraPro Short QQQ',   leverage: -3, tracks: 'QQQ',  type: 'broad' },
  RWM:   { name: 'ProShares Short Russell2000',     leverage: -1, tracks: 'IWM',  type: 'broad' },

  // Sector-specific hedges
  REK:   { name: 'ProShares Short Real Estate',     leverage: -1, tracks: 'XLRE', type: 'sector' },
  SBB:   { name: 'ProShares Short SmallCap600',     leverage: -1, tracks: 'SLY',  type: 'sector' },

  // Volatility (long VIX = short equity)
  VIXY:  { name: 'ProShares VIX Short-Term Futures', leverage: 1, tracks: 'VIX', type: 'volatility' },
  UVXY:  { name: 'ProShares Ultra VIX Short-Term',   leverage: 1.5, tracks: 'VIX', type: 'volatility' },
};

// ─── Short Candidate Detection ───────────────────────────────────────────────
// Mirror of isSwingCandidate: weakest stocks breaking down

function isShortCandidate(stock) {
  return (
    stock.rsRank       <= 20   &&             // Bottom 20% RS — institutional dumping
    stock.swingMomentum <= 35  &&             // Weak short-term momentum
    stock.vsMA50        < -3   &&             // Below 50MA
    stock.vsMA200       < 0    &&             // Below 200MA
    stock.stage         === 4  &&             // Stage 4 downtrend (Weinstein)
    stock.sepaScore     <= 2                  // Failing most SEPA rules
  );
}

// Weaker filter for watchlist candidates (not ready to short yet)
function isShortWatchCandidate(stock) {
  return (
    stock.rsRank       <= 30   &&
    stock.stage        >= 3    &&             // Stage 3 (topping) or 4 (decline)
    stock.vsMA50       < 0     &&
    (stock.sepaScore || 0) <= 3
  );
}

// ─── Short Conviction Score ──────────────────────────────────────────────────
// Inverse of long conviction: rewards weakness

function calcShortConviction(stock, rsTrend) {
  const decel = rsTrend?.vs4w || 0;  // Negative = RS falling = good for shorts

  // Invert RS so lower RS = higher short score
  const invertedRS = 99 - (stock.rsRank || 50);

  let score = (invertedRS * 0.30)
    + (Math.min(Math.abs(Math.min(decel, 0)), 20) * 1.25)  // RS deceleration
    + ((100 - (stock.swingMomentum || 50)) * 0.20)         // Weak momentum
    + ((8 - (stock.sepaScore || 0)) * 2.5);                // Failing SEPA rules

  // Bonuses for short conviction
  if (stock.stage === 4)                    score += 8;   // Stage 4 downtrend
  if (stock.vsMA200 < -10)                  score += 6;   // Deep below 200MA
  if (stock.volumeRatio >= 1.5 && stock.vsMA50 < -3) score += 5; // Heavy-volume breakdown

  // Penalties
  // Graduated earnings penalty — mirrors the long-side graduation in
  // src/signals/conviction.js but scaled to short's smaller base
  // (longs were −15 max → shorts are −10 max, both at d≤3). Pre-print
  // weakness is its own valid short setup, so a flat −10 across the
  // whole 14-day window over-demoted breakdowns 8–14 days out.
  //   8–14d → −1   (light demote, let breakdowns run)
  //   4–7d  → −4   (risk rising)
  //   0–3d  → −10  (imminent gap — keep the demote)
  if (stock.earningsRisk) {
    const d = stock.daysToEarnings;
    if (d != null && d >= 0) {
      if (d <= 3)      score -= 10;
      else if (d <= 7) score -= 4;
      else             score -= 1;
    }
  }
  if (stock.rsRank > 40)                    score -= 15;  // Not weak enough

  const reasons = [];
  if (stock.rsRank <= 15)              reasons.push(`RS ${stock.rsRank} — bottom decile`);
  if (stock.stage === 4)               reasons.push('Stage 4 downtrend');
  if (decel < -5)                      reasons.push(`RS falling ${decel} pts`);
  if (stock.vsMA200 < -10)             reasons.push(`${stock.vsMA200}% below 200MA`);
  if (stock.swingMomentum <= 25)       reasons.push(`Weak momentum (${stock.swingMomentum})`);
  if (stock.sepaScore <= 1)            reasons.push('SEPA 0-1/8 — no uptrend structure');

  return { shortConviction: +Math.max(0, score).toFixed(1), reasons };
}

// ─── Short Trade Setup ───────────────────────────────────────────────────────

function computeShortSetup(stock) {
  const price = stock.price;
  const atr   = stock.atr || (price * 0.025);
  const ma50  = stock.ma50;

  // Entry: at or slightly below current price (selling into weakness)
  const entryHigh = +(price * 1.002).toFixed(2);
  const entryLow  = +(price * 0.995).toFixed(2);

  // Stop: above recent resistance (50MA or 1.5 ATR above entry)
  const stopLevel = ma50 && ma50 > price
    ? +(Math.min(ma50 * 1.01, entryHigh + 1.5 * atr)).toFixed(2)
    : +(entryHigh + 1.5 * atr).toFixed(2);

  // Targets: below entry by ATR multiples
  const target1 = +(entryHigh - 2.5 * atr).toFixed(2);
  const target2 = +(entryHigh - 4.0 * atr).toFixed(2);

  const risk   = stopLevel - entryHigh;
  const reward = entryHigh - target1;
  const rr     = risk > 0 ? +(reward / risk).toFixed(1) : 0;

  return {
    side: 'short',
    entryZone:  `$${entryLow} – $${entryHigh}`,
    stopLevel:  `$${stopLevel} (1.5x ATR above entry)`,
    target1:    `$${target1}`,
    target2:    `$${target2}`,
    riskReward: `${rr}:1`,
    stopPct:    +((risk / entryHigh) * 100).toFixed(1),
    atrUsed:    +atr.toFixed(2),
  };
}

// ─── Hedge Recommendation Engine ─────────────────────────────────────────────
// Based on regime + portfolio state, recommends appropriate hedge allocation

function getHedgeRecommendation(regime, portfolioHeat, vixLevel) {
  const recs = [];
  const vix = vixLevel || 20;

  // ── Permanent Tail Risk Hedge (1-2% of portfolio) ──────────────────────────
  // Always on, sized inversely to VIX (cheaper insurance when VIX is low)
  if (vix < 15) {
    recs.push({
      type: 'tail_risk',
      instrument: 'VIXY',
      allocation: 2.0,
      rationale: 'VIX historically low — cheap tail risk insurance. Buy now while volatility is compressed.',
      urgency: 'standard',
    });
  } else if (vix < 20) {
    recs.push({
      type: 'tail_risk',
      instrument: 'VIXY',
      allocation: 1.0,
      rationale: 'Moderate VIX — maintain minimum tail hedge.',
      urgency: 'standard',
    });
  }
  // Don't buy vol hedges when VIX > 25 — too expensive, damage is already priced

  // ── Regime-Based Hedging ──────────────────────────────────────────────────

  if (regime?.regime === 'HIGH RISK / BEAR' || regime?.sizeMultiplier === 0) {
    // Full bear mode: significant short exposure
    recs.push({
      type: 'directional',
      instrument: 'SH',
      allocation: 15,
      rationale: 'Bear regime — short S&P exposure captures downside instead of sitting in cash.',
      urgency: 'high',
    });
    recs.push({
      type: 'directional',
      instrument: 'PSQ',
      allocation: 10,
      rationale: 'Tech-heavy QQQ short — growth stocks fall hardest in bear markets.',
      urgency: 'high',
    });
  } else if (regime?.regime === 'CAUTION') {
    // Caution: moderate hedge
    recs.push({
      type: 'portfolio_hedge',
      instrument: 'SH',
      allocation: 8,
      rationale: 'Caution regime — partial hedge against long positions.',
      urgency: 'medium',
    });
  } else if (regime?.regime === 'NEUTRAL') {
    // Neutral: light hedge proportional to portfolio heat
    const heatPct = portfolioHeat?.heatPct || 0;
    if (heatPct > 5) {
      recs.push({
        type: 'portfolio_hedge',
        instrument: 'SH',
        allocation: +(heatPct * 0.3).toFixed(1),
        rationale: `Portfolio heat at ${heatPct}% — hedge ~30% of exposure.`,
        urgency: 'low',
      });
    }
  }
  // BULL / RISK ON: tail hedge only (handled above)

  // ── Sector-Specific Short Ideas ──────────────────────────────────────────
  // When a sector is in stage 4, recommend short exposure to that sector

  return {
    recommendations: recs,
    totalHedgeAllocation: +recs.reduce((a, r) => a + r.allocation, 0).toFixed(1),
    regime: regime?.regime || 'UNKNOWN',
    vixLevel: vix,
  };
}

module.exports = {
  HEDGE_INSTRUMENTS,
  isShortCandidate,
  isShortWatchCandidate,
  calcShortConviction,
  computeShortSetup,
  getHedgeRecommendation,
};
