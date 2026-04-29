// ─── Tests: paper-trades module (src/risk/paper-trades.js) ────────────────
//
// Pins the lifecycle: stage → close (manual or auto) → stats. The auto-
// close path stubs the provider manager's getQuotes so we can deterministi-
// cally simulate stop / target hits without network.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the provider manager BEFORE requiring paper-trades.
let _stubQuotes = [];
require.cache[require.resolve('../../src/data/providers/manager')] = {
  exports: { getQuotes: async () => _stubQuotes },
};

const {
  stagePaperTrade, listPaperTrades, getPaperTrade,
  closePaperTrade, cancelPaperTrade,
  autoCloseOnQuotes, getPaperStats,
} = require('../../src/risk/paper-trades');
const { getDB } = require('../../src/data/database');

function wipe() { getDB().prepare('DELETE FROM paper_trades').run(); _stubQuotes = []; }
function mkQuote(symbol, price) { return { symbol, regularMarketPrice: price }; }

// ─── Stage validation ─────────────────────────────────────────────────────
test('stage: rejects stop ≥ entry for a long', () => {
  wipe();
  assert.throws(() => stagePaperTrade({
    symbol: 'NVDA', entryPrice: 100, stopPrice: 105, shares: 10,
  }), /stopPrice must be below entryPrice/);
});

test('stage: rejects negative shares / negative prices', () => {
  wipe();
  assert.throws(() => stagePaperTrade({ symbol: 'X', entryPrice: 100, stopPrice: 90, shares: 0 }),
    /shares must be > 0/);
  assert.throws(() => stagePaperTrade({ symbol: 'X', entryPrice: 0, stopPrice: 0, shares: 1 }),
    /entryPrice must be > 0/);
});

test('stage: stores symbol uppercase + initializes max_favorable / max_adverse to entry', () => {
  wipe();
  const t = stagePaperTrade({ symbol: 'nvda', entryPrice: 100, stopPrice: 90, shares: 10, themeTag: 'AI' });
  assert.equal(t.symbol, 'NVDA');
  assert.equal(t.status, 'open');
  assert.equal(t.max_favorable, 100);
  assert.equal(t.max_adverse,   100);
  assert.equal(t.theme_tag, 'AI');
});

// ─── Manual close — R-multiple math ───────────────────────────────────────
test('close: R-multiple = (exit-entry)/(entry-stop) — winning trade', () => {
  wipe();
  // entry 100, stop 90, exit 130 → R = (130-100)/(100-90) = +3R
  const t = stagePaperTrade({ symbol: 'X', entryPrice: 100, stopPrice: 90, shares: 1 });
  const closed = closePaperTrade(t.id, 130, 'manual');
  assert.equal(closed.r_multiple, 3.0);
  assert.equal(closed.pnl_pct, 30.0);
  assert.equal(closed.exit_reason, 'manual');
  assert.equal(closed.status, 'closed');
});

test('close: stop hit → R = -1', () => {
  wipe();
  const t = stagePaperTrade({ symbol: 'X', entryPrice: 100, stopPrice: 90, shares: 1 });
  const closed = closePaperTrade(t.id, 90, 'stop');
  assert.equal(closed.r_multiple, -1);
  assert.equal(closed.pnl_pct, -10);
});

test('close: closing a non-open trade throws', () => {
  wipe();
  const t = stagePaperTrade({ symbol: 'X', entryPrice: 100, stopPrice: 90, shares: 1 });
  closePaperTrade(t.id, 110, 'manual');
  assert.throws(() => closePaperTrade(t.id, 120, 'manual'), /already closed/);
});

// ─── Cancel ───────────────────────────────────────────────────────────────
test('cancel: sets status=cancelled, never counted in stats', () => {
  wipe();
  const t = stagePaperTrade({ symbol: 'X', entryPrice: 100, stopPrice: 90, shares: 1 });
  const c = cancelPaperTrade(t.id);
  assert.equal(c.status, 'cancelled');
  // Stats must ignore cancelled rows entirely.
  const stats = getPaperStats();
  assert.equal(stats.count, 0);
});

// ─── Auto-close: stop hit ─────────────────────────────────────────────────
test('autoClose: low-water at-or-below stop → closes at stop price', async () => {
  wipe();
  const t = stagePaperTrade({ symbol: 'AAA', entryPrice: 100, stopPrice: 90, shares: 1 });
  // First tick: price drops to 88 (intraday low). Stop = 90. Should close.
  _stubQuotes = [mkQuote('AAA', 88)];
  const r = await autoCloseOnQuotes();
  assert.equal(r.closed, 1);
  assert.equal(r.checked, 1);
  const after = getPaperTrade(t.id);
  assert.equal(after.status, 'closed');
  assert.equal(after.exit_reason, 'stop');
  assert.equal(after.exit_price, 90);   // executed AT the stop, not the wick
  assert.equal(after.r_multiple, -1);
});

