// ─── Stop Monitor — Real-Time Position Monitoring ────────────────────────────
// Uses WebSocket streaming for millisecond-level stop detection.
// Falls back to 5-minute cron for non-streaming scenarios.
const cron = require('node-cron');
const alpaca = require('./alpaca');
const { checkAlerts, getActiveAlerts } = require('./alerts');
const { expireStaleOrders } = require('./staging');
const { priceStream } = require('./stream');
const { getDB } = require('../data/database');
const { yahooQuote } = require('../data/providers/yahoo');
const { evaluateScalingAction, applyScalingAction } = require('../risk/scaling');
const { runBreadthEarlyWarning } = require('../signals/breadth-warning');

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

// ─── Tier 3: Auto Scaling / Partial Exits ──────────────────────────────────
// Triggered on every price tick — checks if any open trade has hit a target
// and applies the partial-exit pyramid (1/3, 1/3, trail final 1/3).

async function _checkScalingForSymbol(symbol, price) {
  const trades = db().prepare(
    'SELECT * FROM trades WHERE exit_date IS NULL AND symbol = ?'
  ).all(symbol);
  if (!trades.length) return;

  const { configured } = alpaca.getConfig();
  const autoExec = process.env.AUTO_SCALE_EXECUTE === 'true' && configured;

  for (const t of trades) {
    const action = evaluateScalingAction(t, price);
    if (!action) continue;

    // Persist the action (move stops, record partial fills)
    const applied = applyScalingAction(t.id, action);
    console.log(`  📤 Scaling ${t.symbol}: ${action.reason}`);

    // Auto-execute partial sell at the broker if enabled
    if (autoExec && action.action === 'partial_exit' && action.shares > 0) {
      try {
        await alpaca.submitOrder({
          symbol: t.symbol,
          qty: action.shares,
          side: t.side === 'short' ? 'buy' : 'sell',
          type: 'market',
          time_in_force: 'day',
        });
        console.log(`  ✓ Auto partial-sold ${action.shares} ${t.symbol} @ ${action.level}`);
      } catch (e) {
        console.error(`  Auto partial-exit failed for ${t.symbol}: ${e.message}`);
      }
    }
  }
}

// ─── Auto-Execute Stops ──────────────────────────────────────────────────────

async function _autoExecuteStops(firedAlerts) {
  const { configured } = alpaca.getConfig();
  if (process.env.AUTO_STOP_EXECUTE !== 'true' || !configured) return;

  for (const alert of firedAlerts) {
    if (alert.type === 'stop_violation') {
      try {
        await alpaca.submitOrder({
          symbol: alert.symbol,
          qty: 0, // Close entire position
          side: 'sell',
          type: 'market',
          time_in_force: 'day',
        });
        console.log(`  Auto-sold ${alert.symbol} on stop violation (price: $${alert.current_price})`);
      } catch (e) {
        console.error(`  Auto-stop failed for ${alert.symbol}: ${e.message}`);
      }
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
    }, { scheduled: true });

    // Expire stale staged orders every hour
    cron.schedule('0 * * * *', () => {
      expireStaleOrders();
    }, { scheduled: true });

    console.log('   Cron Backup: ✓ Running (every 5 min, market hours)');
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
    const result = runBreadthEarlyWarning({ autoApply });
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

    const { configured } = alpaca.getConfig();
    const autoExec = process.env.AUTO_STOP_EXECUTE === 'true' && configured;
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

        // Auto-execute exit if enabled
        if (autoExec) {
          try {
            await alpaca.submitOrder({
              symbol: trade.symbol,
              qty: trade.remaining_shares || trade.shares,
              side: trade.side === 'short' ? 'buy' : 'sell',
              type: 'market',
              time_in_force: 'day',
            });
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

module.exports = {
  startStopMonitor, stopMonitor, getMonitorStatus,
  checkPositionsAgainstStops, checkStrategyExits, checkBreadthEarlyWarning,
  reconcilePositions,
  priceStream, // Export for routes to expose status
};
