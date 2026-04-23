// ─── Macro Regime Model ──────────────────────────────────────────────────────
// Uses market-traded proxies (ETFs, indices) to approximate economic indicators
// that are otherwise gated behind FRED/BLS APIs. Integrates with the existing
// regime system in /src/risk/regime.js as a downgrade-only overlay.
//
// Indicators: yield curve, credit spreads, dollar strength, commodities/inflation,
//             ISM/PMI proxy, intermarket momentum.
//
// Data source: Yahoo Finance via existing provider.

const { cacheGet, cacheSet } = require('../data/cache');
// Routed through the provider manager so a single-provider outage
// (Yahoo 401, Alpaca ECONNRESET) doesn't take the Macro tab down — the
// cascade + circuit breaker keeps the next provider in line serving data.
const { getQuotes, getHistoryFull } = require('../data/providers/manager');

const TTL_MACRO = 5 * 60 * 1000; // 5-minute cache

// ─── Regime hierarchy (used for downgrade logic) ────────────────────────────
const REGIME_LEVELS = {
  'BULL / RISK ON':   0,
  'NEUTRAL':          1,
  'CAUTION':          2,
  'HIGH RISK / BEAR': 3,
  'UNKNOWN':          1,
};

// One level down from each regime
const REGIME_DOWNGRADE = {
  'BULL / RISK ON':   'NEUTRAL',
  'NEUTRAL':          'CAUTION',
  'CAUTION':          'HIGH RISK / BEAR',
  'HIGH RISK / BEAR': 'HIGH RISK / BEAR', // can't go lower
  'UNKNOWN':          'CAUTION',
};

// ─── Helper: rate of change over N bars ─────────────────────────────────────
function rateOfChange(bars, period) {
  if (!bars || bars.length < period + 1) return null;
  const current = bars[bars.length - 1].close;
  const past    = bars[bars.length - 1 - period].close;
  if (!past || past === 0) return null;
  return ((current - past) / past) * 100;
}

// ─── Helper: simple moving average of closes ────────────────────────────────
function sma(bars, period) {
  if (!bars || bars.length < period) return null;
  const slice = bars.slice(-period);
  return slice.reduce((sum, b) => sum + b.close, 0) / period;
}

// ─── 1. getMacroSignals ─────────────────────────────────────────────────────
// Fetches all macro indicators from Yahoo Finance ETF proxies.
async function getMacroSignals() {
  const cached = cacheGet('macro:signals', TTL_MACRO);
  if (cached) return cached;

  try {
    // Batch-fetch all quote data we need
    const quoteSymbols = [
      'TLT', 'SHY',          // yield curve
      '^TNX', '^IRX',        // 10yr / 3mo yields (may fail)
      'HYG', 'LQD',          // credit spreads
      'UUP',                  // dollar
      'USO', 'GLD', 'DBA',   // commodities
      'XLI', 'SPY',          // ISM proxy + benchmark
    ];

    const [quotes, spyBars, tltBars, gldBars, uupBars, usoBars, xliBarsFull] =
      await Promise.all([
        getQuotes(quoteSymbols).catch(() => []),
        getHistoryFull('SPY').catch(() => null),
        getHistoryFull('TLT').catch(() => null),
        getHistoryFull('GLD').catch(() => null),
        getHistoryFull('UUP').catch(() => null),
        getHistoryFull('USO').catch(() => null),
        getHistoryFull('XLI').catch(() => null),
      ]);

    const q = (sym) => quotes.find(r => r.symbol === sym) || null;

    const yieldCurve     = computeYieldCurve(q, tltBars);
    const creditSpreads  = computeCreditSpreads(q);
    const dollarStrength = computeDollarStrength(q, uupBars);
    const commodities    = computeCommodities(q, usoBars, gldBars);
    const ismProxy       = computeISMProxy(q, xliBarsFull, spyBars);
    const intermarket    = computeIntermarketMomentum(spyBars, tltBars, gldBars, uupBars, usoBars);

    const result = {
      yieldCurve,
      creditSpreads,
      dollarStrength,
      commodities,
      ismProxy,
      intermarket,
      fetchedAt: new Date().toISOString(),
    };

    cacheSet('macro:signals', result);
    return result;
  } catch (e) {
    console.warn('Macro signals fetch error:', e.message);
    return null;
  }
}

