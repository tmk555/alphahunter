// ─── Tests: MockBrokerAdapter (contract coverage) ──────────────────────────
//
// These tests exercise the BrokerAdapter interface semantics via the mock
// adapter. They double as:
//   (a) A contract test — if the mock passes, real adapters can follow the
//       same expected behaviors.
//   (b) Documentation — each test describes one piece of the broker-as-
//       source-of-truth model so a reader understands the invariants.
//
// Key invariants under test:
//   1. Market entries auto-fill and activate child legs.
//   2. A limit bracket with held children fills via tick() crossing the
//      entry limit, which then arms the children.
//   3. Stop-out triggers the stop leg and cancels the TP sibling (OCO).
//   4. Target hit triggers the TP leg and cancels the stop sibling (OCO).
//   5. patchStopPrice() works on open stop legs.
//   6. replaceStopsForSymbol() patches every open stop leg for a symbol —
//      the move-to-breakeven path after tranche 1 fills.
//   7. Cancelling a bracket parent cancels all of its children.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockBrokerAdapter } = require('../../src/broker/adapters/mock');
const { assertAdapterContract } = require('../../src/broker/adapter');

function fresh() {
  const a = new MockBrokerAdapter();
  a.reset();
  return a;
}

// ─── Interface contract ─────────────────────────────────────────────────────

test('mock: satisfies BrokerAdapter contract', () => {
  const a = fresh();
  assert.doesNotThrow(() => assertAdapterContract(a));
  assert.equal(a.name, 'mock');
  assert.equal(a.isConfigured(), true);
});

// ─── Account & positions ────────────────────────────────────────────────────

test('mock: getAccount returns paper account with starting equity', async () => {
  const a = fresh();
  const acct = await a.getAccount();
  assert.equal(acct.connected, true);
  assert.equal(acct.paper, true);
  assert.equal(acct.equity, 100000);
});

test('mock: getAccount reports disconnected when !configured', async () => {
  const a = fresh();
  a._setConfigured(false);
  const acct = await a.getAccount();
  assert.equal(acct.connected, false);
  assert.equal(acct.configured, false);
});

test('mock: no positions on fresh adapter', async () => {
  const a = fresh();
  assert.deepEqual(await a.getPositions(), []);
  assert.equal(await a.getPosition('AAPL'), null);
});

// ─── Simple market order opens a position ──────────────────────────────────

test('mock: simple market buy fills at mark and creates a long position', async () => {
  const a = fresh();
  a._setMark('AAPL', 200);
  const o = await a.submitSimpleOrder({ symbol: 'AAPL', qty: 10, side: 'buy', type: 'market' });
  assert.equal(o.status, 'filled');
  assert.equal(o.filledAvgPrice, 200);
  const pos = await a.getPosition('AAPL');
  assert.equal(pos.qty, 10);
  assert.equal(pos.avgEntryPrice, 200);
  assert.equal(pos.side, 'long');
});

// ─── Single bracket: long, limit entry, stop + TP children ─────────────────

test('mock: limit bracket — tick crosses entry, arms children, then TP fires', async () => {
  const a = fresh();
  const bracket = await a.submitBracketOrder({
    symbol: 'AAPL', qty: 10, side: 'buy',
    entryType: 'limit', entryLimitPrice: 200,
    stopPrice: 190,
    takeProfitLimitPrice: 220,
  });
  // Parent is 'new' with children 'held'
  assert.equal(bracket.status, 'new');
  assert.equal(bracket.legs.length, 2);
  assert.ok(bracket.legs.every(l => l.status === 'held'));

  // Price crosses entry → parent fills, children arm
  a.tick('AAPL', 200);
  const parentAfter = await a.getOrder(bracket.id);
  assert.equal(parentAfter.status, 'filled');
  const openBefore = (await a.listOrders({ status: 'open', symbol: 'AAPL' }))
    .filter(o => o.parentOrderId);
  assert.equal(openBefore.length, 2);
  assert.ok(openBefore.every(o => o.status === 'new'));

  // Rally to target — TP fires, stop is cancelled (OCO)
  a.tick('AAPL', 221);
  const openAfter = (await a.listOrders({ status: 'open', symbol: 'AAPL' }))
    .filter(o => o.parentOrderId);
  assert.equal(openAfter.length, 0, 'both child legs should be closed after TP hits');
  const allChildren = (await a.listOrders({ status: 'all', symbol: 'AAPL' }))
    .filter(o => o.parentOrderId);
  const tp   = allChildren.find(o => o.type === 'limit');
  const stop = allChildren.find(o => o.type === 'stop' || o.type === 'stop_limit');
  assert.equal(tp.status, 'filled');
  assert.equal(stop.status, 'cancelled');
  assert.equal(await a.getPosition('AAPL'), null, 'position flat after TP');
});

