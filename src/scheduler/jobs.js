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

// ─── 5b. Broker Fills Sync — Pull filled orders into journal + slippage log ──

registerJobType('broker_fills_sync', {
  description: 'Sync Alpaca fills into trades journal; captures slippage in execution_log',
  defaultConfig: {},
  handler: async () => {
    const { syncBrokerFills } = require('../broker/fills-sync');
    const result = await syncBrokerFills();
    return { synced: result.synced.length, exited: result.exited.length, backfilled: result.backfilled };
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

// ─── 9. Pullback Watch — 3-state 50 SMA pullback detector ──────────────────
// Delegates to src/signals/pullback-monitor.js — the real detector that:
//   • Recomputes 50 SMA from OHLCV closes (NOT Yahoo's EOD fiftyDayAverage)
//   • Uses three bands: approaching (≤1.08×MA50), in_zone (≤1.03×MA50),
//     kissing (≤MA50+0.3×ATR) — each fires a distinct notification
//   • Stores last-fired state per symbol → only state transitions fire alerts
//   • Gates on real leadership: RS≥70, above 200MA, stage 2 OR VCP OR SEPA≥4
//
// Can be scheduled two ways:
//   1. Post-scan daily (e.g. 16:30 ET) — uses latest rs_snapshots, paints the
//      initial pullback state for every leader.
//   2. Intraday 1-minute loop during RTH — catches live state transitions.
//
// Both modes use the same handler; the scanner internally fetches live quotes
// via the cascading provider manager when called without currentPrices.

// ─── Deep Scan — auto-populate deep_scan_cache ─────────────────────────────
// Runs a Deep Scan over the fresh RS universe and persists the results so the
// Trade Setups tab (and Morning Brief) never show stale data. Pulls from the
// in-memory rs:full cache when hot, falls back to runRSScanFn() otherwise.

let _sectorEtfs = null;
function setSectorEtfs(arr) { _sectorEtfs = arr; }

registerJobType('deep_scan', {
  description: 'Populate deep_scan_cache with ranked picks (conviction + sector rotation + ATR levels)',
  defaultConfig: { mode: 'both' },
  handler: async (config) => {
    const { runDeepScan, persistDeepScan } = require('../signals/deep-scan');
    const { cacheGet } = require('../data/cache');

    let stocks = cacheGet('rs:full', 24 * 60 * 60 * 1000);
    if (!stocks || !stocks.length) {
      if (!_runScan) throw new Error('Scanner not initialized — call setRunScan() at startup');
      stocks = await _runScan();
    }

    const mode = config.mode || 'both';
    const scan = await runDeepScan({ stocks, mode, sectorEtfs: _sectorEtfs });
    persistDeepScan({
      mode, results: scan.results, regime: scan.regime,
      scannedCount: scan.candidates, totalInput: scan.totalInput,
    });
    return { mode, picks: scan.results.length, candidates: scan.candidates, totalInput: scan.totalInput };
  },
});

registerJobType('pullback_watch', {
  description: '3-state 50 SMA pullback detector — approaching/in_zone/kissing with live prices',
  defaultConfig: { marketHoursOnly: false },
  handler: async () => {
    const { runPullbackScan } = require('../signals/pullback-monitor');
    const result = await runPullbackScan();
    return result;
  },
});

// ─── Position Deterioration Watch ─────────────────────────────────────────
// Tightens trailing stops on positions whose thesis has eroded:
//   - Industry ETF RS rank dropped ≥20 pts in 10 days (rotation reversal)
//   - Individual stock RS dropped ≥20 pts in 10 days
//   - Stage transitioned from 2 (uptrend) → 3 or 4 (distribution/decline)
// Flips trade.trail_pct from 0.08 → 0.04 and patches broker stop legs.

registerJobType('rotation_watch', {
  description: 'Tighten trailing stops on positions whose industry has rotated down, RS collapsed, or stage transitioned to distribution',
  defaultConfig: { rsDropThreshold: 20, lookbackDays: 10, tightTrailPct: 0.04 },
  handler: async (config) => {
    const { runPositionDeteriorationScan } = require('../signals/position-deterioration');
    return runPositionDeteriorationScan(config);
  },
});

// ─── Pyramid Plans Watcher ──────────────────────────────────────────────────
// Runs every minute during market hours. Checks every armed pyramid plan
// for trigger + volume-pace + gap conditions, and fires the next tranche
// when all gates pass.

registerJobType('pyramid_watch', {
  description: 'Monitor pyramid plans — fire pilot/add1/add2 tranches when triggers hit + volume confirms',
  defaultConfig: {},
  handler: async () => {
    const { checkPyramidPlans } = require('../broker/pyramid-plans');
    return checkPyramidPlans();
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

// ─── 12a. Gap Guard — Pre-open overnight-gap reprice/cancel ────────────────
// Runs before market open (~9:20 ET on the seeded cron). Walks every
// staged/submitted order and cancels anything where the overnight gap has
// broken the setup thesis — e.g. the stock gapped up past our pullback
// entry zone, or gapped down through our stop before the order fills.
// Each cancel fires a 'gap_cancel' trade event so the user gets an alert
// with the specific reason, not a generic "cancelled" ping.

registerJobType('gap_guard', {
  description: 'Pre-open gap guard — cancel staged/submitted orders where overnight gap broke the setup thesis',
  defaultConfig: { gapUpLimitPct: 0.02 },
  handler: async (config) => {
    const { checkPreOpenGaps } = require('../broker/staging');
    return await checkPreOpenGaps({ gapUpLimitPct: config.gapUpLimitPct });
  },
});

// ─── Correlation Drift Watcher (Phase 2.8) ─────────────────────────────────
// Hourly pair-correlation sweep across open positions. Fires a
// `correlation_drift` event when a pair has drifted from its entry baseline
// into lockstep territory (≥ 0.80 current, ≥ 0.20 drift from baseline,
// both legs > 3% of book). See src/risk/correlation-drift.js for the full
// gating logic and why the three-gate design avoids false positives on
// pairs that were always correlated.

registerJobType('correlation_drift', {
  description: 'Watch open positions for pair correlations that have drifted into lockstep since entry',
  defaultConfig: {
    corrThreshold: 0.80,
    driftThreshold: 0.20,
    minWeightPct: 3.0,
    cooldownHours: 24,
    bars: 60,
  },
  handler: async (config) => {
    const { runCorrelationDriftCheck } = require('../risk/correlation-drift');
    // Use the cascading provider manager for live marks — falls back to
    // Yahoo/FMP/AV if Polygon is rate-limited, matches the rest of the app.
    const { getQuotes } = require('../data/providers/manager');
    const { getDB } = require('../data/database');

    // Pull the open-position symbols for a weight calculation. Without live
    // marks the watcher falls back to entry_price which is good enough for
    // the weight gate but slightly stale.
    const syms = getDB().prepare(
      'SELECT DISTINCT symbol FROM trades WHERE exit_date IS NULL'
    ).all().map(r => r.symbol);

    const quotes = {};
    if (syms.length > 0) {
      try {
        const data = await getQuotes(syms);
        for (const q of data) {
          const price = q.regularMarketPrice ?? q.price;
          if (price != null) quotes[q.symbol] = price;
        }
      } catch (e) {
        // Don't let quote fetch failure block the drift sweep — we can
        // still run with entry-price weights.
        console.error(`correlation_drift: quote fetch failed: ${e.message}`);
      }
    }

    return await runCorrelationDriftCheck({ ...config, quotes });
  },
});

// ─── 13. Scale-In Check — Monitor active scale-in plans ────────────────────

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
    const today = marketDate();
    const insertScore = db().prepare(`
      INSERT OR REPLACE INTO revision_scores
        (symbol, date, revision_score, direction, tier,
         eps_current_yr_chg, eps_next_yr_chg, rev_chg, acceleration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const symbol of topStocks) {
      try {
        const current = await fetchEstimateRevisions(symbol);
        if (!current) { errors++; continue; }
        fetched++;

        const prior = loadPriorRevisions(db(), symbol);
        if (prior) {
          const score = scoreRevisions(current, prior);
          if (score) {
            withRevisions++;
            // Persist the score so the scanner can attach it to scan rows
            // and the conviction engine can award its +6 upgrade bonus.
            try {
              insertScore.run(
                symbol, today, score.revisionScore, score.direction || null, score.tier || null,
                score.epsCurrentYrChg ?? null, score.epsNextYrChg ?? null,
                score.revChg ?? null, score.acceleration ?? null,
              );
            } catch (_) { /* table schema may differ on old DBs */ }
          }
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

// ─── 14. Morning Brief — Pre-market push notification ─────────────────────
// Assembles regime status, distribution days, FTD, open positions with P&L,
// staged orders, and top scan picks into a single push to Telegram/Pushover.
// Cron: 8:45 AM ET weekdays — gives the trader a concise snapshot before
// the opening bell without having to open the app.

registerJobType('morning_brief', {
  description: 'Pre-market morning brief — regime, positions, staged orders, top picks pushed to phone',
  defaultConfig: {},
  handler: async () => {
    const { assembleMorningBrief } = require('../notifications/briefs');
    const { deliverAlert, getEnabledChannels } = require('../notifications/channels');

    const brief = await assembleMorningBrief();

    // Build an alert payload compatible with the delivery system
    const alert = {
      type: 'morning_brief',
      symbol: 'PORTFOLIO',
      message: brief.text,
      html_message: brief.html,
      current_price: 0,
      trigger_price: 0,
      timestamp: new Date().toISOString(),
    };

    // Deliver to all enabled channels (DB-configured or env fallback)
    let channels = getEnabledChannels('morning_brief');
    if (!channels.length) channels = _envFallbackChannels();

    const results = channels.length ? await deliverAlert(alert, channels) : [];

    return {
      delivered: results.filter(r => r.delivered).length,
      failed: results.filter(r => !r.delivered).length,
      channels: results.map(r => r.channel),
      summary: brief.data,
    };
  },
});

// ─── 15. Weekly Digest — Sunday evening performance summary ──────────────
// Assembles week P&L, trades taken, win rate, regime changes, and top RS
// movers into a comprehensive push. Grounds the weekend review without
// requiring the trader to open the app.
// Cron: 6:00 PM ET Sunday

registerJobType('weekly_digest', {
  description: 'Sunday weekly digest — week P&L, trades, win rate, regime changes, RS movers',
  defaultConfig: {},
  handler: async () => {
    const { assembleWeeklyDigest } = require('../notifications/briefs');
    const { deliverAlert, getEnabledChannels } = require('../notifications/channels');

    const digest = await assembleWeeklyDigest();

    const alert = {
      type: 'weekly_digest',
      symbol: 'PORTFOLIO',
      message: digest.text,
      html_message: digest.html,
      current_price: 0,
      trigger_price: 0,
      timestamp: new Date().toISOString(),
    };

    let channels = getEnabledChannels('weekly_digest');
    if (!channels.length) channels = _envFallbackChannels();

    const results = channels.length ? await deliverAlert(alert, channels) : [];

    return {
      delivered: results.filter(r => r.delivered).length,
      failed: results.filter(r => !r.delivered).length,
      channels: results.map(r => r.channel),
      summary: digest.data,
    };
  },
});

// ─── Edge Telemetry — Nightly Outcome Closer (Layer 1) ─────────────────────
// Walks every open row in signal_outcomes older than 5 trading days, fetches
// forward OHLCV bars for each symbol (once per symbol), and resolves 5/10/20d
// returns + MFE/MAE + stop/target hits. Rows become 'resolved' only once the
// full 20d horizon has elapsed — before that partial metrics are updated in
// place so the dashboard stays fresh.
//
// Why post-close and why 5:30pm: the RS scan finishes at 16:30 and the
// revision scan at 17:00. Running the closer last means all same-day price
// data that Yahoo publishes has had a chance to land before we use it.

registerJobType('edge_close_outcomes', {
  description: 'Resolve open signal_outcomes rows with 5/10/20d forward returns + MFE/MAE (Layer 1 telemetry)',
  defaultConfig: { minAgeDays: 5, limit: 500 },
  handler: async (config) => {
    const { runOutcomeCloser } = require('../signals/edge-closer');
    return await runOutcomeCloser({
      minAgeDays: config.minAgeDays ?? 5,
      limit: config.limit ?? 500,
    });
  },
});

// Shared helper — builds channel list from env vars when no DB channels exist
function _envFallbackChannels() {
  const channels = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    channels.push({ channel: 'telegram', config: { bot_token: process.env.TELEGRAM_BOT_TOKEN, chat_id: process.env.TELEGRAM_CHAT_ID } });
  }
  if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN) {
    channels.push({ channel: 'pushover', config: { user_key: process.env.PUSHOVER_USER_KEY, app_token: process.env.PUSHOVER_APP_TOKEN } });
  }
  if (process.env.SLACK_WEBHOOK_URL) {
    channels.push({ channel: 'slack', config: { webhook_url: process.env.SLACK_WEBHOOK_URL } });
  }
  if (process.env.ALERT_WEBHOOK_URL) {
    channels.push({ channel: 'webhook', config: { url: process.env.ALERT_WEBHOOK_URL } });
  }
  return channels;
}

// ─── Default Job Seeding ────────────────────────────────────────────────────
//
// Registers a baseline set of scheduled jobs on first startup (idempotent:
// jobs are identified by `name` and skipped if already present).
//
// Why this exists: before this seed, a fresh install had all job TYPES
// registered but ZERO rows in `scheduled_jobs`, so `startScheduler()` iterated
// an empty set and nothing actually ran. The trader had to manually POST to
// /api/scheduler/jobs for every job they wanted, or the pullback monitor and
// daily scans would never fire. That silent broken state is the reason the
// user's phone never buzzed on the 5% pullback entries they cared about.
//
// The seed writes directly via `db().prepare(...).run(...)` instead of
// `createJob(...)` because createJob immediately calls `scheduleJob()` — we
// want startScheduler to handle scheduling in one pass after the seed
// completes, so cron state is consistent across restarts.
//
// Cron timing note: node-cron uses server local time by default. The default
// crons below target common hours (market close ≈16:00 ET) assuming the
// server is in Eastern time. Users in other timezones can edit the cron_expr
// via /api/scheduler/jobs/:id or override per-job via env var.

const DEFAULT_JOBS = [
  // Daily RS + SEPA scan after market close — feeds the pullback monitor's
  // leadership filter. Without this, pullback_watch has no snapshot data.
  {
    name: 'rs_scan_daily',
    description: 'Daily RS/SEPA/VCP scan across universe (post-close)',
    job_type: 'rs_scan',
    cron_expression: '30 16 * * 1-5',  // 4:30 PM server local, weekdays
    config: { persist: true },
  },

  // Intraday 3-state 50 SMA pullback monitor. Runs every 2 minutes on
  // weekdays — the new pullback-monitor.js only fires on state transitions,
  // so most runs are no-ops and extremely cheap.
  {
    name: 'pullback_watch_intraday',
    description: 'Fire 50 SMA pullback alerts (approaching/in_zone/kissing) for leaders',
    job_type: 'pullback_watch',
    cron_expression: '*/2 * * * 1-5',  // every 2 min, weekdays
    config: {},
  },

  // Deep Scan auto-refresh — pre-market warmup + every 30 min during market
  // hours. Makes the Trade Setups tab and Morning Brief read fresh data on
  // load. Free: no AI calls unless ANTHROPIC_API_KEY is set.
  {
    name: 'deep_scan_premarket',
    description: 'Warm deep_scan_cache before the open so Morning Brief + Trade Setups show fresh picks',
    job_type: 'deep_scan',
    cron_expression: '30 8 * * 1-5',  // 8:30 AM server local, weekdays
    config: { mode: 'both' },
  },
  {
    name: 'deep_scan_intraday',
    description: 'Refresh deep_scan_cache every 30 min during market hours',
    job_type: 'deep_scan',
    cron_expression: '*/30 9-16 * * 1-5',  // every 30 min, 9am-4pm weekdays
    config: { mode: 'both' },
  },

  // End-of-day equity snapshot for alpha tracking (TWR, Sharpe, SPY-relative).
  {
    name: 'equity_snapshot_eod',
    description: 'Record daily portfolio equity snapshot for alpha tracking',
    job_type: 'equity_snapshot',
    cron_expression: '45 16 * * 1-5',  // 4:45 PM server local, weekdays
    config: {},
  },

  // Daily portfolio reconcile with broker — catches any drift between local
  // trades table and Alpaca positions.
  {
    name: 'portfolio_reconcile_daily',
    description: 'Reconcile local trade journal with broker positions',
    job_type: 'portfolio_reconcile',
    cron_expression: '0 17 * * 1-5',  // 5:00 PM server local, weekdays
    config: {},
  },

  // Broker fills sync — pulls filled orders into the trades journal and
  // writes to execution_log, which is how slippage becomes measurable
  // without a manual button-press. Runs every 15 min during market hours
  // and once 10 min after close as a safety sweep.
  {
    name: 'broker_fills_sync_intraday',
    description: 'Auto-sync Alpaca fills into trade journal + slippage log (market hours)',
    job_type: 'broker_fills_sync',
    cron_expression: '*/15 9-16 * * 1-5',  // every 15 min, 9am–4pm weekdays
    config: {},
  },
  {
    name: 'broker_fills_sync_eod',
    description: 'EOD sweep: catch any fills missed by the intraday sync',
    job_type: 'broker_fills_sync',
    cron_expression: '10 17 * * 1-5',  // 5:10 PM server local, weekdays
    config: {},
  },

  // Stale order cleanup — expire staged orders older than 24h hourly.
  {
    name: 'expire_stale_orders_hourly',
    description: 'Expire staged orders older than 24 hours',
    job_type: 'expire_stale_orders',
    cron_expression: '0 * * * *',  // top of every hour
    config: { maxAgeHours: 24 },
  },

  // Pre-open gap guard — cancel any staged/submitted order where the
  // overnight gap already invalidated the setup. Runs twice: once during
  // pre-market so we catch the gap before the opening tick can fill a
  // 'submitted' GTC bracket, and once 5 minutes after the open in case
  // pre-market quotes weren't available (Yahoo free tier can be spotty
  // pre-open, so the post-open sweep is the safety net).
  {
    name: 'gap_guard_preopen',
    description: 'Cancel staged/submitted orders where overnight gap broke the setup thesis (pre-open)',
    job_type: 'gap_guard',
    cron_expression: '20 9 * * 1-5',  // 9:20 AM server local, weekdays
    config: { gapUpLimitPct: 0.02 },
  },
  {
    name: 'gap_guard_postopen',
    description: 'Gap guard safety sweep 5 min after the open (catches pre-market quote gaps)',
    job_type: 'gap_guard',
    cron_expression: '35 9 * * 1-5',  // 9:35 AM server local, weekdays
    config: { gapUpLimitPct: 0.02 },
  },

  // Weekly job history cleanup — keep the DB lean.
  {
    name: 'job_history_cleanup_weekly',
    description: 'Prune job execution history older than 30 days',
    job_type: 'job_history_cleanup',
    cron_expression: '0 3 * * 0',  // 3:00 AM Sunday
    config: { keepDays: 30 },
  },

  // Analyst estimate revision scan — daily after market close. Fetches
  // current EPS/revenue estimates for top RS stocks and stores snapshots
  // so the revision-trend engine can compute upgrade/downgrade scores.
  // Without this, the Scanner's "Earnings Estimate Revisions" panel shows
  // "No revision history yet" indefinitely.
  {
    name: 'revision_scan_daily',
    description: 'Fetch analyst EPS/revenue estimate revisions for top 100 RS stocks',
    job_type: 'revision_scan',
    cron_expression: '0 17 * * 1-5',  // 5:00 PM server local, weekdays
    config: { topN: 100 },
  },

  // Industry rotation watcher — daily post-close. If an open position's
  // industry ETF RS rank drops ≥20 points in 2 weeks (rotation reversal
  // against the stock), auto-tighten its trailing stop from 8% → 4%.
  // Closes the "rotation reversal" gap in Minervini/O'Neil risk management.
  {
    name: 'rotation_watch_daily',
    description: 'Tighten trailing stops on positions whose industry ETF RS has rotated down',
    job_type: 'rotation_watch',
    cron_expression: '15 17 * * 1-5',  // 5:15 PM server local, weekdays
    config: { rsDropThreshold: 20, lookbackDays: 10, tightTrailPct: 0.04 },
  },

  // Pyramid plans watcher — runs every 1 min during market hours.
  // Fires armed tranches when price + volume pace + gap gates pass.
  {
    name: 'pyramid_watch_intraday',
    description: 'Fire armed pyramid tranches on trigger + volume confirmation',
    job_type: 'pyramid_watch',
    cron_expression: '*/1 9-15 * * 1-5',  // every 1 min, 9am-3:59pm, weekdays
    config: {},
  },

  // Correlation drift watcher — hourly during market hours. Looks at every
  // pair of open positions, computes current vs baseline correlation, and
  // fires a `correlation_drift` phone alert when lockstep is hit. Off-hours
  // cron (every hour 10-16) because intraday drift is what bites a day
  // trader, but we also want the 4pm sweep to catch close-of-day flips.
  {
    name: 'correlation_drift_hourly',
    description: 'Watch for pair correlations that have drifted into lockstep since entry (intraday)',
    job_type: 'correlation_drift',
    cron_expression: '5 10-16 * * 1-5',  // 5 past the hour, 10am-4pm weekdays
    config: {
      corrThreshold: 0.80,
      driftThreshold: 0.20,
      minWeightPct: 3.0,
      cooldownHours: 24,
      bars: 60,
    },
  },

  // ─── Morning Brief — pre-market push notification ──────────────────────
  // Regime + dist days + FTD + open positions + staged orders + top picks.
  // Fires at 8:45 AM ET so the trader sees it while drinking coffee, 15
  // minutes before the opening bell.
  {
    name: 'morning_brief_daily',
    description: 'Pre-market morning brief — regime, positions, staged orders, top picks',
    job_type: 'morning_brief',
    cron_expression: '45 8 * * 1-5',  // 8:45 AM server local, weekdays
    config: {},
  },

  // ─── Edge Telemetry — Nightly outcome closer ──────────────────────────
  // Resolves open signal_outcomes (LLM briefs, staged orders) with forward
  // 5/10/20d returns + MFE/MAE. Without this job the logger records signals
  // but calibration/strategy metrics stay blank. Runs post-scan, post-revision.
  {
    name: 'edge_close_outcomes_daily',
    description: 'Resolve 5/10/20d forward outcomes for emitted signals (Layer 1 telemetry)',
    job_type: 'edge_close_outcomes',
    cron_expression: '30 17 * * 1-5',  // 5:30 PM server local, weekdays
    config: { minAgeDays: 5, limit: 500 },
  },

  // ─── Weekly Digest — Sunday evening performance summary ────────────────
  // Week P&L, trades, win rate, regime changes, RS movers. Grounds the
  // weekend review without requiring the trader to open the app.
  {
    name: 'weekly_digest_sunday',
    description: 'Sunday weekly digest — week P&L, trades, regime changes, RS movers',
    job_type: 'weekly_digest',
    cron_expression: '0 18 * * 0',  // 6:00 PM server local, Sunday
    config: {},
  },
];

function seedDefaultJobs() {
  const existing = new Set(
    db().prepare('SELECT name FROM scheduled_jobs').all().map(r => r.name)
  );

  const insertStmt = db().prepare(`
    INSERT INTO scheduled_jobs (name, description, job_type, cron_expression, config, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `);

  const seeded = [];
  const skipped = [];
  for (const j of DEFAULT_JOBS) {
    if (existing.has(j.name)) {
      skipped.push(j.name);
      continue;
    }
    try {
      insertStmt.run(
        j.name,
        j.description,
        j.job_type,
        j.cron_expression,
        JSON.stringify(j.config || {})
      );
      seeded.push(j.name);
    } catch (e) {
      // If the insert fails (unique constraint race, etc.), log and continue
      // — one bad row should not block the rest from being seeded.
      console.error(`  Scheduler seed: failed to insert ${j.name}: ${e.message}`);
    }
  }

  if (seeded.length) {
    console.log(`   Scheduler seed: +${seeded.length} default job(s) [${seeded.join(', ')}]`);
  }
  if (skipped.length && !seeded.length) {
    // Only log "already present" in the case where nothing new was added —
    // avoids noise on every restart after the first boot.
  }
  return { seeded, skipped };
}

module.exports = { setRunScan, setSectorEtfs, seedDefaultJobs, DEFAULT_JOBS };
