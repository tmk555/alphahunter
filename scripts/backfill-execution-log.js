#!/usr/bin/env node
// ─── backfill-execution-log.js ────────────────────────────────────────────
//
// One-time (or periodic) script that pulls every filled order from Alpaca's
// order history and writes them into the `execution_log` table so the
// slippage prediction engine (Phase 2.9) has real data to learn from.
//
// The slippage predictor needs >= 5 fills per symbol (tier A) or >= 10
// global fills (tier C) before it returns meaningful numbers instead of
// hard-coded defaults. Most traders have dozens to hundreds of fills in
// Alpaca that have never been logged — this script backfills them in one
// shot.
//
// USAGE
//   node scripts/backfill-execution-log.js                  # backfill all
//   node scripts/backfill-execution-log.js --dry-run        # preview only
//   node scripts/backfill-execution-log.js --since 2025-01-01  # custom start
//   node scripts/backfill-execution-log.js --enrich         # fetch OHLCV for
//                                                            # fill quality calc
//
// WHAT IT DOES
//   1. Paginates through all closed Alpaca orders (500 per page)
//   2. Filters to status === 'filled'
//   3. Deduplicates against existing execution_log rows
//   4. Matches to trades table where possible (for trade_id FK)
//   5. Determines intended_price from order type:
//        - limit orders: limit_price
//        - stop/stop_limit: stop_price
//        - market: matched trade's entry/exit price, or fill price fallback
//   6. Optionally enriches with OHLCV data for fill quality
//   7. Calls logExecution() for each new fill
//
// SAFE: idempotent — running twice won't create duplicates.

require('dotenv').config();

const { getDB }       = require('../src/data/database');
const { logExecution } = require('../src/risk/execution-quality');
const alpaca           = require('../src/broker/alpaca');

// ─── CLI args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ENRICH  = args.includes('--enrich');
const sinceIdx = args.indexOf('--since');
const SINCE   = sinceIdx >= 0 && args[sinceIdx + 1]
  ? args[sinceIdx + 1]
  : '2024-01-01';

// ─── Helpers ──────────────────────────────────────────────────────────────

function isoDate(ts) {
  if (!ts) return null;
  return new Date(ts).toISOString().split('T')[0];
}

function log(...a) { console.log('  ', ...a); }

// Build an index of trades by alpaca_order_id for fast lookup.
function buildTradeIndex() {
  const db = getDB();
  const rows = db.prepare(`
    SELECT id, symbol, side, entry_price, exit_price, stop_price,
           entry_date, exit_date, alpaca_order_id
    FROM trades
    WHERE alpaca_order_id IS NOT NULL
  `).all();
  const idx = {};
  for (const r of rows) {
    idx[r.alpaca_order_id] = r;
  }
  return idx;
}

// Build a set of existing execution_log entries for dedup.
// Key: "SYMBOL|SIDE|FILL_DATE|FILL_PRICE" — unique enough for practical dedup.
function buildExistingSet() {
  const db = getDB();
  const rows = db.prepare(`
    SELECT symbol, side, fill_date, fill_price FROM execution_log
  `).all();
  const s = new Set();
  for (const r of rows) {
    s.add(`${r.symbol}|${r.side}|${r.fill_date}|${r.fill_price}`);
  }
  return s;
}

// Determine the "intended price" — the price the trader expected to get.
// This is the key input for slippage calculation.
function intendedPrice(order, matchedTrade) {
  // Limit orders: the limit_price IS what you asked for.
  if (order.limit_price != null) return Number(order.limit_price);

  // Stop/stop-limit: the stop_price is the trigger.
  if (order.stop_price != null) return Number(order.stop_price);

  // Market orders: no stated price. Best we can do is the trade's intended
  // entry (buy) or exit (sell), or fall back to the fill itself (0 slippage).
  if (matchedTrade) {
    if (order.side === 'buy') return matchedTrade.entry_price;
    if (order.side === 'sell') return matchedTrade.exit_price || matchedTrade.entry_price;
  }

  // Last resort — fill price → zero slippage, which is honest ("we don't
  // know what you intended, so we can't measure the gap").
  return order.filled_avg_price != null ? Number(order.filled_avg_price) : 0;
}

function orderTypeLabel(type) {
  // Alpaca uses: market, limit, stop, stop_limit, trailing_stop
  return type || 'unknown';
}

// ─── OHLCV enrichment (optional) ──────────────────────────────────────────
// Fetches daily history and finds the bar matching the fill date to
// populate dayHigh, dayLow, dayVolume for fill_quality calculation.

