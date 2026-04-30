// ─── Tests for Phase 3.13: Real McClellan Breadth ────────────────────────────
// Verifies that A/D computation uses actual price changes and that the
// McClellan oscillator (EMA(19) - EMA(39)) works correctly.
//
// Converted from Jest to node:test on 2026-04-30. Stubs the database module
// via require.cache injection so the tests can run without a real connection
// while still using better-sqlite3 in-memory for the schema/SQL.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

let mockDatabase;

// Stub the database + cache modules BEFORE requiring breadth so the import
// captures our test doubles.
require.cache[require.resolve('../../src/data/database')] = {
  exports: { getDB: () => mockDatabase },
};
require.cache[require.resolve('../../src/data/cache')] = {
  exports: {
    cacheGet: () => null,
    cacheSet: () => {},
    cacheClear: () => {},
    TTL_QUOTE: 30000,
  },
};

const {
  computeBreadthFromSnapshots,
  computeMcClellanOscillator,
  computeCompositeBreadthScore,
} = require('../../src/signals/breadth');

// Per-test fresh DB. Replaces beforeEach.
function freshDb() {
  if (mockDatabase) try { mockDatabase.close(); } catch (_) {}
  mockDatabase = new Database(':memory:');
  mockDatabase.exec(`
    CREATE TABLE rs_snapshots (
      id INTEGER PRIMARY KEY,
      date TEXT,
      symbol TEXT,
      type TEXT DEFAULT 'stock',
      price REAL,
      vs_ma50 REAL DEFAULT 0,
      vs_ma200 REAL DEFAULT 0,
      rs_rank INTEGER DEFAULT 50,
      swing_momentum REAL DEFAULT 50,
      stage INTEGER DEFAULT 2,
      volume_ratio REAL DEFAULT 1.0,
      rs_line_new_high INTEGER DEFAULT 0,
      vcp_forming INTEGER DEFAULT 0
    );
    CREATE TABLE breadth_snapshots (
      date TEXT PRIMARY KEY,
      pct_above_50ma REAL,
      pct_above_200ma REAL,
      new_highs INTEGER,
      new_lows INTEGER,
      ad_ratio REAL,
      vol_thrust_pct REAL,
      stage2_pct REAL,
      stage4_pct REAL,
      composite_score REAL,
      regime TEXT,
      mcclellan_osc REAL,
      summation_index REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function insertSnapshot(date, symbol, price, overrides = {}) {
  const defaults = {
    type: 'stock', vs_ma50: 0, vs_ma200: 0, rs_rank: 50,
    swing_momentum: 50, stage: 2, volume_ratio: 1.0,
    rs_line_new_high: 0, vcp_forming: 0,
  };
  const d = { ...defaults, ...overrides };
  mockDatabase.prepare(`
    INSERT INTO rs_snapshots (date, symbol, type, price, vs_ma50, vs_ma200, rs_rank,
      swing_momentum, stage, volume_ratio, rs_line_new_high, vcp_forming)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, symbol, d.type, price, d.vs_ma50, d.vs_ma200, d.rs_rank,
    d.swing_momentum, d.stage, d.volume_ratio, d.rs_line_new_high, d.vcp_forming);
}

// ── A/D uses real price changes ───────────────────────────────────────────

test('A/D: advancing = stocks where close > prior close', () => {
  freshDb();
  const symbols = [];
  for (let i = 0; i < 30; i++) symbols.push(`STK${i}`);

  for (const sym of symbols) insertSnapshot('2025-01-10', sym, 100);
  for (let i = 0; i < 20; i++) insertSnapshot('2025-01-13', symbols[i], 102); // up
  for (let i = 20; i < 25; i++) insertSnapshot('2025-01-13', symbols[i], 98);  // down
  for (let i = 25; i < 30; i++) insertSnapshot('2025-01-13', symbols[i], 100); // flat

  const result = computeBreadthFromSnapshots('2025-01-13');
  assert.ok(result, 'result not null');
  assert.equal(result.advancing, 20);
  assert.equal(result.declining, 5);
  assert.equal(result.neutral, 5);
  assert.equal(result.adRatio, 4.00);
});

