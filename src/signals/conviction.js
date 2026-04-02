// ─── Daily Picks conviction score formula ────────────────────────────────────
// Ranks candidates by combined signal strength for automated daily picks

function calcConviction(stock, rsTrend) {
  const accel = rsTrend?.vs4w || 0;
  const sepa  = stock.sepaScore || 0;

  let score = (stock.rsRank * 0.30)
    + (Math.min(accel, 20) * 1.25)
    + (stock.swingMomentum * 0.20)
    + (sepa * 2.5);

  // Bonuses
  if (stock.rsLineNewHigh)  score += 8;
  if (stock.vcpForming)     score += 6;
  if (stock.volumeSurge)    score += 5;
  if (stock.earningsRisk)   score -= 15;
  if (stock.distFromHigh > 0.15) score -= 10;

  const reasons = [];
  if (stock.rsRank >= 80 && accel > 5) reasons.push(`RS ${stock.rsRank} rising +${accel} pts`);
  if (stock.rsLineNewHigh) reasons.push('RS Line at 52-week high');
  if (stock.vcpForming) reasons.push(`VCP forming (${stock.vcpCount} contractions)`);
  if (stock.swingMomentum >= 65) reasons.push(`Strong momentum (${stock.swingMomentum})`);
  if (sepa >= 5) reasons.push(`SEPA ${sepa}/6 — ideal structure`);
  if (stock.earningsRisk) reasons.push(`⚠ Earnings in ${stock.daysToEarnings} days`);

  return { convictionScore: +score.toFixed(1), reasons };
}

module.exports = { calcConviction };