// ─── Yield Curve (market-traded proxy) ──────────────────────────────────────
// TLT/SHY ratio as yield curve proxy. Declining ratio = flattening/inverting.
// Also attempts ^TNX (10yr) and ^IRX (3mo) for a direct spread if available.
function computeYieldCurve(q, tltBars) {
  const tlt = q('TLT');
  const shy = q('SHY');

  if (!tlt?.regularMarketPrice || !shy?.regularMarketPrice) {
    return { score: 0, signal: 'no_data', details: 'Missing TLT or SHY quote' };
  }

  const ratio = tlt.regularMarketPrice / shy.regularMarketPrice;

  // Check ratio trend via TLT history (20-day slope)
  let ratioTrend = null;
  if (tltBars && tltBars.length >= 20) {
    const roc20 = rateOfChange(tltBars, 20);
    ratioTrend = roc20;
  }

  // Direct yield spread if available
  const tnx = q('^TNX');
  const irx = q('^IRX');
  let yieldSpread = null;
  if (tnx?.regularMarketPrice != null && irx?.regularMarketPrice != null) {
    yieldSpread = tnx.regularMarketPrice - irx.regularMarketPrice;
  }

  // Score: -2 (inverted), -1 (flat), 0 (normal), +1 (steepening)
  let score = 0;
  let signal = 'normal';

  if (yieldSpread != null) {
    // Direct spread scoring
    if (yieldSpread < -0.5) {
      score = -2; signal = 'inverted';
    } else if (yieldSpread < 0.25) {
      score = -1; signal = 'flat';
    } else if (yieldSpread > 1.5 && ratioTrend != null && ratioTrend > 2) {
      score = 1; signal = 'steepening';
    } else {
      score = 0; signal = 'normal';
    }
  } else {
    // Fallback: TLT/SHY ratio + trend
    if (ratioTrend != null) {
      if (ratioTrend < -5) {
        score = -2; signal = 'inverted_proxy';
      } else if (ratioTrend < -2) {
        score = -1; signal = 'flat_proxy';
      } else if (ratioTrend > 3) {
        score = 1; signal = 'steepening_proxy';
      } else {
        score = 0; signal = 'normal';
      }
    }
  }

  return {
    score,
    signal,
    tltShyRatio: +ratio.toFixed(4),
    tltRoc20: ratioTrend != null ? +ratioTrend.toFixed(2) : null,
    yieldSpread: yieldSpread != null ? +yieldSpread.toFixed(2) : null,
    details: yieldSpread != null
      ? `10yr-3mo spread: ${yieldSpread.toFixed(2)}%`
      : `TLT/SHY ratio: ${ratio.toFixed(3)}, 20d RoC: ${ratioTrend?.toFixed(1) ?? 'n/a'}%`,
  };
}

// ─── Credit Spreads (risk appetite) ─────────────────────────────────────────
// HYG/LQD ratio declining = spreads widening = risk-off.
// TLT/HYG ratio rising = flight to quality.
function computeCreditSpreads(q) {
  const hyg = q('HYG');
  const lqd = q('LQD');
  const tlt = q('TLT');

  if (!hyg?.regularMarketPrice || !lqd?.regularMarketPrice) {
    return { score: 0, signal: 'no_data', details: 'Missing HYG or LQD quote' };
  }

  const hygLqdRatio = hyg.regularMarketPrice / lqd.regularMarketPrice;

  // HYG and LQD 50-day averages for trend
  const hyg50 = hyg.fiftyDayAverage;
  const lqd50 = lqd.fiftyDayAverage;
  let ratioTrend = null;
  if (hyg50 && lqd50 && lqd50 > 0) {
    const ratio50 = hyg50 / lqd50;
    ratioTrend = ((hygLqdRatio - ratio50) / ratio50) * 100;
  }

  // Flight to quality: TLT outperforming HYG
  let flightToQuality = null;
  if (tlt?.regularMarketPrice && hyg.regularMarketPrice) {
    const tltHygRatio = tlt.regularMarketPrice / hyg.regularMarketPrice;
    const tlt50 = tlt.fiftyDayAverage;
    if (tlt50 && hyg50 && hyg50 > 0) {
      const tltHyg50 = tlt50 / hyg50;
      flightToQuality = ((tltHygRatio - tltHyg50) / tltHyg50) * 100;
    }
  }

  // Score: -2 (widening fast), -1 (widening), 0 (stable), +1 (tightening)
  let score = 0;
  let signal = 'stable';

  if (ratioTrend != null) {
    if (ratioTrend < -2) {
      score = -2; signal = 'widening_fast';
    } else if (ratioTrend < -0.5) {
      score = -1; signal = 'widening';
    } else if (ratioTrend > 1) {
      score = 1; signal = 'tightening';
    }
  }

  // Flight to quality intensifies the signal
  if (flightToQuality != null && flightToQuality > 3 && score >= 0) {
    score = Math.min(score - 1, -1);
    signal = 'flight_to_quality';
  }

  return {
    score,
    signal,
    hygLqdRatio: +hygLqdRatio.toFixed(4),
    ratioVs50d: ratioTrend != null ? +ratioTrend.toFixed(2) : null,
    flightToQuality: flightToQuality != null ? +flightToQuality.toFixed(2) : null,
    details: `HYG/LQD: ${hygLqdRatio.toFixed(3)}, trend: ${ratioTrend?.toFixed(1) ?? 'n/a'}%`,
  };
}

