// ─── Intraday Entry Timing Engine ────────────────────────────────────────────
// VWAP, Opening Range Breakout, and intraday support/resistance.
// Answers: "Is this a good moment to enter, or am I chasing?"
//
// All functions are pure — they take bar arrays and return computed values.
// Data fetching is handled by the provider layer (Polygon intraday bars).

// ─── VWAP Calculation ───────────────────────────────────────────────────────
// Cumulative VWAP with standard deviation bands at ±1σ and ±2σ.
// VWAP acts as dynamic institutional fair value — entries near VWAP are ideal.

function calculateVWAP(bars) {
  if (!bars?.length) return null;

  let cumVol = 0, cumTP_Vol = 0;
  const vwapPoints = [];

  for (const bar of bars) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    cumVol += bar.volume || 0;
    cumTP_Vol += tp * (bar.volume || 0);

    const vwap = cumVol > 0 ? cumTP_Vol / cumVol : tp;
    vwapPoints.push({ time: bar.time, vwap, price: bar.close, volume: bar.volume });
  }

  if (!vwapPoints.length) return null;

  const currentVWAP = vwapPoints[vwapPoints.length - 1].vwap;
  const currentPrice = bars[bars.length - 1].close;

  // Compute standard deviation of price from VWAP
  let sumSqDev = 0;
  for (const pt of vwapPoints) {
    sumSqDev += (pt.price - pt.vwap) ** 2;
  }
  const stdDev = Math.sqrt(sumSqDev / vwapPoints.length);

  return {
    vwap: +currentVWAP.toFixed(2),
    currentPrice: +currentPrice.toFixed(2),
    deviation: +((currentPrice - currentVWAP) / currentVWAP * 100).toFixed(2),
    upperBand1: +(currentVWAP + stdDev).toFixed(2),
    lowerBand1: +(currentVWAP - stdDev).toFixed(2),
    upperBand2: +(currentVWAP + 2 * stdDev).toFixed(2),
    lowerBand2: +(currentVWAP - 2 * stdDev).toFixed(2),
    stdDev: +stdDev.toFixed(2),
    aboveVWAP: currentPrice > currentVWAP,
    nearVWAP: Math.abs(currentPrice - currentVWAP) / currentVWAP < 0.005, // Within 0.5%
  };
}

// ─── Opening Range Breakout (ORB) ───────────────────────────────────────────
// Uses first N minutes to establish the opening range, then detects breakout.
// Classic intraday pattern — first 30 min sets the day's range.

function detectOpeningRangeBreakout(bars, rangePeriodMinutes = 30) {
  if (!bars?.length || bars.length < 5) return null;

  // Determine market open time from first bar
  const firstTime = bars[0].time || '09:30:00';
  const openHour = parseInt(firstTime.split(':')[0]);
  const openMin = parseInt(firstTime.split(':')[1]);

  // Find the end of the opening range period
  const rangeEndMin = openMin + rangePeriodMinutes;
  const rangeEndHour = openHour + Math.floor(rangeEndMin / 60);
  const rangeEndMinute = rangeEndMin % 60;
  const rangeEndTime = `${String(rangeEndHour).padStart(2, '0')}:${String(rangeEndMinute).padStart(2, '0')}`;

  // Collect bars within the opening range
  const rangeBars = [];
  const afterRangeBars = [];

  for (const bar of bars) {
    const barTime = bar.time || '';
    if (barTime <= rangeEndTime) {
      rangeBars.push(bar);
    } else {
      afterRangeBars.push(bar);
    }
  }

  if (!rangeBars.length) return null;

  const rangeHigh = Math.max(...rangeBars.map(b => b.high));
  const rangeLow = Math.min(...rangeBars.map(b => b.low));
  const rangeSize = rangeHigh - rangeLow;
  const rangeVolume = rangeBars.reduce((s, b) => s + (b.volume || 0), 0);

  // Detect breakout after range period
  let breakoutDetected = false;
  let breakoutDirection = null;
  let breakoutTime = null;
  let breakoutPrice = null;
  let breakoutVolume = 0;
  let retestCount = 0;

  for (const bar of afterRangeBars) {
    if (!breakoutDetected) {
      if (bar.close > rangeHigh) {
        breakoutDetected = true;
        breakoutDirection = 'up';
        breakoutTime = bar.time;
        breakoutPrice = bar.close;
        breakoutVolume = bar.volume || 0;
      } else if (bar.close < rangeLow) {
        breakoutDetected = true;
        breakoutDirection = 'down';
        breakoutTime = bar.time;
        breakoutPrice = bar.close;
        breakoutVolume = bar.volume || 0;
      }
    } else {
      // Count retests (price returns to range after breakout)
      if (breakoutDirection === 'up' && bar.low <= rangeHigh) retestCount++;
      if (breakoutDirection === 'down' && bar.high >= rangeLow) retestCount++;
    }
  }

  // Volume confirmation: breakout bar volume vs average range bar volume
  const avgRangeVol = rangeBars.length > 0 ? rangeVolume / rangeBars.length : 0;
  const volumeConfirmed = breakoutVolume > avgRangeVol * 1.3;

  return {
    rangeHigh: +rangeHigh.toFixed(2),
    rangeLow: +rangeLow.toFixed(2),
    rangeSize: +rangeSize.toFixed(2),
    rangeSizePct: +((rangeSize / rangeLow) * 100).toFixed(2),
    rangePeriodMinutes,
    breakoutDetected,
    breakoutDirection,
    breakoutTime,
    breakoutPrice: breakoutPrice ? +breakoutPrice.toFixed(2) : null,
    volumeConfirmed,
    retestCount,
    rangeBarCount: rangeBars.length,
  };
}

