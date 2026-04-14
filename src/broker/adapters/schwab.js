// ─── Schwab / thinkorswim Broker Adapter (STUB) ─────────────────────────────
//
// Placeholder adapter for Charles Schwab's public trading API.
// Not yet implemented — the user's real brokerage account is Schwab/TOS, so
// this file exists to:
//
//   1. Lock in the adapter contract so Schwab goes in without touching
//      business logic (staging/monitor/scaling only depend on the interface).
//   2. Give a clear error message at startup when BROKER=schwab is set,
//      pointing at exactly what needs to be built.
//   3. Document the known gotchas of the Schwab API so whoever implements
//      it later isn't starting from zero.
//
// Implementation notes (as of 2025):
//   - Auth: OAuth 2.0 with refresh tokens. Schwab requires a developer app
//     registration and a manual consent flow the first time. Refresh tokens
//     are long-lived; access tokens are 30 min.
//   - Base URL: https://api.schwabapi.com/trader/v1/
//   - Orders: POST /accounts/{encryptedAccountNumber}/orders
//   - Bracket equivalent: Schwab calls this "OCO" (One-Cancels-Other) or
//     "1st Triggers OCO" (entry triggers an OCO pair of stop + target).
//     Payload is a nested `orderStrategyType: 'TRIGGER'` with a child
//     `childOrderStrategies` array containing an `OCO` group.
//   - Multi-tranche brackets: Schwab does NOT support them as a single
//     order. Same approach as Alpaca — submit N independent 1st-Triggers-OCO
//     orders, one per tranche.
//   - Stop price modification: Schwab supports PUT /orders/{orderId} to
//     replace a working order. Cancel-and-replace is the reliable path.
//   - Account equity/positions: GET /accounts/{encryptedAccountNumber}
//   - Market clock: GET /marketdata/v1/markets/EQUITY/hours
//
// To implement:
//   1. Set SCHWAB_APP_KEY, SCHWAB_APP_SECRET, SCHWAB_REFRESH_TOKEN,
//      SCHWAB_ACCOUNT_HASH env vars.
//   2. Replace each notImplemented() call below with the real REST call.
//   3. Run `node -e "require('./src/broker/adapters/schwab')"` — the
//      assertAdapterContract() check will fail fast if any method is missing.
//   4. Run `node --test test/broker/` to verify the contract tests pass
//      against a Schwab sandbox account.

const { BrokerAdapter, assertAdapterContract } = require('../adapter');

class SchwabAdapter extends BrokerAdapter {
  get name() { return 'schwab'; }

  isConfigured() {
    return !!(process.env.SCHWAB_APP_KEY && process.env.SCHWAB_APP_SECRET
           && process.env.SCHWAB_REFRESH_TOKEN && process.env.SCHWAB_ACCOUNT_HASH);
  }

  async getAccount()              { return notImplemented('getAccount'); }
  async getPositions()             { return notImplemented('getPositions'); }
  async getPosition(_symbol)       { return notImplemented('getPosition'); }
  async getOrder(_orderId)         { return notImplemented('getOrder'); }
  async listOrders(_filter)        { return notImplemented('listOrders'); }
  async submitSimpleOrder(_p)      { return notImplemented('submitSimpleOrder'); }
  async submitBracketOrder(_p)     { return notImplemented('submitBracketOrder'); }
  async submitMultiTrancheBracket(_p) { return notImplemented('submitMultiTrancheBracket'); }
  async cancelOrder(_orderId)      { return notImplemented('cancelOrder'); }
  async patchStopPrice(_p)         { return notImplemented('patchStopPrice'); }
  async replaceStopsForSymbol(_p)  { return notImplemented('replaceStopsForSymbol'); }
  async closePosition(_symbol)     { return notImplemented('closePosition'); }
  async getClock()                 { return notImplemented('getClock'); }
}

function notImplemented(method) {
  throw new Error(
    `Schwab adapter is not yet implemented. Method '${method}' was called ` +
    `but the stub at src/broker/adapters/schwab.js has no real implementation. ` +
    `Either set BROKER=alpaca (paper trading) or implement the Schwab REST ` +
    `bindings. See the comment header in that file for API notes.`
  );
}

const adapter = new SchwabAdapter();
assertAdapterContract(adapter);

module.exports = { SchwabAdapter, adapter };