// ─── Dollar Strength ────────────────────────────────────────────────────────
// Strong dollar (UUP rising) = headwind for multinational earnings.
function computeDollarStrength(q, uupBars) {
  const uup = q('UUP');

  if (!uup?.regularMarketPrice) {
    return { score: 0, signal: 'no_data', details: 'Missing UUP quote' };
  }

  const price = uup.regularMarketPrice;
  const avg50 = uup.fiftyDayAverage;
  const avg200 = uup.twoHundredDayAverage;

  let roc20 = null;
  if (uupBars && uupBars.length >= 20) {
    roc20 = rateOfChange(uupBars, 20);
  }

  // Score: -1 (strong/rising), 0 (stable), +1 (weakening)
  let score = 0;
  let signal = 'stable';

  const aboveBoth = avg50 && avg200 && price > avg50 && price > avg200;
  const belowBoth = avg50 && avg200 && price < avg50 && price < avg200;

  if (aboveBoth && roc20 != null && roc20 > 2) {
    score = -1; signal = 'strong_rising';
  } else if (belowBoth && roc20 != null && roc20 < -2) {
    score = 1; signal = 'weakening';
  } else {
    score = 0; signal = 'stable';
  }

  return {
    score,
    signal,
    uupPrice: +price.toFixed(2),
    roc20: roc20 != null ? +roc20.toFixed(2) : null,
    aboveMAs: aboveBoth,
    details: `UUP: $${price.toFixed(2)}, 20d RoC: ${roc20?.toFixed(1) ?? 'n/a'}%`,
  };
}

// ─── Commodities / Inflation ────────────────────────────────────────────────
// Rising commodities + rising yields = inflation pressure.
function computeCommodities(q, usoBars, gldBars) {
  const uso = q('USO');
  const gld = q('GLD');
  const dba = q('DBA');
  const tnx = q('^TNX');

  let oilRoc = null, goldRoc = null;
  if (usoBars && usoBars.length >= 20) oilRoc = rateOfChange(usoBars, 20);
  if (gldBars && gldBars.length >= 20) goldRoc = rateOfChange(gldBars, 20);

  // Aggregate commodity trend: average RoC of available commodities
  const rocs = [oilRoc, goldRoc].filter(r => r != null);

  // DBA trend via MA comparison
  let dbaRising = false;
  if (dba?.regularMarketPrice && dba?.fiftyDayAverage) {
    dbaRising = dba.regularMarketPrice > dba.fiftyDayAverage;
  }

  // Yields rising?
  let yieldsRising = false;
  if (tnx?.regularMarketPrice && tnx?.fiftyDayAverage) {
    yieldsRising = tnx.regularMarketPrice > tnx.fiftyDayAverage;
  }

  const avgRoc = rocs.length > 0 ? rocs.reduce((a, b) => a + b, 0) / rocs.length : 0;
  const commoditiesRising = avgRoc > 3 || dbaRising;

  // Score: -1 (inflation rising fast), 0 (stable), +1 (disinflation)
  //
  // Fix #4 (2026-04): the old scorer AND-gated on `yieldsRising`, which
  // masked oil shocks when the bond market was flat. A +18% oil move with
  // stable yields is still inflationary (supply-side shock, cost-push, not
  // demand-pull). Score it on its own merits.
  let score = 0;
  let signal = 'stable';

  if (oilRoc != null && oilRoc > 15) {
    // Standalone oil shock — most direct inflation pressure on earnings,
    // regardless of what yields are doing.
    score = -1; signal = 'oil_shock';
  } else if (commoditiesRising && yieldsRising && avgRoc > 5) {
    // Classic reflation — commodities + yields both accelerating.
    score = -1; signal = 'inflation_rising';
  } else if (commoditiesRising && avgRoc > 7) {
    // Commodities surging without yield confirmation — still cost pressure,
    // typically a headwind for margins.
    score = -1; signal = 'commodities_rising';
  } else if (!commoditiesRising && !yieldsRising && avgRoc < -3) {
    score = 1; signal = 'disinflation';
  } else {
    score = 0; signal = 'stable';
  }

  return {
    score,
    signal,
    oilRoc20: oilRoc != null ? +oilRoc.toFixed(2) : null,
    goldRoc20: goldRoc != null ? +goldRoc.toFixed(2) : null,
    avgRoc20: +avgRoc.toFixed(2),
    dbaRising,
    yieldsRising,
    details: `Oil 20d: ${oilRoc?.toFixed(1) ?? 'n/a'}%, Gold 20d: ${goldRoc?.toFixed(1) ?? 'n/a'}%${yieldsRising ? ', yields rising' : ''}`,
  };
}

