// ─── Mock Broker Adapter ────────────────────────────────────────────────────
//
// In-memory implementation of the BrokerAdapter interface for tests.
// Tracks orders and positions in plain JS maps — no network, no time, no
// vendor specifics.
//
// Modeling notes:
//   - A "bracket" is stored as a parent order with two children (stop +
//     take-profit). The parent holds `entryType`/`qty`/`side`; children
//     inherit `symbol` and share a `bracketGroupId` so we can find siblings.
//   - Submitting a bracket with entryType='market' auto-fills the parent
//     at the provided `fillPriceHint` (or entryLimitPrice if given). Tests
//     use fillOrder() to manually advance state for limit entries.
//   - patchStopPrice() updates the stop leg in place — matches Alpaca PATCH
//     semantics for unfilled stops. Does not fail if the order is filled;
//     tests can inspect the return value to see what happened.
//   - closePosition() submits a market sell of the full qty and immediately
//     fills it at `lastMarkPrice[symbol]`. If no mark has been set, it
//     uses the position's avgEntryPrice.

const { BrokerAdapter, assertAdapterContract } = require('../adapter');

class MockBrokerAdapter extends BrokerAdapter {
  constructor() {
    super();
    this.reset();
  }

  // Test-only: wipe all state. Call between test cases.
  reset() {
    this._orders = new Map();           // id → order
    this._positions = new Map();        // symbol → position
    this._nextId = 1;
    this._configured = true;
    this._marketOpen = true;
    this._marks = new Map();            // symbol → last mark price
  }

  // Test-only helpers (not part of the public interface)
  _setConfigured(v) { this._configured = v; }
  _setMarketOpen(v) { this._marketOpen = v; }
  _setMark(symbol, price) { this._marks.set(symbol.toUpperCase(), price); }
  _getMark(symbol) { return this._marks.get(symbol.toUpperCase()); }
  _allOrders() { return [...this._orders.values()]; }
  _openOrders() { return this._allOrders().filter(o => _isOpenStatus(o.status)); }

  get name() { return 'mock'; }

  isConfigured() { return this._configured; }

  async getAccount() {
    if (!this._configured) {
      return { connected: false, configured: false, paper: true, reason: 'Mock not configured' };
    }
    return {
      connected:   true,
      configured:  true,
      paper:       true,
      equity:      100000,
      cash:        100000,
      buyingPower: 200000,
      status:      'ACTIVE',
      patternDayTrader: false,
      tradingBlocked:   false,
    };
  }

  async getPositions() {
    return [...this._positions.values()];
  }

  async getPosition(symbol) {
    return this._positions.get(symbol.toUpperCase()) || null;
  }

  async getOrder(orderId) {
    return this._orders.get(orderId) || null;
  }

  async listOrders(filter = {}) {
    let out = this._allOrders();
    if (filter.status === 'open') {
      out = out.filter(o => _isOpenStatus(o.status));
    } else if (filter.status === 'closed') {
      out = out.filter(o => !_isOpenStatus(o.status));
    }
    if (filter.symbol) {
      const sym = filter.symbol.toUpperCase();
      out = out.filter(o => o.symbol === sym);
    }
    if (filter.limit) out = out.slice(0, filter.limit);
    return out;
  }

  async submitSimpleOrder(params) {
    _validateSimpleOrder(params);
    const id = this._mintId();
    const order = {
      id,
      symbol:      params.symbol.toUpperCase(),
      qty:         params.qty,
      side:        params.side,
      type:        params.type,
      status:      'new',
      timeInForce: params.timeInForce || 'day',
      limitPrice:  params.type === 'limit' ? params.limitPrice : undefined,
      submittedAt: _now(),
    };
    this._orders.set(id, order);

    // Market orders auto-fill immediately at the mark price (or limitPrice
    // if a test didn't set a mark).
    if (params.type === 'market') {
      const fillPx = this._marks.get(order.symbol) ?? order.limitPrice ?? 0;
      this._fill(order, fillPx);
    }

    return { ...order };
  }

  async submitBracketOrder(params) {
    _validateBracket(params);
    const groupId = `bracket-${this._nextId}`;
    const parentId = this._mintId();
    const stopId = this._mintId();
    const tpId   = this._mintId();

    const parent = {
      id:           parentId,
      symbol:       params.symbol.toUpperCase(),
      qty:          params.qty,
      side:         params.side,
      type:         params.entryType,
      status:       'new',
      timeInForce:  params.timeInForce || 'gtc',
      limitPrice:   params.entryType === 'limit' ? params.entryLimitPrice : undefined,
      submittedAt:  _now(),
      bracketGroupId: groupId,
      legs: [],
    };
    const stopLeg = {
      id:            stopId,
      symbol:        parent.symbol,
      qty:           params.qty,
      side:          params.side === 'buy' ? 'sell' : 'buy',
      type:          params.stopLimitPrice != null ? 'stop_limit' : 'stop',
      status:        'held', // child legs are held until the parent fills
      timeInForce:   parent.timeInForce,
      stopPrice:     params.stopPrice,
      limitPrice:    params.stopLimitPrice,
      parentOrderId: parentId,
      bracketGroupId: groupId,
      submittedAt:   _now(),
    };
    const tpLeg = {
      id:            tpId,
      symbol:        parent.symbol,
      qty:           params.qty,
      side:          params.side === 'buy' ? 'sell' : 'buy',
      type:          'limit',
      status:        'held',
      timeInForce:   parent.timeInForce,
      limitPrice:    params.takeProfitLimitPrice,
      parentOrderId: parentId,
      bracketGroupId: groupId,
      submittedAt:   _now(),
    };

    parent.legs = [stopLeg, tpLeg];
    this._orders.set(parentId, parent);
    this._orders.set(stopId, stopLeg);
    this._orders.set(tpId, tpLeg);

    // Market entry auto-fills the parent and activates the children.
    if (params.entryType === 'market') {
      const fillPx = this._marks.get(parent.symbol) ?? params.entryLimitPrice ?? 0;
      this._fill(parent, fillPx);
      stopLeg.status = 'new';
      tpLeg.status   = 'new';
    }

    return { ...parent, legs: [{ ...stopLeg }, { ...tpLeg }] };
  }