// ─── Auto-close: target2 hit ──────────────────────────────────────────────
test('autoClose: high-water at-or-above target2 → closes at target2', async () => {
  wipe();
  const t = stagePaperTrade({
    symbol: 'BBB', entryPrice: 100, stopPrice: 90, shares: 1,
    target1Price: 120, target2Price: 140,
  });
  _stubQuotes = [mkQuote('BBB', 145)];
  const r = await autoCloseOnQuotes();
  assert.equal(r.closed, 1);
  const after = getPaperTrade(t.id);
  assert.equal(after.status, 'closed');
  assert.equal(after.exit_reason, 'target2');
  assert.equal(after.exit_price, 140);
  assert.equal(after.r_multiple, 4);  // (140-100)/(100-90)
});

// ─── Auto-close: target1 hit but no target2 → stays open (manual scale) ──
test('autoClose: target1 hit alone leaves trade OPEN (T1 = manual decision)', async () => {
  wipe();
  const t = stagePaperTrade({
    symbol: 'CCC', entryPrice: 100, stopPrice: 90, shares: 1,
    target1Price: 120, target2Price: 140,
  });
  // Hits T1 ($120) but not T2. Should stay open.
  _stubQuotes = [mkQuote('CCC', 122)];
  const r = await autoCloseOnQuotes();
  assert.equal(r.closed, 0);
  // High-water mark should update though.
  const after = getPaperTrade(t.id);
  assert.equal(after.status, 'open');
  assert.equal(after.max_favorable, 122);
});

// ─── MFE / MAE high-water marks ───────────────────────────────────────────
test('autoClose: high-water and low-water marks track across multiple ticks', async () => {
  wipe();
  const t = stagePaperTrade({ symbol: 'DDD', entryPrice: 100, stopPrice: 90, shares: 1 });
  // Tick 1: price goes to 110.
  _stubQuotes = [mkQuote('DDD', 110)];
  await autoCloseOnQuotes();
  let after = getPaperTrade(t.id);
  assert.equal(after.max_favorable, 110);
  assert.equal(after.max_adverse,   100);  // never went below entry
  // Tick 2: drops to 95 (above stop).
  _stubQuotes = [mkQuote('DDD', 95)];
  await autoCloseOnQuotes();
  after = getPaperTrade(t.id);
  assert.equal(after.max_favorable, 110);  // still
  assert.equal(after.max_adverse,   95);   // new low
  assert.equal(after.status, 'open');
});

// ─── Stats: expectancy math ───────────────────────────────────────────────
test('stats: expectancy = winRate × avgWin + (1-winRate) × avgLoss', () => {
  wipe();
  // 3 trades: +3R, +2R, -1R. winRate=2/3=0.667, avgWin=2.5, avgLoss=-1
  // expectancy = 0.667 × 2.5 + 0.333 × -1 = 1.667 - 0.333 = 1.33R
  const t1 = stagePaperTrade({ symbol: 'A', entryPrice: 100, stopPrice: 90, shares: 1 });
  const t2 = stagePaperTrade({ symbol: 'B', entryPrice: 100, stopPrice: 90, shares: 1 });
  const t3 = stagePaperTrade({ symbol: 'C', entryPrice: 100, stopPrice: 90, shares: 1 });
  closePaperTrade(t1.id, 130, 'manual');  // +3R
  closePaperTrade(t2.id, 120, 'manual');  // +2R
  closePaperTrade(t3.id, 90,  'stop');    // -1R
  const stats = getPaperStats();
  assert.equal(stats.count, 3);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 1);
  assert.equal(stats.winRate, 0.667);
  assert.equal(stats.avgWinR, 2.5);
  assert.equal(stats.avgLossR, -1);
  assert.equal(stats.expectancy, 1.33);
});

// ─── Stats: per-theme breakdown ───────────────────────────────────────────
test('stats: per-theme breakdown groups by theme_tag', () => {
  wipe();
  const a = stagePaperTrade({ symbol: 'A', entryPrice: 100, stopPrice: 90, shares: 1, themeTag: 'AI' });
  const b = stagePaperTrade({ symbol: 'B', entryPrice: 100, stopPrice: 90, shares: 1, themeTag: 'AI' });
  const c = stagePaperTrade({ symbol: 'C', entryPrice: 100, stopPrice: 90, shares: 1, themeTag: 'Defense' });
  closePaperTrade(a.id, 130, 'manual');  // AI: +3R
  closePaperTrade(b.id, 120, 'manual');  // AI: +2R
  closePaperTrade(c.id, 90,  'stop');    // Defense: -1R
  const stats = getPaperStats();
  assert.equal(stats.themes.AI.count, 2);
  assert.equal(stats.themes.AI.wins, 2);
  assert.equal(stats.themes.AI.winRate, 1.0);
  assert.equal(stats.themes.AI.avgR, 2.5);
  assert.equal(stats.themes.Defense.count, 1);
  assert.equal(stats.themes.Defense.winRate, 0);
  assert.equal(stats.themes.Defense.avgR, -1);
});

test('stats: empty (no closed trades) → null fields, no crash', () => {
  wipe();
  stagePaperTrade({ symbol: 'X', entryPrice: 100, stopPrice: 90, shares: 1 });  // open, ignored
  const stats = getPaperStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.winRate, null);
  assert.equal(stats.expectancy, null);
});
