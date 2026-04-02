// ─── Market Regime Detection ─────────────────────────────────────────────────
// Simple regime: SPY vs MAs + VIX (existing)
// Enhanced regime: Distribution days, FTD, rally attempt (new)

const { cacheGet, cacheSet, TTL_QUOTE } = require('../data/cache');
const { yahooQuote, yahooHistoryFull } = require('../data/providers/yahoo');

// ─── Basic regime (existing behavior) ────────────────────────────────────────
async function getMarketRegime() {
  const cached = cacheGet('regime', TTL_QUOTE);
  if (cached) return cached;
  try {
    const quotes = await yahooQuote(['SPY', '^VIX', 'QQQ', 'IWM', 'TLT']);
    const spy = quotes.find(q => q.symbol === 'SPY');
    const vix = quotes.find(q => q.symbol === '^VIX');
    const qqq = quotes.find(q => q.symbol === 'QQQ');
    const iwm = quotes.find(q => q.symbol === 'IWM');
    const tlt = quotes.find(q => q.symbol === 'TLT');

    const spyPrice   = spy?.regularMarketPrice;
    const spy50      = spy?.fiftyDayAverage;
    const spy200     = spy?.twoHundredDayAverage;
    const vixLevel   = vix?.regularMarketPrice || 20;
    const above200   = spyPrice && spy200 ? spyPrice > spy200 : true;
    const above50    = spyPrice && spy50  ? spyPrice > spy50  : true;
    const spyChg1d   = spy?.regularMarketChangePercent;

    let regime, swingOk, positionOk, color, warning, sizeMultiplier;

    if (vixLevel > 35 || !above200) {
      regime = 'HIGH RISK / BEAR';  color = '#ff3d57'; swingOk = false; positionOk = false; sizeMultiplier = 0;
      warning = 'AVOID NEW LONGS — SPY below 200MA or VIX >35. Cash or shorts only.';
    } else if (vixLevel > 25 || !above50) {
      regime = 'CAUTION';           color = '#ff8c00'; swingOk = true;  positionOk = false; sizeMultiplier = 0.5;
      warning = 'Half position size — elevated volatility, tighten stops to 1 ATR';
    } else if (above200 && above50 && vixLevel < 18) {
      regime = 'BULL / RISK ON';    color = '#00e676'; swingOk = true;  positionOk = true;  sizeMultiplier = 1.0;
      warning = null;
    } else {
      regime = 'NEUTRAL';           color = '#f0a500'; swingOk = true;  positionOk = true;  sizeMultiplier = 0.75;
      warning = 'Normal size — mixed signals, respect stops';
    }

    const result = {
      regime, color, swingOk, positionOk, sizeMultiplier, warning, vixLevel,
      spyPrice, spyChg1d, spy50, spy200, above50, above200,
      qqqChg1d: qqq?.regularMarketChangePercent,
      iwmChg1d: iwm?.regularMarketChangePercent,
      tltChg1d: tlt?.regularMarketChangePercent,
      riskOnSignals: [
        above50    && 'SPY above 50MA',
        above200   && 'SPY above 200MA',
        vixLevel < 20 && `VIX calm at ${vixLevel.toFixed(0)}`,
      ].filter(Boolean),
      riskOffSignals: [
        !above50   && 'SPY below 50MA',
        !above200  && 'SPY below 200MA',
        vixLevel > 25 && `VIX elevated at ${vixLevel.toFixed(0)}`,
      ].filter(Boolean),
    };
    cacheSet('regime', result);
    return result;
  } catch(e) {
    return { regime: 'UNKNOWN', color: '#888', swingOk: true, positionOk: true, sizeMultiplier: 0.75, warning: 'Could not fetch regime data' };
  }
}

