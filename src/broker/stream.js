// ─── Real-Time WebSocket Price Streaming ─────────────────────────────────────
// Replaces 5-minute cron polling with millisecond-level price updates.
// Uses Alpaca's streaming data API when configured, falls back to Yahoo polling.
// Emits price updates to subscribers (stop monitor, UI via SSE, etc.)

const WebSocket = require('ws');
const EventEmitter = require('events');
const alpaca = require('./alpaca');

class PriceStream extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.subscribedSymbols = new Set();
    this.latestPrices = {};       // symbol → { price, timestamp, bid, ask }
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;   // starts at 1s, doubles each retry
    this.connected = false;
    this.authenticated = false;
    this.mode = 'none';           // 'alpaca-ws' | 'polling' | 'none'
    this._pollingInterval = null;
    this._heartbeatInterval = null;
  }

  // ─── Start streaming ───────────────────────────────────────────────────────

  async start(symbols = []) {
    for (const s of symbols) this.subscribedSymbols.add(s);

    const { configured } = alpaca.getConfig();
    if (configured) {
      this.mode = 'alpaca-ws';
      this._connectAlpacaWS();
    } else {
      // Fallback: aggressive polling (every 15 seconds during market hours)
      this.mode = 'polling';
      this._startPolling();
    }
  }

  stop() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this._pollingInterval) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = null;
    }
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.mode = 'none';
    this.reconnectAttempts = 0;
  }

  // ─── Subscribe / Unsubscribe ───────────────────────────────────────────────

  subscribe(symbols) {
    const newSymbols = symbols.filter(s => !this.subscribedSymbols.has(s));
    for (const s of newSymbols) this.subscribedSymbols.add(s);

    if (this.mode === 'alpaca-ws' && this.authenticated && newSymbols.length > 0) {
      this._sendAlpaca({ action: 'subscribe', quotes: newSymbols });
    }
  }

  unsubscribe(symbols) {
    for (const s of symbols) this.subscribedSymbols.delete(s);

    if (this.mode === 'alpaca-ws' && this.authenticated) {
      this._sendAlpaca({ action: 'unsubscribe', quotes: symbols });
    }
  }

  getPrice(symbol) {
    return this.latestPrices[symbol] || null;
  }

  getAllPrices() {
    return { ...this.latestPrices };
  }

  getStatus() {
    return {
      mode: this.mode,
      connected: this.connected,
      authenticated: this.authenticated,
      subscribedSymbols: this.subscribedSymbols.size,
      reconnectAttempts: this.reconnectAttempts,
      latestPriceCount: Object.keys(this.latestPrices).length,
    };
  }

  // ─── Alpaca WebSocket Connection ───────────────────────────────────────────

  _connectAlpacaWS() {
    const { key, secret, base } = alpaca.getConfig();

    // Alpaca data stream endpoint (IEX for free, SIP for paid)
    // Paper uses iex by default
    const isPaper = base.includes('paper');
    const streamUrl = isPaper
      ? 'wss://stream.data.alpaca.markets/v2/iex'
      : 'wss://stream.data.alpaca.markets/v2/sip';

    console.log(`  Stream: Connecting to ${isPaper ? 'IEX' : 'SIP'} data stream...`);

    this.ws = new WebSocket(streamUrl);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      console.log('  Stream: WebSocket connected');

      // Authenticate
      this._sendAlpaca({ action: 'auth', key, secret });
    });

    this.ws.on('message', (raw) => {
      try {
        const messages = JSON.parse(raw.toString());
        for (const msg of messages) {
          this._handleAlpacaMessage(msg);
        }
      } catch (e) {
        console.error('  Stream: Parse error:', e.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      this.authenticated = false;
      console.warn(`  Stream: WebSocket closed (${code}): ${reason || 'unknown'}`);
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('  Stream: WebSocket error:', err.message);
    });

    // Heartbeat: detect stale connections
    this._heartbeatInterval = setInterval(() => {
      if (this.ws && this.connected) {
        this.ws.ping();
      }
    }, 30000);
  }

  _handleAlpacaMessage(msg) {
    switch (msg.T) {
      case 'success':
        if (msg.msg === 'connected') {
          console.log('  Stream: Connected to Alpaca data');
        } else if (msg.msg === 'authenticated') {
          this.authenticated = true;
          console.log('  Stream: Authenticated');
          // Subscribe to all tracked symbols
          if (this.subscribedSymbols.size > 0) {
            this._sendAlpaca({
              action: 'subscribe',
              quotes: [...this.subscribedSymbols],
            });
          }
        }
        break;

      case 'error':
        console.error(`  Stream: Error ${msg.code}: ${msg.msg}`);
        if (msg.code === 402) {
          console.error('  Stream: Auth failed — check ALPACA_API_KEY/SECRET');
        }
        break;

      case 'q': // Quote update
        this._processQuote(msg);
        break;

      case 't': // Trade update
        this._processTrade(msg);
        break;

      case 'subscription':
        console.log(`  Stream: Subscribed to ${msg.quotes?.length || 0} quote(s), ${msg.trades?.length || 0} trade(s)`);
        break;
    }
  }

  _processQuote(msg) {
    const symbol = msg.S;
    const update = {
      price: msg.ap || msg.bp || this.latestPrices[symbol]?.price,  // ask price, bid price
      bid: msg.bp,
      ask: msg.ap,
      bidSize: msg.bs,
      askSize: msg.as,
      timestamp: msg.t,
      source: 'alpaca-ws',
    };

    // Use midpoint for price if both bid/ask available
    if (msg.bp && msg.ap) {
      update.price = +((msg.bp + msg.ap) / 2).toFixed(4);
    }

    this.latestPrices[symbol] = update;
    this.emit('price', symbol, update);
  }

  _processTrade(msg) {
    const symbol = msg.S;
    const update = {
      price: msg.p,
      size: msg.s,
      timestamp: msg.t,
      source: 'alpaca-ws-trade',
    };

    // Trade price is more authoritative than quote midpoint
    const existing = this.latestPrices[symbol] || {};
    this.latestPrices[symbol] = { ...existing, ...update };
    this.emit('price', symbol, this.latestPrices[symbol]);
    this.emit('trade', symbol, update);
  }

  _sendAlpaca(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('  Stream: Max reconnect attempts reached — falling back to polling');
      this.mode = 'polling';
      this._startPolling();
      return;
    }

    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    console.log(`  Stream: Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      if (this.mode === 'alpaca-ws') {
        this._connectAlpacaWS();
      }
    }, delay);
  }

  // ─── Polling Fallback ──────────────────────────────────────────────────────

  _startPolling() {
    const { yahooQuote } = require('../data/providers/yahoo');

    // Poll every 15 seconds (vs old 5-minute cron — 20x faster response)
    this._pollingInterval = setInterval(async () => {
      if (this.subscribedSymbols.size === 0) return;

      try {
        const symbols = [...this.subscribedSymbols];
        // Batch in groups of 20 (Yahoo limit)
        for (let i = 0; i < symbols.length; i += 20) {
          const batch = symbols.slice(i, i + 20);
          const quotes = await yahooQuote(batch);
          for (const q of quotes) {
            if (q.regularMarketPrice) {
              const update = {
                price: q.regularMarketPrice,
                bid: q.bid,
                ask: q.ask,
                timestamp: new Date().toISOString(),
                source: 'yahoo-poll',
              };
              this.latestPrices[q.symbol] = update;
              this.emit('price', q.symbol, update);
            }
          }
        }
      } catch (e) {
        console.error('  Stream (poll): Error fetching prices:', e.message);
      }
    }, 15000);

    console.log('  Stream: Polling mode active (15s interval)');
  }
}

// Singleton instance
const priceStream = new PriceStream();

module.exports = { priceStream };
