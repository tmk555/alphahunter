// ─── Tests: Phase 2.10 wash-sale blocker ──────────────────────────────────
//
// Validates:
//   1. checkWashSaleOnBuy detects recent loss trades within 30-day window
//   2. checkWashSaleOnBuy detects recent loss tax_lots within 30-day window
//   3. Losses OUTSIDE the window don't trigger
//   4. Profitable recent trades don't trigger
//   5. Multiple losses are all reported
//   6. preTradeCheck blocks the trade unless allowWashSale: true
//   7. earliestAllowedReentry is 31 days after the most recent loss
//
// No network — pure sqlite + pure math.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getDB } = require('../../src/data/database');
const {
  checkWashSaleOnBuy,
  createTaxLot,
} = require('../../src/risk/tax-engine');
const { preTradeCheck, updateConfig } = require('../../src/risk/portfolio');

// Pin account size so heat/position-size checks don't reject on unrelated grounds.
updateConfig({ accountSize: 1_000_000, maxPortfolioHeat: 20, maxPositionPct: 100, earningsBlackoutDays: 0 });

function wipe() {
  getDB().exec('DELETE FROM trades; DELETE FROM tax_lots;');
}

// Date helpers — all tests pin "today" to a fixed string so the 30-day
// arithmetic is reproducible across calendars.
const TODAY = '2026-04-15';

