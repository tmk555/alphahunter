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

// ─── 9. Pullback Watch — Auto-create alerts for pending pullback stocks ────
// After each RS scan, identifies stocks with strong RS + structure that are
// 5-20% above their 50MA.  Creates a price_below alert at the 5% threshold
// so the trader gets notified when the stock pulls back into the entry zone.

registerJobType('pullback_watch', {
  description: 'Create pullback entry alerts for stocks approaching 50MA support',
  defaultConfig: {},
  handler: async () => {
    const { createAlert, getActiveAlerts, deactivateAlert } = require('../broker/alerts');

    // Get latest RS snapshot data
    const latestDate = db().prepare(
      "SELECT MAX(date) as date FROM rs_snapshots WHERE type = 'stock'"
    ).get()?.date;
    if (!latestDate) return { message: 'No snapshot data', created: 0 };

    const snapshots = db().prepare(`
      SELECT symbol, price, rs_rank, swing_momentum, sepa_score, stage,
             vs_ma50, vs_ma200, volume_ratio, vcp_forming
      FROM rs_snapshots
      WHERE date = ? AND type = 'stock' AND price > 0
    `).all(latestDate);

    // Apply the same pending-pullback filter as the UI
    const candidates = snapshots.filter(s =>
      s.rs_rank >= 70 &&
      s.vs_ma200 > 0 &&
      s.vs_ma50 > 5 && s.vs_ma50 <= 20 &&
      (s.sepa_score >= 4 || s.vcp_forming || s.stage === 2)
    );

    // Get existing pullback alerts to avoid duplicates
    const existing = getActiveAlerts().filter(a => a.alert_type === 'pullback_entry');
    const existingSymbols = new Set(existing.map(a => a.symbol));

    // Deactivate alerts for stocks no longer qualifying
    const candidateSymbols = new Set(candidates.map(c => c.symbol));
    let deactivated = 0;
    for (const alert of existing) {
      if (!candidateSymbols.has(alert.symbol)) {
        deactivateAlert(alert.id);
        deactivated++;
      }
    }

    // Create alerts for new candidates
    let created = 0;
    for (const s of candidates) {
      if (existingSymbols.has(s.symbol)) continue;

      // Trigger price = 5% above 50MA (the entry zone threshold)
      const ma50 = s.price / (1 + s.vs_ma50 / 100);
      const triggerPrice = +(ma50 * 1.05).toFixed(2);

      createAlert({
        symbol: s.symbol,
        alert_type: 'pullback_entry',
        trigger_price: triggerPrice,
        direction: 'below',
        message: `PULLBACK ENTRY: ${s.symbol} near 50MA zone ($${ma50.toFixed(2)}) — RS ${s.rs_rank}, SEPA ${s.sepa_score}/8`,
      });
      created++;
    }

    return { date: latestDate, candidates: candidates.length, created, deactivated, existing: existingSymbols.size };
  },
});

// ─── 10. Equity Snapshot — Daily portfolio alpha tracking ──────────────────

registerJobType('equity_snapshot', {
  description: 'Record daily equity snapshot for portfolio alpha tracking (TWR, Sharpe, SPY-relative)',
  defaultConfig: {},
  handler: async () => {
    const { recordEquitySnapshot } = require('../risk/alpha-tracker');
    const alpaca = require('../broker/alpaca');

    let equity, cashFlow = 0, spyClose, openPositions = 0, heatPct = 0;

    // Get equity from broker (or portfolio_state fallback)
    const { configured } = alpaca.getConfig();
    if (configured) {
      try {
        const account = await alpaca.getAccount();
        equity = +account.equity;
        const positions = await alpaca.getPositions();
        openPositions = positions.length;
      } catch (_) {}
    }

    // Fallback to portfolio_state
    if (!equity) {
      try {
        const row = db().prepare("SELECT value FROM portfolio_state WHERE key = 'account_size'").get();
        equity = row ? +row.value : null;
      } catch (_) {}
    }
    if (!equity) return { error: 'No equity data — configure Alpaca or set account_size' };

    // Get SPY close
    try {
      const quotes = await yahooQuote(['SPY']);
      spyClose = quotes[0]?.regularMarketPrice;
    } catch (_) {}

    // Get portfolio heat
    try {
      const heatRow = db().prepare("SELECT value FROM portfolio_state WHERE key = 'current_heat'").get();
      heatPct = heatRow ? +heatRow.value : 0;
    } catch (_) {}

    const snapshot = recordEquitySnapshot(equity, cashFlow, spyClose, openPositions, heatPct);
    return { date: snapshot.date, equity, spyClose, openPositions, heatPct };
  },
});

// ─── 11. Conditional Entry Check — Monitor pullback/breakout entries ───────

registerJobType('conditional_entry_check', {
  description: 'Check conditional entries against current prices and auto-stage triggered orders',
  defaultConfig: {},
  handler: async () => {
    try {
      const { checkConditionalEntries, expireOldEntries } = require('../broker/auto-stage');

      // Get current prices for conditional entry symbols
      const pending = db().prepare(
        "SELECT DISTINCT symbol FROM conditional_entries WHERE status = 'pending'"
      ).all();
      if (!pending.length) return { checked: 0, triggered: 0, expired: 0 };

      const symbols = pending.map(r => r.symbol);
      const quotes = await yahooQuote(symbols);
      const currentPrices = {};
      for (const q of quotes) {
        if (q.regularMarketPrice) currentPrices[q.symbol] = q.regularMarketPrice;
      }

      const { triggered, expired: expiredByPrice } = await checkConditionalEntries(currentPrices);
      const expiredByTime = expireOldEntries();

      return {
        checked: symbols.length,
        triggered: triggered.length,
        triggeredSymbols: triggered.map(t => t.symbol),
        expired: (expiredByPrice?.length || 0) + expiredByTime,
      };
    } catch (e) {
      return { error: e.message };
    }
  },
});

