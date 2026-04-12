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
      // INSERT OR IGNORE: don't overwrite backfill-generated snapshots that
      // have verified OHLCV close prices with live/cached intraday quotes.
      // Then UPDATE any rows where price is still NULL — fills gaps from
      // partial/crashed runs without clobbering verified backfill closes.
      const insert = db().prepare(`
        INSERT OR IGNORE INTO rs_snapshots (
          date, symbol, type, rs_rank, swing_momentum, sepa_score, stage,
          price, vs_ma50, vs_ma200, volume_ratio, vcp_forming, rs_line_new_high, atr_pct,
          rs_rank_weekly, rs_rank_monthly, rs_tf_alignment, up_down_ratio_50, accumulation_50
        )
        VALUES (?, ?, 'stock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateNull = db().prepare(`
        UPDATE rs_snapshots
        SET price = ?, rs_rank = COALESCE(rs_rank, ?), swing_momentum = COALESCE(swing_momentum, ?),
            sepa_score = COALESCE(sepa_score, ?), stage = COALESCE(stage, ?),
            vs_ma50 = COALESCE(vs_ma50, ?), vs_ma200 = COALESCE(vs_ma200, ?),
            volume_ratio = COALESCE(volume_ratio, ?), vcp_forming = COALESCE(vcp_forming, ?),
            rs_line_new_high = COALESCE(rs_line_new_high, ?), atr_pct = COALESCE(atr_pct, ?)
        WHERE date = ? AND symbol = ? AND type = 'stock' AND price IS NULL
      `);
      const txn = db().transaction(() => {
        let count = 0;
        for (const r of results) {
          insert.run(date, r.ticker, r.rsRank ?? null, r.swingMomentum ?? null, r.sepaScore ?? null, r.stage ?? null,
            r.price ?? null, r.vsMA50 ?? null, r.vsMA200 ?? null, r.volumeRatio ?? null,
            r.vcpForming ? 1 : 0, r.rsLineNewHigh ? 1 : 0, r.atrPct ?? null,
            r.rsRankWeekly ?? null, r.rsRankMonthly ?? null, r.rsTimeframeAlignment ?? null,
            r.volumeProfile?.upDownRatio50 ?? null, r.volumeProfile?.accumulation50 ?? null);
          // Fill NULL prices on existing rows (from partial/crashed prior runs)
          if (r.price != null) {
            updateNull.run(r.price, r.rsRank ?? null, r.swingMomentum ?? null,
              r.sepaScore ?? null, r.stage ?? null,
              r.vsMA50 ?? null, r.vsMA200 ?? null,
              r.volumeRatio ?? null, r.vcpForming ? 1 : 0,
              r.rsLineNewHigh ? 1 : 0, r.atrPct ?? null,
              date, r.ticker);
          }
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

// ─── 8. Universe Reconstitution — Quarterly automated screener ─────────────
// Screens the current universe for stocks that no longer meet inclusion criteria
// (mkt cap < $2B, avg vol < 300K) and flags them for removal. Also identifies
// new candidates from existing sector ETF holdings that meet criteria.

registerJobType('universe_reconstitute', {
  description: 'Quarterly universe reconstitution — screen for additions/removals based on liquidity and market cap criteria',
  defaultConfig: {
    minMarketCap: 2e9,       // $2B minimum
    minAvgVolume: 300000,    // 300K shares/day minimum
    dryRun: true,            // Preview changes without applying
  },
  handler: async (config) => {
    const { FULL_UNIVERSE }   = require('../../universe');
    const symbols = Object.keys(FULL_UNIVERSE).filter(s => FULL_UNIVERSE[s] !== 'Hedge');
    const { yahooQuote } = require('../data/providers/yahoo');

    const removals = [];
    const retentions = [];

    // Screen existing universe in batches
    for (let i = 0; i < symbols.length; i += 20) {
      const batch = symbols.slice(i, i + 20);
      let quotes;
      try { quotes = await yahooQuote(batch); } catch (_) { continue; }
      for (const q of quotes) {
        const mktCap = q.marketCap || 0;
        const avgVol = q.averageDailyVolume3Month || 0;
        const failsCap = mktCap < config.minMarketCap;
        const failsVol = avgVol < config.minAvgVolume;
        if (failsCap || failsVol) {
          const reasons = [];
          if (failsCap) reasons.push(`mktCap $${(mktCap/1e9).toFixed(1)}B < $${(config.minMarketCap/1e9).toFixed(0)}B`);
          if (failsVol) reasons.push(`avgVol ${Math.round(avgVol/1000)}K < ${Math.round(config.minAvgVolume/1000)}K`);
          removals.push({ symbol: q.symbol, sector: FULL_UNIVERSE[q.symbol], reason: reasons.join(', '), mktCap, avgVol });
        } else {
          retentions.push(q.symbol);
        }
      }
    }

    // Persist removals to universe_mgmt (if not dry run)
    const date = marketDate();
    if (!config.dryRun && removals.length) {
      const upsert = db().prepare(`
        INSERT INTO universe_mgmt (symbol, sector, removed_date, reason, source)
        VALUES (?, ?, ?, ?, 'auto_reconstitute')
        ON CONFLICT(symbol) DO UPDATE SET removed_date = ?, reason = ?
      `);
      const txn = db().transaction(() => {
        for (const r of removals) {
          upsert.run(r.symbol, r.sector, date, r.reason, date, r.reason);
        }
      });
      txn();
    }

    return {
      date,
      dryRun: config.dryRun,
      screened: symbols.length,
      passing: retentions.length,
      flaggedForRemoval: removals.length,
      removals: removals.slice(0, 50), // Cap response size
      note: config.dryRun
        ? 'Dry run — set dryRun: false to persist removals to universe_mgmt'
        : `Applied ${removals.length} removals to universe_mgmt`,
    };
  },
});

module.exports = { setRunScan };
