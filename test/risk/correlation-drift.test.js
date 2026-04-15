// ─── Tests: Phase 2.8 correlation drift watcher (src/risk/correlation-drift.js) ─
//
// The drift watcher is designed as a 3-gate filter:
//   (a) current correlation ≥ 0.80
//   (b) drift from baseline ≥ 0.20
//   (c) both legs ≥ 3% of book weight
// All three must hold, AND the pair must be outside its 24h cooldown, for
// an alert to fire. These tests walk each gate.
//
// We seed:
//   - A fake `trades` table row per position so getOpenPositions() works
//   - rs_snapshots rows per symbol with synthetic close sequences that
//     give us precise control over pairwise correlation.
//
// The notifications module is stubbed via require.cache so no real fetch
// happens.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Stub notifications BEFORE requiring the drift module ───────────────────
const notifySpy = [];
require.cache[require.resolve('../../src/notifications/channels')] = {
  exports: {
    notifyTradeEvent: async (event) => { notifySpy.push(event); return event; },
    // Transitive no-ops so unrelated requires don't blow up.
    deliverAlert: async () => [],
    getEnabledChannels: () => [],
    getNotificationChannels: () => [],
    createNotificationChannel: () => ({}),
    updateNotificationChannel: () => ({}),
    deleteNotificationChannel: () => {},
    testChannel: () => [],
    getDeliveryLog: () => [],
    getDeliveryStats: () => [],
    getAvailableChannels: () => [],
    sendSlack: async () => ({}),
    sendTelegram: async () => ({}),
    sendWebhook: async () => ({}),
    sendPushover: async () => ({}),
  },
};

const { getDB } = require('../../src/data/database');
const {
  runCorrelationDriftCheck,
  pairCorrelation,
  computeWeights,
  canonPair,
  pruneClosedBaselines,
} = require('../../src/risk/correlation-drift');

function clearSpy() { notifySpy.length = 0; }

function wipe() {
  const d = getDB();
  d.prepare('DELETE FROM trades').run();
  d.prepare('DELETE FROM rs_snapshots').run();
  try { d.prepare('DELETE FROM correlation_baselines').run(); } catch (_) {}
  try { d.prepare('DELETE FROM correlation_drift_alerts').run(); } catch (_) {}
  clearSpy();
}

// Open a position row directly in the trades table.
function openPosition({ symbol, shares = 100, entryPrice = 100, side = 'long', remaining = null }) {
  const r = getDB().prepare(`
    INSERT INTO trades (symbol, side, entry_date, entry_price, shares, remaining_shares)
    VALUES (?, ?, date('now'), ?, ?, ?)
  `).run(symbol, side, entryPrice, shares, remaining ?? shares);
  return r.lastInsertRowid;
}

// Seed N daily closes for a symbol — controlled return sequence.
// `returns` is the decimal daily return series, `startPrice` the seed.
function seedCloses(symbol, returns, startPrice = 100) {
  const ins = getDB().prepare(`
    INSERT INTO rs_snapshots (date, symbol, type, price)
    VALUES (?, ?, 'stock', ?)
  `);
  let price = startPrice;
  const base = new Date(Date.UTC(2025, 0, 1));
  // Oldest → newest so getSnapshotCloses(...).reverse() tail aligns correctly.
  for (let i = 0; i < returns.length; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    price = price * (1 + returns[i]);
    ins.run(iso, symbol, price);
  }
}

// Build a deterministic return series with a given sign pattern, used to
// create correlated or uncorrelated pairs on demand.
function buildReturns(pattern, n = 60, magnitude = 0.01) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const sign = pattern[i % pattern.length];
    out.push(sign * magnitude);
  }
  return out;
}

// ─── canonPair ─────────────────────────────────────────────────────────────

test('canonPair: returns alphabetical order regardless of input order', () => {
  assert.deepEqual(canonPair('MSFT', 'AAPL'), ['AAPL', 'MSFT']);
  assert.deepEqual(canonPair('AAPL', 'MSFT'), ['AAPL', 'MSFT']);
  assert.deepEqual(canonPair('AAPL', 'AAPL'), ['AAPL', 'AAPL']);
});

