// ─── Broker Adapter Interface ───────────────────────────────────────────────
//
// Every broker integration (Alpaca, Schwab, IBKR, mock) implements the same
// set of methods with the same semantics. Business logic (staging, monitor,
// scaling) depends on this interface — never on a specific vendor — so
// swapping brokers is a one-env-var change.
//
// Design principles:
//   - The broker is the source of truth for stop-loss and take-profit
//     orders. Once placed, they live on the server side and fire even if
//     our Node process is dead.
//   - Scale-out pyramids are modeled as N independent brackets, one per
//     tranche. Each tranche has its own stop + target. Move-to-breakeven
//     is a PATCH of the remaining tranches' stop legs.
//   - Monitor is an observer. It only fires orders for signal-based exits
//     (RS drop, regime change) where the broker has no context. All price-
//     based exits (stops, targets) MUST be broker-side brackets.
//
// JSDoc typedefs are intentionally verbose so future adapter implementers
// can see the contract without hunting through consumer code.

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BrokerAccount
 * @property {boolean} connected        Whether the adapter successfully reached the broker
 * @property {boolean} configured       Whether API keys are set
 * @property {boolean} paper            True if connected to a paper/sandbox endpoint
 * @property {number}  [equity]         Total account equity in USD
 * @property {number}  [cash]           Free cash in USD
 * @property {number}  [buyingPower]    Day-trading or cash buying power
 * @property {string}  [status]         Vendor-specific account status string
 * @property {boolean} [patternDayTrader]
 * @property {boolean} [tradingBlocked]
 * @property {string}  [reason]         Set when connected=false; reason the broker is unreachable
 */

/**
 * @typedef {Object} BrokerPosition
 * @property {string} symbol
 * @property {number} qty               Absolute share count
 * @property {'long'|'short'} side
 * @property {number} avgEntryPrice
 * @property {number} currentPrice
 * @property {number} marketValue
 * @property {number} unrealizedPnl
 */

/**
 * @typedef {Object} BrokerOrder
 * @property {string} id                Broker-side order identifier
 * @property {string} symbol
 * @property {number} qty
 * @property {'buy'|'sell'} side
 * @property {'market'|'limit'|'stop'|'stop_limit'} type
 * @property {'new'|'accepted'|'partially_filled'|'filled'|'cancelled'|'expired'|'rejected'|'pending_new'|'held'} status
 * @property {'day'|'gtc'|'ioc'|'fok'} timeInForce
 * @property {number} [limitPrice]
 * @property {number} [stopPrice]
 * @property {number} [filledQty]
 * @property {number} [filledAvgPrice]
 * @property {string} [filledAt]        ISO timestamp
 * @property {string} [submittedAt]     ISO timestamp
 * @property {string} [parentOrderId]   Set on bracket children
 * @property {BrokerOrder[]} [legs]     Child legs of a bracket/OCO/OTO parent
 */

/**
 * Parameters for a single-leg market/limit order.
 *
 * @typedef {Object} SimpleOrderParams
 * @property {string} symbol
 * @property {number} qty
 * @property {'buy'|'sell'} side
 * @property {'market'|'limit'} type
 * @property {number} [limitPrice]      Required when type='limit'
 * @property {'day'|'gtc'|'ioc'|'fok'} [timeInForce='day']
 */

/**
 * Parameters for a single bracket order (entry + stop-loss + take-profit).
 *
 * Brackets are ONE OCO group on the broker side: entry fires first; once
 * filled, the stop-loss and take-profit become a child OCO pair. Whichever
 * fires first cancels the other.
 *
 * @typedef {Object} BracketOrderParams
 * @property {string} symbol
 * @property {number} qty
 * @property {'buy'|'sell'} side        Entry side ('buy' for longs, 'sell' for shorts)
 * @property {'market'|'limit'} entryType
 * @property {number} [entryLimitPrice] Required when entryType='limit'
 * @property {number} stopPrice         Stop-loss trigger
 * @property {number} [stopLimitPrice]  Optional stop-limit (else market stop)
 * @property {number} takeProfitLimitPrice  Take-profit limit price
 * @property {'day'|'gtc'|'ioc'|'fok'} [timeInForce='gtc']
 * @property {string} [clientOrderId]   Idempotency key (helps reconcile duplicates)
 */

/**
 * Parameters for a multi-tranche bracket (scale-out pyramid).
 * One bracket per tranche is submitted atomically from the caller's view,
 * though the adapter may internally place them sequentially.
 *
 * @typedef {Object} MultiTrancheBracketParams
 * @property {string} symbol
 * @property {'buy'|'sell'} side
 * @property {'market'|'limit'} entryType
 * @property {number} [entryLimitPrice]
 * @property {number} stopPrice         Initial stop (shared across all tranches)
 * @property {'day'|'gtc'|'ioc'|'fok'} [timeInForce='gtc']
 * @property {Array<{ qty: number, takeProfitLimitPrice: number, label?: string }>} tranches
 *   Each element becomes one bracket. `label` is a free-form tag like
 *   'target1' / 'target2' / 'runner' that the caller uses to correlate
 *   broker orders with local DB rows.
 */

/**
 * Return value from a multi-tranche bracket submission.
 *
 * @typedef {Object} MultiTrancheBracketResult
 * @property {Array<{ label?: string, order: BrokerOrder }>} tranches
 * @property {number} totalQty
 */

/**
 * Parameters for patching an open order's stop price.
 * Used by move-to-breakeven after a partial exit.
 *
 * @typedef {Object} PatchStopParams
 * @property {string} orderId           Broker-side child order ID of the stop leg
 * @property {number} newStopPrice
 * @property {number} [newStopLimitPrice]
 */