  async submitMultiTrancheBracket(params) {
    if (!Array.isArray(params.tranches) || params.tranches.length === 0) {
      throw new Error('submitMultiTrancheBracket: tranches[] must be non-empty');
    }
    const submitted = [];
    let totalQty = 0;
    for (const t of params.tranches) {
      const o = await this.submitBracketOrder({
        symbol:               params.symbol,
        qty:                  t.qty,
        side:                 params.side,
        entryType:            params.entryType,
        entryLimitPrice:      params.entryLimitPrice,
        stopPrice:            params.stopPrice,
        takeProfitLimitPrice: t.takeProfitLimitPrice,
        timeInForce:          params.timeInForce || 'gtc',
      });
      submitted.push({ label: t.label, order: o });
      totalQty += t.qty;
    }
    return { tranches: submitted, totalQty };
  }

  async cancelOrder(orderId) {
    const o = this._orders.get(orderId);
    if (!o) throw new Error(`Mock: order ${orderId} not found`);
    if (!_isOpenStatus(o.status)) return; // already closed, no-op
    o.status = 'cancelled';
    // Cancelling a bracket parent cancels its children too.
    if (o.legs) {
      for (const leg of o.legs) {
        if (_isOpenStatus(leg.status)) leg.status = 'cancelled';
      }
    }
    // Cancelling an OCO child cancels its sibling.
    if (o.parentOrderId && o.bracketGroupId) {
      for (const other of this._allOrders()) {
        if (other.id !== o.id && other.bracketGroupId === o.bracketGroupId && _isOpenStatus(other.status)) {
          other.status = 'cancelled';
        }
      }
    }
  }

  async patchStopPrice(params) {
    const o = this._orders.get(params.orderId);
    if (!o) throw new Error(`Mock: order ${params.orderId} not found`);
    if (o.type !== 'stop' && o.type !== 'stop_limit') {
      throw new Error(`Mock: order ${params.orderId} is type '${o.type}', not a stop leg`);
    }
    if (!_isOpenStatus(o.status)) {
      throw new Error(`Mock: cannot patch order ${params.orderId} in status '${o.status}'`);
    }
    o.stopPrice = params.newStopPrice;
    if (params.newStopLimitPrice != null) o.limitPrice = params.newStopLimitPrice;
    return { ...o };
  }

  async replaceStopsForSymbol(params) {
    const sym = params.symbol.toUpperCase();
    const patched = [];
    for (const o of this._allOrders()) {
      if (o.symbol !== sym) continue;
      if (o.type !== 'stop' && o.type !== 'stop_limit') continue;
      if (!_isOpenStatus(o.status)) continue;
      o.stopPrice = params.newStopPrice;
      patched.push({ ...o });
    }
    return patched;
  }

  async closePosition(symbol) {
    const sym = symbol.toUpperCase();
    const pos = this._positions.get(sym);
    if (!pos) throw new Error(`Mock: no position for ${sym}`);
    const side = pos.side === 'long' ? 'sell' : 'buy';
    return this.submitSimpleOrder({
      symbol: sym, qty: pos.qty, side, type: 'market',
    });
  }

  async getClock() {
    return { open: this._marketOpen };
  }

  // ─── Test helpers: drive order state transitions ────────────────────────

  // Fill a limit order at the given price (simulates a matched execution).
  fillOrder(orderId, fillPrice) {
    const o = this._orders.get(orderId);
    if (!o) throw new Error(`Mock: order ${orderId} not found`);
    this._fill(o, fillPrice);
    // If this is a bracket parent, activate the children.
    if (o.legs) {
      for (const leg of o.legs) {
        if (leg.status === 'held') leg.status = 'new';
      }
    }
    // If this is a bracket child that just filled, cancel the sibling (OCO).
    if (o.parentOrderId && o.bracketGroupId) {
      for (const other of this._allOrders()) {
        if (other.id !== o.id && other.bracketGroupId === o.bracketGroupId
            && other.parentOrderId === o.parentOrderId && _isOpenStatus(other.status)) {
          other.status = 'cancelled';
        }
      }
    }
  }

