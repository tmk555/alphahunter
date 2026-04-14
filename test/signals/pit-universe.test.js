// ─── Tests: Point-in-Time Universe Membership ──────────────────────────────
//
// Exercises the three edge cases that break survivor-bias-naive code:
//
//   1. Continuous membership — symbol was in from the start and never left.
//   2. Expired stint — symbol was removed on a date D, so on D itself and
//      after it must NOT appear, but the day before D it must.
//   3. Re-addition — symbol left and came back, stored as two rows; the
//      window between them must exclude the symbol.
//
// The fixture at test/fixtures/pit-universe-tiny.json covers all three with
// a synthetic index ("TEST500") so we never depend on real SP500 data or
// network fetches. end_date is exclusive by convention, matching the
// getMembersOn SQL (`end_date > ?`).

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const pit = require('../../src/signals/pit-universe');
const { getDB } = require('../../src/data/database');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'pit-universe-tiny.json');

// Wipe the test index between cases so state doesn't leak.
function resetFixture() {
  pit.clearIndex('TEST500');
  pit.loadFromSeedFile(FIXTURE);
}

test('pit-universe: loads seed file and reports coverage', () => {
  resetFixture();
  const coverage = pit.getCoverage('TEST500');
  assert.equal(coverage.total_stints, 5, 'fixture has 5 stint rows');
  assert.equal(coverage.distinct_symbols, 4, 'NFLX counted once across 2 stints');
  assert.equal(coverage.earliest_start, '2000-01-03');
});

test('pit-universe: continuous membership (AAPL in since 2010)', () => {
  resetFixture();
  // Before AAPL's start → not a member.
  assert.ok(!pit.getMembersOn('2009-12-31', 'TEST500').includes('AAPL'));
  // On the start date → member (start is inclusive).
  assert.ok(pit.getMembersOn('2010-01-04', 'TEST500').includes('AAPL'));
  // Long after → still a member.
  assert.ok(pit.getMembersOn('2024-06-01', 'TEST500').includes('AAPL'));
});

test('pit-universe: expired stint — ENRON gone after 2001-12-03', () => {
  resetFixture();
  // Day before removal → still a member.
  assert.ok(pit.getMembersOn('2001-12-02', 'TEST500').includes('ENRON'));
  // end_date is exclusive → the removal date itself is NOT a member.
  assert.ok(!pit.getMembersOn('2001-12-03', 'TEST500').includes('ENRON'));
  // Day after removal → not a member.
  assert.ok(!pit.getMembersOn('2002-01-01', 'TEST500').includes('ENRON'));
});

test('pit-universe: re-addition — NFLX out between 2015 and 2019', () => {
  resetFixture();
  // First stint: in.
  assert.ok(pit.getMembersOn('2013-06-01', 'TEST500').includes('NFLX'));
  // After first removal, before second add: out.
  assert.ok(!pit.getMembersOn('2017-01-01', 'TEST500').includes('NFLX'));
  // After re-addition: in again.
  assert.ok(pit.getMembersOn('2020-01-01', 'TEST500').includes('NFLX'));
});

test('pit-universe: getMembersOn is case-insensitive on indexName', () => {
  resetFixture();
  const lower = pit.getMembersOn('2024-01-01', 'test500');
  const upper = pit.getMembersOn('2024-01-01', 'TEST500');
  assert.deepEqual(lower, upper);
  assert.ok(lower.includes('AAPL'));
});

test('pit-universe: empty result on a date predating all stints', () => {
  resetFixture();
  // Before ENRON was added → nothing in our TEST500 universe.
  assert.deepEqual(pit.getMembersOn('1999-06-01', 'TEST500'), []);
});

test('pit-universe: survivor-biased universe would be wrong on 2018-01-01', () => {
  // Concretely demonstrate the bias fix: today's tiny universe has AAPL,
  // NFLX, NVDA — but a 2018 backtest cannot see NVDA (added 2019-11-20)
  // and must see NFLX as absent mid-2018 (between its two stints).
  resetFixture();

  const today    = pit.getMembersOn('2024-06-01', 'TEST500');
  const historic = pit.getMembersOn('2018-01-01', 'TEST500');

  assert.ok(today.includes('NVDA'),      'NVDA is in the current universe');
  assert.ok(!historic.includes('NVDA'),  'NVDA must NOT appear in 2018 universe');
  assert.ok(!historic.includes('NFLX'),  'NFLX was out mid-2018 (between stints)');
  assert.ok(historic.includes('AAPL'),   'AAPL was in throughout');
});

test('pit-universe: importMembership rejects non-array input', () => {
  assert.throws(() => pit.importMembership(null), /array/);
  assert.throws(() => pit.importMembership({}), /array/);
});

test('pit-universe: importMembership skips rows missing required fields', () => {
  pit.clearIndex('JUNK');
  const result = pit.importMembership([
    { indexName: 'JUNK', symbol: 'OK', startDate: '2020-01-01' },
    { indexName: 'JUNK', symbol: null, startDate: '2020-01-01' }, // missing symbol
    { indexName: 'JUNK', startDate: '2020-01-01' },                // missing symbol
    { indexName: 'JUNK', symbol: 'NOSTART' },                      // missing start
  ]);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 3);
});

test('pit-universe: getMembershipOn returns sector metadata', () => {
  resetFixture();
  const rows = pit.getMembershipOn('2024-06-01', 'TEST500');
  const aapl = rows.find(r => r.symbol === 'AAPL');
  assert.ok(aapl);
  assert.equal(aapl.sector, 'Technology');
});

test('pit-universe: clearIndex only wipes the specified index', () => {
  resetFixture();
  pit.importMembership([
    { indexName: 'OTHER', symbol: 'XYZ', startDate: '2020-01-01' },
  ]);
  pit.clearIndex('TEST500');
  assert.deepEqual(pit.getMembersOn('2024-01-01', 'TEST500'), []);
  assert.deepEqual(pit.getMembersOn('2024-01-01', 'OTHER'), ['XYZ']);
  pit.clearIndex('OTHER'); // cleanup
});