// ─── pairCorrelation ──────────────────────────────────────────────────────

test('pairCorrelation: identical series → ≈ +1', () => {
  const a = buildReturns([1, -1, 1, -1], 60);
  const closesA = [];
  let pA = 100, pB = 100;
  const closesB = [];
  for (const r of a) { pA *= 1 + r; closesA.push(pA); pB *= 1 + r; closesB.push(pB); }
  const corr = pairCorrelation(closesA, closesB);
  assert.ok(corr > 0.99, `expected ≥ 0.99, got ${corr}`);
});

test('pairCorrelation: opposite series → ≈ -1', () => {
  const patA = buildReturns([1, -1, 1, -1], 60);
  const patB = patA.map(r => -r);
  let pA = 100, pB = 100;
  const closesA = [], closesB = [];
  for (let i = 0; i < patA.length; i++) {
    pA *= 1 + patA[i]; closesA.push(pA);
    pB *= 1 + patB[i]; closesB.push(pB);
  }
  const corr = pairCorrelation(closesA, closesB);
  assert.ok(corr < -0.99, `expected ≤ -0.99, got ${corr}`);
});

test('pairCorrelation: too few bars → null', () => {
  const short = [100, 101, 102, 103, 104];
  assert.equal(pairCorrelation(short, short), null);
});

test('pairCorrelation: null input → null', () => {
  assert.equal(pairCorrelation(null, [1, 2, 3]), null);
  assert.equal(pairCorrelation([1, 2, 3], null), null);
});

// ─── computeWeights ────────────────────────────────────────────────────────

test('computeWeights: equal-sized positions → equal weights', () => {
  const positions = [
    { symbol: 'A', shares: 100, entry_price: 50 },
    { symbol: 'B', shares: 100, entry_price: 50 },
  ];
  const out = computeWeights(positions);
  assert.equal(out[0].weightPct, 50);
  assert.equal(out[1].weightPct, 50);
});

test('computeWeights: quote override takes precedence over entry_price', () => {
  const positions = [
    { symbol: 'A', shares: 10, entry_price: 100 },  // entry notional 1000
    { symbol: 'B', shares: 10, entry_price: 100 },  // entry notional 1000
  ];
  // A has mark 200 → notional 2000; B still at 1000. Total 3000 → A=66.7%, B=33.3%
  const out = computeWeights(positions, { A: 200, B: 100 });
  assert.ok(Math.abs(out[0].weightPct - 66.666) < 0.1);
  assert.ok(Math.abs(out[1].weightPct - 33.333) < 0.1);
});

test('computeWeights: zero notional → all zero weights, no NaN', () => {
  const out = computeWeights([{ symbol: 'A', shares: 0, entry_price: 0 }]);
  assert.equal(out[0].weightPct, 0);
});

// ─── runCorrelationDriftCheck — the full pipeline ─────────────────────────

test('drift watcher: fewer than 2 positions → no-op', async () => {
  wipe();
  openPosition({ symbol: 'AAPL', shares: 100, entryPrice: 100 });
  // Only one position — nothing to pair.
  const result = await runCorrelationDriftCheck();
  assert.equal(result.checked, 1);
  assert.equal(result.pairs?.length || 0, 0);
  assert.equal(result.alerted.length, 0);
});

test('drift watcher: uncorrelated pair → no alert, baseline seeded', async () => {
  wipe();
  openPosition({ symbol: 'AAA', shares: 100, entryPrice: 100 });
  openPosition({ symbol: 'BBB', shares: 100, entryPrice: 100 });

  // AAA and BBB move with opposite patterns — near-zero correlation.
  seedCloses('AAA', buildReturns([1, -1, 1, -1, 1, -1], 60));
  seedCloses('BBB', buildReturns([1, 1, -1, -1, 1, 1, -1, -1], 60));

  const result = await runCorrelationDriftCheck();
  assert.equal(result.pairs.length, 1);
  assert.equal(result.alerted.length, 0);
  assert.equal(notifySpy.length, 0);
  // Baseline gets written on the first sweep.
  const baseline = getDB().prepare(
    'SELECT baseline FROM correlation_baselines WHERE symbol_a = ? AND symbol_b = ?'
  ).get('AAA', 'BBB');
  assert.ok(baseline != null);
});

