// ─── Minervini SEPA Trend Template ───────────────────────────────────────────
// 8 rules for ideal uptrend structure. A rule's value is:
//   true  — passes
//   false — fails (data available, criterion not met)
//   null  — skipped (data missing, can't evaluate)
//
// Score semantics: `sepaScore` counts rules that PASSED, `sepaAvailable`
// counts rules that were evaluated (true OR false, not null). The UI
// previously rendered "SEPA 7/8" without distinguishing — so a stock with
// 7 passing + 1 missing-data could read identically to a stock with 7
// passing + 1 failing. Now we expose both numerators so the caller can
// render "7/7 (rule 8 skipped)" vs "7/8" honestly.

function calcSEPA(price, ma50, ma150, ma200, closes, distFromHigh, rsRank) {
  const vsMA200 = ma200 ? (price - ma200) / ma200 * 100 : null;
  const vsMA150 = ma150 ? (price - ma150) / ma150 * 100 : null;
  const vsMA50  = ma50  ? (price - ma50)  / ma50  * 100 : null;

  // Rule 5: 50MA must be above BOTH 150MA and 200MA
  const ma50AboveAll = ma50 && ma150 && ma200 ? (ma50 > ma150 && ma50 > ma200) : null;

  const sepa = {
    aboveMA200:      vsMA200 != null ? vsMA200 > 0 : null,        // 1. Price > 200MA
    aboveMA150:      vsMA150 != null ? vsMA150 > 0 : null,        // 2. Price > 150MA
    ma150AboveMA200: ma150 && ma200 ? ma150 > ma200 : null,       // 3. 150MA > 200MA
    ma200Rising:     (() => {                                     // 4. 200MA trending up 4+ weeks
      // True 200MA from ~4 weeks (20 trading days) ago: average of the 200
      // bars ending 20 bars before today, i.e. closes[n-220 .. n-20].
      // Requires ≥220 bars of history (200 for the MA + 20 for the lag).
      if (!closes || closes.length < 220) return null;
      const ma200_4wAgo = closes.slice(-220, -20).reduce((a, b) => a + b, 0) / 200;
      return ma200 > ma200_4wAgo * 1.001;
    })(),
    ma50AboveAll,                                                 // 5. 50MA > 150MA AND 200MA
    aboveMA50:       vsMA50 != null ? vsMA50 > 0 : null,          // 6. Price > 50MA
    // Rule 7: price ≥ 30% above 52-week low. The variable name reads
    // backwards from the rule semantics ("low30pctBelow" sounds like
    // "low is 30% below" but the actual check is "price is ≥ 30% above
    // the low"). Kept as-is to avoid breaking JSON consumers; if you're
    // reading this and want to rename, sweep scanner.js + any persisted
    // signal_outcomes payloads first. Set by caller — needs w52l.
    low30pctBelow:   null,
    priceNearHigh:   distFromHigh != null ? distFromHigh <= 0.25 : null, // 8. Within 25% of 52w high
  };

  // Score = number of TRUE rules. Available = number of rules that
  // returned a definitive boolean (true OR false). Score-of-record is the
  // pair (sepaScore, sepaAvailable); the legacy `sepaScore` count alone is
  // preserved for any consumer that ignored the available count.
  const sepaScore = Object.values(sepa).filter(v => v === true).length;
  const sepaAvailable = Object.values(sepa).filter(v => v === true || v === false).length;

  return { sepa, sepaScore, sepaAvailable, ma50AboveAll };
}

module.exports = { calcSEPA };