// ─── ISM / PMI Proxy ────────────────────────────────────────────────────────
// XLI (Industrials ETF) relative strength vs SPY as economic activity proxy.
// XLI outperforming = expansion expectations; underperforming = contraction fears.
function computeISMProxy(q, xliBars, spyBars) {
  const xli = q('XLI');
  const spy = q('SPY');

  if (!xli?.regularMarketPrice || !spy?.regularMarketPrice) {
    return { score: 0, signal: 'no_data', details: 'Missing XLI or SPY quote' };
  }

  // Current relative strength ratio
  const currentRatio = xli.regularMarketPrice / spy.regularMarketPrice;

  // 50-day average relative strength ratio
  let ratio50 = null;
  if (xli.fiftyDayAverage && spy.fiftyDayAverage && spy.fiftyDayAverage > 0) {
    ratio50 = xli.fiftyDayAverage / spy.fiftyDayAverage;
  }

  // 20-day RoC comparison if bars available
  let xliRoc20 = null, spyRoc20 = null, relativeRoc = null;
  if (xliBars && xliBars.length >= 20 && spyBars && spyBars.length >= 20) {
    xliRoc20 = rateOfChange(xliBars, 20);
    spyRoc20 = rateOfChange(spyBars, 20);
    if (xliRoc20 != null && spyRoc20 != null) {
      relativeRoc = xliRoc20 - spyRoc20;
    }
  }

  // Score: -1 (contraction), 0 (neutral/rotation), +1 (expansion)
  //
  // Fix #5 (2026-04): the old scorer labelled any relativeRoc<-2 as
  // "contraction" — even when XLI was still absolutely rising. That's
  // not contraction, that's leadership rotation (tech/discretionary
  // outperforming industrials in a bull tape). Genuine contraction
  // requires XLI to be falling on an absolute basis, not just lagging.
  let score = 0;
  let signal = 'neutral';

  const ratioTrend = ratio50 ? ((currentRatio - ratio50) / ratio50) * 100 : null;

  if (relativeRoc != null) {
    if (relativeRoc > 2) {
      score = 1; signal = 'expansion';
    } else if (relativeRoc < -2) {
      if (xliRoc20 != null && xliRoc20 > 1) {
        // XLI still rising in absolute terms — just lagging SPY.
        // That's rotation, not economic weakness. Neutral score.
        score = 0; signal = 'defensive_rotation';
      } else {
        score = -1; signal = 'contraction';
      }
    }
  } else if (ratioTrend != null) {
    if (ratioTrend > 1) {
      score = 1; signal = 'expansion';
    } else if (ratioTrend < -1) {
      score = -1; signal = 'contraction';
    }
  }

  return {
    score,
    signal,
    xliSpyRatio: +currentRatio.toFixed(4),
    ratioVs50d: ratioTrend != null ? +ratioTrend.toFixed(2) : null,
    xliRoc20: xliRoc20 != null ? +xliRoc20.toFixed(2) : null,
    spyRoc20: spyRoc20 != null ? +spyRoc20.toFixed(2) : null,
    relativeRoc20: relativeRoc != null ? +relativeRoc.toFixed(2) : null,
    details: `XLI/SPY: ${currentRatio.toFixed(3)}, rel RoC: ${relativeRoc?.toFixed(1) ?? 'n/a'}%${signal === 'defensive_rotation' ? ' (XLI still ↑)' : ''}`,
  };
}

