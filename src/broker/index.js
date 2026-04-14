// ─── Broker Factory ─────────────────────────────────────────────────────────
//
// Single entry point that returns the configured BrokerAdapter. Business
// logic imports `getBroker()` from here — never a specific vendor module —
// so switching brokers is one env var: BROKER=alpaca|schwab|mock.
//
// The adapter is cached after first construction so every caller sees the
// same instance (important for the mock adapter, which holds test state).
// Call resetBroker() in tests to clear the cache and re-read env vars.

const { assertAdapterContract } = require('./adapter');

let _cached = null;
let _cachedKind = null;

function getBroker() {
  const kind = (process.env.BROKER || 'alpaca').toLowerCase();
  if (_cached && _cachedKind === kind) return _cached;

  let adapter;
  switch (kind) {
    case 'alpaca': {
      const { adapter: a } = require('./adapters/alpaca');
      adapter = a;
      break;
    }
    case 'schwab': {
      const { adapter: a } = require('./adapters/schwab');
      adapter = a;
      break;
    }
    case 'mock': {
      const { adapter: a } = require('./adapters/mock');
      adapter = a;
      break;
    }
    default:
      throw new Error(
        `Unknown BROKER='${kind}'. Valid values: alpaca, schwab, mock.`
      );
  }

  assertAdapterContract(adapter);
  _cached = adapter;
  _cachedKind = kind;
  return adapter;
}

// Test-only: clear the cache so getBroker() re-reads BROKER from env.
function resetBroker() {
  _cached = null;
  _cachedKind = null;
}

module.exports = { getBroker, resetBroker };
