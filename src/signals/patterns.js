// ─── Enhanced Chart Pattern Recognition ──────────────────────────────────────
// Detects four advanced Minervini / O'Neil chart patterns:
//   1. Cup and Handle
//   2. Ascending Base
//   3. Power Play (tight area / shelf)
//   4. High Tight Flag
//
// Each pattern returns detection status, key measurements, pivot/stop levels,
// and a confidence score (0-100) indicating how textbook the formation is.

// ─── Utility helpers ────────────────────────────────────────────────────────

/** Simple moving average of the last `period` values. Returns null if insufficient data. */
function sma(arr, period) {
  if (arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

/** Find the index of the maximum value in arr[start..end) */
function idxMax(arr, start, end) {
  let idx = start;
  for (let i = start + 1; i < end; i++) {
    if (arr[i] > arr[idx]) idx = i;
  }
  return idx;
}

/** Find the index of the minimum value in arr[start..end) */
function idxMin(arr, start, end) {
  let idx = start;
  for (let i = start + 1; i < end; i++) {
    if (arr[i] < arr[idx]) idx = i;
  }
  return idx;
}

// ─── 1. Cup and Handle ─────────────────────────────────────────────────────
// Anatomy:  left lip  ->  U-shaped cup bottom  ->  right lip  ->  handle pullback
// Duration: cup 90-180 bars, handle 5-25 bars after right lip
//
// Quality checks:
//   - Cup depth 15-35% below left lip
//   - Right lip within 5% of left lip
//   - Handle pullback 5-15% on declining volume
//   - Rounded bottom (not V-shaped)

function detectCupHandle(bars, closes) {
  const result = { detected: false, depth: 0, handlePullback: 0, pivotPrice: 0, stopPrice: 0, confidence: 0 };
  const n = closes.length;
  if (n < 120) return result; // Need at least 120 bars

  // Scan lookback windows from 90 to 180 bars for the best cup
  let bestConfidence = 0;
  let bestResult     = result;

  for (let cupLen = 90; cupLen <= Math.min(180, n - 20); cupLen += 10) {
    const cupStart = n - cupLen - 25; // leave room for handle
    if (cupStart < 0) continue;
    const cupEnd = n - 25; // reserve last ~25 bars for handle search

    // Left lip: highest point in the first third of the cup window
    const thirdLen    = Math.floor((cupEnd - cupStart) / 3);
    const leftLipIdx  = idxMax(closes, cupStart, cupStart + thirdLen);
    const leftLip     = closes[leftLipIdx];

    // Cup bottom: lowest point in the middle third
    const midStart    = cupStart + thirdLen;
    const midEnd      = cupStart + 2 * thirdLen;
    const bottomIdx   = idxMin(closes, midStart, midEnd);
    const cupBottom   = closes[bottomIdx];

    // Right lip: highest point in the last third of the cup window
    const rightStart  = cupStart + 2 * thirdLen;
    const rightLipIdx = idxMax(closes, rightStart, cupEnd);
    const rightLip    = closes[rightLipIdx];

    // ── Validate cup shape ──────────────────────────────────────────
    const depth = (leftLip - cupBottom) / leftLip * 100;
    if (depth < 15 || depth > 35) continue; // depth must be 15-35%

    const lipDiff = Math.abs(rightLip - leftLip) / leftLip * 100;
    if (lipDiff > 5) continue; // lips within 5%

    // Check for rounded bottom (not V-shaped): the bottom third should
    // have prices that gradually curve — we measure this by checking the
    // bottom half has a reasonable spread
    const bottomSlice = closes.slice(midStart, midEnd);
    const bottomAvg   = bottomSlice.reduce((a, b) => a + b, 0) / bottomSlice.length;
    const bottomRange = (Math.max(...bottomSlice) - Math.min(...bottomSlice)) / cupBottom * 100;
    // A V-shape has a very tight bottom range; a U-shape spreads out
    const isRounded   = bottomRange > 3 && bottomRange < depth * 0.8;

    // ── Handle detection ────────────────────────────────────────────
    // After the right lip, look for a pullback of 5-15%
    const handleStart = rightLipIdx;
    const handleEnd   = Math.min(n, handleStart + 25);
    if (handleEnd - handleStart < 5) continue;

    const handleSlice   = closes.slice(handleStart, handleEnd);
    const handleLow     = Math.min(...handleSlice);
    const handleHigh    = Math.max(...handleSlice);
    const handlePullPct = (handleHigh - handleLow) / handleHigh * 100;

    if (handlePullPct < 5 || handlePullPct > 15) continue;

    // Volume should decline in the handle vs the cup
    const cupVolumes    = bars.slice(cupStart, cupEnd).map(b => b.volume);
    const handleVolumes = bars.slice(handleStart, handleEnd).map(b => b.volume);
    const avgCupVol     = cupVolumes.reduce((a, b) => a + b, 0) / cupVolumes.length;
    const avgHandleVol  = handleVolumes.reduce((a, b) => a + b, 0) / handleVolumes.length;
    const volumeDrying  = avgHandleVol < avgCupVol;

    // ── Confidence scoring ──────────────────────────────────────────
    let confidence = 0;
    confidence += isRounded ? 25 : 10;                       // Rounded bottom
    confidence += lipDiff < 2 ? 20 : (lipDiff < 4 ? 15 : 10); // Lip symmetry
    confidence += (depth >= 20 && depth <= 30) ? 20 : 10;    // Ideal depth
    confidence += volumeDrying ? 20 : 5;                     // Volume decline in handle
    confidence += (handlePullPct >= 8 && handlePullPct <= 12) ? 15 : 8; // Ideal handle

    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestResult = {
        detected:       true,
        depth:          +depth.toFixed(1),
        handlePullback: +handlePullPct.toFixed(1),
        pivotPrice:     +Math.max(rightLip, handleHigh).toFixed(2),
        stopPrice:      +handleLow.toFixed(2),
        confidence:     Math.min(confidence, 100),
      };
    }
  }

  return bestResult;
}

// ─── 2. Ascending Base ──────────────────────────────────────────────────────
// Anatomy: 3+ pullbacks of 10-20% each, each making a HIGHER low
// Each pullback leg: 10-20 bars (2-4 weeks)
// Total pattern: 45-80 bars (9-16 weeks)

function detectAscendingBase(bars, closes) {
  const result = { detected: false, pullbacks: 0, avgPullbackPct: 0, pivotPrice: 0, stopPrice: 0, confidence: 0 };
  const n = closes.length;
  if (n < 60) return result;

  // Scan the last 45-80 bars looking for swing highs and lows
  const lookback = Math.min(80, n);
  const start    = n - lookback;
  const segment  = closes.slice(start);

  // Find local swing highs and lows using a 5-bar window
  const swingHighs = []; // { idx, price }
  const swingLows  = []; // { idx, price }
  const windowSize = 5;

  for (let i = windowSize; i < segment.length - windowSize; i++) {
    const left  = segment.slice(i - windowSize, i);
    const right = segment.slice(i + 1, i + 1 + windowSize);
    const val   = segment[i];

    if (left.every(v => v <= val) && right.every(v => v <= val)) {
      swingHighs.push({ idx: start + i, price: val });
    }
    if (left.every(v => v >= val) && right.every(v => v >= val)) {
      swingLows.push({ idx: start + i, price: val });
    }
  }

  if (swingLows.length < 3 || swingHighs.length < 2) return result;

  // Check for higher lows
  let higherLowCount = 0;
  const pullbackPcts = [];
  for (let i = 1; i < swingLows.length; i++) {
    if (swingLows[i].price > swingLows[i - 1].price) higherLowCount++;

    // Measure pullback from the nearest prior swing high
    const priorHigh = swingHighs.find(h => h.idx < swingLows[i].idx && h.idx > (swingLows[i - 1]?.idx || 0));
    if (priorHigh) {
      const pullPct = (priorHigh.price - swingLows[i].price) / priorHigh.price * 100;
      pullbackPcts.push(pullPct);
    }
  }

  // Require 3+ pullbacks with higher lows
  const validPullbacks = pullbackPcts.filter(p => p >= 10 && p <= 20);
  if (validPullbacks.length < 3 || higherLowCount < 2) return result;

  // Check each pullback leg duration (distance between consecutive swing points)
  let validLegDurations = 0;
  for (let i = 1; i < swingLows.length; i++) {
    const legLen = swingLows[i].idx - swingLows[i - 1].idx;
    if (legLen >= 10 && legLen <= 20) validLegDurations++;
  }

  // Total pattern duration
  const totalDuration = swingLows[swingLows.length - 1].idx - swingLows[0].idx;
  const durationValid = totalDuration >= 45 && totalDuration <= 80;

  const avgPullback = validPullbacks.reduce((a, b) => a + b, 0) / validPullbacks.length;
  const lastHigh    = Math.max(...swingHighs.map(h => h.price));
  const lastLow     = swingLows[swingLows.length - 1].price;

  // ── Confidence scoring ────────────────────────────────────────────
  let confidence = 0;
  confidence += validPullbacks.length >= 4 ? 25 : (validPullbacks.length >= 3 ? 20 : 0);
  confidence += higherLowCount >= 3 ? 25 : (higherLowCount >= 2 ? 15 : 0);
  confidence += durationValid ? 20 : 5;
  confidence += validLegDurations >= 2 ? 15 : 5;
  confidence += (avgPullback >= 12 && avgPullback <= 18) ? 15 : 8;

  return {
    detected:       confidence >= 50,
    pullbacks:      validPullbacks.length,
    avgPullbackPct: +avgPullback.toFixed(1),
    pivotPrice:     +lastHigh.toFixed(2),
    stopPrice:      +lastLow.toFixed(2),
    confidence:     Math.min(confidence, 100),
  };
}

// ─── 3. Power Play ──────────────────────────────────────────────────────────
// Anatomy: stock trades in a tight 10-20% range for 3-6 weeks while price
//          stays above all MAs, volume dries up, and RS line stays strong.
// This is a coiled-spring setup — breakout from quiet consolidation.

function detectPowerPlay(bars, closes, ma50, ma150, ma200) {
  const result = { detected: false, tightness: 0, weeksFlat: 0, pivotPrice: 0, stopPrice: 0, confidence: 0 };
  const n = closes.length;
  if (n < 30) return result;

  // Check prerequisite: price must be above all three MAs
  const lastPrice = closes[n - 1];
  if (ma50 == null || ma150 == null || ma200 == null) return result;
  if (lastPrice <= ma50 || lastPrice <= ma150 || lastPrice <= ma200) return result;

  // Scan 3-6 week windows (15-30 bars) from the recent end
  let bestConfidence = 0;
  let bestResult     = result;

  for (let winLen = 15; winLen <= 30; winLen += 5) {
    if (winLen > n) continue;
    const segment = closes.slice(-winLen);
    const segBars = bars.slice(-winLen);

    const segHigh = Math.max(...segment);
    const segLow  = Math.min(...segment);
    const range   = (segHigh - segLow) / segLow * 100;

    // Range must be 10-20% (tight consolidation)
    if (range < 3 || range > 20) continue;

    // Weekly ranges: split into 5-bar weeks and measure each
    const weeklyRanges = [];
    for (let i = 0; i < segment.length - 4; i += 5) {
      const week   = segment.slice(i, i + 5);
      const wHigh  = Math.max(...week);
      const wLow   = Math.min(...week);
      const wRange = (wHigh - wLow) / wLow * 100;
      weeklyRanges.push(wRange);
    }
    const avgWeeklyRange = weeklyRanges.length > 0
      ? weeklyRanges.reduce((a, b) => a + b, 0) / weeklyRanges.length
      : 99;

    // Tight weekly ranges: average < 3%
    const tightWeeks = avgWeeklyRange < 3;

    // Volume drying up: compare segment volume to prior 50 bars
    const priorVolStart = Math.max(0, n - winLen - 50);
    const priorVolEnd   = n - winLen;
    const priorVolumes  = bars.slice(priorVolStart, priorVolEnd).map(b => b.volume);
    const segVolumes    = segBars.map(b => b.volume);
    const avgPriorVol   = priorVolumes.length > 0
      ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length
      : 1;
    const avgSegVol     = segVolumes.reduce((a, b) => a + b, 0) / segVolumes.length;
    const volumeDry     = avgSegVol < avgPriorVol * 0.7; // 30%+ below average

    // RS line proxy: compare recent price performance vs 50 bars ago
    // (True RS line comparison needs SPY, but we approximate here)
    const priceVs50Ago = n > 50 ? (lastPrice - closes[n - 50]) / closes[n - 50] * 100 : 0;
    const rsStrong     = priceVs50Ago > 0;

    const weeksFlat = Math.floor(winLen / 5);

    // ── Confidence scoring ──────────────────────────────────────────
    let confidence = 0;
    confidence += tightWeeks ? 25 : (avgWeeklyRange < 5 ? 15 : 5);
    confidence += volumeDry ? 25 : 10;
    confidence += rsStrong ? 15 : 0;
    confidence += (range >= 5 && range <= 15) ? 20 : 10; // Ideal range
    confidence += (weeksFlat >= 4 && weeksFlat <= 6) ? 15 : 8;

    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestResult = {
        detected:   confidence >= 50,
        tightness:  +avgWeeklyRange.toFixed(1),
        weeksFlat,
        pivotPrice: +segHigh.toFixed(2),
        stopPrice:  +segLow.toFixed(2),
        confidence: Math.min(confidence, 100),
      };
    }
  }

  return bestResult;
}

