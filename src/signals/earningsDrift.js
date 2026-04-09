// ─── Post-Earnings Announcement Drift (PEAD) signal ──────────────────────────
// Detects stocks that had a strong earnings reaction (gap up + above-average vol)
// and are still holding their post-earnings gains.
// Academic research: PEAD persists 30-60 days after a positive surprise.

// Detect the largest 1-day gap up in the last `lookback` sessions as proxy for
// earnings reaction (when actual earnings date isn't available with bar precision).
function detectEarningsReaction(bars, lookback = 30) {
  if (!bars || bars.length < lookback + 2) return null;
  const slice = bars.slice(-lookback - 1);
  let bestIdx = -1, bestGapPct = 0;
  for (let i = 1; i < slice.length; i++) {
    const prevClose = slice[i - 1].close;
    const open = slice[i].open;
    if (!prevClose || !open) continue;
    const gapPct = ((open - prevClose) / prevClose) * 100;
    if (gapPct > bestGapPct && gapPct >= 3.0) {
      bestGapPct = gapPct;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return null;
  return {
    bar: slice[bestIdx],
    gapPct: +bestGapPct.toFixed(2),
    daysAgo: slice.length - 1 - bestIdx,
  };
}

// Earnings drift score (0-100): higher = stronger PEAD setup
// Inputs:
//   bars: OHLCV array (last N sessions)
//   daysToEarnings: from quote (negative = past, positive = future)
//   q: quote object (optional, for vol confirmation)
function calcEarningsDrift(bars, daysToEarnings, q) {
  if (!bars || bars.length < 30) return null;

  // Two paths:
  // 1. We know exact earnings date (negative daysToEarnings, within 60 days)
  // 2. Detect via biggest gap up in last 30 sessions
  let reaction = null;
  let knownEarnings = false;

  if (daysToEarnings != null && daysToEarnings >= -60 && daysToEarnings <= -1) {
    // Find the bar closest to the earnings date
    const targetIdx = bars.length - 1 + daysToEarnings;
    if (targetIdx >= 1 && targetIdx < bars.length) {
      const prevClose = bars[targetIdx - 1].close;
      const open = bars[targetIdx].open;
      const close = bars[targetIdx].close;
      const gapPct = prevClose ? ((open - prevClose) / prevClose) * 100 : 0;
      const dayChgPct = prevClose ? ((close - prevClose) / prevClose) * 100 : 0;
      reaction = {
        bar: bars[targetIdx],
        gapPct: +gapPct.toFixed(2),
        dayChgPct: +dayChgPct.toFixed(2),
        daysAgo: -daysToEarnings,
      };
      knownEarnings = true;
    }
  }

  if (!reaction) {
    reaction = detectEarningsReaction(bars, 30);
  }

  if (!reaction || reaction.gapPct < 3.0) return null;

  const reactionClose = reaction.bar.close;
  const currentPrice = bars[bars.length - 1].close;
  const driftPct = ((currentPrice - reactionClose) / reactionClose) * 100;
  const heldGains = currentPrice >= reactionClose;

  // Score components
  let score = 0;
  // Gap magnitude (max 30 pts)
  score += Math.min(30, reaction.gapPct * 4);
  // Held gains (20 pts)
  if (heldGains) score += 20;
  // Drift continuation (max 30 pts)
  if (driftPct > 0) score += Math.min(30, driftPct * 2);
  else score += Math.max(-20, driftPct);
  // Recency bonus (within 30 days, max 20 pts)
  if (reaction.daysAgo <= 30) score += Math.round(20 * (1 - reaction.daysAgo / 30));

  // Volume confirmation (small bonus)
  if (q?.averageDailyVolume3Month && reaction.bar.volume) {
    const volRatio = reaction.bar.volume / q.averageDailyVolume3Month;
    if (volRatio >= 1.5) score += 5;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    gapPct: reaction.gapPct,
    daysSinceReaction: reaction.daysAgo,
    driftPct: +driftPct.toFixed(2),
    heldGains,
    knownEarnings,
    strong: score >= 60,
  };
}

module.exports = { calcEarningsDrift, detectEarningsReaction };
