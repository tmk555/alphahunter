// ─── Minervini SEPA Trend Template ───────────────────────────────────────────
// 8 rules for ideal uptrend structure

function calcSEPA(price, ma50, ma150, ma200, closes, distFromHigh, rsRank) {
  const vsMA200 = ma200 ? (price - ma200) / ma200 * 100 : null;
  const vsMA150 = ma150 ? (price - ma150) / ma150 * 100 : null;
  const vsMA50  = ma50  ? (price - ma50)  / ma50  * 100 : null;

  // Rule 5: 50MA must be above BOTH 150MA and 200MA
  const ma50AboveAll = ma50 && ma150 && ma200 ? (ma50 > ma150 && ma50 > ma200) : null;

  const sepa = {
    aboveMA200:      vsMA200 != null && vsMA200 > 0,           // 1. Price > 200MA
    aboveMA150:      vsMA150 != null && vsMA150 > 0,           // 2. Price > 150MA
    ma150AboveMA200: ma150 && ma200 ? ma150 > ma200 : null,    // 3. 150MA > 200MA
    ma200Rising:     (() => {                                    // 4. 200MA trending up 4+ weeks
      if (!closes || closes.length < 252) return null;
      const ma200_4wAgo = closes.slice(-252,-228).reduce((a,b)=>a+b,0)/24;
      return ma200 > ma200_4wAgo * 1.001;
    })(),
    ma50AboveAll,                                                // 5. 50MA > 150MA AND 200MA
    aboveMA50:       vsMA50 != null && vsMA50 > 0,              // 6. Price > 50MA
    low30pctBelow:   null,                                       // 7. Set by caller (needs w52l)
    priceNearHigh:   distFromHigh != null && distFromHigh <= 0.25, // 8. Within 25% of high
  };

  const sepaScore = Object.values(sepa).filter(v => v === true).length;

  return { sepa, sepaScore, ma50AboveAll };
}

module.exports = { calcSEPA };
