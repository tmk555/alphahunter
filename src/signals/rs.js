// ─── IBD Relative Strength calculations ──────────────────────────────────────
const { loadHistory, saveHistory, RS_HISTORY } = require('../data/store');

// Real IBD RS: weighted 12-month performance
function calcRS(closes) {
  if (!closes || closes.length < 63) return null;
  const n    = closes.length;
  const now  = closes[n - 1];
  const p3m  = closes[Math.max(0, n - 63)];
  const p6m  = closes[Math.max(0, n - 126)] || p3m;
  const p9m  = closes[Math.max(0, n - 189)] || p6m;
  const p12m = closes[Math.max(0, n - 252)] || p9m;
  return ((now/p3m - 1)*100)*0.40 + ((now/p6m - 1)*100)*0.20
       + ((now/p9m - 1)*100)*0.20 + ((now/p12m- 1)*100)*0.20;
}

// ─── Multi-Timeframe RS ─────────────────────────────────────────────────────
// Same weighted-period formula, but applied to weekly and monthly resampled
// closes. Confirms whether daily strength is also visible on higher timeframes
// — a stock with daily RS 95 + weekly RS 90 + monthly RS 85 is in a true
// multi-timeframe leadership trend. Daily-only strength can be a 1-2 week
// pop that fades. Use rsTimeframeAlignment as a confirmation gate.

// Resample daily closes to weekly: take every 5th trading day from the end
// (~Friday close) so the most recent weekly bar always reflects today.
function resampleWeekly(closes) {
  if (!closes || closes.length === 0) return [];
  const out = [];
  for (let i = closes.length - 1; i >= 0; i -= 5) out.unshift(closes[i]);
  return out;
}

// Resample to monthly (~21 trading days). With 252-day history we get ~12
// monthly bars, which is just enough for the 3/6/9/12 horizon weights.
function resampleMonthly(closes) {
  if (!closes || closes.length === 0) return [];
  const out = [];
  for (let i = closes.length - 1; i >= 0; i -= 21) out.unshift(closes[i]);
  return out;
}

function calcRSWeekly(closes) {
  // Need at least 13 weeks (~65 trading days) for the 3-month leg
  if (!closes || closes.length < 65) return null;
  const w = resampleWeekly(closes);
  if (w.length < 13) return null;
  const n = w.length;
  const now  = w[n - 1];
  const p3m  = w[Math.max(0, n - 13)];
  const p6m  = w[Math.max(0, n - 26)] || p3m;
  const p9m  = w[Math.max(0, n - 39)] || p6m;
  const p12m = w[Math.max(0, n - 52)] || p9m;
  return ((now/p3m - 1)*100)*0.40 + ((now/p6m - 1)*100)*0.20
       + ((now/p9m - 1)*100)*0.20 + ((now/p12m - 1)*100)*0.20;
}

function calcRSMonthly(closes) {
  // Need at least 3 months of data for the shortest leg
  if (!closes || closes.length < 63) return null;
  const m = resampleMonthly(closes);
  if (m.length < 3) return null;
  const n = m.length;
  const now  = m[n - 1];
  const p3m  = m[Math.max(0, n - 3)];
  const p6m  = m[Math.max(0, n - 6)] || p3m;
  const p9m  = m[Math.max(0, n - 9)] || p6m;
  const p12m = m[Math.max(0, n - 12)] || p9m;
  return ((now/p3m - 1)*100)*0.40 + ((now/p6m - 1)*100)*0.20
       + ((now/p9m - 1)*100)*0.20 + ((now/p12m - 1)*100)*0.20;
}

// rankToRS: percentile-rank items by `inKey` and write the integer rank to
// `outKey`. Defaults preserved so existing call sites (rankToRS(items)) keep
// writing rawRS → rsRank. Pass alternate keys for weekly/monthly:
//   rankToRS(items, 'rawRSWeekly', 'rsRankWeekly')
function rankToRS(items, inKey = 'rawRS', outKey = 'rsRank') {
  const valid = items.filter(s => s[inKey] != null);
  valid.sort((a, b) => a[inKey] - b[inKey]);
  valid.forEach((s, i) => { s[outKey] = Math.round((i / Math.max(valid.length-1, 1)) * 98) + 1; });
  items.filter(s => s[inKey] == null).forEach(s => { s[outKey] = 50; });
  return items;
}

// Multi-timeframe alignment: how many of the 3 timeframes show "leader" RS.
// Returns 0-3. A stock with 3/3 alignment has institutional support across
// daily/weekly/monthly horizons; 1/3 is likely a short-term pop.
function getTimeframeAlignment(stock, threshold = 80) {
  let n = 0;
  if ((stock.rsRank        || 0) >= threshold) n++;
  if ((stock.rsRankWeekly  || 0) >= threshold) n++;
  if ((stock.rsRankMonthly || 0) >= threshold) n++;
  return n;
}