// ─── Intermarket Momentum ───────────────────────────────────────────────────
// 20-day rate of change for SPY, TLT, GLD, UUP, USO.
// Risk-on: SPY up, TLT down, GLD down, UUP down (weak dollar tailwind).
// Risk-off: SPY down, TLT up, GLD up, UUP up (strong dollar headwind), or
// an oil shock (USO surging) that threatens earnings via input costs.
//
// Design notes (2026-04 revision):
//   • Pre-revision bug: UUP and USO were fetched and returned but never
//     contributed to the score. SPY alone could drive "strong_risk_on" on a
//     single-market rally with no confirmation from credit/FX/commodities.
//   • Fix #1 (confirmation cap): SPY +5% alone caps at +1. Reaching +2
//     ("strong_risk_on") now requires non-SPY confirmation — TLT down, GLD
//     down, or UUP down. Symmetrical on the downside.
//   • Fix #2 (gold gradient): gold's safe-haven signal degrades gradually
//     (+2%→-0.5, +5%→-1, +10%→-2) instead of cliffing at +5%.
//   • Fix #3 (USO/UUP wiring): dollar and oil now contribute directly.
function computeIntermarketMomentum(spyBars, tltBars, gldBars, uupBars, usoBars) {
  const period = 20;

  const spyRoc = spyBars ? rateOfChange(spyBars, period) : null;
  const tltRoc = tltBars ? rateOfChange(tltBars, period) : null;
  const gldRoc = gldBars ? rateOfChange(gldBars, period) : null;
  const uupRoc = uupBars ? rateOfChange(uupBars, period) : null;
  const usoRoc = usoBars ? rateOfChange(usoBars, period) : null;

  const dataPoints = [spyRoc, tltRoc, gldRoc].filter(r => r != null);
  if (dataPoints.length < 2) {
    return { score: 0, signal: 'insufficient_data', details: 'Need SPY, TLT, GLD history' };
  }

  // Track each market's contribution separately so we can enforce a
  // "SPY alone isn't enough for +2" confirmation rule at the end.
  let spyContrib = 0, tltContrib = 0, gldContrib = 0, uupContrib = 0, usoContrib = 0;

  // SPY momentum (headline signal)
  if (spyRoc != null) {
    if (spyRoc > 5)       spyContrib = 2;
    else if (spyRoc > 2)  spyContrib = 1;
    else if (spyRoc < -5) spyContrib = -2;
    else if (spyRoc < -2) spyContrib = -1;
  }

  // TLT: inverse relationship with risk appetite
  if (tltRoc != null) {
    if (tltRoc < -3)      tltContrib = 1;   // bonds selling = risk-on
    else if (tltRoc > 5)  tltContrib = -1;  // bonds rallying = risk-off
  }

  // GLD: safe-haven demand — gradient rather than a cliff
  if (gldRoc != null) {
    if (gldRoc > 10)       gldContrib = -2;    // strong fear
    else if (gldRoc > 5)   gldContrib = -1;    // moderate fear
    else if (gldRoc > 2)   gldContrib = -0.5;  // mild safe-haven bid
    else if (gldRoc < -2)  gldContrib = 1;     // gold selling = risk-on
  }

  // UUP: dollar strength — headwind for multinationals and risk assets
  if (uupRoc != null) {
    if (uupRoc > 2)       uupContrib = -1;  // dollar rally = risk-off
    else if (uupRoc < -2) uupContrib = 1;   // weak dollar = risk-on tailwind
  }

  // USO: oil shock asymmetric — surges hurt equities via input costs,
  // crashes are ambiguous (growth scare vs. supply glut), so we only
  // penalize big surges here.
  if (usoRoc != null) {
    if (usoRoc > 15)      usoContrib = -1;     // inflationary shock
    else if (usoRoc > 10) usoContrib = -0.5;   // elevated cost pressure
  }

  let score = spyContrib + tltContrib + gldContrib + uupContrib + usoContrib;

  // Confirmation gating: a +2 reading must have non-SPY tailwind (TLT/GLD/UUP
  // down, etc.). Otherwise the market is running alone and the regime hasn't
  // flipped — cap at +1. Symmetric on the risk-off side.
  const nonSpyContrib = tltContrib + gldContrib + uupContrib + usoContrib;
  if (spyContrib >= 2 && nonSpyContrib <= 0) {
    score = Math.min(score, 1);
  } else if (spyContrib <= -2 && nonSpyContrib >= 0) {
    score = Math.max(score, -1);
  }

  // Clamp to -2..+2
  score = Math.max(-2, Math.min(2, score));

  let signal;
  if (score >= 2)       signal = 'strong_risk_on';
  else if (score >= 1)  signal = 'risk_on';
  else if (score <= -2) signal = 'strong_risk_off';
  else if (score <= -1) signal = 'risk_off';
  else                  signal = 'neutral';

  // Round to 1 decimal — half-steps from the gold gradient matter for the UI.
  score = +score.toFixed(1);

  return {
    score,
    signal,
    spyRoc20: spyRoc != null ? +spyRoc.toFixed(2) : null,
    tltRoc20: tltRoc != null ? +tltRoc.toFixed(2) : null,
    gldRoc20: gldRoc != null ? +gldRoc.toFixed(2) : null,
    uupRoc20: uupRoc != null ? +uupRoc.toFixed(2) : null,
    usoRoc20: usoRoc != null ? +usoRoc.toFixed(2) : null,
    contributions: {
      spy: +spyContrib.toFixed(1),
      tlt: +tltContrib.toFixed(1),
      gld: +gldContrib.toFixed(1),
      uup: +uupContrib.toFixed(1),
      uso: +usoContrib.toFixed(1),
    },
    details: `SPY:${spyRoc?.toFixed(1) ?? '-'}% TLT:${tltRoc?.toFixed(1) ?? '-'}% GLD:${gldRoc?.toFixed(1) ?? '-'}% UUP:${uupRoc?.toFixed(1) ?? '-'}% USO:${usoRoc?.toFixed(1) ?? '-'}%`,
  };
}