// ─── 4. High Tight Flag ─────────────────────────────────────────────────────
// Anatomy: stock doubles (100%+ gain) in 4-8 weeks, then consolidates
//          10-25% in 3-5 weeks on declining volume.
// The rarest and most powerful pattern — only a handful per cycle.

function detectHighTightFlag(bars, closes) {
  const result = { detected: false, priorGainPct: 0, flagPullbackPct: 0, pivotPrice: 0, stopPrice: 0, confidence: 0 };
  const n = closes.length;
  if (n < 55) return result; // Need at least 8+5 weeks of data (65 bars ideal)

  // Scan for the flag portion first: look at last 15-25 bars as the
  // flag, then check the run-up before it.
  let bestConfidence = 0;
  let bestResult     = result;

  for (let flagLen = 15; flagLen <= 25; flagLen += 5) {
    // The run-up precedes the flag
    const flagStart = n - flagLen;
    if (flagStart < 40) continue; // need at least 40 bars of run-up history

    // Flag characteristics
    const flagSlice  = closes.slice(flagStart);
    const flagBars   = bars.slice(flagStart);
    const flagHigh   = Math.max(...flagSlice);
    const flagLow    = Math.min(...flagSlice);
    const flagPull   = (flagHigh - flagLow) / flagHigh * 100;

    if (flagPull < 10 || flagPull > 25) continue; // must consolidate 10-25%

    // Run-up: scan 20-40 bars before the flag for a 100%+ move
    for (let runLen = 20; runLen <= 40; runLen += 5) {
      const runStart = flagStart - runLen;
      if (runStart < 0) continue;

      const runLow  = Math.min(...closes.slice(runStart, runStart + 10)); // base of the move
      const runHigh = Math.max(...closes.slice(runStart, flagStart));     // peak before flag
      const gainPct = (runHigh - runLow) / runLow * 100;

      if (gainPct < 100) continue; // must double

      // Volume: flag volume should decline vs run-up volume
      const runVolumes  = bars.slice(runStart, flagStart).map(b => b.volume);
      const flagVolumes = flagBars.map(b => b.volume);
      const avgRunVol   = runVolumes.reduce((a, b) => a + b, 0) / runVolumes.length;
      const avgFlagVol  = flagVolumes.reduce((a, b) => a + b, 0) / flagVolumes.length;
      const volDeclining = avgFlagVol < avgRunVol * 0.6; // 40%+ decline

      // Flag should be near the high of the run-up (not midway correction)
      const flagMid      = (flagHigh + flagLow) / 2;
      const flagNearHigh = flagMid > runHigh * 0.8;

      // ── Confidence scoring ────────────────────────────────────────
      let confidence = 0;
      confidence += gainPct >= 150 ? 25 : (gainPct >= 100 ? 20 : 0);
      confidence += (flagPull >= 12 && flagPull <= 20) ? 20 : 10;
      confidence += volDeclining ? 25 : 5;
      confidence += flagNearHigh ? 15 : 5;
      confidence += (flagLen >= 15 && flagLen <= 25) ? 15 : 8;

      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestResult = {
          detected:        confidence >= 55,
          priorGainPct:    +gainPct.toFixed(1),
          flagPullbackPct: +flagPull.toFixed(1),
          pivotPrice:      +flagHigh.toFixed(2),
          stopPrice:       +flagLow.toFixed(2),
          confidence:      Math.min(confidence, 100),
        };
      }
    }
  }

  return bestResult;
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Detect all four chart patterns on the given price data.
 *
 * @param {Array<{date,open,high,low,close,volume}>} bars  — OHLCV bars
 * @param {number[]} closes  — array of close prices
 * @param {number|null} ma50  — current 50-day SMA value
 * @param {number|null} ma150 — current 150-day SMA value
 * @param {number|null} ma200 — current 200-day SMA value
 *
 * @returns {{ patterns: Object, patternCount: number, bestPattern: string|null }}
 */