// Sector-relative RS rank: percentile within each sector group
// A stock can be #1 in a weak sector even with moderate absolute RS
function rankBySector(items, sectorKey = 'sector', rawKey = 'rawRS', outKey = 'sectorRsRank') {
  const groups = {};
  for (const s of items) {
    const sec = s[sectorKey] || 'Unknown';
    if (!groups[sec]) groups[sec] = [];
    groups[sec].push(s);
  }
  for (const sec of Object.keys(groups)) {
    const group = groups[sec];
    const valid = group.filter(s => s[rawKey] != null);
    valid.sort((a, b) => a[rawKey] - b[rawKey]);
    valid.forEach((s, i) => {
      s[outKey] = Math.round((i / Math.max(valid.length - 1, 1)) * 98) + 1;
    });
    group.filter(s => s[rawKey] == null).forEach(s => { s[outKey] = 50; });
  }
  return items;
}

function getRSTrend(ticker, history) {
  const dates = Object.keys(history).sort();
  if (dates.length < 2) return null;
  const last = dates[dates.length-1];
  const now  = history[last]?.[ticker];
  if (now == null) return null;
  const findAt = (daysAgo) => {
    const t = new Date(last); t.setDate(t.getDate() - daysAgo);
    const tStr = t.toISOString().split('T')[0];
    const before = dates.filter(d => d <= tStr);
    return before.length ? (history[before[before.length-1]]?.[ticker] ?? null) : null;
  };
  const w1 = findAt(7), w2 = findAt(14), w4 = findAt(28), m3 = findAt(90), m2 = findAt(60);
  const dir  = w1 != null ? (now-w1 > 3 ? 'rising' : now-w1 < -3 ? 'falling' : 'flat') : 'new';
  const note = now < 50 && dir === 'rising' ? 'low-RS-rising' : dir;
  return {
    current: now, direction: dir, note,
    vs1w: w1 != null ? +(now-w1).toFixed(0) : null,
    vs2w: w2 != null ? +(now-w2).toFixed(0) : null,
    vs4w: w4 != null ? +(now-w4).toFixed(0) : null,
    vs3m: m3 != null ? +(now-m3).toFixed(0) : null,
    vs1m: w4 != null ? +(now-w4).toFixed(0) : null,  // 4 weeks ≈ 1 month
    vs2m: m2 != null ? +(now-m2).toFixed(0) : null,
  };
}

// Pre-generate RS history from 1-year price data (no extra API calls)
function preGenerateHistoryFor(histMap, keyFn, histType, label, minSnapshots = 3) {
  const history = loadHistory(histType);
  const existingDates = Object.keys(history).length;

  const lastDate = Object.keys(history).sort().pop();
  const lastSnap = lastDate ? (history[lastDate] || {}) : {};
  const missingSymbols = Object.keys(histMap).filter(sym => {
    const k = keyFn(sym);
    return !(k in lastSnap) && histMap[sym]?.length >= 63;
  });

  if (existingDates >= minSnapshots && missingSymbols.length === 0) return;

  if (missingSymbols.length > 0) {
    console.log(`  Backfilling ${label} RS history for ${missingSymbols.length} new symbols: ${missingSymbols.slice(0,5).join(', ')}...`);
  } else {
    console.log(`  Pre-generating ${label} RS history from 1-year price data...`);
  }
  const today = new Date();

  for (let weeksBack = 13; weeksBack >= 0; weeksBack--) {
    const snapDate = new Date(today);
    snapDate.setDate(snapDate.getDate() - weeksBack * 7);
    const dateStr = snapDate.toISOString().split('T')[0];
    if (history[dateStr]) continue;

    const daysBack  = weeksBack * 5;
    const tempItems = [];

    for (const sym of Object.keys(histMap)) {
      const closes = histMap[sym];
      if (!closes || closes.length < 63) continue;
      const truncated = closes.slice(0, Math.max(63, closes.length - daysBack));
      tempItems.push({ ticker: sym, rawRS: calcRS(truncated) });
    }

    rankToRS(tempItems);
    const snap = {};
    for (const item of tempItems) snap[keyFn(item.ticker)] = item.rsRank;
    saveHistory(histType, snap, dateStr);
  }
  console.log(`  ✓ ${label} RS history pre-generated (13 weekly snapshots)`);
}

module.exports = {
  calcRS, calcRSWeekly, calcRSMonthly,
  resampleWeekly, resampleMonthly,
  rankToRS, rankBySector, getRSTrend, preGenerateHistoryFor,
  getTimeframeAlignment,
};
