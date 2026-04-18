// ─── Stop Monitor — Real-Time Position Monitoring ────────────────────────────
//
// Role: OBSERVER. The monitor watches prices, fires notifications, and
// performs broker-side adjustments that the broker itself cannot know
// about — specifically move-to-breakeven after a tranche fills, and
// signal-based exits (RS dropped, regime flipped, VCP failed).
//
// What the monitor does NOT do anymore (post Day 2-3 refactor):
//   • Submit market sells on stop-loss price crossings. The broker has a
//     bracket; the stop leg fires server-side. If the monitor sees a price
//     cross and the broker hasn't filled, that's a BROKER health issue, not
//     a monitor fallback.
//   • Submit market sells on target1/target2 price crossings. Multi-tranche
//     brackets close each tranche natively on the broker side. The monitor
//     just keeps local DB state in sync and raises stops to breakeven.
//
// Uses WebSocket streaming for millisecond-level detection.
// Falls back to 5-minute cron for non-streaming scenarios.
const cron = require('node-cron');
const alpaca = require('./alpaca');
const { getBroker } = require('./index');
const { checkAlerts, getActiveAlerts } = require('./alerts');
const { expireStaleOrders, syncOrderStatus } = require('./staging');
const { priceStream } = require('./stream');
const { getDB } = require('../data/database');
const { yahooQuote } = require('../data/providers/yahoo');
const { evaluateScalingAction, applyScalingAction } = require('../risk/scaling');
const { runBreadthEarlyWarning } = require('../signals/breadth-warning');
const { notifyTradeEvent } = require('../notifications/channels');

let monitorTask = null;
let lastCheck = null;
let checkCount = 0;
let streamingActive = false;
let lastBreadthWarning = null;

function db() { return getDB(); }

// ─── Stream-Based Real-Time Monitoring ─────────────────────────────────────

function startStreamMonitor() {
  const activeAlerts = getActiveAlerts();
  const symbols = [...new Set(activeAlerts.map(a => a.symbol))];

  if (symbols.length === 0) {
    console.log('  Stream Monitor: No active alerts — will auto-subscribe when alerts are created');
    streamingActive = true;
    _watchForNewAlerts();
    return;
  }

  // Subscribe to all symbols with active alerts
  priceStream.subscribe(symbols);
  streamingActive = true;

  // Listen for every price update and check stops + scaling instantly
  priceStream.on('price', async (symbol, update) => {
    try {
      const activeForSymbol = getActiveAlerts(symbol);
      if (activeForSymbol.length) {
        const prices = { [symbol]: update.price };
        const fired = await checkAlerts(prices);

        if (fired.length > 0) {
          checkCount++;
          lastCheck = {
            time: new Date().toISOString(),
            mode: 'streaming',
            latency: `<${update.source === 'alpaca-ws' ? '50' : '15000'}ms`,
            symbol,
            price: update.price,
            fired: fired.length,
            firedAlerts: fired,
          };

          // Auto-execute stops if enabled
          await _autoExecuteStops(fired);
        }
      }

      // Tier 3: check open trades for partial profit-taking targets
      await _checkScalingForSymbol(symbol, update.price);
    } catch (e) {
      // Don't crash the stream listener on individual check errors
    }
  });

  // Periodically refresh subscriptions as alerts are added/removed
  _watchForNewAlerts();

  console.log(`  Stream Monitor: ✓ Watching ${symbols.length} symbol(s) in real-time`);
}

// Periodically check for new alert subscriptions and update stream
function _watchForNewAlerts() {
  setInterval(() => {
    const activeAlerts = getActiveAlerts();
    const symbols = [...new Set(activeAlerts.map(a => a.symbol))];
    const currentSubs = priceStream.subscribedSymbols;

    // Add new symbols
    const toAdd = symbols.filter(s => !currentSubs.has(s));
    if (toAdd.length > 0) {
      priceStream.subscribe(toAdd);
      console.log(`  Stream Monitor: Added ${toAdd.length} symbol(s): ${toAdd.join(', ')}`);
    }

    // Remove symbols with no active alerts
    const toRemove = [...currentSubs].filter(s => !symbols.includes(s));
    if (toRemove.length > 0) {
      priceStream.unsubscribe(toRemove);
    }
  }, 30000); // Check every 30 seconds
}

