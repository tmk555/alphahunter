// ─── Short-term momentum score for SWING trades (0-100) ──────────────────────
// Absolute score (not percentile-ranked) — same semantics as before so
// thresholds like "momentum >= 60" remain stable across market conditions.
//
// Improvements over original:
//   1. Reduced ROC5 spike sensitivity (3.0→2.0), increased ROC21 (0.5→1.0)
//   2. Trend consistency bonus — steady moves score higher than gap-and-fade
//   3. Volume confirmation — institutional moves on high volume get a boost
//   4. Price vs 10MA — simple trend filter

function calcSwingMomentum(closes, q) {
  if (!closes || closes.length < 21) return 50;
  const n = closes.length, now = closes[n-1];
  let score = 50;

  // 1. Multi-period ROC (reduced spike sensitivity)
  const roc5  = (now / closes[n-5]  - 1) * 100;
  const roc10 = (now / closes[n-10] - 1) * 100;
  const roc21 = (now / closes[n-21] - 1) * 100;
  score += roc5 * 2.0 + roc10 * 1.5 + roc21 * 1.0;

  // 2. Trend consistency — up days / 10 sessions (0 to +8 bonus)
  let upDays = 0;
  for (let i = n - 10; i < n; i++) {
    if (closes[i] > closes[i - 1]) upDays++;
  }
  score += (upDays / 10) * 8;

  // 3. Volume confirmation (only when quote available — live scan)
  const volRatio = q?.averageDailyVolume3Month && q?.regularMarketVolume
    ? q.regularMarketVolume / q.averageDailyVolume3Month : 1;
  if (volRatio >= 2.0) score += 6;
  else if (volRatio >= 1.5) score += 3;

  // 4. Price vs 10MA
  const ma10 = closes.slice(n - 10).reduce((a, b) => a + b, 0) / 10;
  if (now > ma10) score += 5;

  return Math.min(99, Math.max(1, Math.round(score)));
}

// Real period returns from price history
function calcPeriodReturns(closes) {
  if (!closes || closes.length < 5) return {};
  const n = closes.length, now = closes[n-1];
  const ret = (i) => closes[i] ? +((now/closes[i]-1)*100).toFixed(2) : null;
  return {
    chg1d: null, // comes from quote
    chg1w: ret(Math.max(0, n-5)),
    chg1m: ret(Math.max(0, n-21)),
    chg3m: ret(Math.max(0, n-63)),
    chg6m: ret(Math.max(0, n-126)),
  };
}

// ATR (14-day) — for position sizing
// Accepts OHLCV bars [{open, high, low, close, ...}] OR close-only array (legacy fallback)
function calcATR(data) {
  if (!data || data.length < 15) return null;

  // Detect input format: array of objects (bars) vs array of numbers (closes)
  const isBars = typeof data[0] === 'object' && data[0] !== null && 'high' in data[0];

  if (isBars) {
    // True ATR: TR = max(high-low, |high-prevClose|, |low-prevClose|)
    const n = data.length;
    let atrSum = 0;
    for (let i = n - 14; i < n; i++) {
      const bar = data[i];
      const prevClose = data[i - 1].close;
      const tr = Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - prevClose),
        Math.abs(bar.low - prevClose)
      );
      atrSum += tr;
    }
    return +(atrSum / 14).toFixed(2);
  }

  // Legacy fallback: close-to-close (for backward compat where only closes are available)
  const n = data.length;
  let atrSum = 0;
  for (let i = n - 14; i < n; i++) {
    atrSum += Math.abs(data[i] - data[i - 1]);
  }
  return +(atrSum / 14).toFixed(2);
}

// Volume trend proxy (legacy — single-bar quote based)
function volumeTrend(q) {
  if (!q) return 'neutral';
  const price  = q.regularMarketPrice;
  const ma50   = q.fiftyDayAverage;
  const volR   = q.averageDailyVolume3Month
    ? q.regularMarketVolume / q.averageDailyVolume3Month : 1;
  if (!ma50) return 'neutral';
  if (price > ma50 && volR >= 1.2) return 'accumulating';
  if (price < ma50 && volR >= 1.2) return 'distributing';
  if (price > ma50 && volR >= 0.8) return 'neutral-up';
  return 'neutral';
}

// ─── Up/Down Volume Profile ─────────────────────────────────────────────────
// Reads OHLCV bars and decomposes total volume into "up volume" (days the
// stock closed higher) vs "down volume" (closed lower). The ratio is the
// most direct proxy retail traders have for institutional accumulation:
// when big money buys, it shows up as outsized volume on up days. IBD's
// A/B/C/D/E accumulation grades use this same idea. Replaces the previous
// crude single-day volumeTrend() proxy that only looked at the latest bar.
//
// Returns ratios for both 20-day (recent activity, swing-trade horizon) and
// 50-day (institutional positioning timescale). The 50-day is the one that
// matters most for "is this stock under accumulation?".
function calcVolumeProfile(bars) {
  if (!bars || bars.length < 21) return null;

  function ratio(periodDays) {
    if (bars.length < periodDays + 1) return null;
    const slice = bars.slice(-periodDays - 1);
    let upVol = 0, downVol = 0;
    let upDays = 0, downDays = 0;
    for (let i = 1; i < slice.length; i++) {
      const v = slice[i].volume || 0;
      if (slice[i].close > slice[i - 1].close) { upVol += v; upDays++; }
      else if (slice[i].close < slice[i - 1].close) { downVol += v; downDays++; }
    }
    if (downVol === 0) return { ratio: upVol > 0 ? 99 : null, upVol, downVol, upDays, downDays };
    return {
      ratio: +(upVol / downVol).toFixed(2),
      upVol, downVol, upDays, downDays,
    };
  }

  // IBD-style accumulation/distribution grade
  // A: heavy accumulation, E: heavy distribution
  function grade(r) {
    if (r == null) return null;
    if (r >= 1.5) return 'A';
    if (r >= 1.2) return 'B';
    if (r >= 0.9) return 'C';
    if (r >= 0.7) return 'D';
    return 'E';
  }

  const r20 = ratio(20);
  const r50 = ratio(50);

  return {
    upDownRatio20: r20?.ratio ?? null,
    upDownRatio50: r50?.ratio ?? null,
    accumulation20: grade(r20?.ratio),
    accumulation50: grade(r50?.ratio),
    upDays50: r50?.upDays ?? null,
    downDays50: r50?.downDays ?? null,
    // Convenience flags for downstream consumers
    accumulating: r50 != null && r50.ratio != null && r50.ratio >= 1.2,
    distributing: r50 != null && r50.ratio != null && r50.ratio < 0.9,
  };
}

module.exports = { calcSwingMomentum, calcPeriodReturns, calcATR, volumeTrend, calcVolumeProfile };
