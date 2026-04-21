// ─── Institutional Flow Proxy ────────────────────────────────────────────────
// Approximates institutional buying/selling using publicly available data:
// unusual volume patterns, dark pool proxy detection, and options flow analysis.
//
// All functions operate on OHLCV bar arrays from yahooHistoryFull():
//   { date, open, high, low, close, volume }

// Route through the manager cascade. The options-flow fields below
// (putVolume/callVolume) are Yahoo-specific and missing from Polygon/FMP —
// but the function already returns null when they're absent, so using the
// cascade just buys resilience without changing signal behavior.
const { getQuotes } = require('../data/providers/manager');

// ─── 1. detectUnusualVolume ─────────────────────────────────────────────────
// Finds days where volume spikes on significant price moves — hallmarks of
// institutional participation. Institutions can't hide in thin volume; block
// trades leave footprints in the tape.
//
// @param {Array} bars   - OHLCV bar array (must have at least 50 bars for context)
// @param {number} avgVolume - Baseline average daily volume (3-month avg from quote)
// @returns {Object}     - Unusual volume analysis
function detectUnusualVolume(bars, avgVolume) {
  if (!bars || bars.length < 20) {
    return {
      unusualDays: [], accumDays20: 0, distDays20: 0,
      accumDays50: 0, distDays50: 0, powerDays: 0,
      netFlow: 'neutral', flowScore: 50,
    };
  }

  // Use provided avgVolume, or compute from available bars
  const baselineVol = avgVolume && avgVolume > 0
    ? avgVolume
    : bars.slice(-50).reduce((sum, b) => sum + (b.volume || 0), 0) / Math.min(bars.length, 50);

  if (baselineVol <= 0) {
    return {
      unusualDays: [], accumDays20: 0, distDays20: 0,
      accumDays50: 0, distDays50: 0, powerDays: 0,
      netFlow: 'neutral', flowScore: 50,
    };
  }

  const unusualDays = [];
  let accumDays20 = 0, distDays20 = 0;
  let accumDays50 = 0, distDays50 = 0;
  let powerDays = 0;

  // Scan bars (skip index 0 — need prior day for change calculation)
  const startIdx = Math.max(1, bars.length - 50);
  for (let i = startIdx; i < bars.length; i++) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (!bar.volume || !prev.close || prev.close === 0) continue;

    const priceChg = (bar.close - prev.close) / prev.close;
    const volumeRatio = bar.volume / baselineVol;

    // Unusual = volume > 2x average with meaningful price move
    if (volumeRatio < 1.5) continue;

    const isUnusual = volumeRatio >= 2.0;
    const isUp = priceChg > 0.005;    // > +0.5% = advance
    const isDown = priceChg < -0.005;  // < -0.5% = decline

    if (!isUp && !isDown) continue;

    const daysAgo = bars.length - 1 - i;
    const type = isUp ? 'accumulation' : 'distribution';

    if (isUnusual) {
      unusualDays.push({
        date: bar.date,
        type,
        volumeRatio: +volumeRatio.toFixed(2),
        priceChg: +(priceChg * 100).toFixed(2),
      });
    }

    // Power day: vol > 3x avg on 2%+ gain — strongest institutional signal
    if (isUp && volumeRatio >= 3.0 && priceChg >= 0.02) {
      powerDays++;
    }

    // Count accumulation vs distribution in 20/50-day windows
    if (daysAgo < 50) {
      if (isUp && volumeRatio >= 1.5) accumDays50++;
      if (isDown && volumeRatio >= 1.5) distDays50++;
    }
    if (daysAgo < 20) {
      if (isUp && volumeRatio >= 1.5) accumDays20++;
      if (isDown && volumeRatio >= 1.5) distDays20++;
    }
  }

  // Net flow determination
  let netFlow = 'neutral';
  const net20 = accumDays20 - distDays20;
  const net50 = accumDays50 - distDays50;

  if (net20 >= 3 || (net50 >= 4 && net20 >= 1)) {
    netFlow = 'accumulating';
  } else if (net20 <= -3 || (net50 <= -4 && net20 <= -1)) {
    netFlow = 'distributing';
  }

  // Flow score: 0 (heavy distribution) to 100 (heavy accumulation)
  // Base of 50, adjusted by net flow and power days
  let flowScore = 50;
  flowScore += net20 * 5;           // each net accumulation day in 20d = +5
  flowScore += net50 * 2;           // each net accumulation day in 50d = +2 (longer term)
  flowScore += powerDays * 8;       // power days are high-conviction
  flowScore = Math.max(0, Math.min(100, flowScore));

  return {
    unusualDays,
    accumDays20,
    distDays20,
    accumDays50,
    distDays50,
    powerDays,
    netFlow,
    flowScore: +flowScore.toFixed(0),
  };
}

