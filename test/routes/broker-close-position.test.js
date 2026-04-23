// ─── Tests: /broker/close-position multi-tranche flatten ──────────────────
//
// Historical bug: DAL had 3 open journal rows (3 tranches). The user clicked
// Exit → market close. The route only updated the most-recent row; the
// other two stayed open. Alpaca was flat; journal said 2/3 still open.
// P&L, heat, and sector concentration were all wrong after that.
//
// Fix: for the MARKET branch (no exitPrice), the route now closes EVERY
// open row for the symbol in one DB transaction, all priced at the single
// fill price returned by alpaca.closePosition.
//
// LIMIT branch (exitPrice provided) still only touches the single targeted
// row — a limit close is partial by construction.
//
// These tests bypass HTTP and exercise the route handler directly by
// mounting it on an express app and firing requests via http.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// Stub alpaca module BEFORE the route loads it.
const alpacaStub = {
  _closeFill: { id: 'CLOSE-1', status: 'filled', filled_avg_price: 105, type: 'market' },
  _limitFill: { id: 'LIMIT-1', status: 'new', filled_avg_price: null, type: 'limit' },
  _openOrders: [],
  getOrders:      async () => alpacaStub._openOrders,
  cancelOrder:    async () => ({}),
  closePosition:  async (symbol) => ({ ...alpacaStub._closeFill, symbol }),
  submitOrder:    async (args) => ({ ...alpacaStub._limitFill, symbol: args.symbol }),
};
require.cache[require.resolve('../../src/broker/alpaca')] = { exports: alpacaStub };

// Stub the notification channel so we don't spam test runs with delivery
// side effects.
require.cache[require.resolve('../../src/notifications/channels')] = {
  exports: {
    notifyTradeEvent: async () => {},
    deliverAlert:     async () => [],
  },
};

const { getDB } = require('../../src/data/database');
const brokerRoutes = require('../../src/routes/broker');

// Build a mini express app pointed at the test DB.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', brokerRoutes(getDB()));
  return app;
}

