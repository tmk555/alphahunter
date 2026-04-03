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

function rankToRS(items, key = 'rawRS') {
  const valid = items.filter(s => s[key] != null);
  valid.sort((a, b) => a[key] - b[key]);
  valid.forEach((s, i) => { s.rsRank = Math.round((i / Math.max(valid.length-1, 1)) * 98) + 1; });
  items.filter(s => s[key] == null).forEach(s => { s.rsRank = 50; });
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
    vs1m: w4 != null ? +(now-w4).toFixed(0) : null,
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

module.exports = { calcRS, rankToRS, getRSTrend, preGenerateHistoryFor };