// ─── 2. detectDarkPoolProxy ─────────────────────────────────────────────────
// Approximates dark pool / block trade activity using price-volume signatures.
// Institutional block trades often show up as:
//   - "Absorption" days: heavy volume, close near high, but small daily range
//     (institution absorbing all selling pressure without letting price drop)
//   - "Stealth accumulation": close in upper 25% of range on above-average
//     volume with a daily range smaller than typical ATR (buying without fanfare)
//
// @param {Array} bars - OHLCV bar array
// @returns {Object}   - Dark pool proxy analysis
function detectDarkPoolProxy(bars) {
  if (!bars || bars.length < 30) {
    return { stealthDays: 0, absorptionDays: 0, darkPoolScore: 50 };
  }

  // Compute ATR (14-period) for range comparison
  const atrPeriod = 14;
  let atrSum = 0;
  const atrStart = Math.max(1, bars.length - atrPeriod - 20);
  const atrEnd = Math.max(atrStart + atrPeriod, bars.length - 20);
  let atrCount = 0;
  for (let i = atrStart; i < atrEnd && i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1]?.close || 0),
      Math.abs(bars[i].low - bars[i - 1]?.close || 0)
    );
    if (tr > 0) { atrSum += tr; atrCount++; }
  }
  const atr = atrCount > 0 ? atrSum / atrCount : 0;

  // Compute average volume over the reference window
  const volWindow = bars.slice(-50);
  const avgVol = volWindow.reduce((s, b) => s + (b.volume || 0), 0) / volWindow.length;

  let stealthDays = 0;
  let absorptionDays = 0;

  // Scan last 30 trading days
  const scanStart = Math.max(1, bars.length - 30);
  for (let i = scanStart; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar.high || !bar.low || bar.high === bar.low) continue;

    const range = bar.high - bar.low;
    const closePosition = (bar.close - bar.low) / range; // 0 = closed at low, 1 = closed at high
    const volRatio = avgVol > 0 ? (bar.volume || 0) / avgVol : 0;

    // Stealth accumulation: close in upper 25% of range, vol > 1.5x avg, range < ATR
    if (closePosition >= 0.75 && volRatio >= 1.5 && atr > 0 && range < atr) {
      stealthDays++;
    }

    // Absorption: close near high (upper 20%), heavy volume (> 2x), price barely moved
    // (range < 0.7 * ATR) — institution absorbed all selling without price dropping
    const priceChg = bars[i - 1]?.close
      ? Math.abs(bar.close - bars[i - 1].close) / bars[i - 1].close
      : 0;
    if (closePosition >= 0.80 && volRatio >= 2.0 && atr > 0 && range < atr * 0.7 && priceChg < 0.01) {
      absorptionDays++;
    }
  }

  // Dark pool score: 0-100
  // Each stealth day = +6, each absorption day = +10, base 30
  let darkPoolScore = 30;
  darkPoolScore += stealthDays * 6;
  darkPoolScore += absorptionDays * 10;
  darkPoolScore = Math.max(0, Math.min(100, darkPoolScore));

  return {
    stealthDays,
    absorptionDays,
    darkPoolScore: +darkPoolScore.toFixed(0),
  };
}

