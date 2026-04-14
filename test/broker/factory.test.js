// ─── Tests: getBroker() factory ────────────────────────────────────────────
//
// The factory is the single entry point business logic uses to reach a
// broker. These tests nail down its behavior so we can't accidentally break
// the "swap broker with one env var" contract.
//
// Things we verify:
//   1. Default is alpaca when BROKER is unset.
//   2. BROKER=mock returns the mock adapter.
//   3. BROKER is case-insensitive ('MOCK' == 'mock').
//   4. BROKER=schwab returns the schwab stub without calling its methods.
//      (The stub throws on every method call, but construction + contract
//      assertion must succeed so the adapter can be selected.)
//   5. Unknown BROKER values throw a helpful error.
//   6. The adapter is cached: two calls return the same instance.
//   7. resetBroker() clears the cache so a new BROKER value takes effect.
//   8. The returned adapter satisfies the interface contract.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getBroker, resetBroker } = require('../../src/broker');
const { assertAdapterContract } = require('../../src/broker/adapter');

// Save and restore BROKER across tests so nothing leaks.
function withBroker(value, fn) {
  const prev = process.env.BROKER;
  if (value === undefined) delete process.env.BROKER;
  else process.env.BROKER = value;
  try {
    resetBroker();
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BROKER;
    else process.env.BROKER = prev;
    resetBroker();
  }
}

// ─── Default selection ─────────────────────────────────────────────────────

test('factory: defaults to alpaca when BROKER is unset', () => {
  withBroker(undefined, () => {
    const b = getBroker();
    assert.equal(b.name, 'alpaca');
  });
});

// ─── Explicit selection ────────────────────────────────────────────────────

test('factory: BROKER=mock returns the mock adapter', () => {
  withBroker('mock', () => {
    const b = getBroker();
    assert.equal(b.name, 'mock');
  });
});

test('factory: BROKER is case-insensitive', () => {
  withBroker('MOCK', () => {
    const b = getBroker();
    assert.equal(b.name, 'mock');
  });
  withBroker('Alpaca', () => {
    const b = getBroker();
    assert.equal(b.name, 'alpaca');
  });
});

test('factory: BROKER=schwab returns the schwab stub (methods reject with notImplemented)', async () => {
  await withBroker('schwab', async () => {
    const b = getBroker();
    assert.equal(b.name, 'schwab');
    // Every real method is async and throws → becomes a rejected promise.
    // That's the stub's whole job: construction works (so you can SELECT it),
    // but any actual call fails loudly with instructions.
    await assert.rejects(() => b.getAccount(), /not yet implemented/);
  });
});

test('factory: BROKER=alpaca returns the alpaca adapter', () => {
  withBroker('alpaca', () => {
    const b = getBroker();
    assert.equal(b.name, 'alpaca');
  });
});

// ─── Error handling ────────────────────────────────────────────────────────

test('factory: unknown BROKER throws with valid values listed', () => {
  withBroker('bogus', () => {
    assert.throws(
      () => getBroker(),
      /Unknown BROKER.*alpaca.*schwab.*mock/,
    );
  });
});

// ─── Caching ───────────────────────────────────────────────────────────────

test('factory: repeated calls return the same instance (cached)', () => {
  withBroker('mock', () => {
    const a = getBroker();
    const b = getBroker();
    assert.equal(a, b, 'same reference');
  });
});

test('factory: resetBroker() clears the cache and re-reads BROKER', () => {
  withBroker('mock', () => {
    const first = getBroker();
    assert.equal(first.name, 'mock');
  });
  withBroker('alpaca', () => {
    const second = getBroker();
    assert.equal(second.name, 'alpaca');
  });
});

// ─── Contract check on every adapter ───────────────────────────────────────

test('factory: every returned adapter satisfies the contract', () => {
  for (const kind of ['alpaca', 'schwab', 'mock']) {
    withBroker(kind, () => {
      const b = getBroker();
      assert.doesNotThrow(() => assertAdapterContract(b), `${kind} failed contract`);
    });
  }
});
