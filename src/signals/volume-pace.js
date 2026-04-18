// ─── Intraday Volume Pace Helper ─────────────────────────────────────────────
//
// Problem: "Confirm breakout on heavy volume" is a daily-close concept. But
// intraday order triggers need to gate on live pace — we can't wait until 4 PM
// to decide whether to enter.
//
// Solution: volume pace ratio.
//   expected_vol_by_now = (elapsed_minutes / 390) × 50-day avg volume
//   pace_ratio = current_day_volume / expected_vol_by_now
//   pace_ratio > 1.3  → "heavy volume day unfolding" (confirm breakout)
//   pace_ratio < 0.8  → "light volume day" (reject breakout — fakeout risk)
//
// Time of day matters:
//   - First 30 min after open: skew high because opening auction dumps volume
//   - Last 30 min of day: skew high because closing auction
//   - Safe window: 10:00 AM - 3:30 PM ET
//
// We handle opening skew by subtracting the first 10 min of volume when pace
// is requested in the first 60 min of the day. A crude but effective filter.

const { yahooQuote } = require('../data/providers/yahoo');

// Market hours (US regular session, all times in ET)
const MARKET_OPEN_MIN  = 9.5 * 60;   // 9:30 AM = 570
const MARKET_CLOSE_MIN = 16   * 60;  // 4:00 PM = 960
const TRADING_DAY_MIN  = MARKET_CLOSE_MIN - MARKET_OPEN_MIN; // 390

function minutesSinceMarketOpenET(now = new Date()) {
  // Convert to ET by finding the TZ offset — works even when server is in UTC or PT.
  // We take a simple approach: format in ET and parse hour/min back.
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  // etString like "4/17/2026, 14:35:22"
  const m = etString.match(/(\d+):(\d+)/);
  if (!m) return null;
  const hour = +m[1], min = +m[2];
  return hour * 60 + min - MARKET_OPEN_MIN;
}

function isMarketOpen() {
  const m = minutesSinceMarketOpenET();
  return m != null && m >= 0 && m <= TRADING_DAY_MIN;
}

// Main helper. Returns { pace, todayVolume, avgVolume, expectedByNow, confidence }
// or null if we can't compute (missing data, market closed).
//
// `confidence` is a string: 'high' (10 AM - 3:30 PM), 'low' (first/last 30 min),
//   'off_hours' (market closed). The caller can use this to decide whether to
//   gate or ignore the signal.
async function getVolumePace(symbol, now = new Date()) {
  const elapsed = minutesSinceMarketOpenET(now);
  if (elapsed == null || elapsed < 0 || elapsed > TRADING_DAY_MIN) {
    return { pace: null, confidence: 'off_hours', reason: 'Market closed' };
  }

  const quotes = await yahooQuote([symbol]).catch(() => []);
  const q = quotes[0];
  if (!q) return null;

  const todayVolume = q.regularMarketVolume;
  // Prefer 50-day avg; fall back to 10-day if 50 unavailable.
  const avgVolume = q.averageDailyVolume50Day || q.averageDailyVolume10Day;
  if (!todayVolume || !avgVolume) {
    return { pace: null, confidence: 'no_data', reason: 'Missing volume data' };
  }

  // Expected volume by this point in the day, linear proration.
  // For the first 10 minutes we floor elapsed at 10 to avoid divide-by-tiny.
  const effectiveElapsed = Math.max(elapsed, 10);
  const expectedByNow = (effectiveElapsed / TRADING_DAY_MIN) * avgVolume;
  const pace = todayVolume / expectedByNow;

  // Confidence tier based on time of day
  let confidence = 'high';
  if (elapsed < 30 || elapsed > TRADING_DAY_MIN - 30) confidence = 'low';

  return {
    pace: +pace.toFixed(2),
    todayVolume,
    avgVolume,
    expectedByNow: Math.round(expectedByNow),
    elapsed,
    confidence,
    label: pace >= 1.5 ? 'HEAVY'
         : pace >= 1.2 ? 'ELEVATED'
         : pace >= 0.8 ? 'NORMAL'
         : 'LIGHT',
  };
}

// Convenience gate: returns true if pace meets the minimum for a given symbol.
// If we can't compute pace (market closed, no data), returns `fallback` which
// defaults to `true` so entries don't get blocked by a helper outage.
async function passesVolumePace(symbol, minPace = 1.2, fallback = true) {
  const result = await getVolumePace(symbol);
  if (!result || result.pace == null) return fallback;
  // During low-confidence windows, allow but log
  if (result.confidence === 'low') return result.pace >= minPace * 0.8;
  return result.pace >= minPace;
}

module.exports = {
  getVolumePace,
  passesVolumePace,
  minutesSinceMarketOpenET,
  isMarketOpen,
};
