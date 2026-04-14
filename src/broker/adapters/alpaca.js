// ─── Alpaca Broker Adapter ──────────────────────────────────────────────────
//
// Implements the BrokerAdapter interface against Alpaca REST API v2, using
// the existing low-level client in src/broker/alpaca.js for account,
// positions, clock, and raw order calls. This file is the mapping layer —
// it translates the vendor-neutral interface types into Alpaca's JSON shape
// and vice versa.
//
// Multi-tranche brackets: Alpaca does support bracket orders natively
// (order_class='bracket'), but only with a single take-profit leg. To model
// an N-tranche scale-out pyramid, we submit N independent bracket orders,
// each sized for its own tranche with its own TP. If one fails mid-way,
// we throw with the partial submission list so the caller can reconcile.

const raw = require('../alpaca');
const { BrokerAdapter, assertAdapterContract } = require('../adapter');

// ─── Mapping helpers ────────────────────────────────────────────────────────

// Translate Alpaca order JSON into our vendor-neutral BrokerOrder shape.
// Alpaca uses snake_case and some fields are strings that must be coerced.
function mapOrder(o) {
  if (!o) return null;
  return {
    id:             o.id,
    symbol:         o.symbol,
    qty:            o.qty != null ? Number(o.qty) : 0,
    side:           o.side,
    type:           o.type,
    status:         o.status,
    timeInForce:    o.time_in_force,
    limitPrice:     o.limit_price != null ? Number(o.limit_price) : undefined,
    stopPrice:      o.stop_price  != null ? Number(o.stop_price)  : undefined,
    filledQty:      o.filled_qty  != null ? Number(o.filled_qty)  : undefined,
    filledAvgPrice: o.filled_avg_price != null ? Number(o.filled_avg_price) : undefined,
    filledAt:       o.filled_at || undefined,
    submittedAt:    o.submitted_at || undefined,
    parentOrderId:  o.legs ? undefined : (o.parent_order_id || undefined),
    legs:           Array.isArray(o.legs) ? o.legs.map(mapOrder) : undefined,
  };
}

function mapPosition(p) {
  if (!p) return null;
  const qtyAbs = Math.abs(Number(p.qty));
  return {
    symbol:         p.symbol,
    qty:            qtyAbs,
    side:           Number(p.qty) < 0 ? 'short' : 'long',
    avgEntryPrice:  Number(p.avg_entry_price),
    currentPrice:   Number(p.current_price),
    marketValue:    Number(p.market_value),
    unrealizedPnl:  Number(p.unrealized_pl),
  };
}

function mapAccount(a, paper) {
  if (!a) return null;
  return {
    connected:         true,
    configured:        true,
    paper,
    equity:            Number(a.equity),
    cash:              Number(a.cash),
    buyingPower:       Number(a.buying_power),
    status:            a.status,
    patternDayTrader:  !!a.pattern_day_trader,
    tradingBlocked:    !!a.trading_blocked,
  };
}

// ─── Adapter class ──────────────────────────────────────────────────────────

class AlpacaAdapter extends BrokerAdapter {
  get name() { return 'alpaca'; }

  isConfigured() {
    return !!raw.getConfig().configured;
  }

  async getAccount() {
    const { configured, base } = raw.getConfig();
    if (!configured) {
      return { connected: false, configured: false, paper: true, reason: 'Alpaca API keys not set' };
    }
    try {
      const a = await raw.getAccount();
      return mapAccount(a, base.includes('paper'));
    } catch (e) {
      return { connected: false, configured: true, paper: base.includes('paper'), reason: e.message };
    }
  }

  async getPositions() {
    const positions = await raw.getPositions();
    return (positions || []).map(mapPosition);
  }

  async getPosition(symbol) {
    try {
      const p = await raw.getPosition(symbol);
      return mapPosition(p);
    } catch (e) {
      // Alpaca returns 404 for "no position"
      if (/404|not found|position does not exist/i.test(e.message)) return null;
      throw e;
    }
  }

  async getOrder(orderId) {
    try {
      const o = await raw.getOrder(orderId);
      return mapOrder(o);
    } catch (e) {
      if (/404|not found/i.test(e.message)) return null;
      throw e;
    }
  }

  async listOrders(filter = {}) {
    const status = filter.status === 'all' ? 'all'
                 : filter.status === 'closed' ? 'closed'
                 : 'open';
    const orders = await raw.getOrders({ status, limit: filter.limit || 100 });
    const mapped = (orders || []).map(mapOrder);
    return filter.symbol
      ? mapped.filter(o => o.symbol === filter.symbol.toUpperCase())
      : mapped;
  }

  async submitSimpleOrder(params) {
    const p = {
      symbol:        params.symbol,
      qty:           params.qty,
      side:          params.side,
      type:          params.type,
      time_in_force: params.timeInForce || 'day',
    };
    if (params.type === 'limit') {
      if (params.limitPrice == null) throw new Error("submitSimpleOrder: limitPrice required when type='limit'");
      p.limit_price = params.limitPrice;
    }
    const o = await raw.submitOrder(p);
    return mapOrder(o);
  }

  async submitBracketOrder(params) {
    validateBracketParams(params);
    const p = {
      symbol:        params.symbol,
      qty:           params.qty,
      side:          params.side,
      type:          params.entryType,
      time_in_force: params.timeInForce || 'gtc',
      order_class:   'bracket',
      take_profit:   { limit_price: params.takeProfitLimitPrice },
      stop_loss:     { stop_price:  params.stopPrice },
    };
    if (params.entryType === 'limit') {
      if (params.entryLimitPrice == null) throw new Error("submitBracketOrder: entryLimitPrice required when entryType='limit'");
      p.limit_price = params.entryLimitPrice;
    }
    if (params.stopLimitPrice != null) {
      p.stop_loss.limit_price = params.stopLimitPrice;
    }
    if (params.clientOrderId) p.client_order_id = params.clientOrderId;

    const o = await raw.submitOrder(p);
    return mapOrder(o);
  }