// ─── Tier 3: Scaling Observer (move stops, don't submit sells) ─────────────
//
// Triggered on every price tick. Checks if any open trade's price has
// crossed a partial-exit level.
//
// Day 2-3 change: we no longer submit market sells here — the broker's
// multi-tranche bracket closes each tranche natively when its TP hits.
// What the monitor DOES still do:
//
//   1. applyScalingAction() — keeps local DB `remaining_shares` and
//      `partial_exits` fields in step with what the broker just did on its
//      side. This is best-effort bookkeeping so the UI reflects reality;
//      a separate reconciler should eventually replace it with pull-based
//      polling of broker fills.
//
//   2. Move-to-breakeven — after target1 hits, the remaining tranches'
//      stop legs on the broker must be raised. We call
//      broker.replaceStopsForSymbol() to PATCH every open stop leg for
//      that symbol to the new breakeven price.
//
//   3. Notifications — phone alerts on every partial fill.

// Cooldown cache for auto_stop notifications. applyScalingAction does NOT
// write exit_date for full_exit, so without this cache every re-check (once
// per stream tick OR once per cron cycle) would re-fire the same auto_stop
// notification until the broker actually closes the position. 10 minutes is
// long enough for the bracket's stop leg to fill even under wide slippage.
const _autoStopNotifyCooldown = new Map();  // trade_id -> ts
const _AUTO_STOP_COOLDOWN_MS = 10 * 60 * 1000;

function _shouldFireAutoStop(tradeId) {
  const last = _autoStopNotifyCooldown.get(tradeId);
  if (last && Date.now() - last < _AUTO_STOP_COOLDOWN_MS) return false;
  _autoStopNotifyCooldown.set(tradeId, Date.now());
  // Garbage-collect stale entries so the map doesn't grow unbounded over
  // a long-running process. Fine to walk the map here since it's tiny.
  for (const [id, ts] of _autoStopNotifyCooldown) {
    if (Date.now() - ts > _AUTO_STOP_COOLDOWN_MS * 2) _autoStopNotifyCooldown.delete(id);
  }
  return true;
}

async function _checkScalingForSymbol(symbol, price) {
  const trades = db().prepare(
    'SELECT * FROM trades WHERE exit_date IS NULL AND symbol = ?'
  ).all(symbol);
  if (!trades.length) return;

  const broker = getBroker();

  for (const t of trades) {
    const action = evaluateScalingAction(t, price);
    if (!action) continue;

    // Full-exit notifications are rate-limited — see cooldown note above.
    // Partial exits (scale_out) have inherent idempotency via the
    // partial_exits JSON column in the trades table, so no extra guard.
    const isFullExit = action.action === 'full_exit';
    if (isFullExit && !_shouldFireAutoStop(t.id)) {
      continue;
    }

    // Local DB bookkeeping: record the implied partial exit and raise the
    // local stop field. The broker has already closed the tranche by now
    // (its TP fired), so this just keeps our view of the position in sync.
    applyScalingAction(t.id, action);
    console.log(`  📤 Scaling ${t.symbol}: ${action.reason}`);
    notifyTradeEvent({
      event: isFullExit ? 'auto_stop' : 'scale_out',
      symbol: t.symbol,
      details: { shares: action.shares, price, reason: action.reason, level: action.level },
    }).catch(e => console.error('Notification error:', e.message));

    // Move every open stop leg on the broker to the new stop price. This
    // is the ONLY broker write the observer issues on scale events — the
    // partial sell itself is the broker's job, done via the bracket's TP.
    if (action.moveStopTo != null && broker.isConfigured()) {
      try {
        const patched = await broker.replaceStopsForSymbol({
          symbol: t.symbol,
          newStopPrice: action.moveStopTo,
        });
        console.log(`  ✓ Raised ${patched.length} stop leg(s) on ${t.symbol} to ${action.moveStopTo}`);

        // Phase 1.3: fire an `adjustment` notification so the user knows
        // their trailing stop moved. Previously this was silent — the only
        // signal was reading the log or inspecting the DB.
        notifyTradeEvent({
          event: 'adjustment',
          symbol: t.symbol,
          details: {
            price,
            stop: action.moveStopTo,
            shares: patched.length,   // repurposed: # of stop legs patched
            reason: `Stop moved to ${action.moveStopTo} (${action.reason})`,
            level: action.level,
          },
        }).catch(e => console.error('Adjustment notify error:', e.message));
      } catch (e) {
        console.error(`  Stop-move failed for ${t.symbol}: ${e.message}`);
      }
    }
  }
}