// ─── 3. analyzeOptionsFlow ──────────────────────────────────────────────────
// Checks put/call ratio from Yahoo quote data (if available).
// Yahoo quote sometimes includes put/call open interest or volume data.
//
// @param {string} symbol - Ticker symbol
// @returns {Object|null} - Options flow analysis, or null if no data
async function analyzeOptionsFlow(symbol) {
  if (!symbol) return null;

  try {
    const quotes = await getQuotes([symbol]);
    const quote = quotes?.find(q => q.symbol === symbol);
    if (!quote) return null;

    // Yahoo may provide put/call data in various fields
    // Check for any options-related fields
    const putVolume  = quote.putVolume  ?? quote.totalPutOpenInterest  ?? null;
    const callVolume = quote.callVolume ?? quote.totalCallOpenInterest ?? null;

    if (putVolume == null || callVolume == null || callVolume === 0) {
      return null; // No options data available
    }

    const putCallRatio = putVolume / callVolume;

    // Flow bias interpretation:
    // P/C < 0.7 = bullish (more call buying)
    // P/C 0.7-1.0 = neutral
    // P/C > 1.0 = bearish (more put buying / hedging)
    let flowBias = 'neutral';
    let score = 50;

    if (putCallRatio < 0.5) {
      flowBias = 'bullish';  score = 80;
    } else if (putCallRatio < 0.7) {
      flowBias = 'bullish';  score = 65;
    } else if (putCallRatio <= 1.0) {
      flowBias = 'neutral';  score = 50;
    } else if (putCallRatio <= 1.5) {
      flowBias = 'bearish';  score = 35;
    } else {
      flowBias = 'bearish';  score = 20;
    }

    return {
      putCallRatio: +putCallRatio.toFixed(2),
      flowBias,
      score,
    };
  } catch (e) {
    // Options data not available — expected for many symbols
    return null;
  }
}

// ─── 4. computeInstitutionalScore ───────────────────────────────────────────
// Weighted composite: unusual volume 50%, dark pool proxy 30%, options flow 20%.
// If options flow is unavailable, weight redistributes to volume (60%) and
// dark pool (40%).
//
// @param {Object} unusualVol  - From detectUnusualVolume
// @param {Object} darkPool   - From detectDarkPoolProxy
// @param {Object|null} optionsFlow - From analyzeOptionsFlow (may be null)
// @returns {Object}           - Composite institutional score
function computeInstitutionalScore(unusualVol, darkPool, optionsFlow) {
  const volScore = unusualVol?.flowScore ?? 50;
  const dpScore  = darkPool?.darkPoolScore ?? 50;
  const optScore = optionsFlow?.score ?? null;

  let institutionalScore;
  if (optScore != null) {
    // All three available
    institutionalScore = volScore * 0.50 + dpScore * 0.30 + optScore * 0.20;
  } else {
    // Options unavailable — redistribute weight
    institutionalScore = volScore * 0.60 + dpScore * 0.40;
  }

  institutionalScore = Math.max(0, Math.min(100, +institutionalScore.toFixed(0)));

  // Tier classification
  let tier;
  if (institutionalScore >= 80)      tier = 'heavy_accumulation';
  else if (institutionalScore >= 65) tier = 'moderate_accumulation';
  else if (institutionalScore >= 35) tier = 'neutral';
  else if (institutionalScore >= 20) tier = 'moderate_distribution';
  else                               tier = 'heavy_distribution';

  // Build signal descriptions
  const signals = [];
  if (unusualVol) {
    if (unusualVol.netFlow === 'accumulating')
      signals.push(`Net accumulation: ${unusualVol.accumDays20}A vs ${unusualVol.distDays20}D in 20d`);
    if (unusualVol.netFlow === 'distributing')
      signals.push(`Net distribution: ${unusualVol.distDays20}D vs ${unusualVol.accumDays20}A in 20d`);
    if (unusualVol.powerDays > 0)
      signals.push(`${unusualVol.powerDays} power day(s) (3x vol, 2%+ gain)`);
  }
  if (darkPool) {
    if (darkPool.stealthDays >= 3)
      signals.push(`${darkPool.stealthDays} stealth accumulation days detected`);
    if (darkPool.absorptionDays >= 2)
      signals.push(`${darkPool.absorptionDays} absorption days (block trades likely)`);
  }
  if (optionsFlow) {
    signals.push(`Put/Call ${optionsFlow.putCallRatio} — ${optionsFlow.flowBias}`);
  }

  return {
    institutionalScore,
    tier,
    signals,
  };
}