  async submitMultiTrancheBracket(params) {
    if (!Array.isArray(params.tranches) || params.tranches.length === 0) {
      throw new Error('submitMultiTrancheBracket: tranches[] must be non-empty');
    }
    const totalQty = params.tranches.reduce((s, t) => s + t.qty, 0);
    const submitted = [];
    // Sequential submission — if tranche N fails we throw with what succeeded
    // so the caller can cancel/reconcile rather than silently losing legs.
    for (let i = 0; i < params.tranches.length; i++) {
      const t = params.tranches[i];
      try {
        const o = await this.submitBracketOrder({
          symbol:               params.symbol,
          qty:                  t.qty,
          side:                 params.side,
          entryType:            params.entryType,
          entryLimitPrice:      params.entryLimitPrice,
          stopPrice:            params.stopPrice,
          takeProfitLimitPrice: t.takeProfitLimitPrice,
          timeInForce:          params.timeInForce || 'gtc',
          clientOrderId:        t.label ? `${params.symbol}-${t.label}-${Date.now()}` : undefined,
        });
        submitted.push({ label: t.label, order: o });
      } catch (e) {
        const err = new Error(
          `submitMultiTrancheBracket: tranche ${i + 1}/${params.tranches.length} ` +
          `(${t.label || 'unlabeled'}) failed: ${e.message}. ${submitted.length} ` +
          `prior tranche(s) were submitted and may need manual cancellation.`
        );
        err.partial = submitted;
        throw err;
      }
    }
    return { tranches: submitted, totalQty };
  }

  async cancelOrder(orderId) {
    await raw.cancelOrder(orderId);
  }

  async patchStopPrice(params) {
    // Alpaca supports PATCH /v2/orders/{id} with stop_price / stop_limit_price
    // for orders in new/accepted/partially_filled/pending_new/held statuses.
    const body = { stop_price: params.newStopPrice };
    if (params.newStopLimitPrice != null) body.stop_limit_price = params.newStopLimitPrice;

    // The low-level client doesn't expose PATCH — use the private request
    // helper by re-using submitOrder's code path via a direct fetch.
    const { getConfig } = raw;
    const { base, configured, key, secret } = getConfig();
    if (!configured) throw new Error('Alpaca API keys not configured');
    const fetch = require('node-fetch');
    const r = await fetch(`${base}/v2/orders/${encodeURIComponent(params.orderId)}`, {
      method: 'PATCH',
      headers: {
        'APCA-API-KEY-ID':     key,
        'APCA-API-SECRET-KEY': secret,
        'Content-Type':        'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      let msg; try { msg = JSON.parse(text).message; } catch (_) { msg = text; }
      throw new Error(`Alpaca PATCH /v2/orders/${params.orderId} → ${r.status}: ${msg}`);
    }
    return mapOrder(JSON.parse(text));
  }

  async replaceStopsForSymbol(params) {
    // Find every open stop order for this symbol and patch each one. This
    // covers the typical case: multi-tranche brackets with outstanding stop
    // children that need to be raised to breakeven after target1 fills.
    const open = await this.listOrders({ status: 'open', symbol: params.symbol });
    const stopLegs = open.filter(o => o.type === 'stop' || o.type === 'stop_limit');
    const patched = [];
    for (const leg of stopLegs) {
      try {
        const p = await this.patchStopPrice({ orderId: leg.id, newStopPrice: params.newStopPrice });
        patched.push(p);
      } catch (e) {
        // Don't abort on a single leg failure — log and continue. The caller
        // sees `patched.length < stopLegs.length` and can decide to retry.
        console.error(`  Alpaca replaceStopsForSymbol: leg ${leg.id} failed: ${e.message}`);
      }
    }
    return patched;
  }

  async closePosition(symbol) {
    const o = await raw.closePosition(symbol);
    return mapOrder(o);
  }

  async getClock() {
    const c = await raw.getClock();
    return {
      open:       !!c.is_open,
      nextOpen:   c.next_open,
      nextClose:  c.next_close,
    };
  }
}

// ─── Validation helpers ─────────────────────────────────────────────────────

function validateBracketParams(p) {
  if (!p.symbol) throw new Error('bracket: symbol required');
  if (!(p.qty > 0)) throw new Error('bracket: qty must be > 0');
  if (!['buy', 'sell'].includes(p.side)) throw new Error(`bracket: side must be 'buy' or 'sell', got ${p.side}`);
  if (!['market', 'limit'].includes(p.entryType)) throw new Error(`bracket: entryType must be 'market' or 'limit', got ${p.entryType}`);
  if (!(p.stopPrice > 0)) throw new Error('bracket: stopPrice required');
  if (!(p.takeProfitLimitPrice > 0)) throw new Error('bracket: takeProfitLimitPrice required');
  // For longs, stop must be below TP; for shorts, above.
  if (p.side === 'buy' && !(p.stopPrice < p.takeProfitLimitPrice)) {
    throw new Error(`bracket: long order needs stopPrice (${p.stopPrice}) < takeProfitLimitPrice (${p.takeProfitLimitPrice})`);
  }
  if (p.side === 'sell' && !(p.stopPrice > p.takeProfitLimitPrice)) {
    throw new Error(`bracket: short order needs stopPrice (${p.stopPrice}) > takeProfitLimitPrice (${p.takeProfitLimitPrice})`);
  }
}

const adapter = new AlpacaAdapter();
assertAdapterContract(adapter);

module.exports = { AlpacaAdapter, adapter, mapOrder, mapPosition, mapAccount, validateBracketParams };
