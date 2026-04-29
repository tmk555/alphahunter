// ─── Tests: journal → broker stop sync (src/broker/stops-sync.js) ──────────
//
// This is the path that bit the user hardest. Pre-fix the journal said
// "stop tightened to $173.58" while Alpaca's actual broker leg sat at
// $339.31, so positions sat -4% to -7% in the red with the journal flag
// "STOP VIOLATED" but no exit ever firing. This module is the sole bridge
// between the journal's stop_price column and what Alpaca will actually
// execute on. Every Alpaca quirk we hit deserves a regression test.
//
// We stub the alpaca module so the sync runs deterministically — no
// network, no API keys.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Stubs installed BEFORE requiring stops-sync ────────────────────────────
const alpacaStub = {
  _positions: [],
  _orders: [],
  // Capture every API call the sync issues for assertions.
  _calls: { patchStop: [], cancel: [], submit: [], close: [] },
  // Optional override for the patch endpoint — tests use this to simulate
  // 404 / 422 / etc. without poking module internals.
  _patchHandler: null,
  _submitHandler: null,
  _closeHandler: null,

  getPositions: async () => alpacaStub._positions,
  getOrders: async ({ status } = {}) => {
    if (status === 'all') return alpacaStub._orders;
    if (status === 'open') return alpacaStub._orders.filter(o => ['new', 'accepted', 'held', 'pending_new', 'pending_replace', 'partially_filled', 'replaced'].includes(o.status));
    if (status === 'closed') return alpacaStub._orders.filter(o => ['filled', 'canceled', 'expired', 'rejected'].includes(o.status));
    return alpacaStub._orders;
  },
  cancelOrder: async (id) => {
    alpacaStub._calls.cancel.push(id);
    // Mark the order canceled in our state so subsequent getOrders polls
    // see it transition out of pending_cancel naturally.
    const o = alpacaStub._orders.find(x => x.id === id);
    if (o) o.status = 'canceled';
  },
  submitOrder: async (params) => {
    alpacaStub._calls.submit.push(params);
    if (alpacaStub._submitHandler) return alpacaStub._submitHandler(params);
    return { id: `submitted-${alpacaStub._calls.submit.length}`, ...params };
  },
  closePosition: async (symbol) => {
    alpacaStub._calls.close.push(symbol);
    if (alpacaStub._closeHandler) return alpacaStub._closeHandler(symbol);
    return { id: `close-${symbol}-${Date.now()}`, symbol };
  },
};
require.cache[require.resolve('../../src/broker/alpaca')] = { exports: alpacaStub };

// stops-sync's _patchStopPrice goes directly to fetch() because it doesn't
// go through the alpaca module. Override global fetch for this test file.
const originalFetch = global.fetch;
global.fetch = async (url, opts) => {
  // Only intercept Alpaca PATCH /v2/orders/<id> calls that stops-sync
  // makes for stop-price updates.
  const m = /\/v2\/orders\/([^/]+)$/.exec(url || '');
  if (m && opts?.method === 'PATCH') {
    alpacaStub._calls.patchStop.push({ id: m[1], body: JSON.parse(opts.body) });
    if (alpacaStub._patchHandler) {
      const result = alpacaStub._patchHandler(m[1], JSON.parse(opts.body));
      // Return shape mirrors fetch's Response.
      return {
        ok: result.ok !== false,
        status: result.status || 200,
        text: async () => JSON.stringify(result.body || { id: m[1] }),
        json: async () => result.body || { id: m[1] },
      };
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({ id: m[1] }) };
  }
  return originalFetch ? originalFetch(url, opts) : { ok: false, status: 500 };
};

// Provider-manager stub (only getQuotes is called by stops-sync's
// last-close fallback path; we don't need it for the stop-sync tests).
require.cache[require.resolve('../../src/data/providers/manager')] = {
  exports: { getQuotes: async () => [] },
};

const { getDB } = require('../../src/data/database');
const { syncJournalStopsToBroker } = require('../../src/broker/stops-sync');

function wipeAll() {
  const db = getDB();
  db.prepare('DELETE FROM trades').run();
  alpacaStub._positions = [];
  alpacaStub._orders = [];
  alpacaStub._calls = { patchStop: [], cancel: [], submit: [], close: [] };
  alpacaStub._patchHandler = null;
  alpacaStub._submitHandler = null;
  alpacaStub._closeHandler = null;
}

function insertOpenTrade({ symbol, shares, entry, stop, side = 'long' } = {}) {
  return getDB().prepare(`
    INSERT INTO trades (symbol, side, shares, remaining_shares, entry_price, entry_date, stop_price)
    VALUES (?, ?, ?, ?, ?, '2026-04-20', ?)
  `).run(symbol, side, shares, shares, entry, stop).lastInsertRowid;
}