// ─── Enhanced O'Neil Market Cycle Detection ──────────────────────────────────
// Distribution days, FTD, rally attempts — the full system
async function autoDetectCycleState() {
  const cached = cacheGet('cycle:auto', TTL_QUOTE);
  if (cached) return cached;

  try {
    const bars = await yahooHistoryFull('SPY');
    if (!bars || bars.length < 50) return null;

    const vixBars = await yahooHistoryFull('^VIX');
    const vixLevel = vixBars?.length ? vixBars[vixBars.length - 1].close : 20;

    const n = bars.length;
    const recent = bars.slice(-50); // last 50 sessions

    // ── Distribution days: close ≥ -0.2% on volume > 50-day avg ─────────
    const vol50Avg = bars.slice(-50).reduce((s, b) => s + b.volume, 0) / 50;
    const distDays = [];
    for (let i = 1; i < recent.length; i++) {
      const chg = (recent[i].close - recent[i-1].close) / recent[i-1].close;
      if (chg <= -0.002 && recent[i].volume > vol50Avg) {
        distDays.push({ date: recent[i].date, chg: +(chg * 100).toFixed(2), vol: recent[i].volume });
      }
    }
    // Only count distribution days within last 25 sessions (O'Neil rule: they expire after 25 days)
    const recent25 = bars.slice(-25);
    const distDays25 = [];
    for (let i = 1; i < recent25.length; i++) {
      const chg = (recent25[i].close - recent25[i-1].close) / recent25[i-1].close;
      if (chg <= -0.002 && recent25[i].volume > vol50Avg) {
        distDays25.push(recent25[i].date);
      }
    }
    const distCount = distDays25.length;

    // ── SPY position vs MAs ──────────────────────────────────────────────
    const spyNow  = bars[n-1].close;
    const closes  = bars.map(b => b.close);
    const ma50  = closes.slice(-50).reduce((a,b)=>a+b,0) / Math.min(50, closes.length);
    const ma200 = closes.length >= 200 ? closes.slice(-200).reduce((a,b)=>a+b,0) / 200 : ma50;
    const above50  = spyNow > ma50;
    const above200 = spyNow > ma200;

    // ── 200MA direction ──────────────────────────────────────────────────
    const ma200_4wAgo = closes.length >= 220
      ? closes.slice(-220, -200).reduce((a,b)=>a+b,0) / 20
      : ma200;
    const ma200Rising = ma200 > ma200_4wAgo * 1.001;

    // ── Breadth proxy: up days in last 25 ────────────────────────────────
    let upDays = 0;
    for (let i = 1; i < recent25.length; i++) {
      if (recent25[i].close > recent25[i-1].close) upDays++;
    }
    const breadthPct = +(upDays / Math.max(recent25.length - 1, 1) * 100).toFixed(0);

    // ── Rally attempt detection ──────────────────────────────────────────
    // Find most recent swing low (lowest close in last 20 sessions)
    const last20 = bars.slice(-20);
    let swingLowIdx = 0;
    for (let i = 1; i < last20.length; i++) {
      if (last20[i].close < last20[swingLowIdx].close) swingLowIdx = i;
    }
    const swingLowDate = last20[swingLowIdx].date;
    const daysSinceLow = last20.length - 1 - swingLowIdx;
    const rallyDay = daysSinceLow;

    // ── FTD detection: days 4-7 of rally, ≥1.25% gain on vol > prior day ─
    let ftdFired = false, ftdDate = null;
    if (rallyDay >= 4) {
      for (let i = swingLowIdx + 4; i < Math.min(swingLowIdx + 8, last20.length); i++) {
        const dayChg = (last20[i].close - last20[i-1].close) / last20[i-1].close;
        if (dayChg >= 0.0125 && last20[i].volume > last20[i-1].volume) {
          ftdFired = true;
          ftdDate = last20[i].date;
          break;
        }
      }
    }

    // ── FTD confirmation: ≤1 dist day in 5 sessions after FTD ────────────
    let ftdConfirmed = false;
    if (ftdFired && ftdDate) {
      const ftdIdx = bars.findIndex(b => b.date === ftdDate);
      if (ftdIdx >= 0 && ftdIdx + 5 < n) {
        let postFTDDist = 0;
        for (let i = ftdIdx + 1; i <= Math.min(ftdIdx + 5, n - 1); i++) {
          const chg = (bars[i].close - bars[i-1].close) / bars[i-1].close;
          if (chg <= -0.002 && bars[i].volume > vol50Avg) postFTDDist++;
        }
        ftdConfirmed = postFTDDist <= 1;
      }
    }

    // ── Determine mode ───────────────────────────────────────────────────
    let mode, confidence, action;

    if (vixLevel > 35 || (spyNow < ma200 && (spyNow - ma200) / ma200 < -0.15)) {
      mode = 'BEAR'; confidence = 95; action = 'CASH';
    } else if (!above50 && distCount >= 3) {
      mode = 'CORRECTION'; confidence = 85; action = 'CASH';
    } else if (!above50 && distCount >= 4) {
      mode = 'CORRECTION'; confidence = 90; action = 'CASH';
    } else if (ftdConfirmed && above50) {
      mode = 'FTD_CONFIRMED'; confidence = 75; action = 'FULL_DEPLOY';
    } else if (ftdFired && !ftdConfirmed) {
      mode = 'FTD_CONFIRMED'; confidence = 60; action = 'WATCH_ONLY';
    } else if (rallyDay >= 1 && rallyDay <= 7 && !above50) {
      mode = 'RALLY_ATTEMPT'; confidence = 50; action = 'WATCH_ONLY';
    } else if (above50 && above200 && ma200Rising && distCount <= 2) {
      mode = 'UPTREND'; confidence = 90; action = 'FULL_DEPLOY';
    } else if (above50 && above200 && distCount >= 4) {
      mode = 'UPTREND_PRESSURE'; confidence = 70; action = 'TIGHTEN';
    } else {
      mode = 'CHOPPY'; confidence = 50; action = 'WATCH_ONLY';
    }

    const signals = [];
    if (above50) signals.push('SPY > 50MA');
    if (above200) signals.push('SPY > 200MA');
    if (ma200Rising) signals.push('200MA rising');
    if (distCount >= 4) signals.push(`${distCount} distribution days (25-session window)`);
    if (ftdFired) signals.push(`FTD fired on ${ftdDate}`);
    if (ftdConfirmed) signals.push('FTD confirmed');
    if (vixLevel > 25) signals.push(`VIX elevated at ${vixLevel.toFixed(1)}`);

    const result = {
      mode, confidence, action, signals,
      distributionDays: { count: distCount, dates: distDays25, all: distDays },
      ftd: { fired: ftdFired, date: ftdDate, confirmed: ftdConfirmed },
      rallyAttempt: { day: rallyDay, startDate: swingLowDate },
      breadth: { upDaysPct: breadthPct },
      spy: { price: spyNow, ma50, ma200, above50, above200, ma200Rising },
      vixLevel,
    };

    cacheSet('cycle:auto', result);
    return result;
  } catch(e) {
    console.warn('Cycle detection error:', e.message);
    return null;
  }
}

module.exports = { getMarketRegime, autoDetectCycleState };