// ─── Intraday Support/Resistance ────────────────────────────────────────────
// Identifies key price levels from volume clusters and pivot points.

function calculateIntradaySupportResistance(bars) {
  if (!bars?.length || bars.length < 10) return { levels: [] };

  const currentPrice = bars[bars.length - 1].close;

  // 1. Volume-weighted price levels (volume profile)
  const priceStep = _calculatePriceStep(bars);
  const volumeProfile = {};

  for (const bar of bars) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    const bucket = Math.round(tp / priceStep) * priceStep;
    const key = bucket.toFixed(2);
    if (!volumeProfile[key]) volumeProfile[key] = { price: bucket, volume: 0, count: 0 };
    volumeProfile[key].volume += bar.volume || 0;
    volumeProfile[key].count++;
  }

  // Sort by volume (highest = most significant levels)
  const volumeLevels = Object.values(volumeProfile)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5)
    .map(v => ({
      price: +v.price.toFixed(2),
      type: v.price > currentPrice ? 'resistance' : 'support',
      strength: v.count >= 5 ? 3 : v.count >= 3 ? 2 : 1,
      source: 'volume_cluster',
      volume: v.volume,
    }));

  // 2. Pivot points (local highs and lows)
  const pivots = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const isHigh = bars[i].high > bars[i - 1].high && bars[i].high > bars[i - 2].high &&
                   bars[i].high > bars[i + 1].high && bars[i].high > bars[i + 2].high;
    const isLow = bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low &&
                  bars[i].low < bars[i + 1].low && bars[i].low < bars[i + 2].low;

    if (isHigh) {
      pivots.push({
        price: +bars[i].high.toFixed(2),
        type: 'resistance',
        strength: 2,
        source: 'pivot_high',
      });
    }
    if (isLow) {
      pivots.push({
        price: +bars[i].low.toFixed(2),
        type: 'support',
        strength: 2,
        source: 'pivot_low',
      });
    }
  }

  // 3. Day's high/low as key levels
  const dayHigh = Math.max(...bars.map(b => b.high));
  const dayLow = Math.min(...bars.map(b => b.low));

  const dayLevels = [
    { price: +dayHigh.toFixed(2), type: 'resistance', strength: 3, source: 'day_high' },
    { price: +dayLow.toFixed(2), type: 'support', strength: 3, source: 'day_low' },
  ];

  // Merge and deduplicate (within 0.3% of each other)
  const allLevels = [...volumeLevels, ...pivots, ...dayLevels];
  const merged = _mergeLevels(allLevels, currentPrice);

  return {
    levels: merged.slice(0, 8), // Top 8 levels
    currentPrice: +currentPrice.toFixed(2),
    nearestSupport: merged.filter(l => l.type === 'support').sort((a, b) => b.price - a.price)[0] || null,
    nearestResistance: merged.filter(l => l.type === 'resistance').sort((a, b) => a.price - b.price)[0] || null,
  };
}

function _calculatePriceStep(bars) {
  const prices = bars.map(b => b.close);
  const range = Math.max(...prices) - Math.min(...prices);
  if (range < 1) return 0.10;
  if (range < 5) return 0.25;
  if (range < 20) return 0.50;
  return 1.00;
}

function _mergeLevels(levels, currentPrice) {
  const sorted = levels.sort((a, b) => a.price - b.price);
  const merged = [];

  for (const level of sorted) {
    const existing = merged.find(m => Math.abs(m.price - level.price) / level.price < 0.003);
    if (existing) {
      existing.strength = Math.max(existing.strength, level.strength);
      if (level.source !== existing.source) existing.source += '+' + level.source;
    } else {
      merged.push({ ...level });
    }
  }

  // Re-classify based on current price
  for (const level of merged) {
    level.type = level.price > currentPrice ? 'resistance' : 'support';
    level.distance = +((level.price - currentPrice) / currentPrice * 100).toFixed(2);
  }

  return merged.sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance));
}

// ─── Combined Intraday Signals ──────────────────────────────────────────────

function getIntradaySignals(bars) {
  if (!bars?.length) return { error: 'No intraday bars provided' };

  const vwap = calculateVWAP(bars);
  const orb = detectOpeningRangeBreakout(bars, 30);
  const sr = calculateIntradaySupportResistance(bars);

  return {
    vwap,
    orb,
    levels: sr.levels,
    nearestSupport: sr.nearestSupport,
    nearestResistance: sr.nearestResistance,
    currentPrice: bars[bars.length - 1].close,
    barCount: bars.length,
  };
}

