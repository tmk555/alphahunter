// ─── Tests for Phase 3.13: Real McClellan Breadth ────────────────────────────
// Verifies that A/D computation uses actual price changes and that the
// McClellan oscillator (EMA(19) - EMA(39)) works correctly.

const Database = require('better-sqlite3');
const path = require('path');

let mockDatabase;

// Stub out the database module to use an in-memory DB
jest.mock('../../src/data/database', () => ({
  getDB: () => mockDatabase,
}));

// Stub out the cache module
jest.mock('../../src/data/cache', () => ({
  cacheGet: () => null,
  cacheSet: () => {},
}));

const {
  computeBreadthFromSnapshots,
  computeMcClellanOscillator,
  computeCompositeBreadthScore,
} = require('../../src/signals/breadth');

beforeEach(() => {
  mockDatabase = new Database(':memory:');

  // Create rs_snapshots table
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
    )
  `);

  // Create breadth_snapshots table
  mockDatabase.exec(`
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
    )
  `);
});

afterEach(() => {
  mockDatabase.close();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function populateUniverse(date, stocks) {
  for (const s of stocks) {
    insertSnapshot(date, s.symbol, s.price, s);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Phase 3.13: A/D uses real price changes', () => {
  test('advancing = stocks where close > prior close', () => {
    // Prior date: all stocks at $100
    const symbols = [];
    for (let i = 0; i < 30; i++) symbols.push(`STK${i}`);

    // Day 1: all at $100
    for (const sym of symbols) insertSnapshot('2025-01-10', sym, 100);

    // Day 2: 20 up, 5 down, 5 flat
    for (let i = 0; i < 20; i++) insertSnapshot('2025-01-13', symbols[i], 102); // up
    for (let i = 20; i < 25; i++) insertSnapshot('2025-01-13', symbols[i], 98);  // down
    for (let i = 25; i < 30; i++) insertSnapshot('2025-01-13', symbols[i], 100); // flat

    const result = computeBreadthFromSnapshots('2025-01-13');
    expect(result).not.toBeNull();
    expect(result.advancing).toBe(20);
    expect(result.declining).toBe(5);
    expect(result.neutral).toBe(5);
    expect(result.adRatio).toBe(4.00); // 20/5
  });

  test('all stocks declining → adRatio < 1', () => {
    const symbols = [];
    for (let i = 0; i < 25; i++) symbols.push(`D${i}`);

    // Day 1: all at $100
    for (const sym of symbols) insertSnapshot('2025-01-10', sym, 100);
    // Day 2: all down
    for (const sym of symbols) insertSnapshot('2025-01-13', sym, 95);

    const result = computeBreadthFromSnapshots('2025-01-13');
    expect(result.advancing).toBe(0);
    expect(result.declining).toBe(25);
    expect(result.adRatio).toBe(0);
  });

  test('first date falls back to swing_momentum when no prior', () => {
    // Only one date — no prior to compare prices against
    for (let i = 0; i < 25; i++) {
      insertSnapshot('2025-01-10', `F${i}`, 100, {
        swing_momentum: i < 15 ? 60 : 30, // 15 bullish, 10 bearish
      });
    }

    const result = computeBreadthFromSnapshots('2025-01-10');
    expect(result).not.toBeNull();
    // Falls back to swing_momentum: 15 advancing (>=55), 10 declining (<=45)
    expect(result.advancing).toBe(15);
    expect(result.declining).toBe(10);
  });

  test('new stock without prior price falls back to swing_momentum', () => {
    // Day 1: 20 stocks
    for (let i = 0; i < 20; i++) insertSnapshot('2025-01-10', `OLD${i}`, 100);
    // Day 2: 20 old stocks + 5 new ones
    for (let i = 0; i < 20; i++) insertSnapshot('2025-01-13', `OLD${i}`, 102); // all up
    for (let i = 0; i < 5; i++) {
      insertSnapshot('2025-01-13', `NEW${i}`, 50, { swing_momentum: 60 }); // new stock, bullish momentum
    }

    const result = computeBreadthFromSnapshots('2025-01-13');
    // 20 old stocks up (real price change) + 5 new stocks advancing (fallback)
    expect(result.advancing).toBe(25);
  });
});

describe('Phase 3.13: McClellan Oscillator', () => {
  test('returns null with insufficient data (< 40 dates)', () => {
    // Only 10 dates
    for (let d = 1; d <= 10; d++) {
      const date = `2025-01-${String(d).padStart(2, '0')}`;
      for (let i = 0; i < 25; i++) {
        insertSnapshot(date, `S${i}`, 100 + d * 0.5);
      }
    }
    const result = computeMcClellanOscillator(10);
    expect(result).toBeNull();
  });

  test('computes oscillator with sufficient data', () => {
    // 50 dates with enough stocks
    for (let d = 1; d <= 50; d++) {
      const mm = Math.ceil(d / 28);
      const dd = ((d - 1) % 28) + 1;
      const date = `2025-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      for (let i = 0; i < 25; i++) {
        // Alternate: most up on even days, most down on odd days
        const price = d % 2 === 0 ? 100 + i * 0.1 + d * 0.5 : 100 + i * 0.1 + (d - 1) * 0.5 - 0.5;
        insertSnapshot(date, `S${i}`, price);
      }
    }
    const result = computeMcClellanOscillator(50);
    // Should return a valid oscillator with series
    expect(result).not.toBeNull();
    expect(typeof result.current).toBe('number');
    expect(typeof result.summationIndex).toBe('number');
    expect(result.series.length).toBeGreaterThan(0);
    expect(['improving', 'deteriorating', 'unknown']).toContain(result.trend);
  });
});

describe('Phase 3.13: Composite Score', () => {
  test('score is 0-100 range', () => {
    const breadth = {
      pctAbove50MA: 65,
      pctAbove200MA: 55,
      hlRatio: 2.0,
      adRatio: 1.5,
      stage2Pct: 40,
      stage4Pct: 10,
    };
    const result = computeCompositeBreadthScore(breadth, null, null);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.regime).toBeTruthy();
    expect(result.sizeMultiplier).toBeGreaterThanOrEqual(0);
    expect(result.sizeMultiplier).toBeLessThanOrEqual(1);
  });

  test('broken breadth yields low score', () => {
    const breadth = {
      pctAbove50MA: 15,
      pctAbove200MA: 10,
      hlRatio: 0.2,
      adRatio: 0.3,
      stage2Pct: 10,
      stage4Pct: 40,
    };
    const result = computeCompositeBreadthScore(breadth, null, null);
    expect(result.score).toBeLessThan(30);
    expect(result.regime).toMatch(/DETERIORATING|BROKEN/);
  });

  test('strong breadth yields high score', () => {
    const breadth = {
      pctAbove50MA: 80,
      pctAbove200MA: 75,
      hlRatio: 5.0,
      adRatio: 3.0,
      stage2Pct: 60,
      stage4Pct: 5,
    };
    const vix = { signal: 'calm' };
    const credit = { signal: 'risk_on' };
    const result = computeCompositeBreadthScore(breadth, vix, credit);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.regime).toBe('STRONG BREADTH');
  });
});
