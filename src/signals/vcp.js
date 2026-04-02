// ─── VCP (Volatility Contraction Pattern) detector ───────────────────────────
// Minervini's core setup: 3+ contractions where each price range < prior range

function calcVCP(closes) {
  if (!closes || closes.length < 60) return { vcpForming: false, vcpCount: 0, vcpTightness: null };
  const n = closes.length;
  const windowSize = 15;
  const windows = [], lows = [], highs = [];

  for (let i = 0; i < 5; i++) {
    const start = n - (i + 1) * windowSize;
    const end   = n - i * windowSize;
    if (start < 0) break;
    const slice = closes.slice(start, end);
    const hi = Math.max(...slice), lo = Math.min(...slice);
    windows.push((hi - lo) / lo * 100);
    lows.push(lo); highs.push(hi);
  }
  windows.reverse(); lows.reverse(); highs.reverse();

  let contractions = 0;
  for (let i = 1; i < windows.length; i++) {
    if (windows[i] < windows[i-1] * 0.80) contractions++;
  }
  let higherLows = 0;
  for (let i = 1; i < lows.length; i++) { if (lows[i] > lows[i-1]) higherLows++; }

  const vcpForming = contractions >= 2;
  const vcpTight   = windows.length ? +windows[windows.length-1].toFixed(1) : null;
  const vcpPivot   = vcpForming ? +(Math.max(...closes.slice(-windowSize))).toFixed(2) : null;
  const vcpStop    = vcpForming ? +(Math.min(...closes.slice(-windowSize))).toFixed(2) : null;

  return {
    vcpForming, vcpCount: contractions,
    vcpTightness: vcpTight,
    vcpPivot,
    vcpStop,
    vcpHigherLows: higherLows >= 2,
  };
}

module.exports = { calcVCP };