test('mock: limit bracket — stop triggers and cancels TP sibling', async () => {
  const a = fresh();
  const bracket = await a.submitBracketOrder({
    symbol: 'NVDA', qty: 5, side: 'buy',
    entryType: 'limit', entryLimitPrice: 500,
    stopPrice: 480, takeProfitLimitPrice: 550,
  });
  a.tick('NVDA', 500);  // fill entry
  a.tick('NVDA', 479);  // break stop
  const children = (await a.listOrders({ status: 'all', symbol: 'NVDA' }))
    .filter(o => o.parentOrderId);
  const stop = children.find(o => o.type === 'stop');
  const tp   = children.find(o => o.type === 'limit');
  assert.equal(stop.status, 'filled');
  assert.equal(tp.status,   'cancelled');
  assert.equal(await a.getPosition('NVDA'), null);
});

// ─── Multi-tranche bracket (scale-out pyramid) ─────────────────────────────

test('mock: submitMultiTrancheBracket creates N brackets with shared stop', async () => {
  const a = fresh();
  const result = await a.submitMultiTrancheBracket({
    symbol: 'MSFT', side: 'buy',
    entryType: 'limit', entryLimitPrice: 400,
    stopPrice: 380,
    tranches: [
      { qty: 3, takeProfitLimitPrice: 420, label: 'target1' },
      { qty: 3, takeProfitLimitPrice: 460, label: 'target2' },
      { qty: 4, takeProfitLimitPrice: 500, label: 'runner'  },
    ],
  });
  assert.equal(result.totalQty, 10);
  assert.equal(result.tranches.length, 3);
  assert.deepEqual(result.tranches.map(t => t.label), ['target1', 'target2', 'runner']);

  // Every tranche should be its own parent with two held children
  for (const { order } of result.tranches) {
    assert.equal(order.status, 'new');
    assert.equal(order.legs.length, 2);
    assert.ok(order.legs.every(l => l.status === 'held'));
  }
});

test('mock: multi-tranche brackets — target1 hits closes tranche 1, others remain open', async () => {
  const a = fresh();
  const result = await a.submitMultiTrancheBracket({
    symbol: 'MSFT', side: 'buy',
    entryType: 'limit', entryLimitPrice: 400,
    stopPrice: 380,
    tranches: [
      { qty: 3, takeProfitLimitPrice: 420, label: 'target1' },
      { qty: 3, takeProfitLimitPrice: 460, label: 'target2' },
      { qty: 4, takeProfitLimitPrice: 500, label: 'runner'  },
    ],
  });
  a.tick('MSFT', 400);  // all three entries fill at 400
  const pos1 = await a.getPosition('MSFT');
  assert.equal(pos1.qty, 10);

  a.tick('MSFT', 421);  // only target1 hits
  const pos2 = await a.getPosition('MSFT');
  assert.equal(pos2.qty, 7, 'tranche 1 closed 3 shares, 7 remain');

  // Tranche 1's TP should be filled, stop cancelled. Tranches 2 & 3 still open.
  const tranche1Group = result.tranches[0].order.bracketGroupId;
  const tranche2Group = result.tranches[1].order.bracketGroupId;
  const t1Children = a._allOrders().filter(o => o.bracketGroupId === tranche1Group && o.parentOrderId);
  const t2Children = a._allOrders().filter(o => o.bracketGroupId === tranche2Group && o.parentOrderId);
  assert.equal(t1Children.find(o => o.type === 'limit').status, 'filled');
  assert.equal(t1Children.find(o => o.type === 'stop').status,   'cancelled');
  assert.ok(t2Children.every(o => o.status === 'new'), 'tranche 2 still open');
});

// ─── Move-to-breakeven: replaceStopsForSymbol ──────────────────────────────

