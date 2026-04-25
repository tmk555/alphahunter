// ─── VCP (Volatility Contraction Pattern) detector ───────────────────────────
// Minervini's "coiled spring" setup: 3+ progressive contractions where each
// is meaningfully tighter than the prior, the FINAL contraction is genuinely
// tight (≤ 10%), and volume DRIES UP into the squeeze (institutional
// withdrawal — the defining feature, not a bonus check).
//
// Pre-fix this was looser: ≥2 contractions, no tightness gate, no volume
// check, stop = full 75-bar window low (often 25-30% below pivot — destroyed
// R/R math everywhere). Symptom: TXN flagged as VCP with Tightness 41.5% and
// stop 29% below pivot, which is the opposite of a Minervini coiled spring.
//
// API: calcVCP(closes, bars?) — bars optional. When the caller has OHLCV
// (the live scanner does via getHistoryFull), pass `bars` so the textbook
// checks engage:
//   • Pivot = intraday HIGH of last contraction (the actual breakout level)
//   • Stop  = intraday LOW of last contraction (Minervini's "low of last
//     pullback")
//   • Volume drying confirmation
// Legacy callers (pyramid-plans, backfill) still pass just closes; the
// function downgrades to a price-only check (still requires 3+ contractions
// and last range ≤10%) and flags `vcpMode: 'price-only'` so consumers can
// distinguish.

const WINDOW_SIZE              = 15;    // ~3 weeks per contraction window
const N_WINDOWS                = 5;     // 5 windows = 75 bars (~15 weeks)
const CONTRACT_THRESHOLD       = 0.80;  // each window's range must be ≤ 80% of prior
const TEXTBOOK_MIN_CONTRACTIONS = 3;
const TEXTBOOK_MAX_LAST_RANGE   = 10;   // last contraction must be ≤ 10% range
const TEXTBOOK_VOL_DRY_RATIO    = 0.85; // last window vol < 85% of prior window vol

function calcVCP(closes, bars = null) {
  const empty = {
    vcpForming: false, vcpCount: 0, vcpTightness: null,
    vcpPivot: null, vcpStop: null, vcpHigherLows: false,
    vcpVolumeDrying: null, vcpMode: 'insufficient-data',
  };
  if (!closes || closes.length < N_WINDOWS * WINDOW_SIZE) return empty;

  const n = closes.length;
  const usingBars = Array.isArray(bars) && bars.length === closes.length
    && bars[0] && bars[0].high != null && bars[0].low != null;

  const windows = [], lows = [], highs = [], vols = [];
  for (let i = 0; i < N_WINDOWS; i++) {
    const start = n - (i + 1) * WINDOW_SIZE;
    const end   = n - i * WINDOW_SIZE;
    if (start < 0) break;
    const closeSlice = closes.slice(start, end);

    // When OHLCV available, use intraday extremes — captures wicks that a
    // close-only view smooths over (a 5% intraday spike that closes back at
    // flat is still volatility, and Minervini cares about it).
    let hi, lo, volAvg = null;
    if (usingBars) {
      const barSlice = bars.slice(start, end);
      hi = Math.max(...barSlice.map(b => b.high));
      lo = Math.min(...barSlice.map(b => b.low));
      const volSum = barSlice.reduce((s, b) => s + (b.volume || 0), 0);
      volAvg = volSum / barSlice.length;
    } else {
      hi = Math.max(...closeSlice);
      lo = Math.min(...closeSlice);
    }
    windows.push((hi - lo) / lo * 100);
    lows.push(lo);
    highs.push(hi);
    vols.push(volAvg);
  }
  windows.reverse(); lows.reverse(); highs.reverse(); vols.reverse();
  if (windows.length < N_WINDOWS) return empty;

  let contractions = 0;
  for (let i = 1; i < windows.length; i++) {
    if (windows[i] < windows[i - 1] * CONTRACT_THRESHOLD) contractions++;
  }
  let higherLowCount = 0;
  for (let i = 1; i < lows.length; i++) {
    if (lows[i] > lows[i - 1]) higherLowCount++;
  }

  const lastRange      = +windows[windows.length - 1].toFixed(1);
  const lastWindowHigh = highs[highs.length - 1];
  const lastWindowLow  = lows[lows.length - 1];

  // Volume drying: last contraction window vs the window before. Defining
  // check — institutions stop selling, retail boredom sets in, supply dries
  // up. Without OHLCV bars we can't compute this; textbook gate can't engage.
  let volumeDrying = null;
  if (usingBars
    && vols[vols.length - 1] != null
    && vols[vols.length - 2] != null
    && vols[vols.length - 2] > 0) {
    volumeDrying = vols[vols.length - 1] < vols[vols.length - 2] * TEXTBOOK_VOL_DRY_RATIO;
  }

  // Qualification:
  //   • Both modes: 3+ contractions AND last window range ≤ 10%
  //   • textbook  (with bars):  ALSO requires volume drying
  // Old behavior (≥2 contractions, no tightness check) is gone — it let
  // 41.5%-range "VCPs" through and produced absurd stops.
  const baseTight = contractions >= TEXTBOOK_MIN_CONTRACTIONS
    && lastRange <= TEXTBOOK_MAX_LAST_RANGE;
  const vcpForming = usingBars
    ? (baseTight && volumeDrying === true)
    : baseTight;

  return {
    vcpForming,
    vcpCount: contractions,
    vcpTightness: lastRange,
    // Pivot = intraday HIGH of last contraction window (when bars available),
    // else highest CLOSE in the last window. The textbook breakout level
    // lives at the high, not the close — using close meant the displayed
    // pivot was always a few cents below the actual trigger.
    vcpPivot: vcpForming ? +lastWindowHigh.toFixed(2) : null,
    // Stop = intraday LOW of last contraction window. Minervini's "low of
    // the final pullback" — for a 5-8% tight last window this lands ~5-8%
    // below pivot, a sane swing stop. Replaces the old `min of all 75 bars`
    // which produced 25-30%-below-pivot stops on real setups.
    vcpStop:  vcpForming ? +lastWindowLow.toFixed(2)  : null,
    vcpHigherLows: higherLowCount >= 2,
    vcpVolumeDrying: volumeDrying,
    vcpMode: usingBars ? 'textbook' : 'price-only',
  };
}

module.exports = { calcVCP };