function daysAgo(n) {
  const t = new Date(TODAY).getTime() - n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// Insert a closed trade with the given exit date and pnl.
function seedClosedTrade(symbol, exitDate, pnlDollars) {
  getDB().prepare(`
    INSERT INTO trades
      (symbol, side, entry_date, entry_price, exit_date, exit_price, pnl_dollars, shares)
    VALUES (?, 'long', ?, 100, ?, ?, ?, 10)
  `).run(symbol, daysAgo(60), exitDate, 100 + pnlDollars / 10, pnlDollars);
}

// Insert a tax lot that was disposed at a loss.
function seedDisposedLot(symbol, disposedDate, realizedGain) {
  getDB().prepare(`
    INSERT INTO tax_lots
      (symbol, shares, remaining_shares, cost_basis, adjusted_basis,
       acquired_date, disposed_date, sale_price, realized_gain, holding_period)
    VALUES (?, 10, 0, 100, 100, ?, ?, ?, ?, 'short_term')
  `).run(symbol, daysAgo(60), disposedDate, 100 + realizedGain / 10, realizedGain);
}

// ─── checkWashSaleOnBuy: recent loss trigger ───────────────────────────────

test('checkWashSaleOnBuy: loss trade 10 days ago triggers', () => {
  wipe();
  seedClosedTrade('AAPL', daysAgo(10), -1200);
  const r = checkWashSaleOnBuy('AAPL', TODAY);
  assert.equal(r.isWashSale, true);
  assert.equal(r.recentLoss.amount, -1200);
  assert.equal(r.recentLoss.date, daysAgo(10));
  assert.equal(r.recentLoss.source, 'trade');
  assert.ok(r.message.includes('WASH SALE'));
});

test('checkWashSaleOnBuy: loss tax lot 20 days ago triggers', () => {
  wipe();
  seedDisposedLot('MSFT', daysAgo(20), -800);
  const r = checkWashSaleOnBuy('MSFT', TODAY);
  assert.equal(r.isWashSale, true);
  assert.equal(r.recentLoss.amount, -800);
  assert.equal(r.recentLoss.source, 'tax_lot');
});

// ─── checkWashSaleOnBuy: outside window ────────────────────────────────────

test('checkWashSaleOnBuy: loss 31 days ago does NOT trigger', () => {
  wipe();
  seedClosedTrade('TSLA', daysAgo(31), -500);
  const r = checkWashSaleOnBuy('TSLA', TODAY);
  assert.equal(r.isWashSale, false);
  assert.equal(r.recentLoss, null);
});

test('checkWashSaleOnBuy: loss 45 days ago does NOT trigger', () => {
  wipe();
  seedClosedTrade('NVDA', daysAgo(45), -2000);
  const r = checkWashSaleOnBuy('NVDA', TODAY);
  assert.equal(r.isWashSale, false);
});

// ─── checkWashSaleOnBuy: profitable trades ignored ────────────────────────

test('checkWashSaleOnBuy: recent PROFITABLE trade does NOT trigger', () => {
  wipe();
  seedClosedTrade('AMD', daysAgo(5), +1500);
  const r = checkWashSaleOnBuy('AMD', TODAY);
  assert.equal(r.isWashSale, false);
});

test('checkWashSaleOnBuy: profitable + loss — only loss matters', () => {
  wipe();
  seedClosedTrade('GOOG', daysAgo(5),  +800);
  seedClosedTrade('GOOG', daysAgo(15), -600);
  const r = checkWashSaleOnBuy('GOOG', TODAY);
  assert.equal(r.isWashSale, true);
  assert.equal(r.recentLoss.amount, -600);
});

// ─── Multiple losses reported ─────────────────────────────────────────────

test('checkWashSaleOnBuy: multiple recent losses — latest wins, all reported', () => {
  wipe();
  seedClosedTrade('META', daysAgo(5),  -300);
  seedClosedTrade('META', daysAgo(15), -700);
  seedClosedTrade('META', daysAgo(25), -200);
  const r = checkWashSaleOnBuy('META', TODAY);
  assert.equal(r.isWashSale, true);
  assert.equal(r.allRecentLosses.length, 3);
  // Most recent date wins the "recentLoss" slot.
  assert.equal(r.recentLoss.date, daysAgo(5));
  assert.equal(r.recentLoss.amount, -300);
});

test('checkWashSaleOnBuy: earliestAllowedReentry is 31 days after latest loss', () => {
  wipe();
  seedClosedTrade('ORCL', daysAgo(10), -400);
  const r = checkWashSaleOnBuy('ORCL', TODAY);
  // latest = 10 days ago. 10 + 31 = 21 days from our pinned today — but
  // earliestAllowedReentry is 31 days FROM the loss date, not from today.
  const expected = new Date(
    new Date(daysAgo(10)).getTime() + 31 * 86400000
  ).toISOString().slice(0, 10);
  assert.equal(r.earliestAllowedReentry, expected);
});

// ─── Different symbol shouldn't interfere ─────────────────────────────────

test('checkWashSaleOnBuy: loss on another symbol does NOT trigger', () => {
  wipe();
  seedClosedTrade('AAPL', daysAgo(5), -1000);
  const r = checkWashSaleOnBuy('MSFT', TODAY);
  assert.equal(r.isWashSale, false);
});

// ─── Empty/no-data ─────────────────────────────────────────────────────────

test('checkWashSaleOnBuy: empty DB — no trigger', () => {
  wipe();
  const r = checkWashSaleOnBuy('BRKA', TODAY);
  assert.equal(r.isWashSale, false);
  assert.equal(r.recentLoss, null);
});

test('checkWashSaleOnBuy: missing symbol → safe no-op', () => {
  const r = checkWashSaleOnBuy(null);
  assert.equal(r.isWashSale, false);
});

// ─── preTradeCheck integration ────────────────────────────────────────────

function baseCandidate(overrides = {}) {
  return {
    symbol: 'AAPL',
    entryPrice: 100,
    stopPrice: 95,
    shares: 100,           // notional $10k, risk $500 → 0.05% heat on $1M account
    sector: 'Technology',
    industry: 'Semiconductors',
    daysToEarnings: 30,
    entryDate: TODAY,
    ...overrides,
  };
}
const baseRegime = { regime: 'BULL', sizeMultiplier: 1 };

test('preTradeCheck: blocks when recent loss is within window', () => {
  wipe();
  seedClosedTrade('AAPL', daysAgo(10), -1500);
  const result = preTradeCheck(baseCandidate(), [], baseRegime, {});
  const washCheck = result.checks.find(c => c.rule === 'Wash Sale');
  assert.ok(washCheck, 'Wash Sale rule should be present');
  assert.equal(washCheck.pass, false);
  assert.equal(result.approved, false);
  assert.ok(washCheck.washSale);
  assert.equal(washCheck.washSale.isWashSale, true);
});

test('preTradeCheck: allows when recent loss is outside window', () => {
  wipe();
  seedClosedTrade('AAPL', daysAgo(35), -1500);
  const result = preTradeCheck(baseCandidate(), [], baseRegime, {});
  const washCheck = result.checks.find(c => c.rule === 'Wash Sale');
  assert.equal(washCheck.pass, true);
  assert.equal(result.approved, true);
});

test('preTradeCheck: allowWashSale override lets trade through', () => {
  wipe();
  seedClosedTrade('AAPL', daysAgo(10), -1500);
  const result = preTradeCheck(
    baseCandidate({ allowWashSale: true }),
    [], baseRegime, {}
  );
  const washCheck = result.checks.find(c => c.rule === 'Wash Sale');
  assert.equal(washCheck.pass, true);
  assert.ok(washCheck.detail.includes('OVERRIDE'));
  // Override supplies an acknowledgement but should NOT un-block the check's
  // diagnostic payload — caller can still see what they're overriding.
  assert.ok(washCheck.washSale);
  assert.equal(washCheck.washSale.isWashSale, true);
  assert.equal(result.approved, true);
});

test('preTradeCheck: no history — wash check passes cleanly', () => {
  wipe();
  const result = preTradeCheck(baseCandidate(), [], baseRegime, {});
  const washCheck = result.checks.find(c => c.rule === 'Wash Sale');
  assert.equal(washCheck.pass, true);
  assert.ok(washCheck.detail.includes('No recent loss sales'));
  assert.equal(result.approved, true);
});

test('preTradeCheck: unrelated blockers coexist with clean wash-sale check', () => {
  wipe();
  // Turn earnings blackout back on for THIS test only — daysToEarnings=2
  // should trip the blackout. Wash-sale check should still be clean.
  updateConfig({ earningsBlackoutDays: 10 });
  try {
    const result = preTradeCheck(
      baseCandidate({ daysToEarnings: 2 }),
      [], baseRegime, {}
    );
    const earn = result.checks.find(c => c.rule === 'Earnings Blackout');
    assert.equal(earn.pass, false, 'earnings blackout should fire');
    // No seeded loss → wash sale is still clean
    const wash = result.checks.find(c => c.rule === 'Wash Sale');
    assert.equal(wash.pass, true);
    assert.equal(result.approved, false);
  } finally {
    // Restore the default used by the rest of the file.
    updateConfig({ earningsBlackoutDays: 0 });
  }
});
