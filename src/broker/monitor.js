// ─── Stop Monitor Scheduler ─────────────────────────────────────────────────
// Checks positions against stops every 5 minutes during market hours
const cron = require('node-cron');
const alpaca = require('./alpaca');
const { checkAlerts, getActiveAlerts } = require('./alerts');
const { expireStaleOrders } = require('./staging');
const { getDB } = require('../data/database');
const { yahooQuote } = require('../data/providers/yahoo');

let monitorTask = null;
let lastCheck = null;
let checkCount = 0;

function db() { return getDB(); }

// ─── Core: Check positions against stops ────────────────────────────────────

async function checkPositionsAgainstStops() {
  try {
    const activeAlerts = getActiveAlerts();
    if (!activeAlerts.length) {
      lastCheck = { time: new Date().toISOString(), alerts: 0, fired: 0, skipped: 'no active alerts' };
      return;
    }

    // Get unique symbols from active alerts
    const symbols = [...new Set(activeAlerts.map(a => a.symbol))];

    // Fetch current prices — use Alpaca positions if available, otherwise Yahoo
    const currentPrices = {};
    const { configured } = alpaca.getConfig();

    if (configured) {
      try {
        const positions = await alpaca.getPositions();
        for (const pos of positions) {
          currentPrices[pos.symbol] = +pos.current_price;
        }
      } catch (_) { /* fall through to Yahoo */ }
    }

    // Fill any missing prices from Yahoo (batched)
    const missing = symbols.filter(s => !currentPrices[s]);
    if (missing.length) {
      try {
        const quotes = await yahooQuote(missing);
        for (const q of quotes) {
          if (q.regularMarketPrice) currentPrices[q.symbol] = q.regularMarketPrice;
        }
      } catch (e) {
        console.error(`  Monitor: Yahoo quote failed: ${e.message}`);
      }
    }

    // Check alerts against current prices
    const fired = await checkAlerts(currentPrices);

    // Auto-execute stops if enabled
    if (process.env.AUTO_STOP_EXECUTE === 'true' && configured) {
      for (const alert of fired) {
        if (alert.type === 'stop_violation') {
          try {
            await alpaca.submitOrder({
              symbol: alert.symbol,
              qty: 0, // Close entire position
              side: 'sell',
              type: 'market',
              time_in_force: 'day',
            });
            console.log(`  Auto-sold ${alert.symbol} on stop violation`);
          } catch (e) {
            console.error(`  Auto-stop failed for ${alert.symbol}: ${e.message}`);
          }
        }
      }
    }

    checkCount++;
    lastCheck = {
      time: new Date().toISOString(),
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

function startStopMonitor() {
  if (monitorTask) return;

  // Every 5 minutes, weekdays only
  monitorTask = cron.schedule('*/5 * * * 1-5', async () => {
    // Check market hours if Alpaca is configured
    const { configured } = alpaca.getConfig();
    if (configured) {
      try {
        const { open } = await alpaca.isMarketOpen();
        if (!open) return; // Skip outside market hours
      } catch (_) { /* If clock check fails, still run — Yahoo doesn't need market hours */ }
    }

    await checkPositionsAgainstStops();
  }, { scheduled: true });

  // Also expire stale staged orders every hour
  cron.schedule('0 * * * *', () => {
    expireStaleOrders();
  }, { scheduled: true });

  console.log('   Stop Monitor: ✓ Running (every 5 min, market hours)');
}

function stopMonitor() {
  if (monitorTask) {
    monitorTask.stop();
    monitorTask = null;
  }
}

function getMonitorStatus() {
  return {
    running: !!monitorTask,
    lastCheck,
    totalChecks: checkCount,
    activeAlerts: getActiveAlerts().length,
  };
}

module.exports = {
  startStopMonitor, stopMonitor, getMonitorStatus,
  checkPositionsAgainstStops, reconcilePositions,
};
