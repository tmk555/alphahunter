// ─── Weinstein Stage Analysis ────────────────────────────────────────────────
// Stage 1: Basing  — price near flat 150MA, post-downtrend
// Stage 2: Uptrend — price above RISING 150MA (the buy zone)
// Stage 3: Topping — price above 150MA but MA is flattening/declining
// Stage 4: Decline — price below declining 150MA (avoid all longs)

function calcStage(closes, ma150) {
  if (!closes || closes.length < 160 || !ma150) return { stage: 0, stageName: 'Unknown' };
  const price = closes[closes.length - 1];

  // True 150MA from ~10 weeks (50 trading days) ago: average of the 150
  // bars ending 50 bars before today, i.e. closes[n-200 .. n-50]. Fall back
  // to today's ma150 when we don't yet have 200 bars of history (n<200),
  // which makes maRising=false and maFlat=true so short-history names are
  // classified as Stage 1/3 rather than Stage 4.
  const ma150_10wkAgo = closes.length >= 200
    ? closes.slice(-200, -50).reduce((a, b) => a + b, 0) / 150
    : ma150;
  const maRising = ma150 > ma150_10wkAgo * 1.001;
  const maFlat   = Math.abs(ma150 - ma150_10wkAgo) / ma150_10wkAgo < 0.001;

  // Order matters: Stage 4 requires the MA to be strictly falling (not
  // merely "not rising"), otherwise flat-MA+price-below misclassifies as
  // Stage 4 instead of Stage 1 (basing).
  if (price > ma150 && maRising)             return { stage: 2, stageName: 'Stage 2 Uptrend ✓' };
  if (price > ma150)                          return { stage: 3, stageName: 'Stage 3 Topping' };
  if (price < ma150 && !maRising && !maFlat)  return { stage: 4, stageName: 'Stage 4 Downtrend' };
  return { stage: 1, stageName: 'Stage 1 Basing' };
}

module.exports = { calcStage };