test('drift watcher: always-correlated pair → no alert (no drift)', async () => {
  wipe();
  openPosition({ symbol: 'AAA', shares: 100, entryPrice: 100 });
  openPosition({ symbol: 'BBB', shares: 100, entryPrice: 100 });

  // Both series identical → correlation ≈ 1 on day 1 → baseline ≈ 1 →
  // no DRIFT on day 2 because current = baseline, so the drift gate blocks.
  const identical = buildReturns([1, -1, 1, -1, 1], 60);
  seedCloses('AAA', identical);
  seedCloses('BBB', identical);

  // First pass: baselines seeded at ~1.0. No alert — they were already
  // correlated at "entry", which is the signal we want to miss.
  const r1 = await runCorrelationDriftCheck();
  assert.equal(r1.alerted.length, 0, `first sweep should not alert: ${JSON.stringify(r1.alerted)}`);

  // Second pass: current ≈ baseline (still ~1.0) → drift ≈ 0 → still no alert.
  const r2 = await runCorrelationDriftCheck();
  assert.equal(r2.alerted.length, 0);
  assert.ok(r2.skipped.some(s => s.reason === 'not_drifting_from_baseline'),
    `expected not_drifting_from_baseline skip reason, got: ${r2.skipped.map(s => s.reason).join(',')}`);
});

test('drift watcher: drifted pair with sufficient weight → ALERTS', async () => {
  wipe();
  openPosition({ symbol: 'AAA', shares: 100, entryPrice: 100 });
  openPosition({ symbol: 'BBB', shares: 100, entryPrice: 100 });

  // Seed a baseline where A and B were uncorrelated (seed the
  // correlation_baselines row directly — simulates historical state).
  // Then later seed closes that make them perfectly correlated now.
  const aaaPerfect = buildReturns([1, -1, 1, -1, 1], 60);
  const bbbPerfect = aaaPerfect.slice();
  seedCloses('AAA', aaaPerfect);
  seedCloses('BBB', bbbPerfect);

  // Inject a LOW baseline before the sweep — simulates "these were
  // uncorrelated at entry". Since current ≈ 1, drift = ~+0.8 > 0.2 gate.
  getDB().prepare(`
    INSERT INTO correlation_baselines (symbol_a, symbol_b, baseline)
    VALUES ('AAA', 'BBB', 0.10)
  `).run();

  clearSpy();
  const r = await runCorrelationDriftCheck();

  assert.equal(r.alerted.length, 1, `expected 1 alert, got ${JSON.stringify(r, null, 2)}`);
  assert.equal(r.alerted[0].symbol_a, 'AAA');
  assert.equal(r.alerted[0].symbol_b, 'BBB');
  assert.ok(r.alerted[0].current > 0.80);
  assert.ok(r.alerted[0].drift > 0.20);

  // And a notification must have fired with the expected event name.
  assert.equal(notifySpy.length, 1);
  assert.equal(notifySpy[0].event, 'correlation_drift');
  assert.equal(notifySpy[0].symbol, 'AAA/BBB');
});

test('drift watcher: below-weight leg → no alert even on lockstep', async () => {
  wipe();
  // BBB is only 10 shares at $10 = $100, vs AAA 100 shares at $100 = $10,000.
  // Book = $10,100 → BBB weight ≈ 0.99%, below the 3% gate.
  openPosition({ symbol: 'AAA', shares: 100, entryPrice: 100 });
  openPosition({ symbol: 'BBB', shares: 10, entryPrice: 10 });

  const perfect = buildReturns([1, -1, 1, -1, 1], 60);
  seedCloses('AAA', perfect);
  seedCloses('BBB', perfect);

  getDB().prepare(`
    INSERT INTO correlation_baselines (symbol_a, symbol_b, baseline)
    VALUES ('AAA', 'BBB', 0.10)
  `).run();

  clearSpy();
  const r = await runCorrelationDriftCheck();

  assert.equal(r.alerted.length, 0);
  assert.ok(r.skipped.some(s => s.reason === 'below_min_weight'));
  assert.equal(notifySpy.length, 0);
});

