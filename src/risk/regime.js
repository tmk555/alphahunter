// ─── Market Regime Detection ─────────────────────────────────────────────────
// Simple regime: SPY vs MAs + VIX (existing)
// Enhanced regime: Distribution days, FTD, rally attempt (new)

const { cacheGet, cacheSet, TTL_QUOTE } = require('../data/cache');
// Route through the provider manager — cascades Polygon → Yahoo → FMP → AV for
// quotes (Alpaca is skipped for quotes — history-only) and Polygon → Alpaca →
// Yahoo → FMP → AV for history. When a single provider is down (Yahoo 401,
// Alpaca ECONNRESET), the cascade + circuit breaker keeps regime detection
// alive instead of taking the whole tab down.
const { getQuotes, getHistoryFull } = require('../data/providers/manager');

// ─── Basic regime (existing behavior) ────────────────────────────────────────
async function getMarketRegime() {
  const cached = cacheGet('regime', TTL_QUOTE);
  if (cached) return cached;
  try {
    const quotes = await getQuotes(['SPY', '^VIX', 'QQQ', 'IWM', 'TLT']);
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
        const ftdFailed = cycle.ftd?.failed;
        const distDays = cycle.distributionDays?.count || 0;
        const distDaysRecent10 = cycle.distributionDays?.recent10Count || 0;
        const distDaysScrubbed = cycle.distributionDays?.scrubbedCount || 0;
        // O'Neil ramp: pilot → half → three-quarter → full
        let maxHeatPct, exposureLevel;
        if (ftdFailed) {
          // FTD fired but failed confirmation — back to minimal exposure
          maxHeatPct = 2; exposureLevel = 'PILOT';
        } else if (!ftdConfirmed || rallyDay <= 3) {
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
        exposureRamp = {
          maxHeatPct, exposureLevel, rallyDay, ftdConfirmed, distDays,
          // Surface recovery-scrub metadata for UI tooltips — the tier may
          // read REDUCED due to old dist days that have since been scrubbed
          // by +5% recovery, and users need to see that transparently.
          distDaysRecent10, distDaysScrubbed,
        };
      }
    } catch (err) {
      // Don't crash regime if cycle detection fails, but surface it. Silent
      // catches here were masking exposureRamp becoming null intermittently.
      if (process.env.DEBUG_REGIME) console.warn('[regime] exposureRamp failed:', err.message);
    }

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
    } catch (err) {
      // Breadth integration failed — proceed with basic + cycle regime. Log
      // under DEBUG so silent failures don't hide stale-snapshot issues.
      if (process.env.DEBUG_REGIME) console.warn('[regime] breadthOverlay failed:', err.message);
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

    // ── Exposure-ramp modulator (breadth + macro) ───────────────────────────
    // The raw ramp above only looks at FTD/rallyDay/distDays. It can happily
    // read FULL on Day-17 of a rally whose internals are quietly rolling
    // (composite breadth 51, macro neutral). O'Neil's rule is: "don't push to
    // full exposure when the generals are carrying the tape." Apply a tier
    // downshift based on breadth score and macro regime so the ramp surfaced
    // to the UI reflects the state of the whole market, not just SPY's MAs.
    //
    // Downshift ladder: FULL → THREE_QUARTER → HALF → PILOT.
    // REDUCED is its own state (too many dist days) and is only further
    // downshifted toward PILOT when stacking insults.
    if (exposureRamp) {
      const tiers = ['PILOT', 'HALF', 'THREE_QUARTER', 'FULL'];
      const heatByTier = { PILOT: 2, HALF: 4, THREE_QUARTER: 6, FULL: 8, REDUCED: 4 };
      const downshiftReasons = [];
      const startTierIdx = tiers.indexOf(exposureRamp.exposureLevel);
      let currentIdx = startTierIdx >= 0 ? startTierIdx : -1;

      const bs = breadthOverlay?.score;
      if (typeof bs === 'number') {
        let n = 0;
        if (bs < 30) n = 3;
        else if (bs < 50) n = 2;
        else if (bs < 60) n = 1;  // 51 (MIXED) softens ramp by one tier
        if (n > 0) {
          downshiftReasons.push(`breadth ${bs}/100 (-${n})`);
          if (currentIdx >= 0) currentIdx = Math.max(0, currentIdx - n);
        }
      }

      const mr = macroOverlay?.regime;
      if (mr === 'MACRO_BEARISH') {
        downshiftReasons.push('macro bearish (-1)');
        if (currentIdx >= 0) currentIdx = Math.max(0, currentIdx - 1);
      } else if (mr === 'MACRO_CAUTION') {
        // Half-step caution: only downshift if we'd otherwise be at FULL.
        if (currentIdx === tiers.indexOf('FULL')) {
          downshiftReasons.push('macro caution (-1)');
          currentIdx -= 1;
        }
      }

      if (downshiftReasons.length && currentIdx >= 0 && currentIdx !== startTierIdx) {
        const modulatedLevel = tiers[currentIdx];
        exposureRamp.baseExposureLevel = exposureRamp.exposureLevel;
        exposureRamp.baseMaxHeatPct    = exposureRamp.maxHeatPct;
        exposureRamp.exposureLevel     = modulatedLevel;
        exposureRamp.maxHeatPct        = heatByTier[modulatedLevel];
        exposureRamp.modulated         = true;
        exposureRamp.modulationReasons = downshiftReasons;
      }
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

        // ── Auto-tighten trailing stops on regime downgrade ──
        // Only fire on downgrades (BULL→NEUTRAL, NEUTRAL→CAUTION, CAUTION→BEAR, etc.)
        // based on size multiplier direction. Upgrades don't tighten anything.
        const regimeLevel = (r) => ({
          'BULL / RISK ON': 0, 'BULL': 0, 'NEUTRAL': 1, 'CAUTION': 2,
          'HIGH RISK / BEAR': 3, 'BEAR': 3, 'CORRECTION': 3,
        }[r] ?? 1);
        const isDowngrade = regimeLevel(regime) > regimeLevel(prevRegime);
        if (isDowngrade) {
          try {
            const { tightenOnRegimeDowngrade } = require('../signals/position-deterioration');
            // Fire-and-forget — don't block regime detection on broker I/O.
            // Failures log internally and don't affect the app's behavior.
            tightenOnRegimeDowngrade({
              fromRegime: prevRegime,
              toRegime: regime,
              // Heavier downgrade = tighter stop: BULL→BEAR uses 3% trail, single-step uses 4%
              tightTrailPct: regimeLevel(regime) - regimeLevel(prevRegime) >= 2 ? 0.03 : 0.04,
            }).then(r => {
              if (r.tightened > 0) {
                console.log(`  Regime downgrade tightened ${r.tightened} open position(s); ${r.brokerPatched} broker legs patched`);
              }
            }).catch(e => console.error('  Regime downgrade tighten failed:', e.message));
          } catch (e) {
            console.warn(`  Could not load position-deterioration module: ${e.message}`);
          }
        }

        // Log regime change to regime_log table (Phase 3.12: persist ftd_date + rally_day)
        const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        let cycleData = null;
        try { cycleData = await autoDetectCycleState(); } catch (_) {}
        _db.prepare(`
          INSERT OR REPLACE INTO regime_log (date, mode, confidence, spy_price, vix_level, dist_days, breadth_pct, ftd_date, rally_day, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(date, regime, 80, spyPrice, vixLevel,
          cycleData?.distributionDays?.count || exposureRamp?.distDays || 0,
          breadthOverlay?.score || null,
          cycleData?.ftd?.date || null,
          cycleData?.rallyAttempt?.day || null,
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
// Dual-index distribution days, FTD, rally attempts — the full system.
//
// Phase 3.11: Real O'Neil distribution days on BOTH SPY (S&P 500) and QQQ
//   (Nasdaq 100). O'Neil watched both indices — a distribution day on EITHER
//   counts. 5+ in 25 sessions = "under distribution" → CORRECTION.
//
// Phase 3.12: Real follow-through day (FTD) on EITHER index.
//   Classic O'Neil: day 4-7 of rally, ≥1.5% gain on volume > prior session.
//   FTD on either SPY or QQQ qualifies. Tracks FTD failures (fired but
//   confirmation failed due to subsequent distribution).

// ── Distribution day detection for a single index ─────────────────────────
// O'Neil's full rules — NOT just a 25-session count:
//   1. 25-session expiry (days outside the window fall off automatically)
//   2. +5% recovery scrub — a dist day is invalidated if the index
//      subsequently closes ≥+5% above that day's close. Rationale: the
//      market absorbed the selling and rallied through it; dragging that
//      dist day forward is stale signal.
// Both rules applied here. `active` = after both filters. `scrubbed` are
// surfaced separately so the UI can explain why the raw count shrinks.
//
// Returns:
//   all          — last 50 sessions, raw dist days (for display only)
//   active       — dates still counting (25-session + not +5% recovered)
//   count        — active.length
//   scrubbed     — dates that WOULD be active but were invalidated by +5%
//   recent10     — active dates falling in the last 10 sessions
//   rawCount     — 25-session count BEFORE scrub (raw O'Neil count)
const RECOVERY_SCRUB_PCT = 0.05; // +5% above dist-day close → scrubbed
const RECENT_DIST_WINDOW = 10;   // for the "X in last 10" tooltip split

function _countDistributionDays(bars, indexLabel) {
  if (!bars || bars.length < 50) {
    return {
      all: [], active: [], count: 0,
      scrubbed: [], scrubbedCount: 0,
      recent10: [], recent10Count: 0,
      rawCount: 0, vol50Avg: 0,
    };
  }

  const vol50Avg = bars.slice(-50).reduce((s, b) => s + b.volume, 0) / 50;

  // All distribution days in last 50 sessions (for display)
  const recent50 = bars.slice(-50);
  const all = [];
  for (let i = 1; i < recent50.length; i++) {
    const chg = (recent50[i].close - recent50[i - 1].close) / recent50[i - 1].close;
    if (chg <= -0.002 && recent50[i].volume > vol50Avg) {
      all.push({ date: recent50[i].date, chg: +(chg * 100).toFixed(2), vol: recent50[i].volume, index: indexLabel });
    }
  }

  // 25-session window + O'Neil recovery-scrub
  const recent25 = bars.slice(-25);
  const active = [];
  const scrubbed = [];
  let rawCount = 0;
  for (let i = 1; i < recent25.length; i++) {
    const chg = (recent25[i].close - recent25[i - 1].close) / recent25[i - 1].close;
    if (!(chg <= -0.002 && recent25[i].volume > vol50Avg)) continue;
    rawCount++;

    // Did the index subsequently close ≥+5% above this dist-day close?
    // Scan only within recent25 — anything farther back is already aged out.
    const scrubThreshold = recent25[i].close * (1 + RECOVERY_SCRUB_PCT);
    let recovered = false;
    for (let j = i + 1; j < recent25.length; j++) {
      if (recent25[j].close >= scrubThreshold) { recovered = true; break; }
    }
    if (recovered) scrubbed.push(recent25[i].date);
    else           active.push(recent25[i].date);
  }

  // Recent-10-session split — only ACTIVE (non-scrubbed) days count toward
  // the "market recovering" indicator the user asked for. If there are
  // fresh dist days in the last 10 sessions, the recovery isn't clean.
  const recent10DateSet = new Set(bars.slice(-RECENT_DIST_WINDOW).map(b => b.date));
  const recent10 = active.filter(d => recent10DateSet.has(d));

  return {
    all,
    active, count: active.length,
    scrubbed, scrubbedCount: scrubbed.length,
    recent10, recent10Count: recent10.length,
    rawCount,
    vol50Avg,
  };
}

// ── FTD detection for a single index ──────────────────────────────────────
// Classic O'Neil: day 4-7 after swing low, ≥1.5% gain on volume > prior day.
// Returns { fired, date, index }
const FTD_GAIN_THRESHOLD = 0.015; // 1.5% — O'Neil's canonical threshold

function _detectFTD(bars, indexLabel) {
  if (!bars || bars.length < 20) return { fired: false, date: null, index: indexLabel };

  const last20 = bars.slice(-20);
  let swingLowIdx = 0;
  for (let i = 1; i < last20.length; i++) {
    if (last20[i].close < last20[swingLowIdx].close) swingLowIdx = i;
  }
  const swingLowDate = last20[swingLowIdx].date;
  const rallyDay = last20.length - 1 - swingLowIdx;

  let fired = false, ftdDate = null;
  if (rallyDay >= 4) {
    for (let i = swingLowIdx + 4; i < Math.min(swingLowIdx + 8, last20.length); i++) {
      const dayChg = (last20[i].close - last20[i - 1].close) / last20[i - 1].close;
      if (dayChg >= FTD_GAIN_THRESHOLD && last20[i].volume > last20[i - 1].volume) {
        fired = true;
        ftdDate = last20[i].date;
        break;
      }
    }
  }

  return { fired, date: ftdDate, index: indexLabel, swingLowDate, rallyDay };
}

// ── FTD confirmation check ────────────────────────────────────────────────
// Post-FTD: watch 3-5 sessions. If ≤1 distribution day occurs, confirmed.
// If 2+ distribution days → FTD failed (tracked for history).
function _confirmFTD(bars, ftdDate, vol50Avg) {
  if (!ftdDate || !bars?.length) return { confirmed: false, failed: false, postFTDDistDays: 0 };

  const n = bars.length;
  const ftdIdx = bars.findIndex(b => b.date === ftdDate);
  if (ftdIdx < 0) return { confirmed: false, failed: false, postFTDDistDays: 0 };

  const sessionsAfterFTD = n - 1 - ftdIdx;
  if (sessionsAfterFTD < 3) return { confirmed: false, failed: false, postFTDDistDays: 0, pending: true };

  const lookAhead = Math.min(sessionsAfterFTD, 5);
  let postFTDDist = 0;
  for (let i = ftdIdx + 1; i <= ftdIdx + lookAhead; i++) {
    const chg = (bars[i].close - bars[i - 1].close) / bars[i - 1].close;
    if (chg <= -0.002 && bars[i].volume > vol50Avg) postFTDDist++;
  }

  const confirmed = postFTDDist <= 1;
  const failed = !confirmed && sessionsAfterFTD >= 5; // definitively failed after 5 sessions

  return { confirmed, failed, postFTDDistDays: postFTDDist, sessionsChecked: lookAhead };
}

async function autoDetectCycleState() {
  const cached = cacheGet('cycle:auto', TTL_QUOTE);
  if (cached) return cached;

  try {
    // ── Fetch BOTH indices in parallel (Phase 3.11) ─────────────────────
    const [spyBars, qqqBars, vixBars] = await Promise.all([
      getHistoryFull('SPY'),
      getHistoryFull('QQQ'),
      getHistoryFull('^VIX'),
    ]);

    if (!spyBars || spyBars.length < 50) return null;
    const vixLevel = vixBars?.length ? vixBars[vixBars.length - 1].close : 20;

    // ── Distribution days: BOTH indices (union of dates) ────────────────
    // O'Neil counted distribution on both S&P 500 and Nasdaq. A dist day
    // on EITHER index counts toward the 5-in-25 threshold.
    const spyDist = _countDistributionDays(spyBars, 'SPY');
    const qqqDist = qqqBars?.length >= 50 ? _countDistributionDays(qqqBars, 'QQQ') : { all: [], active: [], count: 0 };

    // Merge active dist days by date (union — same date on both = 1 count)
    const activeDateSet = new Set([...spyDist.active, ...qqqDist.active]);
    const distCount = activeDateSet.size;
    const distDays25 = [...activeDateSet].sort();
    const distDaysAll = [...spyDist.all, ...qqqDist.all].sort((a, b) => a.date.localeCompare(b.date));

    // Merge scrubbed dates. If a date is active on ONE index and scrubbed on
    // the other, active wins — don't double-count or mislabel.
    const scrubbedDateSet = new Set([...spyDist.scrubbed, ...qqqDist.scrubbed]);
    for (const d of activeDateSet) scrubbedDateSet.delete(d);
    const distScrubbed = [...scrubbedDateSet].sort();

    // Recent-10 split: any active date that falls in last 10 sessions on
    // EITHER index (the union — consistent with how the active set is built).
    const recent10Set = new Set([...spyDist.recent10, ...qqqDist.recent10]);
    const recent10Dates = [...recent10Set].sort();
    const rawCount25 = distCount + distScrubbed.length;

    // ── SPY position vs MAs ──────────────────────────────────────────────
    const n = spyBars.length;
    const spyNow  = spyBars[n - 1].close;
    const closes  = spyBars.map(b => b.close);
    const ma50  = closes.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, closes.length);
    const ma200 = closes.length >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : ma50;
    const above50  = spyNow > ma50;
    const above200 = spyNow > ma200;

    // ── 200MA direction ──────────────────────────────────────────────────
    const ma200_4wAgo = closes.length >= 220
      ? closes.slice(-220, -20).reduce((a, b) => a + b, 0) / 200
      : ma200;
    const ma200Rising = ma200 > ma200_4wAgo * 1.001;

    // ── QQQ MAs (for display) ────────────────────────────────────────────
    let qqqAbove50 = null, qqqAbove200 = null, qqqPrice = null;
    if (qqqBars?.length >= 50) {
      const qn = qqqBars.length;
      qqqPrice = qqqBars[qn - 1].close;
      const qCloses = qqqBars.map(b => b.close);
      const qMa50 = qCloses.slice(-50).reduce((a, b) => a + b, 0) / 50;
      const qMa200 = qCloses.length >= 200 ? qCloses.slice(-200).reduce((a, b) => a + b, 0) / 200 : qMa50;
      qqqAbove50 = qqqPrice > qMa50;
      qqqAbove200 = qqqPrice > qMa200;
    }

    // ── Breadth proxy: up days in last 25 ────────────────────────────────
    const recent25 = spyBars.slice(-25);
    let upDays = 0;
    for (let i = 1; i < recent25.length; i++) {
      if (recent25[i].close > recent25[i - 1].close) upDays++;
    }
    const breadthPct = +(upDays / Math.max(recent25.length - 1, 1) * 100).toFixed(0);

    // ── Rally attempt detection (from SPY swing low) ─────────────────────
    const last20 = spyBars.slice(-20);
    let swingLowIdx = 0;
    for (let i = 1; i < last20.length; i++) {
      if (last20[i].close < last20[swingLowIdx].close) swingLowIdx = i;
    }
    const swingLowDate = last20[swingLowIdx].date;
    const daysSinceLow = last20.length - 1 - swingLowIdx;
    const rallyDay = daysSinceLow;

    // ── FTD detection: EITHER index qualifies (Phase 3.12) ──────────────
    // O'Neil: an FTD on either the S&P 500 or the Nasdaq counts as a
    // green light. We check both and take the earliest one.
    const spyFTD = _detectFTD(spyBars, 'SPY');
    const qqqFTD = qqqBars?.length >= 20 ? _detectFTD(qqqBars, 'QQQ') : { fired: false };

    let ftdFired = spyFTD.fired || qqqFTD.fired;
    let ftdDate = null, ftdIndex = null;
    if (spyFTD.fired && qqqFTD.fired) {
      // Both fired — take the earlier date (stronger signal)
      ftdDate = spyFTD.date <= qqqFTD.date ? spyFTD.date : qqqFTD.date;
      ftdIndex = spyFTD.date <= qqqFTD.date ? 'SPY' : 'QQQ';
    } else if (spyFTD.fired) {
      ftdDate = spyFTD.date; ftdIndex = 'SPY';
    } else if (qqqFTD.fired) {
      ftdDate = qqqFTD.date; ftdIndex = 'QQQ';
    }

    // ── FTD confirmation with failure tracking ───────────────────────────
    let ftdConfirmed = false, ftdFailed = false, ftdConfirmDetail = null;
    if (ftdFired && ftdDate) {
      const confirmedOn = ftdIndex === 'SPY' ? spyBars : qqqBars;
      const vol50 = ftdIndex === 'SPY' ? spyDist.vol50Avg : (qqqDist.vol50Avg || spyDist.vol50Avg);
      const detail = _confirmFTD(confirmedOn, ftdDate, vol50);
      ftdConfirmed = detail.confirmed;
      ftdFailed = detail.failed;
      ftdConfirmDetail = detail;
    }

    // ── Determine mode ───────────────────────────────────────────────────
    let mode, confidence, action;

    if (vixLevel > 35 || (spyNow < ma200 && (spyNow - ma200) / ma200 < -0.15)) {
      mode = 'BEAR'; confidence = 95; action = 'CASH';
    } else if (!above50 && distCount >= 5) {
      // O'Neil's threshold: 5+ distribution days in 25 sessions = definitive correction
      mode = 'CORRECTION'; confidence = 95; action = 'CASH';
    } else if (!above50 && distCount >= 4) {
      mode = 'CORRECTION'; confidence = 90; action = 'CASH';
    } else if (!above50 && distCount >= 3) {
      mode = 'CORRECTION'; confidence = 85; action = 'CASH';
    } else if (ftdConfirmed && above50) {
      mode = 'FTD_CONFIRMED'; confidence = 75; action = 'FULL_DEPLOY';
    } else if (ftdFired && ftdFailed) {
      // FTD fired but distribution followed — not safe to deploy
      mode = 'FTD_FAILED'; confidence = 65; action = 'WATCH_ONLY';
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
    if (qqqAbove50) signals.push('QQQ > 50MA');
    if (qqqAbove200) signals.push('QQQ > 200MA');
    if (ma200Rising) signals.push('200MA rising');
    if (distCount >= 4) signals.push(`${distCount} distribution days across SPY+QQQ (25-session window)`);
    else if (distCount >= 2) signals.push(`${distCount} distribution days (25-session window)`);
    if (distScrubbed.length > 0) signals.push(`${distScrubbed.length} dist day(s) scrubbed by +5% recovery`);
    if (recent10Dates.length > 0) signals.push(`${recent10Dates.length} active dist day(s) in last 10 sessions`);
    if (ftdFired) signals.push(`FTD fired on ${ftdIndex} ${ftdDate}`);
    if (ftdConfirmed) signals.push('FTD confirmed');
    if (ftdFailed) signals.push(`FTD failed — distribution followed on ${ftdDate}`);
    if (vixLevel > 25) signals.push(`VIX elevated at ${vixLevel.toFixed(1)}`);

    const result = {
      mode, confidence, action, signals,
      distributionDays: {
        count: distCount,
        dates: distDays25,
        all: distDaysAll,
        // Phase: O'Neil +5% recovery-scrub transparency
        scrubbed: distScrubbed,
        scrubbedCount: distScrubbed.length,
        rawCount25,                  // 25-session count BEFORE scrub
        recent10: recent10Dates,     // active dist days in last 10 sessions
        recent10Count: recent10Dates.length,
        spy: {
          count: spyDist.count,
          dates: spyDist.active,
          scrubbed: spyDist.scrubbed,
          recent10: spyDist.recent10,
        },
        qqq: {
          count: qqqDist.count,
          dates: qqqDist.active,
          scrubbed: qqqDist.scrubbed,
          recent10: qqqDist.recent10,
        },
      },
      ftd: {
        fired: ftdFired,
        date: ftdDate,
        index: ftdIndex,
        confirmed: ftdConfirmed,
        failed: ftdFailed,
        confirmDetail: ftdConfirmDetail,
        // Both indices' raw FTD results for transparency
        spyFTD: { fired: spyFTD.fired, date: spyFTD.date },
        qqqFTD: { fired: qqqFTD.fired, date: qqqFTD.date },
      },
      rallyAttempt: { day: rallyDay, startDate: swingLowDate },
      breadth: { upDaysPct: breadthPct },
      spy: { price: spyNow, ma50, ma200, above50, above200, ma200Rising },
      qqq: { price: qqqPrice, above50: qqqAbove50, above200: qqqAbove200 },
      vixLevel,
    };

    cacheSet('cycle:auto', result);
    return result;
  } catch (e) {
    console.warn('Cycle detection error:', e.message);
    return null;
  }
}

// Expose helpers for testing
autoDetectCycleState._countDistributionDays = _countDistributionDays;
autoDetectCycleState._detectFTD = _detectFTD;
autoDetectCycleState._confirmFTD = _confirmFTD;
autoDetectCycleState.FTD_GAIN_THRESHOLD = FTD_GAIN_THRESHOLD;

module.exports = { getMarketRegime, autoDetectCycleState };
