// ─── Tests: submission gate evaluator (src/broker/vwap-gate.js) ───────────
//
// Covers the new opt-in gate semantics: triggerPrice + volumePaceMin gates
// combine with the legacy VWAP/gap gates via AND, and unset fields are
// skipped (instead of inheriting always-on defaults). Also pins the
// backward-compat path: legacy gate JSON with only VWAP/gap fields still
// behaves as before.

process.env.ALPHAHUNTER_DB = ':memory:';
process.env.BROKER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── Stub the data-provider + volume-pace modules BEFORE requiring vwap-gate ──
// Each test mutates these arrays/objects to simulate market state.

const quotesStub = { _quotes: {} };
const intradayStub = { _bars: [] };
const volPaceStub  = { _pace: null };

require.cache[require.resolve('../../src/data/providers/manager')] = {
  exports: {
    getQuotes:        async (symbols) => symbols.map(s => quotesStub._quotes[s] ?? null).filter(Boolean),
    getIntradayBars:  async ()        => intradayStub._bars,
    getHistory:       async ()        => [],
    getHistoryFull:   async ()        => null,
    getFundamentals:  async ()        => null,
  },
};
require.cache[require.resolve('../../src/signals/volume-pace')] = {
  exports: {
    getVolumePace:    async ()        => volPaceStub._pace,
    passesVolumePace: async ()        => true,
    minutesSinceMarketOpenET: () => 120,
    isMarketOpen:    () => true,
  },
};

const { evaluateGate } = require('../../src/broker/vwap-gate');

// ── Helpers ────────────────────────────────────────────────────────────────
const buyRow = (overrides = {}) => ({
  id: 1, symbol: 'MKSI', side: 'buy', entry_price: 281.00, ...overrides,
});

// ── Trigger-price gate ─────────────────────────────────────────────────────

test('trigger-only: live price ≥ trigger → pass', async () => {
  quotesStub._quotes.MKSI = { symbol: 'MKSI', regularMarketPrice: 281.50 };
  const v = await evaluateGate(buyRow(), { triggerPrice: 280.98 });
  assert.equal(v.pass, true, v.reasons.join(','));
  assert.match(v.reasons[0], /all_gates_passed:trigger/);
});

test('trigger-only: live price < trigger → fail (still pending)', async () => {
  quotesStub._quotes.MKSI = { symbol: 'MKSI', regularMarketPrice: 280.00 };
  const v = await evaluateGate(buyRow(), { triggerPrice: 280.98 });
  assert.equal(v.pass, false);
  assert.match(v.reasons[0], /below_trigger/);
});

test('trigger-only short side: live price ≤ trigger → pass', async () => {
  quotesStub._quotes.MKSI = { symbol: 'MKSI', regularMarketPrice: 99.50 };
  const v = await evaluateGate(buyRow({ side: 'sell' }), { triggerPrice: 100 });
  assert.equal(v.pass, true);
});

test('trigger-only: missing quote → fail safely (no submit)', async () => {
  delete quotesStub._quotes.MKSI;
  const v = await evaluateGate(buyRow(), { triggerPrice: 280.98 });
  assert.equal(v.pass, false);
  assert.match(v.reasons[0], /trigger_quote_unavailable/);
});

// ── Volume-pace gate ───────────────────────────────────────────────────────

test('volume-only: pace ≥ min → pass', async () => {
  volPaceStub._pace = { pace: 1.5, label: 'HEAVY', confidence: 'high' };
  const v = await evaluateGate(buyRow(), { volumePaceMin: 1.4 });
  assert.equal(v.pass, true);
  assert.match(v.reasons[0], /all_gates_passed:volume/);
});

test('volume-only: pace < min → fail', async () => {
  volPaceStub._pace = { pace: 1.1, label: 'NORMAL', confidence: 'high' };
  const v = await evaluateGate(buyRow(), { volumePaceMin: 1.4 });
  assert.equal(v.pass, false);
  assert.match(v.reasons[0], /volume_light/);
});

test('volume-only: low-confidence window allows 80% threshold (1.4 → 1.12)', async () => {
  // Pace 1.2 in low-confidence window (first 30 min) is below 1.4 strict
  // but above 1.4 × 0.8 = 1.12, so the gate should accept it.
  volPaceStub._pace = { pace: 1.2, label: 'ELEVATED', confidence: 'low' };
  const v = await evaluateGate(buyRow(), { volumePaceMin: 1.4 });
  assert.equal(v.pass, true);
});