// ─── W Pattern (double bottom) ───────────────────────────────────────────
// Two lows separated by a meaningful peak — looks like the letter W on
// the chart. Reversal pattern signaling end of downtrend.
//
// Two variants returned as detected=true:
//   • RISING W  (low2 > low1 by ≥1%)  — bullish ascending double bottom.
//                                        Higher low = clear demand, the
//                                        institutional accumulation tell.
//                                        Highest-confidence variant.
//   • FLAT W    (|low2 - low1| < 1%)  — classic textbook double bottom.
//                                        Solid reversal, equal lows.
//
// FALLING W (low2 < low1 by >1%) is computed but NOT marked detected=true
// — falling W is a bounce off a lower low, not a true reversal pattern.
// The metadata is still returned (in case future analysis wants it) but
// the chip filter and badges only fire on rising/flat.
//
// PRIOR-DOWNTREND GATE: a W is a *reversal* pattern, so we require the
// 30 bars BEFORE the first low to contain a clear high-water mark that's
// at least 10% above lo1. Otherwise a stock in steady uptrend with two
// pullbacks could falsely trigger.
//
// Detection rules:
//   • Last 60 bars (or N if shorter)
//   • Local lows: bar i where low[i] ≤ each of 2 neighbors on either side
//   • Spacing in BARS is parameterized — opts.minSpacing / opts.maxSpacing.
//     Daily default 8–40 (≈ 1.5–8 weeks). Weekly caller passes 4–16
//     (≈ 1–4 months — institutional W reversal scale).
//   • Symmetry: |low2 - low1|/min(low1,low2) ≤ 8%
//   • Peak between them: ≥ 5% above the lower of the two lows
//   • Prior downtrend: highest high in 30 bars before lo1 is ≥10% above lo1
//   • Current price: ≥ 98% of low2
//
// Pivot/breakout level = peak between the two bottoms (the neckline).
function detectWPattern(bars, closes, opts = {}) {
  if (!bars || bars.length < 30) return { detected: false, confidence: 0 };

  const minSpacing = opts.minSpacing ?? 8;
  const maxSpacing = opts.maxSpacing ?? 40;

  const N = Math.min(60, bars.length);
  const start = bars.length - N;
  const window = bars.slice(start);

  // Find local lows: bar i where low[i] ≤ each of the 2 bars on either side.
  const lows = [];
  for (let i = 2; i < window.length - 2; i++) {
    const v = window[i].low;
    if (v <= window[i-1].low && v <= window[i-2].low &&
        v <= window[i+1].low && v <= window[i+2].low) {
      lows.push({ idx: i, low: v });
    }
  }
  if (lows.length < 2) return { detected: false, confidence: 0 };

  // Take the two most recent significant lows.
  const lo1 = lows[lows.length - 2];
  const lo2 = lows[lows.length - 1];

  const gap = lo2.idx - lo1.idx;
  if (gap < minSpacing || gap > maxSpacing) return { detected: false, confidence: 0 };

  const lowDelta = (lo2.low - lo1.low) / lo1.low;       // signed: + rising, - falling
  if (Math.abs(lowDelta) > 0.08) return { detected: false, confidence: 0 };

  // Peak (highest high) between the two lows = the neckline / pivot.
  let peak = -Infinity;
  for (let i = lo1.idx + 1; i < lo2.idx; i++) {
    if (window[i].high > peak) peak = window[i].high;
  }
  const minLow = Math.min(lo1.low, lo2.low);
  const peakRise = (peak - minLow) / minLow;
  if (peakRise < 0.05) return { detected: false, confidence: 0 };

  // Prior-downtrend gate. Look at the 30 bars in `bars` (full series, not
  // sliced window) BEFORE the first low's absolute index. The first low's
  // absolute index in the full series is start + lo1.idx.
  const lo1AbsIdx = start + lo1.idx;
  const lookbackStart = Math.max(0, lo1AbsIdx - 30);
  let priorHigh = -Infinity;
  for (let i = lookbackStart; i < lo1AbsIdx; i++) {
    if (bars[i].high > priorHigh) priorHigh = bars[i].high;
  }
  // Need a meaningful prior peak — at least 10% above lo1 (i.e. lo1 was
  // a real decline from somewhere). If we don't have 30 bars of prior
  // history, skip the gate (early in the series — give benefit of doubt).
  if (lo1AbsIdx >= 30 && priorHigh > 0) {
    const priorDecline = (priorHigh - lo1.low) / priorHigh;
    if (priorDecline < 0.10) {
      return { detected: false, confidence: 0, reason: 'no_prior_downtrend' };
    }
  }

  const currentPrice = closes[closes.length - 1];
  if (currentPrice < lo2.low * 0.98) return { detected: false, confidence: 0 };

  // Direction classification.
  let direction;
  if      (lowDelta >  0.01) direction = 'rising';
  else if (lowDelta < -0.01) direction = 'falling';
  else                       direction = 'flat';

  // Falling W: compute metadata but don't flag as detected. It's a
  // bounce off a lower low, not a reversal.
  if (direction === 'falling') {
    return {
      detected: false,
      confidence: 0,
      direction,
      reason: 'falling_w_not_a_reversal',
      leftLow: +lo1.low.toFixed(2),
      rightLow: +lo2.low.toFixed(2),
      pivotPrice: +peak.toFixed(2),
      lowsGapBars: gap,
      lowDeltaPct: +(lowDelta * 100).toFixed(2),
    };
  }

  // Confidence: 50 base + direction bonus + symmetry/peak/breakout/trend bonuses.
  let confidence = 50;
  if (direction === 'rising') confidence += 15;          // accumulation tell
  else                        confidence += 5;           // flat W
  const symAbs = Math.abs(lowDelta);
  confidence += (0.08 - symAbs) * 100;                   // up to +8 for tight symmetry
  confidence += Math.min(peakRise, 0.20) * 75;           // up to +15 for tall peak
  if (currentPrice >= peak) confidence += 15;            // already breaking out
  confidence = Math.max(0, Math.min(100, confidence));

  return {
    detected: true,
    confidence: +confidence.toFixed(0),
    direction,                                           // 'rising' | 'flat' (falling filtered out)
    leftLow:    +lo1.low.toFixed(2),
    rightLow:   +lo2.low.toFixed(2),
    pivotPrice: +peak.toFixed(2),
    lowsGapBars: gap,
    peakRisePct: +(peakRise * 100).toFixed(1),
    lowDeltaPct: +(lowDelta * 100).toFixed(2),
  };
}

function detectPatterns(bars, closes, ma50, ma150, ma200, opts = {}) {
  const cupHandle     = detectCupHandle(bars, closes);
  const ascendingBase = detectAscendingBase(bars, closes);
  const powerPlay     = detectPowerPlay(bars, closes, ma50, ma150, ma200);
  const highTightFlag = detectHighTightFlag(bars, closes);
  // W detector accepts spacing thresholds via opts. Daily caller leaves
  // defaults (8-40 bars). Weekly caller passes tighter (4-16 bars =
  // 1-4 months) to match institutional reversal scale.
  const wPattern      = detectWPattern(bars, closes, opts.w || {});

  const patterns = { cupHandle, ascendingBase, powerPlay, highTightFlag, wPattern };

  // Count detected patterns and pick the highest-confidence one
  const detected = Object.entries(patterns).filter(([, v]) => v.detected);
  const patternCount = detected.length;

  let bestPattern = null;
  if (detected.length > 0) {
    detected.sort((a, b) => b[1].confidence - a[1].confidence);
    bestPattern = detected[0][0];
  }

  return { patterns, patternCount, bestPattern };
}

module.exports = { detectPatterns };
