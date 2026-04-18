// ─── Tests: Two-Signal Confirmation Gate (src/risk/portfolio.js) ───────────
//
// The gate requires ≥2 of {rs_strong, stage_2, revision_up, pattern, breadth_ok}
// confirmations from DB tables (rs_snapshots, revision_scores, breadth_snapshots).
// Fail-open when NO data exists for the symbol.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getDB } = require('../../src/data/database');
const { preTradeCheck } = require('../../src/risk/portfolio');

const baseRegime = { regime: 'UPTREND', sizeMultiplier: 1 };

function baseCandidate(overrides = {}) {
  return {
    symbol: 'TSLA', sector: 'Consumer Cyclical',
    entryPrice: 250, stopPrice: 240, shares: 100,
    daysToEarnings: 30,
    ...overrides,
  };
}

function seedSnapshot({ symbol = 'TSLA', date = '2026-04-17', rs_rank = 50, stage = 1, vcp_forming = 0, pattern_type = null } = {}) {
  getDB().prepare(`
    INSERT OR REPLACE INTO rs_snapshots (date, symbol, type, rs_rank, stage, vcp_forming, pattern_type, price)
    VALUES (?, ?, 'stock', ?, ?, ?, ?, 250)
  `).run(date, symbol, rs_rank, stage, vcp_forming, pattern_type);
}

function seedRevision({ symbol = 'TSLA', date = '2026-04-17', direction = 'flat', revision_score = 0 } = {}) {
  getDB().prepare(`
    INSERT OR REPLACE INTO revision_scores (symbol, date, direction, revision_score)
    VALUES (?, ?, ?, ?)
  `).run(symbol, date, direction, revision_score);
}

function seedBreadth({ date = '2026-04-17', regime = 'UPTREND', composite_score = 70 } = {}) {
  getDB().prepare(`
    INSERT OR REPLACE INTO breadth_snapshots (date, regime, composite_score)
    VALUES (?, ?, ?)
  `).run(date, regime, composite_score);
}

function wipe() {
  const db = getDB();
  db.prepare('DELETE FROM rs_snapshots').run();
  db.prepare('DELETE FROM revision_scores').run();
  db.prepare('DELETE FROM breadth_snapshots').run();
  db.prepare('DELETE FROM trades').run();
  db.prepare('DELETE FROM tax_lots').run();
}

test('two-signal gate: fail-open when no data for symbol', () => {
  wipe();
  const r = preTradeCheck(baseCandidate(), [], baseRegime, {});
  const check = r.checks.find(c => c.rule === 'Two-Signal Confirmation');
  assert.ok(check, 'rule should be present');
  assert.equal(check.pass, true);
  assert.ok(check.detail.includes('skipped'));
});

test('two-signal gate: blocks on 1 signal (RS only, no stage/pattern/revision/breadth)', () => {
  wipe();
  seedSnapshot({ rs_rank: 90, stage: 1, vcp_forming: 0, pattern_type: null });
  seedRevision({ direction: 'flat', revision_score: 0 });
  seedBreadth({ regime: 'DISTRIBUTION', composite_score: 30 });
  const r = preTradeCheck(baseCandidate(), [], baseRegime, {});
  const check = r.checks.find(c => c.rule === 'Two-Signal Confirmation');
  assert.equal(check.pass, false);
  assert.equal(r.approved, false);
  assert.ok(check.detail.includes('1/5') || check.detail.includes('Only 1'));
});

test('two-signal gate: passes with 2 confirmations (RS + stage 2)', () => {
  wipe();
  seedSnapshot({ rs_rank: 90, stage: 2 });
  seedRevision({ direction: 'flat' });
  seedBreadth({ regime: 'DISTRIBUTION', composite_score: 30 });
  const r = preTradeCheck(baseCandidate(), [], baseRegime, {});
  const check = r.checks.find(c => c.rule === 'Two-Signal Confirmation');
  assert.equal(check.pass, true);
  assert.ok(/rs_strong/.test(check.detail));
  assert.ok(/stage_2/.test(check.detail));
});

test('two-signal gate: allowLowConfidence override lets 1-signal through', () => {
  wipe();
  seedSnapshot({ rs_rank: 90, stage: 1 });
  seedRevision({ direction: 'down' });
  seedBreadth({ regime: 'DISTRIBUTION' });
  const r = preTradeCheck(
    baseCandidate({ allowLowConfidence: true }), [], baseRegime, {}
  );
  const check = r.checks.find(c => c.rule === 'Two-Signal Confirmation');
  assert.equal(check.pass, true);
  assert.ok(/OVERRIDE/.test(check.detail));
});

test('two-signal gate: all 5 signals confirm → pass with full list', () => {
  wipe();
  seedSnapshot({ rs_rank: 95, stage: 2, vcp_forming: 1 });
  seedRevision({ direction: 'up', revision_score: 8 });
  seedBreadth({ regime: 'UPTREND', composite_score: 75 });
  const r = preTradeCheck(baseCandidate(), [], baseRegime, {});
  const check = r.checks.find(c => c.rule === 'Two-Signal Confirmation');
  assert.equal(check.pass, true);
  assert.ok(/5\/5/.test(check.detail));
});

test('two-signal gate: breadth_ok is symbol-independent (uses latest global breadth)', () => {
  wipe();
  seedSnapshot({ symbol: 'AAPL', rs_rank: 90, stage: 2 });
  seedBreadth({ regime: 'UPTREND', composite_score: 70 });
  // No revision data for AAPL; rs_strong + stage_2 + breadth_ok = 3 signals
  const r = preTradeCheck(baseCandidate({ symbol: 'AAPL' }), [], baseRegime, {});
  const check = r.checks.find(c => c.rule === 'Two-Signal Confirmation');
  assert.equal(check.pass, true);
});
