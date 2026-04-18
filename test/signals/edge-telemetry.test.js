// ─── Tests: edge-telemetry (Layer 1 logger) ─────────────────────────────────
//
// Exercises the signal_outcomes logger: insertion, batch, querying, and
// outcome resolution. Uses an in-memory DB so the test is self-contained.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

// getDB initializes schema on first call — must be triggered before the
// telemetry module inserts.
require('../../src/data/database').getDB();

const {
  logSignal,
  logSignalsBatch,
  getOpenSignals,
  getSignal,
  listSignals,
  resolveOutcome,
  summary,
  confidenceToProb,
  parsePrice,
} = require('../../src/signals/edge-telemetry');

test('confidenceToProb maps tiers, returns null for unknown', () => {
  assert.equal(confidenceToProb('high'), 0.75);
  assert.equal(confidenceToProb('MEDIUM'), 0.50);
  assert.equal(confidenceToProb(' low '), 0.25);
  assert.equal(confidenceToProb('bogus'), null);
  assert.equal(confidenceToProb(null), null);
});

test('parsePrice handles numbers and $-prefixed strings', () => {
  assert.equal(parsePrice(123.45), 123.45);
  assert.equal(parsePrice('$185.50'), 185.50);
  assert.equal(parsePrice('$180-$185'), 180);        // uses first number in range
  assert.equal(parsePrice('1.5×ATR below entry'), 1.5);
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice('garbage'), null);
});

test('logSignal inserts and returns id, rejects bad input', () => {
  // Missing source/symbol → null, no throw
  assert.equal(logSignal({}), null);
  assert.equal(logSignal({ source: 'trade_setup' }), null);
  assert.equal(logSignal(null), null);

  const id = logSignal({
    source: 'trade_setup',
    symbol: 'aapl',                    // lowercase to verify uppercasing
    strategy: 'swing',
    verdict: 'BUY',
    confidence: 'high',
    conviction_score: 78.5,
    entry_price: '$185.00',
    stop_price: 180,
    target1_price: 195,
    target2_price: 205,
    rs_rank: 88,
    swing_momentum: 72,
    regime: 'BULL',
    meta: { thesis: 'strong setup' },
  });
  assert.ok(id > 0);

  const row = getSignal(id);
  assert.equal(row.symbol, 'AAPL');    // uppercased
  assert.equal(row.confidence_prob, 0.75);
  assert.equal(row.entry_price, 185);  // parsed from string
  assert.equal(row.stop_price, 180);
  assert.equal(row.status, 'open');
  assert.equal(row.horizon_days, 20);  // default
  assert.equal(row.side, 'long');      // default
  assert.equal(JSON.parse(row.meta).thesis, 'strong setup');
});

test('logSignal defaults confidence_prob from confidence string', () => {
  const id = logSignal({ source: 'staged_order', symbol: 'NVDA', confidence: 'medium' });
  assert.equal(getSignal(id).confidence_prob, 0.50);
});

test('logSignal tolerates null confidence without failure', () => {
  const id = logSignal({ source: 'staged_order', symbol: 'MSFT' });
  assert.ok(id > 0);
  assert.equal(getSignal(id).confidence_prob, null);
});

test('logSignalsBatch inserts multiple and skips invalid entries', () => {
  const ids = logSignalsBatch([
    { source: 'trade_setup', symbol: 'AMD', verdict: 'BUY', confidence: 'high' },
    { symbol: 'bad_no_source' },                                 // skipped
    null,                                                         // skipped
    { source: 'trade_setup', symbol: 'TSLA', verdict: 'WATCH', confidence: 'medium' },
  ]);
  assert.equal(ids.length, 4);
  assert.ok(ids[0] > 0);
  assert.equal(ids[1], null);
  assert.equal(ids[2], null);
  assert.ok(ids[3] > 0);
});

test('listSignals filters by source, strategy, symbol, status', () => {
  logSignal({ source: 'pullback_alert', symbol: 'META', strategy: 'pullback' });
  const pb = listSignals({ source: 'pullback_alert' });
  assert.ok(pb.length >= 1);
  assert.ok(pb.every(r => r.source === 'pullback_alert'));

  const aapl = listSignals({ symbol: 'AAPL' });
  assert.ok(aapl.length >= 1);
  assert.ok(aapl.every(r => r.symbol === 'AAPL'));

  const open = listSignals({ status: 'open' });
  assert.ok(open.every(r => r.status === 'open'));
});

test('resolveOutcome updates row and clears from open set when resolved', () => {
  const id = logSignal({
    source: 'trade_setup', symbol: 'GOOG', verdict: 'BUY',
    confidence: 'high', entry_price: 100, stop_price: 95,
    // Backdate emission to simulate an old signal
    emission_date: '2020-01-01',
  });
  const ok = resolveOutcome(id, {
    status: 'resolved',
    close_price_5d: 102, close_price_10d: 103, close_price_20d: 105,
    ret_5d: 0.02, ret_10d: 0.03, ret_20d: 0.05,
    max_favorable: 0.06, max_adverse: -0.01,
    hit_stop: false, hit_target1: true, hit_target2: false,
    realized_r: 1.0, outcome_label: 'winner',
  });
  assert.equal(ok, true);

  const row = getSignal(id);
  assert.equal(row.status, 'resolved');
  assert.equal(row.outcome_label, 'winner');
  assert.equal(row.hit_target1, 1);
  assert.equal(row.ret_20d, 0.05);

  // Old signal resolved → shouldn't appear in open set
  const open = getOpenSignals({ minAgeDays: 1 });
  assert.ok(!open.find(r => r.id === id));
});

test('summary counts totals and outcome buckets', () => {
  const s = summary();
  assert.ok(s.total > 0);
  assert.ok(s.winners >= 1);
  assert.ok(s.resolved_count >= 1);
});

test('getOpenSignals respects minAgeDays', () => {
  // Fresh signal (today) — should NOT appear with minAgeDays=5
  logSignal({ source: 'trade_setup', symbol: 'CRM' });
  const recent = getOpenSignals({ minAgeDays: 5 });
  assert.ok(!recent.find(r => r.symbol === 'CRM'));

  // With minAgeDays=0, newly inserted rows qualify
  const allOpen = getOpenSignals({ minAgeDays: 0 });
  assert.ok(allOpen.find(r => r.symbol === 'CRM'));
});