function mkPosition({ symbol, qty = 10, avgEntry = 100, currentPrice = 110 } = {}) {
  return { symbol, qty, avg_entry_price: avgEntry, current_price: currentPrice };
}

function mkOrder({ id, symbol, side = 'sell', type = 'stop', qty = 10,
                   stopPrice = null, limitPrice = null, status = 'held' } = {}) {
  return {
    id, symbol, side, type, qty,
    stop_price: stopPrice, limit_price: limitPrice, status,
    legs: null,
  };
}

// ─── 1. Drift detected — patch existing leg up to journal stop ──────────────
test('drift: broker stop $X < journal stop $Y → PATCH leg up to $Y', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 105 });
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 10, avgEntry: 100, currentPrice: 108 })];
  alpacaStub._orders = [mkOrder({ id: 'leg-1', symbol: 'TEST', stopPrice: 100, status: 'held' })];

  const r = await syncJournalStopsToBroker();
  const plan = r.plans.find(p => p.symbol === 'TEST');
  assert.equal(plan.desiredStop, 105);
  assert.equal(plan.coveredQty, 10);
  assert.equal(plan.uncovered, 0);
  assert.equal(alpacaStub._calls.patchStop.length, 1, 'should issue exactly one PATCH');
  assert.equal(alpacaStub._calls.patchStop[0].id, 'leg-1');
  assert.equal(alpacaStub._calls.patchStop[0].body.stop_price, 105);
});

// ─── 2. Never-loosen — broker stop tighter than journal → no patch ──────────
test('never loosen: broker stop ABOVE journal target (long) → skip', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 95 });
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 10, currentPrice: 110 })];
  alpacaStub._orders = [mkOrder({ id: 'leg-1', symbol: 'TEST', stopPrice: 100, status: 'held' })];

  await syncJournalStopsToBroker();

  assert.equal(alpacaStub._calls.patchStop.length, 0, 'must not patch when target is wider');
});

// ─── 3. Already-correct — no-op ─────────────────────────────────────────────
test('no-op: broker stop matches journal exactly → no patch', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 105 });
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 10, currentPrice: 108 })];
  alpacaStub._orders = [mkOrder({ id: 'leg-1', symbol: 'TEST', stopPrice: 105, status: 'held' })];

  await syncJournalStopsToBroker();

  assert.equal(alpacaStub._calls.patchStop.length, 0);
  assert.equal(alpacaStub._calls.submit.length, 0);
});

// ─── 4. Naked position — no broker stop exists → CREATE one ────────────────
test('naked: no broker sell-stop exists → submitOrder type=stop', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 95 });
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 10, currentPrice: 110 })];
  alpacaStub._orders = [];

  await syncJournalStopsToBroker();

  assert.equal(alpacaStub._calls.submit.length, 1);
  const submitted = alpacaStub._calls.submit[0];
  assert.equal(submitted.symbol, 'TEST');
  assert.equal(submitted.side, 'sell');
  assert.equal(submitted.type, 'stop');
  assert.equal(submitted.qty, 10);
  assert.equal(submitted.stop_price, 95);
});

// ─── 5. Breached + naked — current < journal stop → MARKET CLOSE ───────────
test('breached + naked: current price ≤ journal stop → closePosition (market sell)', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 105 });
  // Current price 102 is BELOW journal stop 105 → breached.
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 10, currentPrice: 102 })];
  alpacaStub._orders = [];

  await syncJournalStopsToBroker();

  assert.equal(alpacaStub._calls.close.length, 1, 'should call closePosition');
  assert.equal(alpacaStub._calls.close[0], 'TEST');
  assert.equal(alpacaStub._calls.submit.length, 0, 'should NOT submit a stop above current');
});

// ─── 6. Held-leg PATCH 404 → cancel + resubmit standalone ──────────────────
test('PATCH 404: held bracket leg cancelled and resubmitted as standalone stop', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 105 });
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 10, currentPrice: 108 })];
  alpacaStub._orders = [mkOrder({ id: 'leg-held', symbol: 'TEST', stopPrice: 100, status: 'held' })];
  // Simulate Alpaca refusing PATCH on held legs.
  alpacaStub._patchHandler = () => ({ ok: false, status: 404, body: { message: 'Not Found' } });

  const r = await syncJournalStopsToBroker();

  assert.equal(alpacaStub._calls.cancel.length, 1, 'must cancel the held leg');
  assert.equal(alpacaStub._calls.cancel[0], 'leg-held');
  assert.equal(alpacaStub._calls.submit.length, 1, 'must resubmit a fresh standalone stop');
  assert.equal(alpacaStub._calls.submit[0].stop_price, 105);
  // The plan should record what we resubmitted as.
  const plan = r.plans.find(p => p.symbol === 'TEST');
  assert.ok(plan.legPatches[0].resubmittedAs, 'plan should expose resubmittedAs id');
});

