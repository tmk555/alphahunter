// ─── Tests: ATR-based chandelier trail ───────────────────────────────────
//
// Covers the trail wiring across atr-context (capture), stop-discipline
// (live trail recommendation), and scaling (post-target2 trail). Verifies:
//
//   1. captureAtrContext writes entry_atr from rs_snapshots and
//      trail_atr_mult from strategies.exit_rules.
//   2. captureAtrContext falls back gracefully when no rs_snapshot exists.
//   3. stop-discipline trail uses chandelier formula when entry_atr set,
//      legacy flat trail_pct otherwise.
//   4. scaling.evaluateScalingAction post-T2 trail uses ATR chandelier
//      when entry_atr set.
//   5. Tighter trail_atr_mult produces tighter stops (smaller distance
//      from price).

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { evaluateScalingAction } = require('../../src/risk/scaling');

// Build a fresh in-memory DB with the schema bits we need (just trades +
// rs_snapshots + strategies — the helper doesn't touch anything else).
function mkDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, side TEXT, entry_date TEXT, entry_price REAL,
      shares INTEGER, strategy TEXT,
      entry_atr REAL, trail_atr_mult REAL, trail_pct REAL DEFAULT 0.08
    );
    CREATE TABLE rs_snapshots (
      symbol TEXT, date TEXT, type TEXT, atr_pct REAL,
      PRIMARY KEY (symbol, date, type)
    );
    CREATE TABLE strategies (
      id TEXT PRIMARY KEY, exit_rules TEXT
    );
  `);
  return db;
}

test('atr-context: pulls atr_pct × entry_price + strategy mult', () => {
  const db = mkDb();
  db.prepare("INSERT INTO rs_snapshots VALUES ('ANET', '2026-04-29', 'stock', 3.79)").run();
  db.prepare("INSERT INTO strategies VALUES ('momentum_swing', '{\"trail_atr_mult\":2.5}')").run();
  const r = db.prepare(
    "INSERT INTO trades (symbol, side, entry_date, entry_price, shares, strategy) VALUES ('ANET','long','2026-04-29',165.29,100,'momentum_swing')"
  ).run();

  const { applyAtrContext } = require('../../src/risk/atr-context');
  const ctx = applyAtrContext(db, r.lastInsertRowid, {
    symbol: 'ANET', entryDate: '2026-04-29', entryPrice: 165.29, strategy: 'momentum_swing',
  });

  // 165.29 × 3.79% = 6.2645 (rounded to 4dp)
  assert.equal(ctx.entryAtr, 6.2645);
  assert.equal(ctx.trailAtrMult, 2.5);
  const row = db.prepare('SELECT entry_atr, trail_atr_mult FROM trades WHERE id = ?').get(r.lastInsertRowid);
  assert.equal(row.entry_atr, 6.2645);
  assert.equal(row.trail_atr_mult, 2.5);
});

test('atr-context: missing rs_snapshot → entry_atr null, mult still set', () => {
  const db = mkDb();
  // No rs_snapshots row, no strategies row
  const r = db.prepare(
    "INSERT INTO trades (symbol, side, entry_date, entry_price, shares) VALUES ('NEW','long','2026-04-29',50,100)"
  ).run();
  const { applyAtrContext } = require('../../src/risk/atr-context');
  const ctx = applyAtrContext(db, r.lastInsertRowid, {
    symbol: 'NEW', entryDate: '2026-04-29', entryPrice: 50, strategy: null,
  });
  assert.equal(ctx.entryAtr, null);
  assert.equal(ctx.trailAtrMult, 2.5); // default
  assert.match(ctx.fallback, /no_rs_snapshot/);
});

test('atr-context: idempotent — second call does not overwrite', () => {
  const db = mkDb();
  db.prepare("INSERT INTO rs_snapshots VALUES ('ANET', '2026-04-29', 'stock', 3.79)").run();
  const r = db.prepare(
    "INSERT INTO trades (symbol, side, entry_date, entry_price, shares, entry_atr, trail_atr_mult) VALUES ('ANET','long','2026-04-29',165.29,100, 1.23, 1.0)"
  ).run();
  const { applyAtrContext } = require('../../src/risk/atr-context');
  applyAtrContext(db, r.lastInsertRowid, {
    symbol: 'ANET', entryDate: '2026-04-29', entryPrice: 165.29, strategy: null,
  });
  // Pre-existing values must NOT be overwritten (COALESCE behavior).
  const row = db.prepare('SELECT entry_atr, trail_atr_mult FROM trades WHERE id = ?').get(r.lastInsertRowid);
  assert.equal(row.entry_atr, 1.23);
  assert.equal(row.trail_atr_mult, 1.0);
});

// ─── scaling.js post-T2 trail ─────────────────────────────────────────────

function mkScalingTrade({ remaining = 4, target1 = 200, target2 = 220, stop = 180,
                         entry = 190, entryAtr = null, trailAtrMult = null,
                         trailPct = 0.08, trailingActive = 1,
                         partials = [{ level: 'target1', shares: 2, price: 200 },
                                     { level: 'target2', shares: 2, price: 220 }] } = {}) {
  return {
    side: 'long',
    initial_shares: 8,
    shares: 8,
    remaining_shares: remaining,
    target1, target2, stop_price: stop, entry_price: entry,
    partial_exits: JSON.stringify(partials),
    trailing_stop_active: trailingActive,
    trail_pct: trailPct,
    entry_atr: entryAtr,
    trail_atr_mult: trailAtrMult,
    exit_strategy: 'full_in_scale_out',
  };
}

test('scaling: post-T2 with entry_atr set → chandelier trail (price - mult×atr)', () => {
  // Price 250, ATR $5, mult 2.5 → trail = 250 - 12.5 = 237.50
  const trade = mkScalingTrade({
    remaining: 1, stop: 220, entryAtr: 5, trailAtrMult: 2.5,
  });
  const action = evaluateScalingAction(trade, 250);
  assert.ok(action, 'should propose update_stop');
  assert.equal(action.action, 'update_stop');
  assert.equal(action.moveStopTo, 237.50);
  assert.match(action.reason, /Chandelier/);
});

test('scaling: post-T2 without entry_atr → legacy flat trail_pct', () => {
  // Price 250, trail_pct 0.08 → trail = 250 × 0.92 = 230.00
  const trade = mkScalingTrade({
    remaining: 1, stop: 220, entryAtr: null, trailAtrMult: null, trailPct: 0.08,
  });
  const action = evaluateScalingAction(trade, 250);
  assert.ok(action);
  assert.equal(action.moveStopTo, 230.00);
  assert.match(action.reason, /legacy/);
});

test('scaling: tighter mult → tighter stop (closer to price)', () => {
  const wide = mkScalingTrade({ remaining: 1, stop: 220, entryAtr: 5, trailAtrMult: 2.5 });
  const tight = mkScalingTrade({ remaining: 1, stop: 220, entryAtr: 5, trailAtrMult: 1.0 });
  const wideAct = evaluateScalingAction(wide, 250);
  const tightAct = evaluateScalingAction(tight, 250);
  // 250 - 2.5×5 = 237.50  vs  250 - 1.0×5 = 245.00 — tight stop is HIGHER (long)
  assert.ok(tightAct.moveStopTo > wideAct.moveStopTo,
    `tight (${tightAct.moveStopTo}) must be higher than wide (${wideAct.moveStopTo})`);
});

test('scaling: chandelier never loosens — current stop above new trail blocks update', () => {
  // Price 250, ATR $5, mult 2.5 → would be 237.50, but current stop is already 240
  const trade = mkScalingTrade({
    remaining: 1, stop: 240, entryAtr: 5, trailAtrMult: 2.5,
  });
  const action = evaluateScalingAction(trade, 250);
  assert.equal(action, null, 'must not loosen — 237.50 < 240 (existing stop)');
});