test('drift watcher: cooldown suppresses duplicate alert inside 24h', async () => {
  wipe();
  openPosition({ symbol: 'AAA', shares: 100, entryPrice: 100 });
  openPosition({ symbol: 'BBB', shares: 100, entryPrice: 100 });
  const perfect = buildReturns([1, -1, 1, -1, 1], 60);
  seedCloses('AAA', perfect);
  seedCloses('BBB', perfect);
  getDB().prepare(`
    INSERT INTO correlation_baselines (symbol_a, symbol_b, baseline)
    VALUES ('AAA', 'BBB', 0.10)
  `).run();

  clearSpy();
  const first = await runCorrelationDriftCheck();
  assert.equal(first.alerted.length, 1);
  assert.equal(notifySpy.length, 1);

  // Immediate second sweep — must be suppressed by cooldown.
  const second = await runCorrelationDriftCheck();
  assert.equal(second.alerted.length, 0);
  assert.ok(second.skipped.some(s => s.reason === 'cooldown_active'));
  assert.equal(notifySpy.length, 1, 'no duplicate notification inside cooldown');
});

test('drift watcher: insufficient price data → skipped with reason', async () => {
  wipe();
  openPosition({ symbol: 'AAA', shares: 100, entryPrice: 100 });
  openPosition({ symbol: 'BBB', shares: 100, entryPrice: 100 });
  // Only 5 bars — below MIN_BARS=30.
  seedCloses('AAA', [0.01, 0.02, -0.01, 0.01, 0]);
  seedCloses('BBB', [0.01, 0.02, -0.01, 0.01, 0]);

  const r = await runCorrelationDriftCheck();
  assert.equal(r.alerted.length, 0);
  assert.ok(r.skipped.some(s => s.reason === 'insufficient_price_data'));
});

test('drift watcher: custom quotes override entry price for weight calc', async () => {
  wipe();
  // Position sizes small relative to the mark delta so the weight calc
  // is driven by the quote, not the shares.
  openPosition({ symbol: 'AAA', shares: 10, entryPrice: 10 });  // entry notional 100
  openPosition({ symbol: 'BBB', shares: 10, entryPrice: 10 });
  const perfect = buildReturns([1, -1, 1, -1, 1], 60);
  seedCloses('AAA', perfect);
  seedCloses('BBB', perfect);
  getDB().prepare(`
    INSERT INTO correlation_baselines (symbol_a, symbol_b, baseline)
    VALUES ('AAA', 'BBB', 0.10)
  `).run();

  clearSpy();
  // With quotes of $1000 each, notionals become $10,000 per leg — giving
  // both 50% weight, well above the 3% gate.
  const r = await runCorrelationDriftCheck({ quotes: { AAA: 1000, BBB: 1000 } });
  assert.equal(r.alerted.length, 1);
});

test('drift watcher: pruneClosedBaselines drops rows for closed positions', () => {
  wipe();
  // Insert baselines for 3 pairs, then close one position and prune.
  getDB().prepare(`INSERT INTO trades (symbol, side, entry_date, entry_price, shares) VALUES
    ('X', 'long', date('now'), 100, 10),
    ('Y', 'long', date('now'), 100, 10),
    ('Z', 'long', date('now'), 100, 10)
  `).run();
  getDB().prepare(`INSERT INTO correlation_baselines (symbol_a, symbol_b, baseline) VALUES
    ('X', 'Y', 0.3),
    ('X', 'Z', 0.4),
    ('Y', 'Z', 0.5)
  `).run();
  // Close Z
  getDB().prepare("UPDATE trades SET exit_date = date('now') WHERE symbol = 'Z'").run();

  pruneClosedBaselines();

  const remaining = getDB().prepare('SELECT symbol_a, symbol_b FROM correlation_baselines').all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].symbol_a, 'X');
  assert.equal(remaining[0].symbol_b, 'Y');
});