test('mock: replaceStopsForSymbol patches every open stop leg to breakeven', async () => {
  const a = fresh();
  await a.submitMultiTrancheBracket({
    symbol: 'TSLA', side: 'buy',
    entryType: 'market',  // auto-fill entries
    stopPrice: 180,
    tranches: [
      { qty: 2, takeProfitLimitPrice: 220, label: 'target1' },
      { qty: 2, takeProfitLimitPrice: 240, label: 'target2' },
      { qty: 2, takeProfitLimitPrice: 260, label: 'runner'  },
    ],
  });
  a._setMark('TSLA', 200);

  // Simulate tranche 1 filling via tick, then move stops to breakeven
  a.tick('TSLA', 220);
  const posAfterT1 = await a.getPosition('TSLA');
  assert.equal(posAfterT1.qty, 4);

  const patched = await a.replaceStopsForSymbol({ symbol: 'TSLA', newStopPrice: 200 });
  assert.equal(patched.length, 2, 'only tranches 2 and 3 still have open stops');
  assert.ok(patched.every(o => o.stopPrice === 200));

  // Now drop to breakeven-1 → both remaining tranches stop out at 200
  a.tick('TSLA', 199);
  assert.equal(await a.getPosition('TSLA'), null);
});

// ─── patchStopPrice error paths ────────────────────────────────────────────

test('mock: patchStopPrice rejects filled orders and non-stop types', async () => {
  const a = fresh();
  a._setMark('QQQ', 400);
  const o = await a.submitSimpleOrder({ symbol: 'QQQ', qty: 1, side: 'buy', type: 'market' });
  // o is filled; trying to patch its stop (even if it were a stop) should fail
  await assert.rejects(
    () => a.patchStopPrice({ orderId: o.id, newStopPrice: 390 }),
    /not a stop leg|cannot patch/,
  );
});

// ─── Cancel bracket parent ─────────────────────────────────────────────────

test('mock: cancelling a bracket parent cancels its children', async () => {
  const a = fresh();
  const bracket = await a.submitBracketOrder({
    symbol: 'AMD', qty: 10, side: 'buy',
    entryType: 'limit', entryLimitPrice: 150,
    stopPrice: 140, takeProfitLimitPrice: 170,
  });
  await a.cancelOrder(bracket.id);
  const all = await a.listOrders({ status: 'all', symbol: 'AMD' });
  assert.equal(all.length, 3);
  assert.ok(all.every(o => o.status === 'cancelled'));
});

// ─── closePosition — signal-based full exit ────────────────────────────────

test('mock: closePosition issues a market sell of full qty', async () => {
  const a = fresh();
  a._setMark('SPY', 500);
  await a.submitSimpleOrder({ symbol: 'SPY', qty: 20, side: 'buy', type: 'market' });
  const closeOrder = await a.closePosition('SPY');
  assert.equal(closeOrder.status, 'filled');
  assert.equal(closeOrder.side,   'sell');
  assert.equal(closeOrder.qty,    20);
  assert.equal(await a.getPosition('SPY'), null);
});

// ─── Validation ────────────────────────────────────────────────────────────

test('mock: bracket validation — long requires stop < takeProfit', async () => {
  const a = fresh();
  // Inverted OCO: stop above target → can never coexist, must reject.
  await assert.rejects(
    () => a.submitBracketOrder({
      symbol: 'X', qty: 1, side: 'buy',
      entryType: 'limit', entryLimitPrice: 100,
      stopPrice: 150, takeProfitLimitPrice: 120,
    }),
    /stopPrice.*takeProfit|long needs/,
  );
  // Valid: stop above entry but below target is fine — brokers don't care
  // where stop sits relative to entry, only that the OCO pair is ordered.
  await assert.doesNotReject(
    () => a.submitBracketOrder({
      symbol: 'X2', qty: 1, side: 'buy',
      entryType: 'limit', entryLimitPrice: 100,
      stopPrice: 110, takeProfitLimitPrice: 120,
    }),
  );
});

test('mock: multi-tranche rejects empty tranches[]', async () => {
  const a = fresh();
  await assert.rejects(
    () => a.submitMultiTrancheBracket({
      symbol: 'X', side: 'buy', entryType: 'market', stopPrice: 90,
      tranches: [],
    }),
    /tranches/,
  );
});
