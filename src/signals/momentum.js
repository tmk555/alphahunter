// ─── Short-term momentum score for SWING trades (0-100) ──────────────────────
// Separate from IBD RS — captures what's moving RIGHT NOW

function calcSwingMomentum(closes, q) {
  if (!closes || closes.length < 10) return 50;
  const n = closes.length, now = closes[n-1];
  let score = 50;
  const roc5  = closes[n-5]  ? (now/closes[n-5]  - 1)*100 : 0;
  const roc10 = closes[n-10] ? (now/closes[n-10] - 1)*100 : 0;
  const roc21 = closes[n-21] ? (now/closes[n-21] - 1)*100 : 0;
  score += roc5 * 3.0;
  score += roc10 * 1.5;
  score += roc21 * 0.5;
  const ma10 = closes.slice(n-10).reduce((a,b)=>a+b,0)/10;
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

// Volume trend proxy
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

module.exports = { calcSwingMomentum, calcPeriodReturns, calcATR, volumeTrend };
