// ─── Daily Picks conviction score formula ────────────────────────────────────
// Ranks candidates by combined signal strength for automated daily picks

function calcConviction(stock, rsTrend, rotationModel) {
  const accel = rsTrend?.vs4w || 0;
  const sepa  = stock.sepaScore || 0;
  const sectorRs = stock.sectorRsRank || 50;
  const drift   = stock.earningsDrift?.score || 0;
  const tfAlign = stock.rsTimeframeAlignment || 0;
  const vp      = stock.volumeProfile || null;

  let score = (stock.rsRank * 0.25)
    + (sectorRs * 0.10)              // sector-relative RS — leader within its peer group
    + (Math.min(accel, 20) * 1.25)
    + (stock.swingMomentum * 0.20)
    + (sepa * 2.5)
    + (drift * 0.10);                 // PEAD signal contribution

  // Bonuses
  if (stock.rsLineNewHigh)  score += 8;
  if (stock.vcpForming)     score += 6;
  if (stock.volumeSurge)    score += 5;
  if (stock.earningsDrift?.strong) score += 6;
  if (sectorRs >= 90)       score += 4;       // sector leader bonus

  // Multi-timeframe RS alignment — daily strength alone is often a 1-2 week pop;
  // weekly/monthly confirmation indicates institutional positioning across horizons
  if (tfAlign >= 3)         score += 8;
  else if (tfAlign === 2)   score += 4;

  // Up/down volume profile (IBD accumulation) — direct proxy for institutional buying
  if (vp?.accumulating)     score += 6;       // 50-day up/down vol ≥ 1.2 (B+ grade)
  if (vp?.accumulation50 === 'A') score += 3; // exceptional accumulation (≥1.5)
  if (vp?.distributing)     score -= 8;       // under distribution — avoid

  // Sector rotation tilt: overweight sectors get a boost, underweight get penalized
  if (rotationModel?.sectors) {
    const sector = stock.sector;
    const match = rotationModel.sectors.find(s => s.sector === sector);
    if (match) {
      if (match.tilt === 'overweight')  score += 5;
      if (match.tilt === 'underweight') score -= 4;
    }
  }

  if (stock.earningsRisk)   score -= 15;
  if (stock.distFromHigh > 0.15) score -= 10;

  const reasons = [];
  if (stock.rsRank >= 80 && accel > 5) reasons.push(`RS ${stock.rsRank} rising +${accel} pts`);
  if (sectorRs >= 90) reasons.push(`Top ${100 - sectorRs + 1}% of ${stock.sector || 'sector'}`);
  if (stock.rsLineNewHigh) reasons.push('RS Line at 52-week high');
  if (stock.vcpForming) reasons.push(`VCP forming (${stock.vcpCount} contractions)`);
  if (stock.swingMomentum >= 65) reasons.push(`Strong momentum (${stock.swingMomentum})`);
  if (sepa >= 5) reasons.push(`SEPA ${sepa}/6 — ideal structure`);
  if (stock.earningsDrift?.strong) reasons.push(`PEAD: +${stock.earningsDrift.gapPct}% gap, holding`);
  if (tfAlign >= 3) reasons.push('RS leader on daily/weekly/monthly');
  else if (tfAlign === 2) reasons.push('RS leader on 2 of 3 timeframes');
  if (vp?.accumulating) reasons.push(`Accumulation grade ${vp.accumulation50} (U/D ${vp.upDownRatio50})`);
  if (vp?.distributing) reasons.push(`⚠ Distribution grade ${vp.accumulation50} (U/D ${vp.upDownRatio50})`);
  if (stock.earningsRisk) reasons.push(`⚠ Earnings in ${stock.daysToEarnings} days`);

  return { convictionScore: +score.toFixed(1), reasons };
}

// ─── Conviction Override for Weak Regimes ──────────────────────────────────
// When regime is CAUTION or worse, strong-conviction stocks shouldn't be
// treated the same as marginal picks. This evaluates whether a stock qualifies
// for reduced regime penalty based on conviction strength.
//
// Philosophy: waiting for regime to flip back to BULL before buying an elite
// momentum stock means missing the bulk of the move. The move IS the catalyst.

function evaluateConvictionOverride(stock, convictionScore, regime) {
  if (!regime) return null;
  const regimeName = regime.regime || '';
  const sizeMult = regime.sizeMultiplier ?? 1;

  // Only applies in weakened regimes (CAUTION, NEUTRAL with distribution pressure)
  if (sizeMult >= 1.0) return null;

  // Conviction thresholds for override — stock must be genuinely elite
  const isElite = convictionScore >= 65
    && (stock.rsRank || 0) >= 80
    && (stock.swingMomentum || 0) >= 60;

  const isStrong = convictionScore >= 55
    && (stock.rsRank || 0) >= 75
    && (stock.swingMomentum || 0) >= 55
    && (stock.rsLineNewHigh || stock.vcpForming || (stock.sepaScore || 0) >= 5);

  if (!isElite && !isStrong) return null;

  const tier = isElite ? 'elite' : 'strong';

  // Adjusted regime multiplier: reduce the penalty but don't eliminate it
  // Elite: 75% of normal size in CAUTION (vs 50%), 50% in BEAR (vs 0%)
  // Strong: 65% in CAUTION, 35% in BEAR
  let adjustedMultiplier;
  if (regimeName.includes('BEAR') || regimeName.includes('HIGH RISK')) {
    adjustedMultiplier = tier === 'elite' ? 0.50 : 0.35;
  } else if (regimeName === 'CAUTION') {
    adjustedMultiplier = tier === 'elite' ? 0.75 : 0.65;
  } else {
    // NEUTRAL with pressure — mild adjustment
    adjustedMultiplier = Math.min(1.0, sizeMult * 1.15);
  }

  const reasons = [];
  if (isElite) reasons.push(`Elite conviction (${convictionScore}) overrides regime penalty`);
  else reasons.push(`Strong conviction (${convictionScore}) reduces regime penalty`);
  if (stock.rsRank >= 90) reasons.push(`RS ${stock.rsRank} — top decile momentum`);
  if (stock.rsLineNewHigh) reasons.push('RS line new high — institutional demand confirmed');
  if (stock.swingMomentum >= 70) reasons.push(`Momentum ${stock.swingMomentum} — trend too strong to ignore`);
  reasons.push(`Regime: ${regimeName} (${sizeMult}x → ${adjustedMultiplier}x)`);

  return {
    override: true,
    tier,
    originalMultiplier: sizeMult,
    adjustedMultiplier: +adjustedMultiplier.toFixed(2),
    reasons,
  };
}

module.exports = { calcConviction, evaluateConvictionOverride };
