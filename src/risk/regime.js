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

    // ── Cycle-based regime adjustments ─────────────────────────────────────
    let cycleOverride = null;
    try {
      const cycle = await autoDetectCycleState();
      if (cycle) {
        const basicRegime = regime;

        // Rule 1: BEAR + FTD_CONFIRMED with above50 → upgrade to CAUTION
        if (sizeMultiplier === 0 && cycle.mode === 'FTD_CONFIRMED' && cycle.spy?.above50) {
          regime = 'CAUTION'; color = '#ff8c00'; swingOk = true; positionOk = false; sizeMultiplier = 0.5;
          warning = 'FTD confirmed — pilot buys allowed';
          cycleOverride = { applied: true, from: basicRegime, to: regime, reason: 'FTD confirmed — pilot buys allowed' };
        }
        // Rule 2: CAUTION + FTD_CONFIRMED with confidence >= 70 → upgrade to NEUTRAL
        else if (basicRegime === 'CAUTION' && cycle.mode === 'FTD_CONFIRMED' && cycle.confidence >= 70) {
          regime = 'NEUTRAL'; color = '#f0a500'; swingOk = true; positionOk = true; sizeMultiplier = 0.75;
          warning = 'FTD confirmed — increased sizing';
          cycleOverride = { applied: true, from: basicRegime, to: regime, reason: 'FTD confirmed — increased sizing' };
        }
        // Rule 4: CORRECTION (below 50MA + 3+ dist days) → force CAUTION (checked before Rule 3 to take priority)
        else if (cycle.mode === 'CORRECTION') {
          if (basicRegime !== 'HIGH RISK / BEAR' && basicRegime !== 'CAUTION') {
            regime = 'CAUTION'; color = '#ff8c00'; swingOk = true; positionOk = false; sizeMultiplier = 0.5;
            warning = 'Correction detected — reduce to half position size';
            cycleOverride = { applied: true, from: basicRegime, to: regime, reason: 'Correction detected — below 50MA with distribution days' };
          }
        }
        // Rule 3: UPTREND_PRESSURE (4+ dist days) → downgrade by one level
        else if (cycle.mode === 'UPTREND_PRESSURE' && cycle.distributionDays?.count >= 4) {
          if (basicRegime === 'BULL / RISK ON') {
            regime = 'NEUTRAL'; color = '#f0a500'; swingOk = true; positionOk = true; sizeMultiplier = 0.75;
            warning = 'Distribution day accumulation — reduce exposure';
            cycleOverride = { applied: true, from: basicRegime, to: regime, reason: 'Distribution day accumulation — reduce exposure' };
          } else if (basicRegime === 'NEUTRAL') {
            regime = 'CAUTION'; color = '#ff8c00'; swingOk = true; positionOk = false; sizeMultiplier = 0.5;
            warning = 'Distribution day accumulation — reduce exposure';
            cycleOverride = { applied: true, from: basicRegime, to: regime, reason: 'Distribution day accumulation — reduce exposure' };
          }
        }
      }
    } catch (e) {
      // Cycle detection failed — proceed with basic regime only
    }

    // ── Graduated exposure ramp (O'Neil: increase exposure as rally confirms) ──
    // maxHeatPct tells the portfolio module how much total risk is allowed right now
    let exposureRamp = null;
    try {
      const cycle = cycleOverride?._cycle || await autoDetectCycleState();
      if (cycle && cycle.ftd?.fired) {
        const rallyDay = cycle.rallyAttempt?.day || 0;
        const ftdConfirmed = cycle.ftd?.confirmed;
        const distDays = cycle.distributionDays?.count || 0;
        // O'Neil ramp: pilot → half → three-quarter → full
        let maxHeatPct, exposureLevel;
        if (!ftdConfirmed || rallyDay <= 3) {
          maxHeatPct = 2; exposureLevel = 'PILOT';          // 25% of normal 8% heat
        } else if (rallyDay <= 7 && distDays <= 1) {
          maxHeatPct = 4; exposureLevel = 'HALF';           // 50% of normal heat
        } else if (rallyDay <= 15 && distDays <= 2 && above50) {
          maxHeatPct = 6; exposureLevel = 'THREE_QUARTER';  // 75% of normal heat
        } else if (above50 && above200 && distDays <= 2) {
          maxHeatPct = 8; exposureLevel = 'FULL';           // Full heat ceiling
        } else {
          maxHeatPct = 4; exposureLevel = 'REDUCED';        // Too many dist days
        }
        exposureRamp = { maxHeatPct, exposureLevel, rallyDay, ftdConfirmed, distDays };
      }
    } catch (_) {}

    // ── Breadth-enhanced regime overlay ──────────────────────────────────────
    // Integrates market breadth internals for earlier regime signals.
    // Breadth leads price by days/weeks — catches divergences before MA crosses.
    let breadthOverlay = null;
    try {
      const { computeBreadthFromSnapshots, computeCompositeBreadthScore,
              assessVIXTermStructure, detectBreadthDivergence } = require('../signals/breadth');
      const { getDB } = require('../data/database');
      const _db = getDB();
      const latestDate = _db.prepare(
        `SELECT MAX(date) as date FROM rs_snapshots WHERE type = 'stock'`
      ).get()?.date;

      if (latestDate) {
        const breadth = computeBreadthFromSnapshots(latestDate);
        if (breadth) {
          const vixHistory = _db.prepare(
            `SELECT price FROM rs_snapshots WHERE symbol = '^VIX' AND type = 'sector' AND price > 0
             ORDER BY date DESC LIMIT 252`
          ).all().map(r => r.price).reverse();
          const vixStruct = vixHistory.length > 20
            ? assessVIXTermStructure(vixLevel, vixHistory) : null;

          const composite = computeCompositeBreadthScore(breadth, vixStruct, null);
          const divergence = detectBreadthDivergence(40);

          breadthOverlay = {
            score: composite.score,
            regime: composite.regime,
            sizeMultiplier: composite.sizeMultiplier,
            divergence: divergence.divergence,
            divergenceType: divergence.type,
            pctAbove50MA: breadth.pctAbove50MA,
            pctAbove200MA: breadth.pctAbove200MA,
            adRatio: breadth.adRatio,
            vixStructure: vixStruct?.signal,
          };

          // Breadth can DOWNGRADE regime (never upgrade — that's the FTD's job)
          if (composite.sizeMultiplier < sizeMultiplier && composite.score < 40) {
            const prevRegime = regime;
            sizeMultiplier = Math.max(sizeMultiplier * 0.7, composite.sizeMultiplier);
            if (sizeMultiplier < 0.5 && regime === 'BULL / RISK ON') {
              regime = 'NEUTRAL'; color = '#f0a500';
              warning = `Breadth deteriorating (score ${composite.score}/100) — reducing exposure`;
            }
            breadthOverlay.override = {
              applied: true, from: prevRegime, to: regime,
              reason: `Breadth score ${composite.score}/100 forced downgrade`,
            };
          }

          // Bearish divergence warning: SPY near highs but breadth fading
          if (divergence.divergence) {
            breadthOverlay.divergenceWarning = divergence.message;
            if (sizeMultiplier >= 0.75) {
              sizeMultiplier *= 0.85;
              warning = (warning ? warning + '. ' : '') + 'BREADTH DIVERGENCE detected — reduce new entries';
            }
          }
        }
      }
    } catch (_) {
      // Breadth integration failed — proceed with basic + cycle regime
    }

    // ── Macro regime overlay (v8: yield curve, credit spreads, dollar, ISM) ──
    let macroOverlay = null;
    try {
      const { getMacroSignals, computeMacroScore, getMacroRegimeOverlay } = require('../signals/macro');
      const macroSignals = await getMacroSignals();
      if (macroSignals) {
        const macroResult = computeMacroScore(macroSignals);
        const overlay = getMacroRegimeOverlay(macroResult, { regime, sizeMultiplier });
        macroOverlay = {
          score: macroResult.score,
          regime: macroResult.regime,
          multiplier: macroResult.macroSizeMultiplier,
          yieldCurve: macroSignals.yieldCurve,
          creditSpread: macroSignals.creditSpreads,
          dollar: macroSignals.dollarStrength,
          commodities: macroSignals.commodities,
          ismProxy: macroSignals.ismProxy,
          intermarket: macroSignals.intermarket,
        };
        // Macro can only DOWNGRADE (never upgrade)
        if (overlay.adjusted) {
          const prevRegime = regime;
          regime = overlay.to;
          sizeMultiplier = Math.min(sizeMultiplier, macroResult.macroSizeMultiplier);
          color = sizeMultiplier <= 0.5 ? '#ff8c00' : sizeMultiplier <= 0.75 ? '#f0a500' : color;
          warning = (warning ? warning + '. ' : '') + overlay.reason;
          macroOverlay.override = { applied: true, from: prevRegime, to: regime, reason: overlay.reason };
        }
      }
    } catch (macroErr) {
      console.error('  Macro overlay error:', macroErr.message);
    }

    const result = {
      regime, color, swingOk, positionOk, sizeMultiplier, warning, vixLevel,
      spyPrice, spyChg1d, spy50, spy200, above50, above200,
      cycleOverride, exposureRamp, breadthOverlay, macroOverlay,
      qqqChg1d: qqq?.regularMarketChangePercent,
      iwmChg1d: iwm?.regularMarketChangePercent,
      tltChg1d: tlt?.regularMarketChangePercent,
      riskOnSignals: [
        above50    && 'SPY above 50MA',
        above200   && 'SPY above 200MA',
        vixLevel < 20 && `VIX calm at ${vixLevel.toFixed(0)}`,
        breadthOverlay?.score >= 70 && `Breadth healthy (${breadthOverlay.score}/100)`,
      ].filter(Boolean),
      riskOffSignals: [
        !above50   && 'SPY below 50MA',
        !above200  && 'SPY below 200MA',
        vixLevel > 25 && `VIX elevated at ${vixLevel.toFixed(0)}`,
        breadthOverlay?.score < 40 && `Breadth weak (${breadthOverlay.score}/100)`,
        breadthOverlay?.divergence && 'BREADTH DIVERGENCE — internals fading',
      ].filter(Boolean),
    };

    // ── Regime Change Detection & Push Notification ─────────────────────────
    // Compare current regime against last-known regime stored in portfolio_state.
    // On change, send high-priority push notification (critical for position traders).
    try {
      const { getDB } = require('../data/database');
      const _db = getDB();
      const prevRow = _db.prepare("SELECT value FROM portfolio_state WHERE key = 'last_regime'").get();
      const prevRegime = prevRow?.value || '';

      if (prevRegime && prevRegime !== regime) {
        // Regime changed — send notification
        const { notifyTradeEvent } = require('../notifications/channels');
        notifyTradeEvent({
          event: 'regime_change',
          symbol: 'SPY',
          details: {
            price: spyPrice,
            message: `REGIME CHANGE: ${prevRegime} → ${regime}\nVIX: ${vixLevel?.toFixed(1)} | Size mult: ${sizeMultiplier}x\n${warning || 'Adjust positions accordingly'}`,
            from: prevRegime,
            to: regime,
            sizeMultiplier,
            vixLevel,
          },
        }).catch(e => console.error('Regime notification error:', e.message));

        // Log regime change to regime_log table
        const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        _db.prepare(`
          INSERT OR REPLACE INTO regime_log (date, mode, confidence, spy_price, vix_level, dist_days, breadth_pct, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(date, regime, 80, spyPrice, vixLevel,
          exposureRamp?.distDays || 0,
          breadthOverlay?.score || null,
          `Changed from ${prevRegime} → ${regime}`);
      }

      // Store current regime
      _db.prepare("INSERT OR REPLACE INTO portfolio_state (key, value, updated_at) VALUES ('last_regime', ?, datetime('now'))").run(regime);
    } catch (_) {
      // Don't fail regime detection on notification/storage errors
    }

    cacheSet('regime', result);
    return result;
  } catch(e) {
    console.error('  ⚠ Regime detection failed:', e.message);
    return { regime: 'UNKNOWN', color: '#888', swingOk: true, positionOk: true, sizeMultiplier: 0.75, warning: `Could not fetch regime data: ${e.message}` };
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

    // ── FTD confirmation: ≤1 dist day in sessions after FTD ────────────
    // O'Neil: watch 3-5 sessions post-FTD for distribution. If market holds
    // (≤1 dist day), FTD is confirmed. We require minimum 3 sessions of data,
    // not 5 — waiting for 5 full days to confirm meant FTD stayed "unconfirmed"
    // for a full week, blocking entries during the most profitable window.
    let ftdConfirmed = false;
    if (ftdFired && ftdDate) {
      const ftdIdx = bars.findIndex(b => b.date === ftdDate);
      const sessionsAfterFTD = n - 1 - ftdIdx; // how many bars exist after FTD
      if (ftdIdx >= 0 && sessionsAfterFTD >= 3) {
        const lookAhead = Math.min(sessionsAfterFTD, 5); // check up to 5 sessions
        let postFTDDist = 0;
        for (let i = ftdIdx + 1; i <= ftdIdx + lookAhead; i++) {
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
    } else if (!above50 && distCount >= 4) {
      mode = 'CORRECTION'; confidence = 90; action = 'CASH';  // 4+ dist days = high confidence
    } else if (!above50 && distCount >= 3) {
      mode = 'CORRECTION'; confidence = 85; action = 'CASH';  // 3 dist days = moderate confidence
    } else if (ftdConfirmed && above50) {
      mode = 'FTD_CONFIRMED'; confidence = 75; action = 'FULL_DEPLOY';
    } else if (ftdFired && !ftdConfirmed) {
      mode = 'FTD_FIRED'; confidence = 60; action = 'WATCH_ONLY';
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
