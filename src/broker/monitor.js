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

let monitorTask = null;
let lastCheck = null;
let checkCount = 0;
let streamingActive = false;

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

function getMonitorStatus() {
  return {
    running: !!monitorTask || streamingActive,
    streamStatus: priceStream.getStatus(),
    lastCheck,
    totalChecks: checkCount,
    activeAlerts: getActiveAlerts().length,
  };
}

// ─── Strategy-Based Exit Monitoring ────────────────────────────────────────
// For open trades tagged with a replay strategy, evaluate signal-based exits
// (RS drop, SEPA degrade, regime change) using the latest scan data.
// Runs alongside the cron stop check every 5 minutes.

const STRATEGY_EXIT_RULES = {
  rs_momentum:      { exitField: 'rsRank',        exitThreshold: 50, compare: 'below', reason: 'rs_dropped' },
  sepa_trend:       { exitField: 'sepaScore',      exitThreshold: 3,  compare: 'below', reason: 'sepa_degraded' },
  rs_line_new_high: { exitField: 'vsMA50',         exitThreshold: -5, compare: 'below', reason: 'below_ma50' },
  vcp_breakout:     null,  // ATR stop/target only — no signal exit
  conviction:       null,  // ATR stop/target only — no signal exit
};

async function checkStrategyExits() {
  try {
    // Get open trades with a strategy tag
    const trades = db().prepare(
      "SELECT * FROM trades WHERE exit_date IS NULL AND strategy IS NOT NULL"
    ).all();
    if (!trades.length) return [];

    // Get latest scan data from cache
    const { cacheGet, TTL_QUOTE } = require('../data/cache');
    const scanData = cacheGet('rs:full', TTL_QUOTE);
    if (!scanData || !scanData.length) return [];

    // Build lookup by ticker
    const scanMap = {};
    for (const s of scanData) scanMap[s.ticker] = s;

    // Check regime (applies to all long strategies)
    const spy = scanMap['SPY'];
    let regime = 'NEUTRAL';
    if (spy) {
      const above50 = (spy.vsMA50 || 0) > 0;
      const above200 = (spy.vsMA200 || 0) > 0;
      if (above50 && above200) regime = 'BULL';
      else if (!above50 && above200) regime = 'NEUTRAL';
      else if (above50 && !above200) regime = 'CAUTION';
      else regime = 'CORRECTION';
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
  checkPositionsAgainstStops, checkStrategyExits, reconcilePositions,
  priceStream, // Export for routes to expose status
};
