// ─── Tests: fills-sync reconciliation (src/broker/fills-sync.js) ───────────
//
// Two families of regressions we're pinning here:
//
//   1. exit_order_id DEDUPE — the sells loop used to have no idempotency key,
//      so each re-run would close a fresh row for every sell. Combined with
//      orphan-reconcile creating ghost rows, DELL produced 6 duplicate closes
//      on 2026-04-20. Fix: trades.exit_order_id is set on close; subsequent
//      syncs skip any sell whose id is already in the set.
//
//   2. reconcileOrphanPositions COOLDOWN — when a sell just closed a row but
//      Alpaca's position cache is still warm, reconcile would see the lingering
//      Alpaca position, not match any open trades row, and create a new
//      orphan. Fix: a 15-minute cooldown skips symbols whose most recent
//      exit_date is within the window.
//
// We stub the alpaca module at the require cache so the sync can run fully
// deterministically — no network, no Alpaca keys, fixed order/position data.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Stubs installed BEFORE requiring fills-sync ────────────────────────────
// fills-sync pulls from the alpaca module directly (not the adapter), so we
// have to replace the module in the require cache.
const alpacaStub = {
  _orders: [],      // what getOrders returns
  _positions: [],   // what getPositions returns
  getOrders:    async ({ status } = {}) => {
    // status='closed' → only filled orders (sync path).
    // status='all'    → everything (reconcile's order-history lookup).
    if (status === 'closed') return alpacaStub._orders.filter(o => o.status === 'filled');
    return alpacaStub._orders;
  },
  getPositions: async () => alpacaStub._positions,
  // Everything else fills-sync might transitively hit is a no-op.
};
require.cache[require.resolve('../../src/broker/alpaca')] = { exports: alpacaStub };

// Stub the tax + execution loggers — they touch DB tables we don't prep in
// this suite and would just clutter assertions. Failures inside them are
// already swallowed by fills-sync (try/catch), but stubbing is cleaner.
require.cache[require.resolve('../../src/risk/tax-engine')] = {
  exports: { createTaxLot: () => {}, sellTaxLots: () => {} },
};
require.cache[require.resolve('../../src/risk/execution-quality')] = {
  exports: { logExecution: () => {} },
};
require.cache[require.resolve('../../src/risk/strategy-manager')] = {
  exports: { assignStrategy: () => ({ strategy: 'test', confidence: 0 }) },
};
require.cache[require.resolve('../../src/risk/regime')] = {
  exports: { getMarketRegime: () => ({ regime: 'BULL' }) },
};

const { getDB } = require('../../src/data/database');
const { syncBrokerFills, reconcileOrphanPositions } = require('../../src/broker/fills-sync');

// Helper: reset DB state + stub data for a clean test.
function wipeAll() {
  const db = getDB();
  db.prepare('DELETE FROM trades').run();
  db.prepare('DELETE FROM staged_orders').run();
  alpacaStub._orders = [];
  alpacaStub._positions = [];
}

// Helper: insert an open long trade so sells can match.
function insertOpenTrade({ symbol = 'DELL', shares = 18, entry = 100, stop = 95,
                           entryDate = '2026-04-20', alpacaOrderId = null } = {}) {
  const info = getDB().prepare(`
    INSERT INTO trades (symbol, side, shares, entry_price, entry_date, stop_price, alpaca_order_id)
    VALUES (?, 'long', ?, ?, ?, ?, ?)
  `).run(symbol, shares, entry, entryDate, stop, alpacaOrderId);
  return info.lastInsertRowid;
}

// Helper: build an Alpaca-shaped order object. Keeps tests readable.
function mkOrder({ id, symbol, side, status = 'filled', qty = 10, price = 100,
                   filledAt = '2026-04-20T14:30:00Z', type = 'market' } = {}) {
  return {
    id, symbol, side, status, type,
    filled_qty: qty, filled_avg_price: price,
    qty,
    filled_at: filledAt,
    created_at: filledAt,
    submitted_at: filledAt,
  };
}

// ─── Bug #1a: exit_order_id dedupe ─────────────────────────────────────────

test('sells dedupe: re-running sync does NOT close a second row for the same sell id', async () => {
  wipeAll();

  // Two open rows for DELL (multi-tranche or reconcile-created duplicate).
  const row1 = insertOpenTrade({ symbol: 'DELL', shares: 18, entry: 100 });
  const row2 = insertOpenTrade({ symbol: 'DELL', shares: 18, entry: 100 });

  alpacaStub._orders = [
    mkOrder({ id: 'SELL-X', symbol: 'DELL', side: 'sell', qty: 18, price: 105 }),
  ];

  // First run: one real sell → closes exactly one row.
  await syncBrokerFills();

  const after1 = getDB().prepare('SELECT id, exit_date, exit_order_id FROM trades ORDER BY id').all();
  const closed1 = after1.filter(r => r.exit_date);
  assert.equal(closed1.length, 1, 'first sync must close exactly one row');
  assert.equal(closed1[0].exit_order_id, 'SELL-X', 'exit_order_id must be stamped');

  // Second run with the same sell still in the broker's 7-day window.
  // Without dedupe this would close row2 too — the historical DELL bug.
  await syncBrokerFills();

  const after2 = getDB().prepare('SELECT id, exit_date FROM trades ORDER BY id').all();
  const closed2 = after2.filter(r => r.exit_date);
  assert.equal(closed2.length, 1,
    'second sync with identical sell id must NOT close a second row (dedupe by exit_order_id)');
});