// ─── Cron-path scaling fallback ────────────────────────────────────────────
//
// When the WebSocket stream is down (or the user runs with streamingActive
// off), `_checkScalingForSymbol` never fires because it's only hooked to
// `priceStream.on('price', ...)`. This function walks every open trade and
// runs the same scaling evaluator against a freshly-fetched quote. It's
// called from the 5-minute cron cycle so scaling/stop lifecycle events are
// guaranteed to fire even without streaming.
//
// Idempotency: `evaluateScalingAction` is already idempotent against
// already-recorded partial exits (it re-reads the trade row and skips levels
// whose records exist in `partial_exits`), so running this in addition to
// the stream path produces no duplicate notifications for a given level.

async function checkOpenTradeScaling() {
  try {
    const openTrades = db().prepare(
      "SELECT DISTINCT symbol FROM trades WHERE exit_date IS NULL"
    ).all();
    if (!openTrades.length) return;

    const symbols = openTrades.map(r => r.symbol);
    const currentPrices = {};

    // Try streaming cache first (if streamingActive, prices are already warm)
    if (streamingActive) {
      for (const s of symbols) {
        const streamPrice = priceStream.getPrice(s);
        if (streamPrice) currentPrices[s] = streamPrice.price;
      }
    }

    // Fill from broker positions (pos.current_price is the most reliable
    // real-time source when Alpaca is configured).
    const missing = symbols.filter(s => !currentPrices[s]);
    const { configured } = alpaca.getConfig();
    if (configured && missing.length) {
      try {
        const positions = await alpaca.getPositions();
        for (const pos of positions) {
          if (missing.includes(pos.symbol) && pos.current_price != null) {
            currentPrices[pos.symbol] = +pos.current_price;
          }
        }
      } catch (_) {}
    }

    // Final fallback: Yahoo quote
    const stillMissing = symbols.filter(s => !currentPrices[s]);
    if (stillMissing.length) {
      try {
        const quotes = await yahooQuote(stillMissing);
        for (const q of quotes) {
          if (q.regularMarketPrice) currentPrices[q.symbol] = q.regularMarketPrice;
        }
      } catch (_) {}
    }

    // Run scaling check for every symbol that has a price
    for (const symbol of Object.keys(currentPrices)) {
      try {
        await _checkScalingForSymbol(symbol, currentPrices[symbol]);
      } catch (e) {
        console.error(`  Scaling check failed for ${symbol}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`  checkOpenTradeScaling error: ${e.message}`);
  }
}

// ─── Stop Alert Handler (observer only) ────────────────────────────────────
//
// Day 2-3: the monitor does NOT submit market sells on stop alerts. Every
// open position should already have a broker-side bracket whose stop leg
// fires automatically when the broker sees the price cross. If we see the
// cross first, the right response is to notify the user — and optionally,
// as a LAST-RESORT safety net, call broker.closePosition() for positions
// that have no bracket (orphans from legacy code paths).
//
// AUTO_STOP_EXECUTE=true enables the safety net. It's off by default
// because a healthy system should never need it: if it fires, something
// upstream is broken and the user should investigate.

async function _autoExecuteStops(firedAlerts) {
  const broker = getBroker();
  const safetyNet = process.env.AUTO_STOP_EXECUTE === 'true' && broker.isConfigured();

  for (const alert of firedAlerts) {
    if (alert.type !== 'stop_violation') continue;

    // Always notify — this is the observer's primary job.
    notifyTradeEvent({
      event: 'force_stop',
      symbol: alert.symbol,
      details: {
        price: alert.current_price,
        stop:  alert.trigger_price,
        reason: 'Stop price crossed (broker bracket should be firing)',
      },
    }).catch(e => console.error('Notification error:', e.message));

    if (!safetyNet) continue;

    // Safety net: only closes if there's still an open position, meaning
    // the broker's bracket somehow missed. closePosition is a no-op for
    // flat symbols at the broker level (or throws a handleable error).
    try {
      const pos = await broker.getPosition(alert.symbol);
      if (!pos || pos.qty === 0) continue; // broker already flat — good
      console.warn(`  ⚠ Safety net: ${alert.symbol} still open despite stop cross, closing via broker.closePosition`);
      await broker.closePosition(alert.symbol);
    } catch (e) {
      console.error(`  Safety-net close failed for ${alert.symbol}: ${e.message}`);
    }
  }
}

// ─── Legacy Cron Fallback (still used as safety net) ───────────────────────

async function checkPositionsAgainstStops() {
  try {
    const activeAlerts = getActiveAlerts();
    if (!activeAlerts.length) {
      lastCheck = { time: new Date().toISOString(), alerts: 0, fired: 0, skipped: 'no active alerts' };
      return;
    }

    const symbols = [...new Set(activeAlerts.map(a => a.symbol))];
    const currentPrices = {};

    // Try streaming prices first (already available if stream is active)
    if (streamingActive) {
      for (const s of symbols) {
        const streamPrice = priceStream.getPrice(s);
        if (streamPrice) currentPrices[s] = streamPrice.price;
      }
    }

    // Fill gaps from Alpaca positions API
    const { configured } = alpaca.getConfig();
    const missing = symbols.filter(s => !currentPrices[s]);

    if (configured && missing.length) {
      try {
        const positions = await alpaca.getPositions();
        for (const pos of positions) {
          if (!currentPrices[pos.symbol]) {
            currentPrices[pos.symbol] = +pos.current_price;
          }
        }
      } catch (_) {}
    }

    // Final fallback: Yahoo quotes for anything still missing
    const stillMissing = symbols.filter(s => !currentPrices[s]);
    if (stillMissing.length) {
      try {
        const quotes = await yahooQuote(stillMissing);
        for (const q of quotes) {
          if (q.regularMarketPrice) currentPrices[q.symbol] = q.regularMarketPrice;
        }
      } catch (e) {
        console.error(`  Monitor: Yahoo quote failed: ${e.message}`);
      }
    }

    const fired = await checkAlerts(currentPrices);
    await _autoExecuteStops(fired);

    checkCount++;
    lastCheck = {
      time: new Date().toISOString(),
      mode: streamingActive ? 'cron-backup' : 'cron-primary',
      alertsChecked: activeAlerts.length,
      symbolsChecked: symbols.length,
      pricesFetched: Object.keys(currentPrices).length,
      fired: fired.length,
      firedAlerts: fired,
    };

    if (fired.length > 0) {
      console.log(`  Monitor: ${fired.length} alert(s) fired at ${lastCheck.time}`);
    }
  } catch (e) {
    console.error(`  Monitor error: ${e.message}`);
    lastCheck = { time: new Date().toISOString(), error: e.message };
  }
}

// ─── Reconcile local trades with broker positions ───────────────────────────

async function reconcilePositions() {
  const { configured } = alpaca.getConfig();
  if (!configured) return { error: 'Alpaca not configured' };

  const [alpacaPositions, localTrades] = await Promise.all([
    alpaca.getPositions(),
    Promise.resolve(db().prepare('SELECT * FROM trades WHERE exit_date IS NULL').all()),
  ]);

  const alpacaSymbols = new Set(alpacaPositions.map(p => p.symbol));
  const localSymbols  = new Set(localTrades.map(t => t.symbol));

  const inBrokerOnly = alpacaPositions.filter(p => !localSymbols.has(p.symbol)).map(p => ({
    symbol: p.symbol, qty: +p.qty, market_value: +p.market_value, unrealized_pl: +p.unrealized_pl,
  }));
  const inLocalOnly  = localTrades.filter(t => !alpacaSymbols.has(t.symbol)).map(t => ({
    symbol: t.symbol, shares: t.shares, entry_price: t.entry_price, entry_date: t.entry_date,
  }));

  return {
    synced: alpacaPositions.filter(p => localSymbols.has(p.symbol)).length,
    inBrokerOnly,
    inLocalOnly,
    discrepancies: inBrokerOnly.length + inLocalOnly.length,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

async function startStopMonitor() {
  // Start WebSocket streaming (primary real-time monitor)
  try {
    await priceStream.start();
    startStreamMonitor();
    console.log('   Stream Monitor: ✓ Real-time price streaming active');
  } catch (e) {
    console.warn(`   Stream Monitor: Failed to start streaming: ${e.message}`);
  }

  // Keep cron as a safety net (catches anything the stream misses)
  if (!monitorTask) {
    monitorTask = cron.schedule('*/5 * * * 1-5', async () => {
      const { configured } = alpaca.getConfig();
      if (configured) {
        try {
          const { open } = await alpaca.isMarketOpen();
          if (!open) return;
        } catch (_) {}
      }
      await checkPositionsAgainstStops();
      await checkStrategyExits();
      await checkBreadthEarlyWarning();
      await checkConditionalAndScaleIn();
      // Phase 1.3: cron-path scaling fallback. Guarantees scale_out /
      // auto_stop / adjustment notifications fire even when the WebSocket
      // stream is dead (or was never started because no alerts were active).
      await checkOpenTradeScaling();
    }, { scheduled: true });

    // Expire stale staged orders every hour
    cron.schedule('0 * * * *', () => {
      expireStaleOrders();
    }, { scheduled: true });

    // ─── Order Status Poller (Option A) ─────────────────────────────────
    // Walks every staged row in 'submitted' state once per minute during
    // market hours and calls syncOrderStatus() to pick up broker-side
    // transitions (fill / cancel / reject / expire). The sync function
    // fires notifyTradeEvent on each terminal transition, so this cron is
    // the source of real-time phone alerts for broker fills — without
    // requiring a subscription to Alpaca's trade_updates WebSocket.
    //
    // Idempotency: once a row leaves 'submitted' it's no longer selected,
    // so each transition produces exactly one notification.
    //
    // Rate budget: typical open-order count is <5, Alpaca's rate limit is
    // 200 requests/min — 5 poll calls/min is a rounding error.
    cron.schedule('* * * * 1-5', async () => {
      const { configured } = alpaca.getConfig();
      if (!configured) return;
      try {
        const { open } = await alpaca.isMarketOpen();
        if (!open) return;
      } catch (_) { return; }

      const rows = db().prepare(
        "SELECT id FROM staged_orders WHERE status = 'submitted'"
      ).all();
      if (!rows.length) return;

      for (const row of rows) {
        try {
          await syncOrderStatus(row.id);
        } catch (e) {
          console.error(`  Status poll failed for staged #${row.id}: ${e.message}`);
        }
      }

      // ── Pyramid tranche fill poll ──
      // Iterate pyramid plans with 'submitted' tranches; check each tranche's
      // broker order status, and call handleTrancheFill() on transition to
      // filled so the NEXT tranche gets armed for the live checker to fire.
      try {
        const { handleTrancheFill } = require('./pyramid-plans');
        const pyramidRows = db().prepare(
          "SELECT id, tranches_json FROM pyramid_plans WHERE status IN ('armed_pilot','pilot_filled','add1_filled')"
        ).all();
        for (const pRow of pyramidRows) {
          let tranches; try { tranches = JSON.parse(pRow.tranches_json); } catch (_) { continue; }
          for (const t of tranches) {
            if (t.status !== 'submitted' || !t.orderId) continue;
            try {
              const ord = await alpaca.getOrder(t.orderId);
              if (ord?.status === 'filled') {
                handleTrancheFill(t.orderId);
              } else if (['canceled','cancelled','expired','rejected'].includes(ord?.status)) {
                // Tranche killed before fill — mark failed so it doesn't block the chain
                t.status = ord.status === 'rejected' ? 'rejected' : 'cancelled';
                db().prepare('UPDATE pyramid_plans SET tranches_json = ?, updated_at = datetime(\'now\') WHERE id = ?')
                  .run(JSON.stringify(tranches), pRow.id);
              }
            } catch (e) {
              console.error(`  Pyramid tranche poll ${t.orderId}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        console.error(`  Pyramid poll error: ${e.message}`);
      }
    }, { scheduled: true });

    console.log('   Cron Backup: ✓ Running (every 5 min, market hours)');
    console.log('   Order Status Poll: ✓ Running (every 60s, market hours)');
  }
}

function stopMonitor() {
  priceStream.stop();
  streamingActive = false;

  if (monitorTask) {
    monitorTask.stop();
    monitorTask = null;
  }
}

// ─── Breadth Early Warning Check ──────────────────────────────────────────
// Runs during the cron cycle. Evaluates breadth deterioration and
// auto-applies stop tightening when AUTO_BREADTH_TIGHTEN is enabled.

async function checkBreadthEarlyWarning() {
  try {
    const autoApply = process.env.AUTO_BREADTH_TIGHTEN === 'true';
    const result = await runBreadthEarlyWarning({ autoApply });
    lastBreadthWarning = {
      time: new Date().toISOString(),
      ...result.warning,
      adjustmentCount: result.adjustments?.length || 0,
      applied: result.applied?.applied || 0,
    };
    if (result.warning.level > 0) {
      console.log(`  Breadth Warning: ${result.warning.message}`);
    }
    return result;
  } catch (e) {
    console.error(`  Breadth warning check error: ${e.message}`);
    return null;
  }
}

function getMonitorStatus() {
  return {
    running: !!monitorTask || streamingActive,
    streamStatus: priceStream.getStatus(),
    lastCheck,
    totalChecks: checkCount,
    activeAlerts: getActiveAlerts().length,
    breadthWarning: lastBreadthWarning,
  };
}

// ─── Strategy-Based Exit Monitoring ────────────────────────────────────────
// For open trades tagged with a replay strategy, evaluate signal-based exits
// (RS drop, SEPA degrade, regime change, VCP failure, conviction degradation)
// using live regime data + scan cache with DB fallback.
// Runs alongside the cron stop check every 5 minutes.

const STRATEGY_EXIT_RULES = {
  rs_momentum:      { exitField: 'rsRank',        exitThreshold: 50, compare: 'below', reason: 'rs_dropped' },
  sepa_trend:       { exitField: 'sepaScore',      exitThreshold: 3,  compare: 'below', reason: 'sepa_degraded' },
  rs_line_new_high: { exitField: 'vsMA50',         exitThreshold: -5, compare: 'below', reason: 'below_ma50' },
  vcp_breakout:     { exitField: 'rsRank',         exitThreshold: 50, compare: 'below', reason: 'vcp_rs_failed' },
  conviction:       { exitField: 'rsRank',         exitThreshold: 50, compare: 'below', reason: 'conviction_rs_failed' },
};

// Build signal data map from scan cache with rs_snapshots DB fallback.
// This ensures strategy exits work even when the scan cache has expired.
function _getSignalMap() {
  const { cacheGet, TTL_QUOTE } = require('../data/cache');
  const scanData = cacheGet('rs:full', TTL_QUOTE);

  if (scanData && scanData.length) {
    const map = {};
    for (const s of scanData) map[s.ticker] = s;
    return { map, source: 'cache' };
  }

  // Fallback: load latest day from rs_snapshots DB table
  try {
    const latestDate = db().prepare(
      "SELECT date FROM rs_snapshots WHERE type='stock' ORDER BY date DESC LIMIT 1"
    ).pluck().get();
    if (!latestDate) return { map: {}, source: 'none' };

    const rows = db().prepare(
      "SELECT symbol, rs_rank, swing_momentum, sepa_score, vs_ma50, vs_ma200, price, atr_pct, vcp_forming, stage FROM rs_snapshots WHERE date=? AND type='stock'"
    ).all(latestDate);

    const map = {};
    for (const r of rows) {
      map[r.symbol] = {
        ticker: r.symbol,
        rsRank: r.rs_rank,
        swingMomentum: r.swing_momentum,
        sepaScore: r.sepa_score,
        vsMA50: r.vs_ma50,
        vsMA200: r.vs_ma200,
        price: r.price,
        atrPct: r.atr_pct,
        vcpForming: r.vcp_forming,
        stage: r.stage,
      };
    }
    return { map, source: `db:${latestDate}` };
  } catch (e) {
    console.error(`  Signal map DB fallback failed: ${e.message}`);
    return { map: {}, source: 'error' };
  }
}

async function checkStrategyExits() {
  try {
    // Get open trades with a strategy tag
    const trades = db().prepare(
      "SELECT * FROM trades WHERE exit_date IS NULL AND strategy IS NOT NULL"
    ).all();
    if (!trades.length) return [];

    // Gap fix 3: scan cache with rs_snapshots DB fallback
    const { map: scanMap, source } = _getSignalMap();
    if (!Object.keys(scanMap).length) {
      console.log('  Strategy exit check: no signal data (cache expired, no DB snapshots)');
      return [];
    }
    if (source !== 'cache') {
      console.log(`  Strategy exit check: using fallback data (${source})`);
    }

    // Gap fix 1: use getMarketRegime() for live regime detection
    // This fetches a fresh SPY quote (10-min cache) instead of relying on stale scan data
    const { getMarketRegime } = require('../risk/regime');
    let regime = 'NEUTRAL';
    try {
      const regimeData = await getMarketRegime();
      regime = regimeData?.regime || 'NEUTRAL';
      // Normalize regime names for comparison
      if (regime === 'HIGH RISK' || regime === 'BEAR') regime = 'CORRECTION';
      if (regime === 'BULL' || regime === 'RISK ON') regime = 'BULL';
    } catch (e) {
      // If live regime fetch fails, fall back to scan-derived regime
      const spy = scanMap['SPY'];
      if (spy) {
        const above50 = (spy.vsMA50 || 0) > 0;
        const above200 = (spy.vsMA200 || 0) > 0;
        if (above50 && above200) regime = 'BULL';
        else if (!above50 && above200) regime = 'NEUTRAL';
        else if (above50 && !above200) regime = 'CAUTION';
        else regime = 'CORRECTION';
      }
      console.log(`  Live regime fetch failed, using scan-derived: ${regime}`);
    }

    const broker = getBroker();
    const autoExec = process.env.AUTO_STOP_EXECUTE === 'true' && broker.isConfigured();
    const fired = [];

    for (const trade of trades) {
      const stock = scanMap[trade.symbol];
      if (!stock) continue;

      let exitReason = null;

      // Regime force-exit for all long strategies
      if (trade.side === 'long' && (regime === 'CAUTION' || regime === 'CORRECTION')) {
        exitReason = `regime_${regime.toLowerCase()}`;
      }

      // Strategy-specific signal exit
      if (!exitReason) {
        const rule = STRATEGY_EXIT_RULES[trade.strategy];
        if (rule) {
          const val = stock[rule.exitField];
          if (val != null && rule.compare === 'below' && val <= rule.exitThreshold) {
            exitReason = rule.reason;
          }
        }
      }

      // Gap fix 2: additional VCP exit — breakout failure (price back below entry)
      if (!exitReason && trade.strategy === 'vcp_breakout' && stock.price && trade.entry_price) {
        if (stock.price < trade.entry_price * 0.97) {
          exitReason = 'vcp_breakout_failed';
        }
      }

      if (exitReason) {
        console.log(`  Strategy exit: ${trade.symbol} (${trade.strategy}) — ${exitReason}`);
        fired.push({ symbol: trade.symbol, strategy: trade.strategy, reason: exitReason, tradeId: trade.id });

        // Signal-based exits route through broker.closePosition — the broker
        // has no context for "RS dropped" or "regime changed", so we have to
        // tell it explicitly. This is one of the few places the monitor
        // writes to the broker as an actor rather than an observer.
        if (autoExec) {
          try {
            await broker.closePosition(trade.symbol);
            console.log(`  ✓ Auto-exited ${trade.symbol}: ${exitReason}`);
          } catch (e) {
            console.error(`  Auto-exit failed for ${trade.symbol}: ${e.message}`);
          }
        }

        // Send notification
        try {
          const { createAlert } = require('./alerts');
          createAlert({
            symbol: trade.symbol,
            alert_type: 'strategy_exit',
            trigger_price: stock.price,
            direction: 'below',
            trade_id: trade.id,
            message: `${trade.strategy} exit signal: ${exitReason} (${trade.symbol} RS:${stock.rsRank} Mom:${stock.swingMomentum})`,
          });
        } catch (_) {}
      }
    }

    return fired;
  } catch (e) {
    console.error(`  Strategy exit check error: ${e.message}`);
    return [];
  }
}

// ─── Phase 2: Conditional Entry + Scale-In Monitoring ──────────────────────
// Checks conditional entries (pullback/breakout triggers) and active scale-in
// plans on every cron cycle. Real-time stream triggers are handled separately.

async function checkConditionalAndScaleIn() {
  try {
    // Conditional entries
    const pendingEntries = db().prepare(
      "SELECT DISTINCT symbol FROM conditional_entries WHERE status = 'pending'"
    ).all();

    if (pendingEntries.length > 0) {
      const symbols = pendingEntries.map(r => r.symbol);
      const currentPrices = {};

      // Get prices from stream first, then fill gaps
      if (streamingActive) {
        for (const s of symbols) {
          const streamPrice = priceStream.getPrice(s);
          if (streamPrice) currentPrices[s] = streamPrice.price;
        }
      }

      const missing = symbols.filter(s => !currentPrices[s]);
      if (missing.length) {
        try {
          const quotes = await yahooQuote(missing);
          for (const q of quotes) {
            if (q.regularMarketPrice) currentPrices[q.symbol] = q.regularMarketPrice;
          }
        } catch (_) {}
      }

      if (Object.keys(currentPrices).length > 0) {
        try {
          const { checkConditionalEntries, expireOldEntries } = require('./auto-stage');
          const result = await checkConditionalEntries(currentPrices);
          expireOldEntries();
          if (result.triggered?.length > 0) {
            console.log(`  Conditional: ${result.triggered.length} entry/entries triggered`);
          }
        } catch (e) {
          console.error(`  Conditional entry check error: ${e.message}`);
        }
      }
    }

    // Scale-in plans
    const activePlans = db().prepare(
      "SELECT DISTINCT symbol FROM scale_in_plans WHERE status = 'active'"
    ).all();

    if (activePlans.length > 0) {
      const symbols = activePlans.map(r => r.symbol);
      const currentPrices = {};

      if (streamingActive) {
        for (const s of symbols) {
          const streamPrice = priceStream.getPrice(s);
          if (streamPrice) currentPrices[s] = streamPrice.price;
        }
      }

      const missing = symbols.filter(s => !currentPrices[s]);
      if (missing.length) {
        try {
          const quotes = await yahooQuote(missing);
          for (const q of quotes) {
            if (q.regularMarketPrice) currentPrices[q.symbol] = q.regularMarketPrice;
          }
        } catch (_) {}
      }

      if (Object.keys(currentPrices).length > 0) {
        try {
          const { checkAllActivePlans } = require('../risk/scale-in');
          const result = await checkAllActivePlans(currentPrices);
          if (result.triggered?.length > 0) {
            console.log(`  Scale-in: ${result.triggered.length} tranche(s) triggered`);
          }
        } catch (e) {
          console.error(`  Scale-in check error: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error(`  Conditional/Scale-in check error: ${e.message}`);
  }
}

module.exports = {
  startStopMonitor, stopMonitor, getMonitorStatus,
  checkPositionsAgainstStops, checkStrategyExits, checkBreadthEarlyWarning,
  checkConditionalAndScaleIn,
  checkOpenTradeScaling,
  reconcilePositions,
  priceStream, // Export for routes to expose status
};