// ─── 2. computeMacroScore ───────────────────────────────────────────────────
// Aggregates all indicator scores into a single macro regime score.
// Weights: yield curve 25%, credit 25%, dollar 10%, commodities 10%,
//          ISM 15%, intermarket 15%
function computeMacroScore(signals) {
  if (!signals) {
    return {
      score: 0, regime: 'MACRO_NEUTRAL', macroSizeMultiplier: 0.8,
      details: 'No macro signals available',
    };
  }

  const yc   = signals.yieldCurve?.score     ?? 0;
  const cs   = signals.creditSpreads?.score   ?? 0;
  const ds   = signals.dollarStrength?.score   ?? 0;
  const co   = signals.commodities?.score      ?? 0;
  const ism  = signals.ismProxy?.score         ?? 0;
  const im   = signals.intermarket?.score      ?? 0;

  // Normalize: yield curve is -2..+1, credit is -2..+1, dollar is -1..+1,
  // commodities is -1..+1, ISM is -1..+1, intermarket is -2..+2.
  // Scale each to a -10..+10 equivalent contribution before weighting.
  // Max possible raw ranges: yc [-2,1], cs [-2,1], ds [-1,1], co [-1,1], ism [-1,1], im [-2,2]
  const scaledYC  = yc * 5;     // -2*5=-10, +1*5=+5 → range [-10, 5]
  const scaledCS  = cs * 5;     // same
  const scaledDS  = ds * 10;    // -1*10=-10, +1*10=+10
  const scaledCO  = co * 10;    // same
  const scaledISM = ism * 10;   // same
  const scaledIM  = im * 5;     // -2*5=-10, +2*5=+10

  const weightedScore =
    scaledYC  * 0.25 +
    scaledCS  * 0.25 +
    scaledDS  * 0.10 +
    scaledCO  * 0.10 +
    scaledISM * 0.15 +
    scaledIM  * 0.15;

  // Clamp to -10..+10
  const score = Math.max(-10, Math.min(10, +weightedScore.toFixed(2)));

  // Regime mapping
  let regime, macroSizeMultiplier;
  if (score >= 3) {
    regime = 'MACRO_BULLISH';         macroSizeMultiplier = 1.0;
  } else if (score >= 1) {
    regime = 'MACRO_NEUTRAL_BULL';    macroSizeMultiplier = 0.9;
  } else if (score >= -1) {
    regime = 'MACRO_NEUTRAL';         macroSizeMultiplier = 0.8;
  } else if (score >= -3) {
    regime = 'MACRO_CAUTIOUS';        macroSizeMultiplier = 0.6;
  } else {
    regime = 'MACRO_BEARISH';         macroSizeMultiplier = 0.4;
  }

  // Build summary of contributing signals
  const breakdown = {
    yieldCurve:   { raw: yc,  scaled: +scaledYC.toFixed(1),  weighted: +(scaledYC * 0.25).toFixed(2) },
    creditSpreads:{ raw: cs,  scaled: +scaledCS.toFixed(1),  weighted: +(scaledCS * 0.25).toFixed(2) },
    dollarStrength:{ raw: ds, scaled: +scaledDS.toFixed(1),  weighted: +(scaledDS * 0.10).toFixed(2) },
    commodities:  { raw: co,  scaled: +scaledCO.toFixed(1),  weighted: +(scaledCO * 0.10).toFixed(2) },
    ismProxy:     { raw: ism, scaled: +scaledISM.toFixed(1), weighted: +(scaledISM * 0.15).toFixed(2) },
    intermarket:  { raw: im,  scaled: +scaledIM.toFixed(1),  weighted: +(scaledIM * 0.15).toFixed(2) },
  };

  return {
    score,
    regime,
    macroSizeMultiplier,
    breakdown,
    details: `Macro score ${score.toFixed(1)}/10 → ${regime} (size: ${macroSizeMultiplier}x)`,
  };
}