test('A/D: all stocks declining → adRatio = 0', () => {
  freshDb();
  const symbols = [];
  for (let i = 0; i < 25; i++) symbols.push(`D${i}`);
  for (const sym of symbols) insertSnapshot('2025-01-10', sym, 100);
  for (const sym of symbols) insertSnapshot('2025-01-13', sym, 95);

  const result = computeBreadthFromSnapshots('2025-01-13');
  assert.equal(result.advancing, 0);
  assert.equal(result.declining, 25);
  assert.equal(result.adRatio, 0);
});

test('A/D: first date falls back to swing_momentum when no prior', () => {
  freshDb();
  for (let i = 0; i < 25; i++) {
    insertSnapshot('2025-01-10', `F${i}`, 100, {
      swing_momentum: i < 15 ? 60 : 30, // 15 bullish, 10 bearish
    });
  }
  const result = computeBreadthFromSnapshots('2025-01-10');
  assert.ok(result);
  assert.equal(result.advancing, 15);
  assert.equal(result.declining, 10);
});

test('A/D: new stock without prior price falls back to swing_momentum', () => {
  freshDb();
  for (let i = 0; i < 20; i++) insertSnapshot('2025-01-10', `OLD${i}`, 100);
  for (let i = 0; i < 20; i++) insertSnapshot('2025-01-13', `OLD${i}`, 102);
  for (let i = 0; i < 5; i++) {
    insertSnapshot('2025-01-13', `NEW${i}`, 50, { swing_momentum: 60 });
  }
  const result = computeBreadthFromSnapshots('2025-01-13');
  assert.equal(result.advancing, 25);
});

// ── McClellan oscillator ──────────────────────────────────────────────────

test('McClellan: returns null with insufficient data (< 40 dates)', () => {
  freshDb();
  for (let d = 1; d <= 10; d++) {
    const date = `2025-01-${String(d).padStart(2, '0')}`;
    for (let i = 0; i < 25; i++) insertSnapshot(date, `S${i}`, 100 + d * 0.5);
  }
  const result = computeMcClellanOscillator(10);
  assert.equal(result, null);
});

test('McClellan: computes oscillator with sufficient data', () => {
  freshDb();
  for (let d = 1; d <= 50; d++) {
    const mm = Math.ceil(d / 28);
    const dd = ((d - 1) % 28) + 1;
    const date = `2025-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    for (let i = 0; i < 25; i++) {
      const price = d % 2 === 0 ? 100 + i * 0.1 + d * 0.5 : 100 + i * 0.1 + (d - 1) * 0.5 - 0.5;
      insertSnapshot(date, `S${i}`, price);
    }
  }
  const result = computeMcClellanOscillator(50);
  assert.ok(result, 'oscillator should compute with 50 dates');
  assert.equal(typeof result.current, 'number');
  assert.equal(typeof result.summationIndex, 'number');
  assert.ok(result.series.length > 0);
  assert.ok(['improving', 'deteriorating', 'unknown'].includes(result.trend));
});

// ── Composite breadth score ───────────────────────────────────────────────

test('Composite: score is in 0-100 range', () => {
  const breadth = {
    pctAbove50MA: 65, pctAbove200MA: 55,
    hlRatio: 2.0, adRatio: 1.5, stage2Pct: 40, stage4Pct: 10,
  };
  const result = computeCompositeBreadthScore(breadth, null, null);
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(result.regime);
  assert.ok(result.sizeMultiplier >= 0 && result.sizeMultiplier <= 1);
});

test('Composite: broken breadth yields low score', () => {
  const breadth = {
    pctAbove50MA: 15, pctAbove200MA: 10,
    hlRatio: 0.2, adRatio: 0.3, stage2Pct: 10, stage4Pct: 40,
  };
  const result = computeCompositeBreadthScore(breadth, null, null);
  assert.ok(result.score < 30, `score ${result.score} should be < 30`);
  assert.match(result.regime, /DETERIORATING|BROKEN/);
});

test('Composite: strong breadth yields high score', () => {
  const breadth = {
    pctAbove50MA: 80, pctAbove200MA: 75,
    hlRatio: 5.0, adRatio: 3.0, stage2Pct: 60, stage4Pct: 5,
  };
  const vix = { signal: 'calm' };
  const credit = { signal: 'risk_on' };
  const result = computeCompositeBreadthScore(breadth, vix, credit);
  assert.ok(result.score >= 80, `score ${result.score} should be >= 80`);
  assert.equal(result.regime, 'STRONG BREADTH');
});