let _historyCache = {};
async function getOhlcvForDate(symbol, dateStr) {
  if (!ENRICH) return {};
  try {
    if (!_historyCache[symbol]) {
      const { getHistory } = require('../src/data/providers/manager');
      _historyCache[symbol] = await getHistory(symbol);
    }
    const bars = _historyCache[symbol];
    if (!Array.isArray(bars)) return {};
    // Find bar matching date
    const bar = bars.find(b => {
      const d = b.date || b.timestamp;
      return d && d.startsWith(dateStr);
    });
    if (!bar) return {};
    return {
      dayHigh: bar.high,
      dayLow: bar.low,
      dayOpen: bar.open,
      dayClose: bar.close,
      dayVolume: bar.volume,
    };
  } catch (_) {
    return {};
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Backfill Execution Log from Alpaca Fill History');
  console.log('  ================================================');
  log(`Since: ${SINCE}`);
  log(`Dry run: ${DRY_RUN}`);
  log(`OHLCV enrichment: ${ENRICH}`);
  console.log();

  // Check Alpaca credentials.
  const { configured } = alpaca.getConfig();

  // Build indexes.
  const tradeIndex = buildTradeIndex();
  const existing   = buildExistingSet();
  log(`Trades in DB: ${Object.keys(tradeIndex).length} (with alpaca_order_id)`);
  log(`Existing execution_log entries: ${existing.size}`);
  console.log();

  // Paginate through all closed orders from Alpaca.
  let allOrders = [];
  let after = new Date(SINCE).toISOString();
  let page = 0;
  const PAGE_SIZE = 500;

  log('Fetching orders from Alpaca...');
  while (true) {
    page++;
    let orders;
    try {
      orders = await alpaca.getOrders({
        status: 'closed',
        limit: PAGE_SIZE,
        after,
        direction: 'asc',
      });
    } catch (e) {
      console.error(`  Alpaca API error: ${e.message}`);
      if (e.message.includes('not configured')) {
        console.error('  Set ALPACA_API_KEY and ALPACA_API_SECRET in .env');
      }
      process.exit(1);
    }

    if (!Array.isArray(orders) || orders.length === 0) break;
    allOrders = allOrders.concat(orders);
    log(`  Page ${page}: ${orders.length} orders (total: ${allOrders.length})`);

    // Advance cursor past the last order's created_at timestamp.
    const last = orders[orders.length - 1];
    after = last.created_at || last.submitted_at;
    if (!after || orders.length < PAGE_SIZE) break;
  }

  // Filter to filled only. Alpaca "closed" includes cancelled, expired, etc.
  const filled = allOrders.filter(o => o.status === 'filled');
  log(`\nTotal closed orders: ${allOrders.length}`);
  log(`Filled orders: ${filled.length}`);

  // Process fills.
  let inserted = 0, skipped = 0, errors = 0;
  const symbolCounts = {};

  for (const order of filled) {
    const symbol    = order.symbol;
    const side      = order.side;  // 'buy' or 'sell'
    const fillPrice = Number(order.filled_avg_price);
    const fillQty   = Number(order.filled_qty || order.qty);
    const fillDate  = isoDate(order.filled_at);
    const orderDate = isoDate(order.submitted_at);
    const orderType = orderTypeLabel(order.type);

    // Dedup check.
    const key = `${symbol}|${side}|${fillDate}|${fillPrice}`;
    if (existing.has(key)) {
      skipped++;
      continue;
    }

    // Match to trades table.
    const matchedTrade = tradeIndex[order.id] || null;
    // Also try parent_order_id match for bracket legs.
    const parentMatch  = order.parent_order_id
      ? tradeIndex[order.parent_order_id] || null
      : null;
    const trade = matchedTrade || parentMatch;
    const tradeId = trade ? trade.id : null;

    // Compute intended price.
    const intended = intendedPrice(order, trade);

    // Optional OHLCV enrichment.
    const ohlcv = await getOhlcvForDate(symbol, fillDate);

    if (DRY_RUN) {
      const slip = intended > 0
        ? ((side === 'buy' ? fillPrice - intended : intended - fillPrice) / intended * 100).toFixed(3)
        : '0.000';
      log(`[DRY] ${symbol} ${side} ${fillDate} — fill: $${fillPrice.toFixed(2)}, intended: $${intended.toFixed(2)}, slip: ${slip}%, type: ${orderType}, trade_id: ${tradeId || 'N/A'}`);
      inserted++;
    } else {
      try {
        logExecution({
          tradeId,
          symbol,
          side,
          intendedPrice: intended,
          fillPrice,
          shares:    fillQty,
          orderType,
          signalDate: trade ? trade.entry_date : null,
          orderDate,
          fillDate,
          dayHigh:   ohlcv.dayHigh,
          dayLow:    ohlcv.dayLow,
          dayOpen:   ohlcv.dayOpen,
          dayClose:  ohlcv.dayClose,
          dayVolume: ohlcv.dayVolume,
        });
        existing.add(key);  // update dedup set
        inserted++;
      } catch (e) {
        log(`[ERR] ${symbol} ${side} ${fillDate}: ${e.message}`);
        errors++;
      }
    }

    symbolCounts[symbol] = (symbolCounts[symbol] || 0) + 1;
  }

  // ─── Report ────────────────────────────────────────────────────────────
  console.log('\n  ── Summary ──────────────────────────────────');
  log(`Filled orders scanned: ${filled.length}`);
  log(`Already in execution_log: ${skipped}`);
  log(`${DRY_RUN ? 'Would insert' : 'Inserted'}: ${inserted}`);
  if (errors > 0) log(`Errors: ${errors}`);

  const symbols = Object.entries(symbolCounts).sort((a, b) => b[1] - a[1]);
  if (symbols.length > 0) {
    console.log('\n  Per-symbol fill counts:');
    for (const [sym, count] of symbols) {
      log(`  ${sym.padEnd(6)} ${String(count).padStart(4)} fills`);
    }
  }

  // Show tier readiness.
  if (!DRY_RUN && inserted > 0) {
    const db = getDB();
    const tierA = db.prepare(`
      SELECT symbol, side, order_type, COUNT(*) as n
      FROM execution_log
      GROUP BY symbol, side, order_type
      HAVING n >= 5
    `).all();
    const tierC = db.prepare('SELECT COUNT(*) as n FROM execution_log').get();
    console.log('\n  Slippage prediction tier readiness:');
    log(`Tier A (symbol+side+orderType >= 5): ${tierA.length} combos`);
    for (const r of tierA) {
      log(`  ${r.symbol} ${r.side} ${r.order_type}: ${r.n} fills`);
    }
    log(`Tier C (global >= 10): ${tierC.n >= 10 ? 'YES' : 'NO'} (${tierC.n} total fills)`);
  }

  console.log('\n  Done.\n');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