// ─── Entry Timing Evaluation ────────────────────────────────────────────────
// Returns a quality rating for entering at the current moment.

function evaluateEntryTiming(signals, entryPrice, side = 'buy') {
  if (!signals || !entryPrice) {
    return { quality: 'unknown', score: 0, reasons: ['No signal data'] };
  }

  let score = 0;
  const reasons = [];
  const isLong = side === 'buy';

  // 1. VWAP proximity (25 pts)
  if (signals.vwap) {
    const deviation = Math.abs(entryPrice - signals.vwap.vwap) / signals.vwap.vwap * 100;
    if (deviation < 0.3) {
      score += 25;
      reasons.push('Entry at VWAP — institutional fair value');
    } else if (deviation < 0.7) {
      score += 18;
      reasons.push(`Near VWAP (${deviation.toFixed(1)}% away)`);
    } else if (isLong && entryPrice > signals.vwap.upperBand1) {
      score += 5;
      reasons.push('Extended above VWAP +1σ — risk of mean reversion');
    } else if (!isLong && entryPrice < signals.vwap.lowerBand1) {
      score += 5;
      reasons.push('Extended below VWAP -1σ — risk of bounce');
    } else {
      score += 12;
    }
  }

  // 2. ORB status (25 pts)
  if (signals.orb) {
    if (signals.orb.breakoutDetected) {
      if (isLong && signals.orb.breakoutDirection === 'up') {
        if (signals.orb.volumeConfirmed) {
          score += 25;
          reasons.push('ORB breakout UP with volume confirmation');
        } else {
          score += 18;
          reasons.push('ORB breakout UP (no volume confirmation)');
        }
      } else if (!isLong && signals.orb.breakoutDirection === 'down') {
        score += 22;
        reasons.push('ORB breakdown — short entry confirmed');
      } else {
        score += 8;
        reasons.push('ORB breakout in opposite direction — contra entry');
      }
    } else {
      // No breakout — range-bound
      if (isLong && entryPrice <= signals.orb.rangeLow * 1.005) {
        score += 20;
        reasons.push('Near opening range low — good long entry');
      } else if (!isLong && entryPrice >= signals.orb.rangeHigh * 0.995) {
        score += 20;
        reasons.push('Near opening range high — good short entry');
      } else {
        score += 10;
        reasons.push('Within opening range — no edge');
      }
    }
  }

  // 3. Support/Resistance alignment (25 pts)
  if (signals.nearestSupport || signals.nearestResistance) {
    if (isLong && signals.nearestSupport) {
      const distToSupport = Math.abs(entryPrice - signals.nearestSupport.price) / entryPrice * 100;
      if (distToSupport < 0.5) {
        score += 25;
        reasons.push(`At support $${signals.nearestSupport.price} (strength ${signals.nearestSupport.strength})`);
      } else if (distToSupport < 1.5) {
        score += 18;
        reasons.push(`Near support $${signals.nearestSupport.price}`);
      } else {
        score += 10;
      }
    }
    if (!isLong && signals.nearestResistance) {
      const distToResistance = Math.abs(entryPrice - signals.nearestResistance.price) / entryPrice * 100;
      if (distToResistance < 0.5) {
        score += 25;
        reasons.push(`At resistance $${signals.nearestResistance.price}`);
      } else if (distToResistance < 1.5) {
        score += 18;
        reasons.push(`Near resistance $${signals.nearestResistance.price}`);
      } else {
        score += 10;
      }
    }
  }

  // 4. Volume pattern (25 pts) — implied from VWAP and ORB volume
  if (signals.vwap?.aboveVWAP && isLong) {
    score += 15;
    reasons.push('Price above VWAP — buyers in control');
  } else if (!signals.vwap?.aboveVWAP && !isLong) {
    score += 15;
    reasons.push('Price below VWAP — sellers in control');
  }
  if (signals.orb?.volumeConfirmed) {
    score += 10;
    reasons.push('Strong volume on breakout');
  }

  // Quality classification
  let quality;
  if (score >= 80) quality = 'excellent';
  else if (score >= 60) quality = 'good';
  else if (score >= 40) quality = 'wait';
  else quality = 'avoid';

  return {
    quality,
    score: Math.min(100, score),
    reasons,
    side,
    entryPrice: +entryPrice.toFixed(2),
  };
}

// ─── Aggregate to Higher Timeframe ──────────────────────────────────────────

function aggregateToTimeframe(bars, minutes) {
  if (!bars?.length || minutes < 1) return bars;

  const aggregated = [];
  let current = null;
  let barCount = 0;

  for (const bar of bars) {
    if (!current || barCount >= minutes) {
      if (current) aggregated.push(current);
      current = {
        date: bar.date,
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
      };
      barCount = 1;
    } else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.volume += bar.volume || 0;
      barCount++;
    }
  }
  if (current) aggregated.push(current);

  return aggregated;
}

module.exports = {
  calculateVWAP,
  detectOpeningRangeBreakout,
  calculateIntradaySupportResistance,
  getIntradaySignals,
  evaluateEntryTiming,
  aggregateToTimeframe,
};