  // Simulate price moving to `mark`, firing any triggered stops/targets.
  // This is the hook that makes "the broker is the source of truth" real
  // in tests: move the price, the broker fires the right OCO leg, end of story.
  tick(symbol, mark) {
    const sym = symbol.toUpperCase();
    this._setMark(sym, mark);
    for (const o of [...this._allOrders()]) {
      if (o.symbol !== sym) continue;
      if (!_isOpenStatus(o.status)) continue;

      // Limit entries that were 'new' fill when mark crosses their limit.
      if (o.type === 'limit' && o.side === 'buy' && !o.parentOrderId
          && o.status === 'new' && mark <= o.limitPrice) {
        this._fill(o, o.limitPrice);
        if (o.legs) for (const leg of o.legs) if (leg.status === 'held') leg.status = 'new';
      }

      // Stop-out: long stop triggers when mark <= stop
      if ((o.type === 'stop' || o.type === 'stop_limit')
          && o.side === 'sell' && o.status === 'new' && mark <= o.stopPrice) {
        this._fill(o, o.stopPrice);
        this._cancelSiblings(o);
      }
      // Long take-profit triggers when mark >= limit
      if (o.type === 'limit' && o.side === 'sell' && o.parentOrderId
          && o.status === 'new' && mark >= o.limitPrice) {
        this._fill(o, o.limitPrice);
        this._cancelSiblings(o);
      }
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  _mintId() {
    return `mock-${this._nextId++}`;
  }

  _fill(order, price) {
    order.status = 'filled';
    order.filledQty = order.qty;
    order.filledAvgPrice = price;
    order.filledAt = _now();

    // Parent buys open/increase a long position; parent sells either
    // short-open or close-long depending on whether there's a long position.
    // Child sells (from a bracket stop/TP) close the corresponding position.
    const sym = order.symbol;
    const existing = this._positions.get(sym);

    if (order.side === 'buy' && !order.parentOrderId) {
      // Entry fill on a long bracket or simple buy.
      if (existing) {
        const newQty = existing.qty + order.qty;
        const newAvg = (existing.avgEntryPrice * existing.qty + price * order.qty) / newQty;
        existing.qty = newQty;
        existing.avgEntryPrice = newAvg;
        existing.currentPrice = price;
        existing.marketValue = newQty * price;
      } else {
        this._positions.set(sym, {
          symbol:        sym,
          qty:           order.qty,
          side:          'long',
          avgEntryPrice: price,
          currentPrice:  price,
          marketValue:   order.qty * price,
          unrealizedPnl: 0,
        });
      }
    } else if (order.side === 'sell' && existing) {
      // Exit (stop, TP, or explicit close) — reduce the position.
      const newQty = existing.qty - order.qty;
      if (newQty <= 0) {
        this._positions.delete(sym);
      } else {
        existing.qty = newQty;
        existing.currentPrice = price;
        existing.marketValue = newQty * price;
      }
    }
  }

  _cancelSiblings(filledChild) {
    if (!filledChild.parentOrderId || !filledChild.bracketGroupId) return;
    for (const other of this._allOrders()) {
      if (other.id === filledChild.id) continue;
      if (other.bracketGroupId !== filledChild.bracketGroupId) continue;
      if (other.parentOrderId !== filledChild.parentOrderId) continue;
      if (_isOpenStatus(other.status)) other.status = 'cancelled';
    }
  }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function _isOpenStatus(s) {
  return ['new', 'accepted', 'partially_filled', 'pending_new', 'held'].includes(s);
}

function _now() {
  return new Date().toISOString();
}

function _validateSimpleOrder(p) {
  if (!p.symbol) throw new Error('simple: symbol required');
  if (!(p.qty > 0)) throw new Error('simple: qty must be > 0');
  if (!['buy', 'sell'].includes(p.side)) throw new Error(`simple: bad side ${p.side}`);
  if (!['market', 'limit'].includes(p.type)) throw new Error(`simple: bad type ${p.type}`);
  if (p.type === 'limit' && !(p.limitPrice > 0)) throw new Error('simple: limitPrice required for limit orders');
}

function _validateBracket(p) {
  _validateSimpleOrder({ ...p, type: p.entryType, limitPrice: p.entryLimitPrice });
  if (!(p.stopPrice > 0)) throw new Error('bracket: stopPrice required');
  if (!(p.takeProfitLimitPrice > 0)) throw new Error('bracket: takeProfitLimitPrice required');
  if (p.side === 'buy' && !(p.stopPrice < p.takeProfitLimitPrice)) {
    throw new Error(`bracket: long needs stopPrice < takeProfitLimitPrice (got ${p.stopPrice} >= ${p.takeProfitLimitPrice})`);
  }
  if (p.side === 'sell' && !(p.stopPrice > p.takeProfitLimitPrice)) {
    throw new Error(`bracket: short needs stopPrice > takeProfitLimitPrice (got ${p.stopPrice} <= ${p.takeProfitLimitPrice})`);
  }
}

const adapter = new MockBrokerAdapter();
assertAdapterContract(adapter);

module.exports = { MockBrokerAdapter, adapter };
