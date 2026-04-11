// ─── Built-in Job Types for Alpha Hunter ────────────────────────────────────
// Each job type has a handler function and default config
const { registerJobType } = require('./engine');
const { getDB }           = require('../data/database');
const { yahooQuote }      = require('../data/providers/yahoo');
const { cacheClear }      = require('../data/cache');

function db() { return getDB(); }

// US market date (Eastern timezone) — avoids writing tomorrow's date when
// running after midnight UTC (8 PM ET during EDT).
function marketDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── 1. RS Scan — Daily universe scan, persist snapshots ────────────────────

let _runScan = null;

function setRunScan(fn) { _runScan = fn; }

registerJobType('rs_scan', {
  description: 'Run full RS scan across universe and persist snapshots to SQLite',
  defaultConfig: { persist: true },
  handler: async (config) => {
    if (!_runScan) throw new Error('Scanner not initialized — call setRunScan() at startup');
    // Clear cache so snapshot prices reflect the latest quotes, not stale cached data
    cacheClear();
    const results = await _runScan();
    const date = marketDate();

    if (config.persist !== false) {
      const insert = db().prepare(`
        INSERT OR REPLACE INTO rs_snapshots (
          date, symbol, type, rs_rank, swing_momentum, sepa_score, stage,
          price, vs_ma50, vs_ma200, volume_ratio, vcp_forming, rs_line_new_high, atr_pct,
          rs_rank_weekly, rs_rank_monthly, rs_tf_alignment, up_down_ratio_50, accumulation_50
        )
        VALUES (?, ?, 'stock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const txn = db().transaction(() => {
        let count = 0;
        for (const r of results) {
          insert.run(date, r.ticker, r.rsRank ?? null, r.swingMomentum ?? null, r.sepaScore ?? null, r.stage ?? null,
            r.price ?? null, r.vsMA50 ?? null, r.vsMA200 ?? null, r.volumeRatio ?? null,
            r.vcpForming ? 1 : 0, r.rsLineNewHigh ? 1 : 0, r.atrPct ?? null,
            r.rsRankWeekly ?? null, r.rsRankMonthly ?? null, r.rsTimeframeAlignment ?? null,
            r.volumeProfile?.upDownRatio50 ?? null, r.volumeProfile?.accumulation50 ?? null);
          count++;
        }
        return count;
      });
      const count = txn();
      return { date, scanned: results.length, persisted: count };
    }

    return { date, scanned: results.length, persisted: 0 };
  },
});

// ─── 2. Stop Monitor — Check alerts against current prices ──────────────────

registerJobType('stop_monitor', {
  description: 'Check active alert subscriptions against current prices (stop monitoring)',
  defaultConfig: { marketHoursOnly: true },
  handler: async (config) => {
    const { checkPositionsAgainstStops } = require('../broker/monitor');
    await checkPositionsAgainstStops();
    return { checked: true };
  },
});

// ─── 3. Stale Order Cleanup — Expire old staged orders ──────────────────────

registerJobType('expire_stale_orders', {
  description: 'Expire staged orders older than configured hours',
  defaultConfig: { maxAgeHours: 24 },
  handler: async (config) => {
    const { expireStaleOrders } = require('../broker/staging');
    const expired = expireStaleOrders(config.maxAgeHours);
    return { expired: expired || 0 };
  },
});

// ─── 4. Watchlist Price Snapshot — Grab prices for watchlist symbols ─────────

registerJobType('watchlist_snapshot', {
  description: 'Fetch current prices for all watchlist symbols and log to history',
  defaultConfig: {},
  handler: async () => {
    const fs = require('fs');
    const path = require('path');
    const wlPath = path.join(__dirname, '..', '..', 'data', 'watchlist.json');

    let symbols = [];
    // Try DB watchlist first, fall back to JSON
    try {
      const rows = db().prepare("SELECT symbol FROM alert_subscriptions WHERE active = 1 GROUP BY symbol").all();
      symbols = rows.map(r => r.symbol);
    } catch (_) {}

    if (!symbols.length && fs.existsSync(wlPath)) {
      try {
        const wl = JSON.parse(fs.readFileSync(wlPath, 'utf8'));
        symbols = Array.isArray(wl) ? wl.map(w => w.symbol || w) : [];
      } catch (_) {}
    }

    if (!symbols.length) return { message: 'No watchlist symbols found', count: 0 };

    const quotes = await yahooQuote(symbols);
    const prices = {};
    for (const q of quotes) {
      if (q.regularMarketPrice) prices[q.symbol] = q.regularMarketPrice;
    }

    return { count: Object.keys(prices).length, prices };
  },
});

// ─── 5. Portfolio Reconciliation — Sync local trades with broker ────────────

registerJobType('portfolio_reconcile', {
  description: 'Reconcile local trade journal with Alpaca broker positions',
  defaultConfig: {},
  handler: async () => {
    const { reconcilePositions } = require('../broker/monitor');
    return await reconcilePositions();
  },
});

// ─── 6. RS History Cleanup — Prune old snapshots ────────────────────────────

registerJobType('rs_history_cleanup', {
  description: 'Remove RS snapshots older than configured days to keep database lean',
  defaultConfig: { keepDays: 365 },
  handler: async (config) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (config.keepDays || 365));
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const result = db().prepare('DELETE FROM rs_snapshots WHERE date < ?').run(cutoffStr);
    return { deletedBefore: cutoffStr, rowsRemoved: result.changes };
  },
});

// ─── 7. Job History Cleanup — Prune old execution logs ──────────────────────

registerJobType('job_history_cleanup', {
  description: 'Remove job execution history older than configured days',
  defaultConfig: { keepDays: 30 },
  handler: async (config) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (config.keepDays || 30));
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const result = db().prepare("DELETE FROM job_history WHERE started_at < ?").run(cutoffStr);
    return { deletedBefore: cutoffStr, rowsRemoved: result.changes };
  },
});

module.exports = { setRunScan };