// ─── 3. getMacroRegimeOverlay ───────────────────────────────────────────────
// Integrates macro result with existing regime from /src/risk/regime.js.
// Can only DOWNGRADE regime by one level (never upgrade — that's price action's job).
function getMacroRegimeOverlay(macroResult, currentRegime) {
  if (!macroResult || !currentRegime) {
    return {
      adjusted: false,
      from: currentRegime?.regime || 'UNKNOWN',
      to: currentRegime?.regime || 'UNKNOWN',
      reason: 'Insufficient data for macro overlay',
      macroScore: macroResult?.score ?? null,
      macroRegime: macroResult?.regime ?? null,
    };
  }

  const currentRegimeName = currentRegime.regime || 'UNKNOWN';
  const macroScore = macroResult.score;
  const macroRegime = macroResult.regime;

  // Only downgrade when macro is cautious or bearish
  const shouldDowngrade =
    (macroRegime === 'MACRO_CAUTIOUS' || macroRegime === 'MACRO_BEARISH') &&
    currentRegimeName !== 'HIGH RISK / BEAR'; // already at lowest

  if (!shouldDowngrade) {
    return {
      adjusted: false,
      from: currentRegimeName,
      to: currentRegimeName,
      reason: macroRegime === 'MACRO_BULLISH' || macroRegime === 'MACRO_NEUTRAL_BULL'
        ? `Macro supportive (${macroScore.toFixed(1)}) — no regime change needed`
        : `Macro neutral (${macroScore.toFixed(1)}) — no downgrade warranted`,
      macroScore,
      macroRegime,
    };
  }

  const downgradedRegime = REGIME_DOWNGRADE[currentRegimeName] || currentRegimeName;

  // Build reason string
  const bearishSignals = [];
  if (macroResult.breakdown) {
    const bd = macroResult.breakdown;
    if (bd.yieldCurve.raw < 0)    bearishSignals.push('yield curve flattening');
    if (bd.creditSpreads.raw < 0) bearishSignals.push('credit spreads widening');
    if (bd.dollarStrength.raw < 0) bearishSignals.push('dollar strengthening');
    if (bd.commodities.raw < 0)   bearishSignals.push('inflation pressure');
    if (bd.ismProxy.raw < 0)      bearishSignals.push('economic contraction signal');
    if (bd.intermarket.raw < 0)   bearishSignals.push('intermarket risk-off');
  }

  const reason = bearishSignals.length > 0
    ? `Macro headwinds (${macroScore.toFixed(1)}): ${bearishSignals.join(', ')}`
    : `Macro score ${macroScore.toFixed(1)} warrants caution`;

  return {
    adjusted: true,
    from: currentRegimeName,
    to: downgradedRegime,
    reason,
    macroScore,
    macroRegime,
  };
}

module.exports = { getMacroSignals, computeMacroScore, getMacroRegimeOverlay };