// ─── 5. calcInstitutionalAdjustment ─────────────────────────────────────────
// Returns a conviction score adjustment based on institutional flow detection.
// Meant to be added to the stock's conviction score from conviction.js.
//
// Heavy accumulation + strong RS: +10 (institutions are clearly buying leaders)
// Heavy distribution + weak RS: -10 (institutions exiting, RS confirms weakness)
//
// @param {Object} instScore - From computeInstitutionalScore
// @param {Object} stock     - Stock object with at least { rsRank }
// @returns {Object}         - Adjustment value and reasons
function calcInstitutionalAdjustment(instScore, stock) {
  if (!instScore) {
    return { adjustment: 0, reasons: ['No institutional data available'] };
  }

  const score = instScore.institutionalScore ?? 50;
  const tier  = instScore.tier ?? 'neutral';
  const rs    = stock?.rsRank ?? 50;

  let adjustment = 0;
  const reasons = [];

  // Heavy accumulation tiers
  if (tier === 'heavy_accumulation') {
    if (rs >= 80) {
      adjustment = 10;
      reasons.push(`Heavy institutional accumulation (${score}) + RS ${rs} — strong institutional demand for leaders`);
    } else if (rs >= 60) {
      adjustment = 6;
      reasons.push(`Heavy accumulation (${score}) — institutions buying, moderate RS ${rs}`);
    } else {
      adjustment = 3;
      reasons.push(`Heavy accumulation (${score}) — institutions buying, but RS ${rs} lags`);
    }
  }
  // Moderate accumulation
  else if (tier === 'moderate_accumulation') {
    if (rs >= 80) {
      adjustment = 6;
      reasons.push(`Moderate accumulation (${score}) + strong RS ${rs}`);
    } else if (rs >= 60) {
      adjustment = 3;
      reasons.push(`Moderate accumulation (${score}), RS ${rs}`);
    } else {
      adjustment = 1;
      reasons.push(`Mild accumulation (${score}), RS ${rs} below average`);
    }
  }
  // Moderate distribution
  else if (tier === 'moderate_distribution') {
    if (rs < 50) {
      adjustment = -6;
      reasons.push(`Moderate distribution (${score}) + weak RS ${rs} — institutions likely exiting`);
    } else {
      adjustment = -3;
      reasons.push(`Moderate distribution (${score}), RS ${rs} still acceptable`);
    }
  }
  // Heavy distribution
  else if (tier === 'heavy_distribution') {
    if (rs < 50) {
      adjustment = -10;
      reasons.push(`Heavy distribution (${score}) + RS ${rs} — institutions clearly exiting`);
    } else if (rs < 70) {
      adjustment = -7;
      reasons.push(`Heavy distribution (${score}) — institutional selling despite RS ${rs}`);
    } else {
      adjustment = -4;
      reasons.push(`Heavy distribution (${score}) — unusual selling despite strong RS ${rs}`);
    }
  }
  // Neutral — no adjustment
  else {
    adjustment = 0;
    reasons.push(`Institutional flow neutral (${score})`);
  }

  // Clamp to -10..+10
  adjustment = Math.max(-10, Math.min(10, adjustment));

  return { adjustment, reasons };
}

module.exports = {
  detectUnusualVolume,
  detectDarkPoolProxy,
  analyzeOptionsFlow,
  computeInstitutionalScore,
  calcInstitutionalAdjustment,
};