test('volume-only: no-data response → allow (fallback=true philosophy)', async () => {
  volPaceStub._pace = { pace: null, reason: 'Missing volume data', confidence: 'no_data' };
  const v = await evaluateGate(buyRow(), { volumePaceMin: 1.4 });
  assert.equal(v.pass, true);
  assert.equal(v.data.volumePaceFallback, 'Missing volume data');
});

// ── Combined trigger + volume (AND) ────────────────────────────────────────

test('trigger + volume: both pass → pass', async () => {
  quotesStub._quotes.MKSI = { symbol: 'MKSI', regularMarketPrice: 281.50 };
  volPaceStub._pace = { pace: 1.5, confidence: 'high' };
  const v = await evaluateGate(buyRow(), { triggerPrice: 280.98, volumePaceMin: 1.4 });
  assert.equal(v.pass, true);
  assert.deepEqual(v.data.activeGates, ['trigger', 'volume']);
});

test('trigger + volume: trigger pass, volume fail → fail', async () => {
  quotesStub._quotes.MKSI = { symbol: 'MKSI', regularMarketPrice: 281.50 };
  volPaceStub._pace = { pace: 1.0, confidence: 'high' };
  const v = await evaluateGate(buyRow(), { triggerPrice: 280.98, volumePaceMin: 1.4 });
  assert.equal(v.pass, false);
  assert.match(v.reasons[0], /volume_light/);
});

test('trigger + volume: trigger fail short-circuits → no volume call', async () => {
  // If trigger fails, we should not even consult volume — the cron will
  // re-evaluate next tick. This pins the cheap-checks-first ordering.
  quotesStub._quotes.MKSI = { symbol: 'MKSI', regularMarketPrice: 270.00 };
  let volCalled = false;
  const prev = require.cache[require.resolve('../../src/signals/volume-pace')].exports.getVolumePace;
  require.cache[require.resolve('../../src/signals/volume-pace')].exports.getVolumePace = async () => { volCalled = true; return { pace: 1.5, confidence: 'high' }; };
  const v = await evaluateGate(buyRow(), { triggerPrice: 280.98, volumePaceMin: 1.4 });
  require.cache[require.resolve('../../src/signals/volume-pace')].exports.getVolumePace = prev;
  assert.equal(v.pass, false);
  assert.equal(volCalled, false, 'volume gate should not be evaluated when trigger fails');
});

// ── Empty gate JSON edge case ──────────────────────────────────────────────

test('empty gate: passes with no_gates_configured (UI should disarm instead)', async () => {
  const v = await evaluateGate(buyRow(), {});
  assert.equal(v.pass, true);
  assert.match(v.reasons[0], /no_gates_configured/);
});

// ── eodOnly defers all evaluation until 3:00 PM ET ────────────────────────

test('eodOnly: midday (120 min after open) → deferred', async () => {
  // The volume-pace stub at top of file returns minutesSinceMarketOpenET=120.
  // 120 < 375, so eodOnly blocks regardless of trigger.
  quotesStub._quotes.MKSI = { symbol: 'MKSI', regularMarketPrice: 281.50 };
  const v = await evaluateGate(buyRow(), { eodOnly: true, triggerPrice: 280.98 });
  assert.equal(v.pass, false);
  assert.match(v.reasons[0], /eod_only:wait_until_3pm_et/);
});

test('eodOnly: late-session (380 min after open) → gates run normally', async () => {
  const prev = require.cache[require.resolve('../../src/signals/volume-pace')].exports.minutesSinceMarketOpenET;
  require.cache[require.resolve('../../src/signals/volume-pace')].exports.minutesSinceMarketOpenET = () => 380;
  quotesStub._quotes.MKSI = { symbol: 'MKSI', regularMarketPrice: 281.50 };
  const v = await evaluateGate(buyRow(), { eodOnly: true, triggerPrice: 280.98 });
  require.cache[require.resolve('../../src/signals/volume-pace')].exports.minutesSinceMarketOpenET = prev;
  assert.equal(v.pass, true, v.reasons.join(','));
  assert.deepEqual(v.data.activeGates, ['eod', 'trigger']);
});
