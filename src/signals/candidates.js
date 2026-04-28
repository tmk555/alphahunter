// ─── Swing and Position candidate filters ────────────────────────────────────

// SWING: near breakout OR actively moving with strong RS
// Relaxed from the original (vol≥1.1x AND within 7% of high) which was too
// restrictive — on a normal day almost nothing qualifies. Now volume surge
// or proximity to high are additive, not both required.
function isSwingCandidate(s) {
  // rsRising blind-spot fix: a stock pinned at RS 95+ can't show "rising"
  // because there's no headroom left in the percentile (it's already
  // beating 95% of the universe). Treat RS ≥ 90 as already-leading and
  // accept it the same way as a stock whose rank is climbing. Without
  // this, names like MU at RS 98 / momentum 99 / SEPA 8/8 were silently
  // excluded from Swing setups because their rsTrend reads "flat".
  const rsRising = s.rsTrend?.direction === 'rising'
                || s.rsTrend?.vs1m > 3
                || s.rsRank >= 90;
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
//
// ATR multipliers below are the single source of truth for what the UI shows
// AND what gets written to staged_orders (staging.js parses these strings back
// into numeric prices). They match MODE_OVERRIDES in src/signals/replay.js so
// the preview a trader sees is the same configuration the backtest validated.
//
//   Swing   : holdDays 10,  stop 1.0×ATR,  T1 1.5×ATR,  T2 2.5×ATR
//             (full-in / full-out; short-term momentum cadence)
//   Position: holdDays 40,  stop 2.5×ATR,  T1 3.5×ATR,  T2 7.0×ATR
//             (pyramid entry ⅓-⅓-⅓ + scale-out ladder — tuned from the
//              4-mode × 4-window sweep; see commit cce08aa)
//
// If you change a multiplier here, change MODE_OVERRIDES in replay.js too.
const SWING_STOP_ATR = 1.0, SWING_T1_ATR = 1.5, SWING_T2_ATR = 2.5;
const POS_STOP_ATR   = 2.5, POS_T1_ATR   = 3.5, POS_T2_ATR   = 7.0;

function computeTradeSetup(stock, mode) {
  const price = stock.price;
  const atr   = stock.atr || (price * 0.02);
  const ma50  = stock.ma50;

  let entryLow, entryHigh, stopLevel, target1, target2, stopMult;

  if (mode === 'swing') {
    // Swing: enter near current price, tight 1.0×ATR stop
    entryLow  = +(price * 0.998).toFixed(2);
    entryHigh = +(price * 1.005).toFixed(2);
    stopMult  = SWING_STOP_ATR;
    stopLevel = +(entryLow - SWING_STOP_ATR * atr).toFixed(2);
    target1   = +(entryLow + SWING_T1_ATR   * atr).toFixed(2);
    target2   = +(entryLow + SWING_T2_ATR   * atr).toFixed(2);
  } else {
    // Position: entry at pullback to 50MA zone (or current price if we're
    // already within 3% of 50MA). Stop is 2.5×ATR below entry — wider to
    // survive normal trend-following retracements on a 40-day cadence.
    const nearMA50   = ma50 && Math.abs(price - ma50) / price < 0.03;
    const pivotEntry = nearMA50 ? price : (ma50 ? +(ma50 * 1.002).toFixed(2) : price);
    entryLow  = +(pivotEntry * 0.995).toFixed(2);
    entryHigh = +(pivotEntry * 1.010).toFixed(2);
    stopMult  = POS_STOP_ATR;
    stopLevel = +(entryLow - POS_STOP_ATR * atr).toFixed(2);
    target1   = +(entryLow + POS_T1_ATR   * atr).toFixed(2);
    target2   = +(entryLow + POS_T2_ATR   * atr).toFixed(2);
  }

  const risk   = entryLow - stopLevel;
  const reward = target1  - entryLow;
  const rr     = risk > 0 ? +(reward / risk).toFixed(1) : 0;

  return {
    entryZone:  `$${entryLow} – $${entryHigh}`,
    stopLevel:  `$${stopLevel} (${stopMult}× ATR below entry)`,
    target1:    `$${target1}`,
    target2:    `$${target2}`,
    riskReward: `${rr}:1`,
    stopPct:    +((risk / entryLow) * 100).toFixed(1),
    atrUsed:    +atr.toFixed(2),
  };
}

module.exports = { isSwingCandidate, isPositionCandidate, computeTradeSetup };
