// ─── RS Line: stock / SPY ratio. New high = institutional accumulation ───────

function calcRSLine(closes, spyCloses) {
  if (!closes || !spyCloses || closes.length < 10 || spyCloses.length < 10) {
    return { rsLineNewHigh: false, rsLine52wkHigh: false };
  }
  const n = Math.min(closes.length, spyCloses.length);
  const ratios = [];
  for (let i = Math.max(0, n - 252); i < n; i++) {
    const spy = spyCloses[i] || spyCloses[spyCloses.length - 1];
    ratios.push(spy > 0 ? closes[i] / spy : 0);
  }
  const currentRatio = ratios[ratios.length - 1];
  const max52w = Math.max(...ratios);
  const rsLineNewHigh = currentRatio >= max52w * 0.995;
  return { rsLineNewHigh, rsLine52wkHigh: rsLineNewHigh };
}

module.exports = { calcRSLine };