test('sells: pending_close_order_id pins the fill to the exact lot', async () => {
  wipeAll();

  // Two tranches of DELL, entered at different prices. Row A is the target.
  const rowA = insertOpenTrade({ symbol: 'DELL', shares: 9, entry: 100, entryDate: '2026-04-18' });
  const rowB = insertOpenTrade({ symbol: 'DELL', shares: 9, entry: 110, entryDate: '2026-04-20' }); // most-recent

  // rowA has a pending_close submitted; the sell is its fill.
  getDB().prepare(
    "UPDATE trades SET pending_close_order_id = 'SELL-P', pending_close_submitted_at = datetime('now') WHERE id = ?"
  ).run(rowA);

  alpacaStub._orders = [
    mkOrder({ id: 'SELL-P', symbol: 'DELL', side: 'sell', qty: 9, price: 103 }),
  ];

  await syncBrokerFills();

  const a = getDB().prepare('SELECT * FROM trades WHERE id = ?').get(rowA);
  const b = getDB().prepare('SELECT * FROM trades WHERE id = ?').get(rowB);
  assert.ok(a.exit_date, 'row A (pending-close) must be closed');
  assert.equal(a.exit_reason, 'manual_exit_fill', 'pending-close fills get manual_exit_fill, not auto_sync');
  assert.equal(a.exit_order_id, 'SELL-P');
  assert.equal(a.pending_close_order_id, null, 'pending_close_order_id cleared after fill');
  assert.equal(b.exit_date, null,
    'without the pending_close pin, legacy code would have closed row B (most-recent heuristic) — this is the bug fix');
});

// ─── Bug #1b: reconcile cooldown ───────────────────────────────────────────

test('reconcile: symbol closed <15 min ago is SKIPPED even if Alpaca still reports it', async () => {
  wipeAll();

  // Simulate a trade that just closed this minute.
  getDB().prepare(`
    INSERT INTO trades (symbol, side, shares, entry_price, entry_date, exit_date, exit_price, exit_reason)
    VALUES ('DELL', 'long', 18, 100, '2026-04-15', datetime('now'), 105, 'auto_sync')
  `).run();

  // Alpaca's positions cache is still warm — it reports DELL open.
  alpacaStub._positions = [
    { symbol: 'DELL', qty: '18', avg_entry_price: '100' },
  ];

  const result = await reconcileOrphanPositions({ lookbackDays: 90, recentCloseWindowMin: 15 });
  assert.deepEqual(result.reconciled, [],
    'DELL must NOT be reconciled — it was closed within the cooldown window');

  // And no new open row should have been created.
  const openRows = getDB().prepare(
    "SELECT id FROM trades WHERE symbol = 'DELL' AND exit_date IS NULL"
  ).all();
  assert.equal(openRows.length, 0,
    'no ghost open row may exist after cooldown-protected reconcile (this was the DELL 6-duplicate bug)');
});

test('reconcile: symbol closed LONG ago → still eligible (cooldown expired)', async () => {
  wipeAll();

  // Last close is 2 hours old — well outside the 15-min window.
  getDB().prepare(`
    INSERT INTO trades (symbol, side, shares, entry_price, entry_date, exit_date, exit_price, exit_reason)
    VALUES ('NVDA', 'long', 10, 500, '2026-03-01', datetime('now', '-2 hours'), 550, 'auto_sync')
  `).run();

  // And Alpaca really does still hold NVDA — user re-entered manually.
  alpacaStub._positions = [
    { symbol: 'NVDA', qty: '5', avg_entry_price: '520' },
  ];

  const result = await reconcileOrphanPositions({ lookbackDays: 90, recentCloseWindowMin: 15 });
  assert.equal(result.reconciled.length, 1, 'NVDA should reconcile — last close was 2h ago, past cooldown');
  assert.equal(result.reconciled[0].symbol, 'NVDA');

  const openRow = getDB().prepare(
    "SELECT shares, entry_price FROM trades WHERE symbol = 'NVDA' AND exit_date IS NULL"
  ).get();
  assert.equal(openRow.shares, 5);
  assert.equal(openRow.entry_price, 520);
});

test('reconcile: symbol already tracked in journal → untouched', async () => {
  wipeAll();

  // Open row already exists — reconcile should not double up.
  insertOpenTrade({ symbol: 'AAPL', shares: 100, entry: 200 });
  alpacaStub._positions = [
    { symbol: 'AAPL', qty: '100', avg_entry_price: '200' },
  ];

  const result = await reconcileOrphanPositions({ lookbackDays: 90 });
  assert.deepEqual(result.reconciled, [], 'tracked symbol must never be reconciled');
  const count = getDB().prepare("SELECT COUNT(*) c FROM trades WHERE symbol='AAPL' AND exit_date IS NULL").get().c;
  assert.equal(count, 1, 'no duplicate row created');
});
