// ─── Portfolio Alpha Tracking Engine ─────────────────────────────────────────
// Time-weighted returns, rolling Sharpe/Sortino, SPY-relative equity curve,
// max drawdown duration. Answers: "Am I actually generating alpha?"
const { getDB } = require('../data/database');

function db() { return getDB(); }

function marketDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Same trading-day check we use in scanner.js — keeps weekend rows out of
// equity_snapshots. Pre-fix the user clicked "Record Snapshot" on a Saturday
// and it stored a row with date=2026-04-25 that duplicated Friday's
// $101,214.77 (markets were closed, so equity hadn't moved). That weekend
// row then polluted TWR/drawdown/Sharpe inputs as a "real" data point.
function isTradingDay(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return true; // fail-open
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6;
}

// ─── Time-Weighted Return (TWR) ─────────────────────────────────────────────
// Sub-period linking: eliminates the effect of deposits/withdrawals.
// Each sub-period ends at a cash flow event; the overall return is the
// geometric product of sub-period returns.

function calculateTWR(snapshots) {
  if (!snapshots?.length || snapshots.length < 2) {
    return { twr: 0, annualized: 0, periods: 0, subPeriodReturns: [] };
  }

  const subPeriodReturns = [];
  let periodStart = 0;

  for (let i = 1; i < snapshots.length; i++) {
    const prevEquity = snapshots[i - 1].equity;
    const currEquity = snapshots[i].equity;
    const cashFlow = snapshots[i].cash_flow || 0;

    // Sub-period return: (end - cashFlow) / start - 1
    // cashFlow adjusts for deposits/withdrawals during the period
    const adjustedEnd = currEquity - cashFlow;
    if (prevEquity > 0) {
      const subReturn = (adjustedEnd / prevEquity) - 1;
      subPeriodReturns.push({ date: snapshots[i].date, return: +subReturn.toFixed(6) });
    }

    // Start new sub-period at each cash flow event
    if (Math.abs(cashFlow) > 0) periodStart = i;
  }

  // Geometric linking
  const twr = subPeriodReturns.reduce((product, sp) => product * (1 + sp.return), 1) - 1;

  // Annualize
  const tradingDays = snapshots.length - 1;
  const years = tradingDays / 252;
  const annualized = years > 0 ? Math.pow(1 + twr, 1 / years) - 1 : twr;

  return {
    twr: +(twr * 100).toFixed(2),
    annualized: +(annualized * 100).toFixed(2),
    periods: subPeriodReturns.length,
    subPeriodReturns: subPeriodReturns.slice(-30), // Last 30 for chart
  };
}

// ─── Rolling Sharpe Ratio ───────────────────────────────────────────────────
// (mean_return - risk_free_rate) / std_dev * sqrt(252)

function calculateRollingSharpe(snapshots, windowDays = 30, riskFreeRate = 0.05) {
  if (!snapshots?.length || snapshots.length < windowDays + 1) return [];

  const dailyRf = riskFreeRate / 252;
  const results = [];

  for (let i = windowDays; i < snapshots.length; i++) {
    const window = snapshots.slice(i - windowDays, i + 1);
    const returns = [];
    for (let j = 1; j < window.length; j++) {
      if (window[j - 1].equity > 0) {
        returns.push(window[j].equity / window[j - 1].equity - 1);
      }
    }

    if (returns.length < 10) continue;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);

    const sharpe = std > 0 ? ((mean - dailyRf) / std) * Math.sqrt(252) : 0;
    results.push({
      date: snapshots[i].date,
      sharpe: +sharpe.toFixed(2),
    });
  }

  return results;
}

// ─── Rolling Sortino Ratio ──────────────────────────────────────────────────
// Like Sharpe but only penalizes downside deviation (returns below target)

function calculateRollingSortino(snapshots, windowDays = 30, riskFreeRate = 0.05) {
  if (!snapshots?.length || snapshots.length < windowDays + 1) return [];

  const dailyRf = riskFreeRate / 252;
  const results = [];

  for (let i = windowDays; i < snapshots.length; i++) {
    const window = snapshots.slice(i - windowDays, i + 1);
    const returns = [];
    for (let j = 1; j < window.length; j++) {
      if (window[j - 1].equity > 0) {
        returns.push(window[j].equity / window[j - 1].equity - 1);
      }
    }

    if (returns.length < 10) continue;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const downside = returns.filter(r => r < 0);
    const downsideVariance = downside.length > 0
      ? downside.reduce((a, r) => a + r ** 2, 0) / downside.length
      : 0;
    const downsideDev = Math.sqrt(downsideVariance);

    const sortino = downsideDev > 0 ? ((mean - dailyRf) / downsideDev) * Math.sqrt(252) : 0;
    results.push({
      date: snapshots[i].date,
      sortino: +sortino.toFixed(2),
    });
  }

  return results;
}