// ─── 12. Scale-In Check — Monitor active scale-in plans ────────────────────

registerJobType('scale_in_check', {
  description: 'Check active scale-in plans and trigger next tranche when conditions are met',
  defaultConfig: {},
  handler: async () => {
    try {
      const { checkAllActivePlans } = require('../risk/scale-in');

      // Get current prices for all active plan symbols
      const plans = db().prepare(
        "SELECT DISTINCT symbol FROM scale_in_plans WHERE status = 'active'"
      ).all();
      if (!plans.length) return { checked: 0, triggered: 0 };

      const symbols = plans.map(r => r.symbol);
      const quotes = await yahooQuote(symbols);
      const currentPrices = {};
      for (const q of quotes) {
        if (q.regularMarketPrice) currentPrices[q.symbol] = q.regularMarketPrice;
      }

      // Build scan data from latest snapshots for trigger evaluation
      const scanData = {};
      const latestDate = db().prepare(
        "SELECT MAX(date) as date FROM rs_snapshots WHERE type = 'stock'"
      ).get()?.date;
      if (latestDate) {
        const snapshots = db().prepare(
          "SELECT symbol, rs_rank, swing_momentum, volume_ratio FROM rs_snapshots WHERE date = ? AND type = 'stock'"
        ).all(latestDate);
        for (const s of snapshots) scanData[s.symbol] = s;
      }

      const result = await checkAllActivePlans(currentPrices, scanData);
      return result;
    } catch (e) {
      return { error: e.message };
    }
  },
});

// ─── Equity Snapshot — Automated daily portfolio equity recording ──────────
// Records portfolio equity for alpha tracking (TWR, Sharpe, Sortino, SPY Alpha).
// Calculates equity from account size + open position P&L, fetches SPY for benchmark.

registerJobType('equity_snapshot', {
  description: 'Record daily portfolio equity snapshot for alpha performance tracking (TWR, Sharpe, Sortino)',
  defaultConfig: {},
  handler: async () => {
    const { recordEquitySnapshot } = require('../risk/alpha-tracker');
    const { getConfig, getPortfolioHeat } = require('../risk/portfolio');
    const { getQuotes } = require('../data/providers/manager');

    const config = getConfig();
    const accountSize = config.accountSize || 100000;

    // Get open trades and calculate equity
    const openTrades = db().prepare(
      'SELECT symbol, side, entry_price, shares, remaining_shares FROM trades WHERE exit_date IS NULL'
    ).all();

    // Fetch current prices for open positions + SPY
    const symbols = [...new Set(openTrades.map(t => t.symbol).concat('SPY'))];
    const quotes = await getQuotes(symbols);
    const priceMap = {};
    for (const q of quotes) {
      priceMap[q.symbol || q.ticker] = q.price || q.regularMarketPrice;
    }

    // Calculate open P&L
    let openPnl = 0;
    for (const t of openTrades) {
      const currentPrice = priceMap[t.symbol] || t.entry_price;
      const shares = t.remaining_shares || t.shares || 0;
      const pnl = (currentPrice - t.entry_price) * shares * (t.side === 'short' ? -1 : 1);
      openPnl += pnl;
    }

    const equity = +(accountSize + openPnl).toFixed(2);
    const spyClose = priceMap['SPY'] || null;

    // Get portfolio heat
    let heatPct = 0;
    try {
      const heat = getPortfolioHeat();
      heatPct = heat?.heatPct || 0;
    } catch (_) {}

    const snapshot = recordEquitySnapshot(equity, 0, spyClose, openTrades.length, heatPct);

    return {
      date: marketDate(),
      equity,
      spyClose,
      openPositions: openTrades.length,
      openPnl: +openPnl.toFixed(2),
      heatPct,
      snapshot,
    };
  },
});

// ─── Revision Scan — Daily earnings estimate snapshot ──────────────────────
// Fetches analyst estimates for the universe stocks and stores snapshots.
// Revision scores appear once a prior snapshot exists for comparison.

registerJobType('revision_scan', {
  description: 'Fetch earnings estimate revisions for top stocks and store snapshots for trend tracking',
  defaultConfig: { topN: 100 },
  handler: async () => {
    const { fetchEstimateRevisions, storeRevisions, loadPriorRevisions, scoreRevisions } = require('../signals/earningsRevisions');
    const { cacheGet } = require('../data/cache');

    // Use latest scan results to get top stocks by RS
    const cached = cacheGet('rs:full', 60 * 60 * 1000);
    if (!cached || !cached.length) {
      return { error: 'No scan results cached. Run rs_scan first.' };
    }

    const topStocks = cached
      .sort((a, b) => (b.rsRank || 0) - (a.rsRank || 0))
      .slice(0, 100)
      .map(s => s.ticker);

    let fetched = 0, stored = 0, withRevisions = 0, errors = 0;

    for (const symbol of topStocks) {
      try {
        const current = await fetchEstimateRevisions(symbol);
        if (!current) { errors++; continue; }
        fetched++;

        const prior = loadPriorRevisions(db(), symbol);
        if (prior) {
          const score = scoreRevisions(current, prior);
          if (score) withRevisions++;
        }

        storeRevisions(db(), symbol, current);
        stored++;

        // Rate limit: 200ms between Yahoo calls
        await new Promise(r => setTimeout(r, 200));
      } catch (_) { errors++; }
    }

    return {
      date: marketDate(),
      attempted: topStocks.length,
      fetched,
      stored,
      withRevisions,
      errors,
    };
  },
});

module.exports = { setRunScan };