// Fire a JSON POST at the test server. Returns { status, body }.
function postJson(server, path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const { port } = server.address();
    const req = http.request({
      method: 'POST', host: '127.0.0.1', port, path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (_) { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function withServer(fn) {
  return new Promise((resolve, reject) => {
    const app = makeApp();
    const server = app.listen(0, async () => {
      try {
        const out = await fn(server);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

function wipe() {
  const db = getDB();
  db.prepare('DELETE FROM trades').run();
  alpacaStub._openOrders = [];
}

function insertTrancheRow({ symbol = 'DAL', shares = 10, entry = 40, stop = 38 } = {}) {
  return getDB().prepare(`
    INSERT INTO trades (symbol, side, shares, entry_price, entry_date, stop_price)
    VALUES (?, 'long', ?, ?, '2026-04-15', ?)
  `).run(symbol, shares, entry, stop).lastInsertRowid;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('market close: flattens ALL open rows for the symbol', async () => {
  await withServer(async (server) => {
    wipe();

    // Three tranches (DAL scenario).
    const t1 = insertTrancheRow({ symbol: 'DAL', shares: 10, entry: 40 });
    const t2 = insertTrancheRow({ symbol: 'DAL', shares: 10, entry: 41 });
    const t3 = insertTrancheRow({ symbol: 'DAL', shares: 10, entry: 42 });

    alpacaStub._closeFill = { id: 'CLOSE-DAL', status: 'filled', filled_avg_price: 45, type: 'market' };

    const { status, body } = await postJson(server, '/api/broker/close-position', {
      symbol: 'DAL',
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.journalState, 'closed_market');
    assert.equal(body.rowsClosed, 3, 'all 3 tranches must be closed in one shot');

    // All three rows must have exit_date set at the single fill price.
    const rows = getDB().prepare("SELECT id, exit_date, exit_price FROM trades WHERE symbol='DAL'").all();
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.ok(r.exit_date, `row ${r.id} must have exit_date`);
      assert.equal(r.exit_price, 45);
    }
  });
});

test('market close: pnl calculated per-row against each tranche\'s entry price', async () => {
  await withServer(async (server) => {
    wipe();

    insertTrancheRow({ symbol: 'AAPL', shares: 10, entry: 100, stop: 90 }); // +$100 at fill=110
    insertTrancheRow({ symbol: 'AAPL', shares: 10, entry: 105, stop: 90 }); // +$50  at fill=110

    alpacaStub._closeFill = { id: 'CLOSE-AAPL', status: 'filled', filled_avg_price: 110, type: 'market' };

    const { body } = await postJson(server, '/api/broker/close-position', { symbol: 'AAPL' });
    assert.equal(body.rowsClosed, 2);

    const rows = getDB().prepare("SELECT shares, entry_price, exit_price, pnl_dollars FROM trades WHERE symbol='AAPL' ORDER BY entry_price").all();
    assert.equal(rows[0].pnl_dollars, 100, 'tranche 1 (entry 100, exit 110, 10sh) → +$100');
    assert.equal(rows[1].pnl_dollars, 50,  'tranche 2 (entry 105, exit 110, 10sh) → +$50');
  });
});

test('limit close: touches ONLY the most-recent row (partial by construction)', async () => {
  await withServer(async (server) => {
    wipe();

    const t1 = insertTrancheRow({ symbol: 'NVDA', shares: 5, entry: 500 });
    const t2 = insertTrancheRow({ symbol: 'NVDA', shares: 5, entry: 510 });
    const t3 = insertTrancheRow({ symbol: 'NVDA', shares: 5, entry: 520 });

    alpacaStub._limitFill = { id: 'LIMIT-NVDA', status: 'new', type: 'limit' };

    const { body } = await postJson(server, '/api/broker/close-position', {
      symbol: 'NVDA', shares: 5, exitPrice: 550,
    });

    assert.equal(body.journalState, 'pending_limit_fill');
    assert.equal(body.pending, true);
    // Only row t3 (most recent) gets the pending_close pin; others untouched.
    const t3Row = getDB().prepare('SELECT pending_close_order_id, exit_date FROM trades WHERE id = ?').get(t3);
    const t1Row = getDB().prepare('SELECT pending_close_order_id, exit_date FROM trades WHERE id = ?').get(t1);
    const t2Row = getDB().prepare('SELECT pending_close_order_id, exit_date FROM trades WHERE id = ?').get(t2);
    assert.equal(t3Row.pending_close_order_id, 'LIMIT-NVDA');
    assert.equal(t3Row.exit_date, null, 'limit close does NOT close the journal row — only pins for fills-sync');
    assert.equal(t1Row.pending_close_order_id, null);
    assert.equal(t2Row.pending_close_order_id, null);
  });
});

test('explicit tradeId overrides the "all rows" fan-out even for market closes', async () => {
  // Edge case: the route supports passing a single tradeId. In that mode we
  // expect only that row to be touched — this lets callers close just one
  // tranche if they really want to, though it's a rare path.
  await withServer(async (server) => {
    wipe();

    const t1 = insertTrancheRow({ symbol: 'MSFT', shares: 10, entry: 400 });
    const t2 = insertTrancheRow({ symbol: 'MSFT', shares: 10, entry: 410 });

    alpacaStub._closeFill = { id: 'CLOSE-MSFT', status: 'filled', filled_avg_price: 420, type: 'market' };

    const { body } = await postJson(server, '/api/broker/close-position', {
      symbol: 'MSFT', tradeId: t1,
    });
    assert.equal(body.rowsClosed, 1, 'explicit tradeId → one row only');

    const r1 = getDB().prepare('SELECT exit_date FROM trades WHERE id = ?').get(t1);
    const r2 = getDB().prepare('SELECT exit_date FROM trades WHERE id = ?').get(t2);
    assert.ok(r1.exit_date);
    assert.equal(r2.exit_date, null);
  });
});

test('broker failure → HTTP 502 and journal untouched', async () => {
  await withServer(async (server) => {
    wipe();
    insertTrancheRow({ symbol: 'META', shares: 5, entry: 500 });

    // Force closePosition to throw.
    const origClose = alpacaStub.closePosition;
    alpacaStub.closePosition = async () => { throw new Error('Alpaca blew up'); };

    try {
      const { status, body } = await postJson(server, '/api/broker/close-position', { symbol: 'META' });
      assert.equal(status, 502);
      assert.equal(body.brokerSubmitted, false);

      // Journal row is still open — route must NOT have written exit data.
      const row = getDB().prepare("SELECT exit_date FROM trades WHERE symbol='META'").get();
      assert.equal(row.exit_date, null, 'on broker failure, journal must stay untouched');
    } finally {
      alpacaStub.closePosition = origClose;
    }
  });
});