// ─── SPY-Relative Equity Curve ──────────────────────────────────────────────

function calculateSPYRelativeCurve(snapshots) {
  if (!snapshots?.length || snapshots.length < 2) return [];

  // Filter to snapshots with both equity and spy_close
  const valid = snapshots.filter(s => s.equity > 0 && s.spy_close > 0);
  if (valid.length < 2) return [];

  const results = [];
  let cumulativeAlpha = 0;

  for (let i = 1; i < valid.length; i++) {
    const portfolioReturn = (valid[i].equity / valid[i - 1].equity) - 1;
    const spyReturn = (valid[i].spy_close / valid[i - 1].spy_close) - 1;
    const dailyAlpha = portfolioReturn - spyReturn;
    cumulativeAlpha += dailyAlpha;

    results.push({
      date: valid[i].date,
      portfolioReturn: +(portfolioReturn * 100).toFixed(3),
      spyReturn: +(spyReturn * 100).toFixed(3),
      dailyAlpha: +(dailyAlpha * 100).toFixed(3),
      cumulativeAlpha: +(cumulativeAlpha * 100).toFixed(2),
    });
  }

  return results;
}

// ─── Max Drawdown Duration ──────────────────────────────────────────────────

function calculateMaxDrawdownDuration(snapshots) {
  if (!snapshots?.length) {
    return { maxDrawdownPct: 0, maxDrawdownDuration: 0, currentDrawdownPct: 0, currentDrawdownDays: 0 };
  }

  let peak = snapshots[0].equity;
  let peakDate = snapshots[0].date;
  let maxDD = 0, maxDDDuration = 0;
  let maxDDPeakDate = null, maxDDTroughDate = null, maxDDRecoveryDate = null;

  let currentDDStart = null;
  let currentDDDays = 0;
  let trough = peak, troughDate = peakDate;

  for (let i = 0; i < snapshots.length; i++) {
    const eq = snapshots[i].equity;
    const dt = snapshots[i].date;

    if (eq >= peak) {
      // New high — check if we were in a drawdown
      if (currentDDStart && currentDDDays > maxDDDuration) {
        maxDDDuration = currentDDDays;
        maxDDRecoveryDate = dt;
      }
      peak = eq;
      peakDate = dt;
      currentDDStart = null;
      currentDDDays = 0;
      trough = peak;
      troughDate = dt;
    } else {
      // In drawdown
      if (!currentDDStart) currentDDStart = dt;
      currentDDDays++;

      const dd = ((peak - eq) / peak) * 100;
      if (dd > maxDD) {
        maxDD = dd;
        maxDDPeakDate = peakDate;
      }
      if (eq < trough) {
        trough = eq;
        troughDate = dt;
        maxDDTroughDate = dt;
      }
    }
  }

  // Current drawdown state
  const lastEquity = snapshots[snapshots.length - 1].equity;
  const currentDD = peak > 0 ? ((peak - lastEquity) / peak) * 100 : 0;

  return {
    maxDrawdownPct: +maxDD.toFixed(2),
    maxDrawdownDuration: maxDDDuration,
    currentDrawdownPct: +currentDD.toFixed(2),
    currentDrawdownDays: currentDDDays,
    peakDate: maxDDPeakDate,
    troughDate: maxDDTroughDate,
    recoveryDate: maxDDRecoveryDate,
    currentPeak: +peak.toFixed(2),
    currentPeakDate: peakDate,
  };
}

// ─── Record Daily Equity Snapshot ────────────────────────────────────────────

// Last US-equity trading day on or before the given date (server local).
// Saturday/Sunday roll back to Friday; trading day passes through. Does NOT
// account for market holidays — same scope decision as scanner.js / catchup.
function lastTradingDayOnOrBefore(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const d = new Date(dateStr + 'T12:00:00Z');
  let dow = d.getUTCDay();
  while (dow === 0 || dow === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
    dow = d.getUTCDay();
  }
  return d.toISOString().slice(0, 10);
}