// ─── 7. Idempotent: existing market sell pending → don't queue another ─────
test('dedup: pending market sell on symbol → skip submitting another', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 105 });
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 10, currentPrice: 102 })]; // breached
  // A market sell is already queued from a prior sync.
  alpacaStub._orders = [
    { id: 'pending-mkt', symbol: 'TEST', side: 'sell', type: 'market', qty: 10, status: 'accepted' }
  ];

  const r = await syncJournalStopsToBroker();

  assert.equal(alpacaStub._calls.close.length, 0, 'must NOT submit a duplicate close');
  const plan = r.plans.find(p => p.symbol === 'TEST');
  assert.match(String(plan.marketCloseId || ''), /already queued/);
});

// ─── 8. Multi-tranche: tightest journal stop wins (long → MAX) ─────────────
test('multi-tranche: 3 journal rows with stops 100/105/103 → uses 105', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 5, entry: 100, stop: 100 });
  insertOpenTrade({ symbol: 'TEST', shares: 5, entry: 100, stop: 105 });
  insertOpenTrade({ symbol: 'TEST', shares: 5, entry: 100, stop: 103 });
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 15, currentPrice: 110 })];
  alpacaStub._orders = [mkOrder({ id: 'leg-1', symbol: 'TEST', stopPrice: 100, qty: 15, status: 'held' })];

  const r = await syncJournalStopsToBroker();

  const plan = r.plans.find(p => p.symbol === 'TEST');
  assert.equal(plan.desiredStop, 105, 'tightest (highest for long) journal stop wins');
  assert.equal(alpacaStub._calls.patchStop[0].body.stop_price, 105);
});

// ─── 9. Zombie symbol (broker reports zero qty) → skip ─────────────────────
test('zombie: journal-open + broker zero qty → skip with reason', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 95 });
  alpacaStub._positions = []; // broker says nothing
  alpacaStub._orders = [];

  const r = await syncJournalStopsToBroker();

  assert.equal(alpacaStub._calls.submit.length, 0);
  assert.equal(alpacaStub._calls.close.length, 0);
  // Plan IS reported with action='skip' so the cron log explains why
  // nothing happened. The zombie reconciler in fills-sync handles closing
  // the journal row; stops-sync just gets out of its way.
  const plan = r.plans.find(p => p.symbol === 'TEST');
  assert.ok(plan, 'should report a plan for the zombie symbol');
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /zero qty/);
});

// ─── 10. Dry-run preview returns plan but performs no API writes ──────────
test('dry-run: returns same plan but never calls submit/cancel/close/PATCH', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 105 });
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 10, currentPrice: 108 })];
  alpacaStub._orders = [mkOrder({ id: 'leg-1', symbol: 'TEST', stopPrice: 100, status: 'held' })];

  const r = await syncJournalStopsToBroker({ dryRun: true });

  assert.equal(r.dryRun, true);
  assert.equal(alpacaStub._calls.patchStop.length, 0);
  assert.equal(alpacaStub._calls.submit.length, 0);
  assert.equal(alpacaStub._calls.cancel.length, 0);
  // Plan still describes intended action.
  const plan = r.plans.find(p => p.symbol === 'TEST');
  assert.equal(plan.desiredStop, 105);
  assert.equal(plan.legPatches.length, 1);
  assert.equal(plan.legPatches[0].action, 'patch');
});

// ─── 11. Excludes terminal-status orders from coverage tally ───────────────
test('coverage tally: canceled / expired / filled orders are NOT counted as coverage', async () => {
  wipeAll();
  insertOpenTrade({ symbol: 'TEST', shares: 10, entry: 100, stop: 95 });
  alpacaStub._positions = [mkPosition({ symbol: 'TEST', qty: 10, currentPrice: 110 })];
  // Old canceled stop + a filled limit shouldn't fool the sync into thinking
  // we're covered. Only the held one counts.
  alpacaStub._orders = [
    mkOrder({ id: 'old-1', symbol: 'TEST', stopPrice: 80, status: 'canceled', qty: 10 }),
    mkOrder({ id: 'old-2', symbol: 'TEST', stopPrice: 70, status: 'expired', qty: 10 }),
  ];

  await syncJournalStopsToBroker();

  // No held coverage → must create a fresh stop.
  assert.equal(alpacaStub._calls.submit.length, 1);
  assert.equal(alpacaStub._calls.submit[0].stop_price, 95);
});
