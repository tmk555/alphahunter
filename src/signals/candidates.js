// ─── Swing and Position candidate filters ────────────────────────────────────

// SWING: near breakout OR actively moving with strong RS
// Relaxed from the original (vol≥1.1x AND within 7% of high) which was too
// restrictive — on a normal day almost nothing qualifies. Now volume surge
// or proximity to high are additive, not both required.
function isSwingCandidate(s) {
  const rsRising = s.rsTrend?.direction === 'rising' || s.rsTrend?.vs1m > 3;
  if (s.rsRank < 70 || !rsRising || (s.swingMomentum || 0) < 50 || (s.vsMA50 || 0) <= 0) return false;

  // Must meet at least ONE of: volume surge, near high, or very strong momentum
  const nearHigh    = (s.distFromHigh || 1) <= 0.12;   // within 12% of 52-week high
  const volumeSurge = (s.volumeRatio || 0) >= 1.1;
  const strongMom   = (s.swingMomentum || 0) >= 65;

  return nearHigh || volumeSurge || strongMom;
}

// POSITION: selective — uptrend + RS rising + pullback opportunity
function isPositionCandidate(s) {
  const rsRisingMonth = s.rsTrend?.vs1m > 3;
  return (
    s.rsRank       >= 70   &&
    rsRisingMonth          &&
    s.vsMA200      >  0    &&
    s.vsMA50       <= 5    &&
    s.vsMA50       > -15   &&
    (s.distFromHigh||1) <= 0.30
  );
}

// Algorithmic trade setup (pure price math, no API)
function computeTradeSetup(stock, mode) {
  const price = stock.price;
  const atr   = stock.atr || (price * 0.02);
  const ma50  = stock.ma50;

  let entryLow, entryHigh, stopLevel, target1, target2;

  if (mode === 'swing') {
    // Swing: enter near current price, tight stop
    entryLow  = +(price * 0.998).toFixed(2);
    entryHigh = +(price * 1.005).toFixed(2);
    stopLevel = +(entryLow - 1.5 * atr).toFixed(2);
    target1   = +(entryLow + 2.5 * atr).toFixed(2);
    target2   = +(entryLow + 4.0 * atr).toFixed(2);
  } else {
    // Position: entry on pullback to 50MA area, not at current price
    // If price is already near 50MA (within 3%), use current price
    // Otherwise, the ideal entry is a pullback to the 50MA zone
    const nearMA50 = ma50 && Math.abs(price - ma50) / price < 0.03;
    const pivotEntry = nearMA50 ? price : (ma50 ? +(ma50 * 1.002).toFixed(2) : price);
    entryLow  = +(pivotEntry * 0.995).toFixed(2);
    entryHigh = +(pivotEntry * 1.010).toFixed(2);
    stopLevel = ma50 ? +Math.max(ma50 * 0.975, entryLow - 2 * atr).toFixed(2)
                     : +(entryLow - 2 * atr).toFixed(2);
    target1   = +(entryLow + 3.0 * atr).toFixed(2);
    target2   = +(entryLow + 5.0 * atr).toFixed(2);
  }

  const risk   = entryLow - stopLevel;
  const reward = target1  - entryLow;
  const rr     = risk > 0 ? +(reward / risk).toFixed(1) : 0;

  return {
    entryZone:  `$${entryLow} – $${entryHigh}`,
    stopLevel:  `$${stopLevel} (${mode === 'swing' ? '1.5' : '2'}× ATR below entry)`,
    target1:    `$${target1}`,
    target2:    `$${target2}`,
    riskReward: `${rr}:1`,
    stopPct:    +((risk / entryLow) * 100).toFixed(1),
    atrUsed:    +atr.toFixed(2),
  };
}

module.exports = { isSwingCandidate, isPositionCandidate, computeTradeSetup };