function recordEquitySnapshot(equity, cashFlow = 0, spyClose = null, openPositions = 0, heatPct = 0, opts = {}) {
  // Date selection rules:
  //   • Default: today's NY-time date (marketDate()), then guard against
  //     Sat/Sun via isTradingDay (skipped, no row written).
  //   • opts.dateOverride: caller specifies the date — used by the weekly
  //     safety-net cron to record a Friday-dated row when it fires on a
  //     Sunday. Skips the trading-day guard since the override is already
  //     a trading day by construction (lastTradingDayOnOrBefore).
  //   • opts.force: bypass the trading-day guard for backfill scripts that
  //     intentionally need a weekend-dated row.
  const date = opts.dateOverride || marketDate();
  if (!opts.force && !opts.dateOverride && !isTradingDay(date)) {
    return { skipped: true, reason: 'non-trading-day', date };
  }
  db().prepare(`
    INSERT OR REPLACE INTO equity_snapshots (date, equity, cash_flow, spy_close, open_positions, total_heat_pct)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(date, equity, cashFlow, spyClose, openPositions, heatPct);
  return { date, equity, cashFlow, spyClose, openPositions, heatPct };
}

// ─── Query Equity Snapshots ──────────────────────────────────────────────────

function getEquitySnapshots(startDate, endDate) {
  let query = 'SELECT * FROM equity_snapshots';
  const params = [];
  const conditions = [];

  if (startDate) { conditions.push('date >= ?'); params.push(startDate); }
  if (endDate) { conditions.push('date <= ?'); params.push(endDate); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY date ASC';

  return db().prepare(query).all(...params);
}

// ─── Period Return Helper ────────────────────────────────────────────────────

function computePeriodReturn(snapshots, days) {
  if (!snapshots?.length || snapshots.length < 2) return null;
  const end = snapshots[snapshots.length - 1];
  const startIdx = Math.max(0, snapshots.length - 1 - days);
  const start = snapshots[startIdx];
  if (!start.equity || start.equity === 0) return null;
  return +((end.equity / start.equity - 1) * 100).toFixed(2);
}

// ─── Full Alpha Report ──────────────────────────────────────────────────────

function generateAlphaReport(windowDays = 30) {
  const snapshots = getEquitySnapshots();

  if (!snapshots.length) {
    return {
      error: 'No equity snapshots. Run the equity_snapshot scheduled job or POST /api/portfolio/equity-snapshot.',
      snapshotCount: 0,
    };
  }

  const twr = calculateTWR(snapshots);
  const sharpeRolling = calculateRollingSharpe(snapshots, windowDays);
  const sortinoRolling = calculateRollingSortino(snapshots, windowDays);
  const spyRelative = calculateSPYRelativeCurve(snapshots);
  const drawdown = calculateMaxDrawdownDuration(snapshots);

  const currentSharpe = sharpeRolling.length ? sharpeRolling[sharpeRolling.length - 1].sharpe : null;
  const currentSortino = sortinoRolling.length ? sortinoRolling[sortinoRolling.length - 1].sortino : null;

  return {
    twr: {
      total: twr.twr,
      annualized: twr.annualized,
    },
    sharpe: {
      current: currentSharpe,
      window: windowDays,
      rolling: sharpeRolling.slice(-60), // Last 60 data points for chart
    },
    sortino: {
      current: currentSortino,
      window: windowDays,
      rolling: sortinoRolling.slice(-60),
    },
    spyRelative: {
      totalAlpha: spyRelative.length ? spyRelative[spyRelative.length - 1].cumulativeAlpha : 0,
      curve: spyRelative.slice(-60),
    },
    drawdown,
    periodReturns: {
      '1w': computePeriodReturn(snapshots, 5),
      '1m': computePeriodReturn(snapshots, 21),
      '3m': computePeriodReturn(snapshots, 63),
      '6m': computePeriodReturn(snapshots, 126),
      '1y': computePeriodReturn(snapshots, 252),
      ytd: computePeriodReturn(snapshots, _daysSinceYearStart()),
      mtd: computePeriodReturn(snapshots, new Date().getDate()),
    },
    snapshotCount: snapshots.length,
    firstDate: snapshots[0].date,
    lastDate: snapshots[snapshots.length - 1].date,
  };
}

function _daysSinceYearStart() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return Math.floor((now - start) / (1000 * 60 * 60 * 24));
}

// ─── Stale-SPY auto-correct ────────────────────────────────────────────
// Find equity_snapshot rows whose spy_close exactly matches the previous
// trading day's spy_close (a fingerprint of a stale Yahoo quote — happens
// when the snapshot was recorded pre-market or via the weekend safety-net
// before the daily-path stale-SPY guard existed). For each such row,
// re-fetch SPY's actual settled close from getHistoryFull (which returns
// real OHLC bars, not the live quote) and update the row in-place.
//
// This is destructive-ish (overwrites spy_close), so we:
//   - Only update when the historical close actually DIFFERS from the
//     stale value (so a coincidental flat day stays as-is).
//   - Log every correction with before/after values for audit.
//   - Skip rows whose date is the most recent snapshot — the live cron
//     hasn't had a chance to overwrite it yet.
//
// Returns { scanned, corrected: [{date, before, after}], failed: [{date, error}] }.
async function correctStaleSpyRows() {
  const { getHistoryFull } = require('../data/providers/manager');

  const rows = getDB().prepare(
    'SELECT date, spy_close FROM equity_snapshots ORDER BY date'
  ).all();

  // Find adjacent-day spy_close ties — the stale fingerprint.
  const stale = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].spy_close;
    const b = rows[i].spy_close;
    if (a != null && b != null && Math.abs(a - b) < 1e-4) {
      stale.push({ date: rows[i].date, prevDate: rows[i - 1].date, currentSpy: b });
    }
  }

  // Skip the very last row — if it's stale, the next live cron will fix it.
  // Re-fetching it from history before settlement risks overwriting with
  // an incomplete bar.
  const lastDate = rows.length ? rows[rows.length - 1].date : null;
  const fixable = stale.filter(s => s.date !== lastDate);

  if (fixable.length === 0) {
    return { scanned: rows.length, staleFound: stale.length, corrected: [], failed: [], skippedLastRow: stale.length - fixable.length };
  }

  // One history fetch covers all dates. Pull at least 60 bars so the deepest
  // stale row is in range — minBars is a hint, not a hard cap.
  let bars;
  try {
    bars = await getHistoryFull('SPY', { minBars: Math.max(60, fixable.length + 30) });
  } catch (e) {
    return { scanned: rows.length, staleFound: stale.length, corrected: [], failed: fixable.map(s => ({ date: s.date, error: `history fetch failed: ${e.message}` })) };
  }
  if (!Array.isArray(bars) || bars.length === 0) {
    return { scanned: rows.length, staleFound: stale.length, corrected: [], failed: fixable.map(s => ({ date: s.date, error: 'no history bars returned' })) };
  }

  // Index by ISO date string for O(1) lookup.
  const byDate = {};
  for (const b of bars) {
    const d = (b.date || '').slice(0, 10);
    if (d && b.close != null) byDate[d] = b.close;
  }

  const update = getDB().prepare('UPDATE equity_snapshots SET spy_close = ? WHERE date = ?');
  const corrected = [];
  const failed = [];
  for (const s of fixable) {
    const real = byDate[s.date];
    if (real == null) {
      failed.push({ date: s.date, error: `no historical bar for ${s.date}` });
      continue;
    }
    if (Math.abs(real - s.currentSpy) < 1e-4) {
      // Coincidence — actual close matches the prior day too. Leave as-is.
      continue;
    }
    update.run(real, s.date);
    corrected.push({ date: s.date, before: s.currentSpy, after: real });
  }

  return { scanned: rows.length, staleFound: stale.length, corrected, failed, skippedLastRow: stale.length - fixable.length };
}

module.exports = {
  calculateTWR,
  calculateRollingSharpe,
  calculateRollingSortino,
  calculateSPYRelativeCurve,
  calculateMaxDrawdownDuration,
  recordEquitySnapshot,
  getEquitySnapshots,
  computePeriodReturn,
  generateAlphaReport,
  // Helpers used by the equity_snapshot job's safety_weekly mode
  isTradingDay,
  lastTradingDayOnOrBefore,
  correctStaleSpyRows,
};
