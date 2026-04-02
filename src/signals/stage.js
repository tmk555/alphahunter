// ─── Weinstein Stage Analysis ────────────────────────────────────────────────
// Stage 1: Basing  — price near flat 150MA, post-downtrend
// Stage 2: Uptrend — price above RISING 150MA (the buy zone)
// Stage 3: Topping — price above 150MA but MA is flattening/declining
// Stage 4: Decline — price below declining 150MA (avoid all longs)

function calcStage(closes, ma150) {
  if (!closes || closes.length < 160 || !ma150) return { stage: 0, stageName: 'Unknown' };
  const price  = closes[closes.length - 1];
  const ma150_10wkAgo = closes.slice(-200, -150).length >= 40
    ? closes.slice(-200, -150).reduce((a,b)=>a+b,0)/50 : ma150;
  const maRising = ma150 > ma150_10wkAgo * 1.001;
  const maFlat   = Math.abs(ma150 - ma150_10wkAgo) / ma150_10wkAgo < 0.001;

  if (price > ma150 && maRising)            return { stage: 2, stageName: 'Stage 2 Uptrend ✓' };
  if (price > ma150 && (maFlat || !maRising)) return { stage: 3, stageName: 'Stage 3 Topping' };
  if (price < ma150 && !maRising)           return { stage: 4, stageName: 'Stage 4 Downtrend' };
  if (price < ma150 && (maFlat || maRising))  return { stage: 1, stageName: 'Stage 1 Basing' };
  return { stage: 1, stageName: 'Stage 1 Basing' };
}

module.exports = { calcStage };