/**
 * @typedef {Object} MarketClock
 * @property {boolean} open
 * @property {string} [nextOpen]
 * @property {string} [nextClose]
 */

// ─── Abstract Adapter Interface ─────────────────────────────────────────────
//
// Concrete adapters should either:
//   (a) extend this class and override every method, OR
//   (b) export a plain object with the same method names.
// Both forms pass the contract test in test/broker/mock-adapter.test.js.

class BrokerAdapter {
  /** @type {string} Human-readable adapter name, e.g. 'alpaca', 'schwab', 'mock' */
  get name() { return notImplemented('name'); }

  /** @returns {boolean} */
  isConfigured() { return notImplemented('isConfigured'); }

  // ── Account & positions ────────────────────────────────────────────────
  /** @returns {Promise<BrokerAccount>} */
  async getAccount() { return notImplemented('getAccount'); }

  /** @returns {Promise<BrokerPosition[]>} */
  async getPositions() { return notImplemented('getPositions'); }

  /** @param {string} symbol @returns {Promise<BrokerPosition|null>} */
  async getPosition(symbol) { return notImplemented('getPosition'); }

  // ── Orders (reads) ─────────────────────────────────────────────────────
  /** @param {string} orderId @returns {Promise<BrokerOrder|null>} */
  async getOrder(orderId) { return notImplemented('getOrder'); }

  /**
   * List orders. Filter defaults to status='open' which returns new/accepted/
   * pending/held/partially_filled.
   * @param {{ status?: 'open'|'closed'|'all', symbol?: string, limit?: number }} [filter]
   * @returns {Promise<BrokerOrder[]>}
   */
  async listOrders(filter) { return notImplemented('listOrders'); }

  // ── Orders (writes) ────────────────────────────────────────────────────
  /**
   * Place a single market or limit order. Used for signal-based exits where
   * a bracket is not appropriate (e.g. RS degraded, regime flipped).
   * @param {SimpleOrderParams} params
   * @returns {Promise<BrokerOrder>}
   */
  async submitSimpleOrder(params) { return notImplemented('submitSimpleOrder'); }

  /**
   * Place a single bracket order (entry + stop + target1). Use this for
   * 'full_in_full_out' exit strategies.
   * @param {BracketOrderParams} params
   * @returns {Promise<BrokerOrder>}
   */
  async submitBracketOrder(params) { return notImplemented('submitBracketOrder'); }

  /**
   * Place one bracket per tranche. Use this for scale-out strategies so the
   * broker natively closes each tranche at its own target, without Node-side
   * price monitoring.
   * @param {MultiTrancheBracketParams} params
   * @returns {Promise<MultiTrancheBracketResult>}
   */
  async submitMultiTrancheBracket(params) { return notImplemented('submitMultiTrancheBracket'); }

  /**
   * Cancel an open order by ID. Cancelling a bracket parent also cancels its
   * children. Cancelling an OCO child cancels its sibling.
   * @param {string} orderId @returns {Promise<void>}
   */
  async cancelOrder(orderId) { return notImplemented('cancelOrder'); }

  /**
   * Patch the stop price of an open stop-loss child order. Used to move a
   * tranche's stop to breakeven after a target hits on another tranche.
   * @param {PatchStopParams} params
   * @returns {Promise<BrokerOrder>}
   */
  async patchStopPrice(params) { return notImplemented('patchStopPrice'); }

  /**
   * Convenience: patch every open stop-loss child for `symbol` to the same
   * new stop price. Implemented in terms of listOrders + patchStopPrice.
   * @param {{ symbol: string, newStopPrice: number }} params
   * @returns {Promise<BrokerOrder[]>}
   */
  async replaceStopsForSymbol(params) { return notImplemented('replaceStopsForSymbol'); }

  /**
   * Close an entire position at market. Used by signal-based force exits.
   * @param {string} symbol @returns {Promise<BrokerOrder>}
   */
  async closePosition(symbol) { return notImplemented('closePosition'); }

  // ── Market clock ───────────────────────────────────────────────────────
  /** @returns {Promise<MarketClock>} */
  async getClock() { return notImplemented('getClock'); }
}

function notImplemented(method) {
  throw new Error(
    `BrokerAdapter.${method}() is not implemented by this adapter. ` +
    `Either extend BrokerAdapter and override ${method}(), or use a ` +
    `different broker (set BROKER=alpaca|mock).`
  );
}

// Run-time contract check: asserts that `adapter` has every method the
// interface requires, with the right arity. Intended for unit tests and
// for getBroker() to reject half-baked adapters early.
function assertAdapterContract(adapter) {
  const required = [
    ['name',                         'getter', 0],
    ['isConfigured',                 'method', 0],
    ['getAccount',                   'method', 0],
    ['getPositions',                 'method', 0],
    ['getPosition',                  'method', 1],
    ['getOrder',                     'method', 1],
    ['listOrders',                   'method', 1], // filter is a single arg object
    ['submitSimpleOrder',            'method', 1],
    ['submitBracketOrder',           'method', 1],
    ['submitMultiTrancheBracket',    'method', 1],
    ['cancelOrder',                  'method', 1],
    ['patchStopPrice',               'method', 1],
    ['replaceStopsForSymbol',        'method', 1],
    ['closePosition',                'method', 1],
    ['getClock',                     'method', 0],
  ];
  const missing = [];
  for (const [prop, kind] of required) {
    if (kind === 'getter') {
      if (adapter[prop] === undefined) missing.push(prop);
    } else {
      if (typeof adapter[prop] !== 'function') missing.push(prop + '()');
    }
  }
  if (missing.length) {
    throw new Error(
      `Broker adapter '${adapter.name || 'unknown'}' is missing required ` +
      `interface members: ${missing.join(', ')}`
    );
  }
}

module.exports = { BrokerAdapter, assertAdapterContract };
