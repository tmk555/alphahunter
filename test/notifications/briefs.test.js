// ─── Morning Brief & Weekly Digest — Unit Tests ─────────────────────────────
//
// Converted from Jest to node:test on 2026-04-30. Mocks the surrounding
// modules via require.cache injection so the brief assemblers can run
// against canned data — the tests check formatted output strings.

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mock state (mutable per-test) ──────────────────────────────────────────
let dbQueryMap = {};

function makeStmt(result) {
  return {
    all: () => result.all || [],
    get: () => result.get || null,
    run: () => {},
  };
}

const mockDatabase = {
  prepare: (sql) => {
    for (const [pattern, result] of Object.entries(dbQueryMap)) {
      if (sql.includes(pattern)) return makeStmt(result);
    }
    return makeStmt({ all: [], get: null });
  },
};

// Default regime stub — tests can override before calling.
let regimeOverride = null;
const defaultRegime = {
  regime: 'BULL / RISK ON',
  spyPrice: 540.50,
  vixLevel: 16.2,
  warning: null,
};
const defaultCycle = {
  mode: 'FTD_CONFIRMED',
  confidence: 75,
  action: 'Pilot buys allowed',
  signals: ['SPY > 50MA', 'SPY > 200MA'],
  distributionDays: { count: 2, spy: { count: 1 }, qqq: { count: 1 } },
  ftd: { fired: true, date: '2025-04-08', index: 'SPY', confirmed: true, failed: false },
  spy: { price: 540.50, above50: true, above200: true },
  qqq: { price: 462.15, above50: true, above200: true },
  vixLevel: 16.2,
};

// ── Install module stubs BEFORE requiring briefs ──────────────────────────
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
require.cache[require.resolve('../../src/data/providers/manager')] = {
  exports: { getQuotes: async () => [] },
};
require.cache[require.resolve('../../src/risk/regime')] = {
  exports: {
    getMarketRegime: async () => regimeOverride || defaultRegime,
    autoDetectCycleState: async () => defaultCycle,
  },
};
require.cache[require.resolve('../../src/risk/portfolio')] = {
  exports: {
    getPortfolioHeat: () => ({
      heatPct: 4.2,
      totalDollarRisk: 4200,
      positionCount: 2,
      maxHeat: 8,
      withinLimits: true,
      details: [],
    }),
    getConfig: () => ({ accountSize: 100000 }),
  },
};
require.cache[require.resolve('../../src/risk/alpha-tracker')] = {
  exports: {
    getEquitySnapshots: () => [
      { date: '2025-04-07', equity: 100000, spy_close: 530 },
      { date: '2025-04-08', equity: 100500, spy_close: 533 },
      { date: '2025-04-09', equity: 100800, spy_close: 535 },
      { date: '2025-04-10', equity: 101200, spy_close: 538 },
      { date: '2025-04-11', equity: 101500, spy_close: 540 },
    ],
    computePeriodReturn: () => 1.5,
  },
};

const { assembleMorningBrief, assembleWeeklyDigest } = require('../../src/notifications/briefs');

function setMorningDb() {
  dbQueryMap = {
    'FROM trades WHERE exit_date IS NULL': {
      all: [
        { symbol: 'NVDA', side: 'long', entry_price: 240, shares: 50, remaining_shares: 50, stop_price: 232, sector: 'Technology' },
        { symbol: 'AAPL', side: 'long', entry_price: 180, shares: 40, remaining_shares: 40, stop_price: 174, sector: 'Technology' },
      ],
    },
    'FROM staged_orders': {
      all: [
        { symbol: 'MSFT', side: 'buy', qty: 25, limit_price: 425, stop_price: 412, status: 'staged' },
      ],
    },
    'MAX(date)': { get: { date: '2025-04-11' } },
    'FROM deep_scan_cache': {
      // Scan picks now come from deep_scan_cache (scheduler-populated)
      // instead of rs_snapshots. Brief renders 'DEEP SCAN PICKS' from
      // the JSON results blob below.
      get: {
        mode: 'both',
        age_hrs: 1,
        results: JSON.stringify([
          { ticker: 'SMCI', rsRank: 98, stage: 2, vcpForming: 1, rsLineNewHigh: 0, vsMA50: 3.2, swingMomentum: 72 },
          { ticker: 'CRWD', rsRank: 95, stage: 2, vcpForming: 0, rsLineNewHigh: 1, vsMA50: 5.1, swingMomentum: 68 },
        ]),
      },
    },
  };
  regimeOverride = null;
}

function setWeeklyDb() {
  dbQueryMap = {
    'entry_date BETWEEN': {
      all: [
        { symbol: 'NVDA', side: 'long', entry_price: 248, shares: 50, entry_date: '2025-04-07' },
      ],
    },
    'exit_date BETWEEN': {
      all: [
        { symbol: 'MSFT', side: 'long', entry_price: 410, exit_price: 430, shares: 30, exit_date: '2025-04-10', pnl_dollars: 600, pnl_pct: 4.9 },
      ],
    },
    'FROM trades WHERE exit_date IS NOT NULL': {
      all: [
        { pnl_pct: 5.2, pnl_dollars: 520 },
        { pnl_pct: -2.1, pnl_dollars: -210 },
        { pnl_pct: 8.0, pnl_dollars: 800 },
        { pnl_pct: 3.5, pnl_dollars: 350 },
        { pnl_pct: -1.5, pnl_dollars: -150 },
      ],
    },
    'FROM regime_log': {
      all: [
        { date: '2025-04-09', mode: 'FTD_CONFIRMED', confidence: 75, ftd_date: '2025-04-08' },
      ],
    },
    "date = ? AND type = 'stock' AND rs_rank": { all: [] },
  };
  regimeOverride = null;
}

// ═════════════════════════════════════════════════════════════════════════
// Morning Brief Tests
// ═════════════════════════════════════════════════════════════════════════

test('morning: returns subject, text, html, and data', async () => {
  setMorningDb();
  const result = await assembleMorningBrief();
  assert.ok('subject' in result);
  assert.ok('text' in result);
  assert.ok('html' in result);
  assert.ok('data' in result);
  assert.match(result.subject, /Morning Brief/);
});

test('morning: includes regime status in output', async () => {
  setMorningDb();
  const result = await assembleMorningBrief();
  assert.match(result.text, /MARKET REGIME/);
  assert.match(result.text, /FTD_CONFIRMED/);
  assert.match(result.text, /75%/);
  assert.match(result.html, /<b>MARKET REGIME<\/b>/);
});

test('morning: includes distribution days and FTD', async () => {
  setMorningDb();
  const result = await assembleMorningBrief();
  assert.match(result.text, /DISTRIBUTION \/ FTD/);
  assert.match(result.text, /Dist days \(25-session\): 2/);
  assert.match(result.text, /Confirmed/);
  assert.match(result.text, /SPY/);
});

test('morning: includes portfolio heat and positions', async () => {
  setMorningDb();
  const result = await assembleMorningBrief();
  assert.match(result.text, /PORTFOLIO HEAT/);
  assert.match(result.text, /2 open positions/);
  assert.match(result.text, /4\.2%/);
  assert.match(result.text, /NVDA/);
  assert.match(result.text, /AAPL/);
});

test('morning: includes staged orders', async () => {
  setMorningDb();
  const result = await assembleMorningBrief();
  assert.match(result.text, /STAGED ORDERS/);
  assert.match(result.text, /MSFT/);
  assert.match(result.text, /\$425\.00/);
});

test('morning: includes top scan picks from deep_scan_cache', async () => {
  // Section was renamed TOP SCAN PICKS → DEEP SCAN PICKS when the brief
  // switched data source from rs_snapshots to deep_scan_cache.
  setMorningDb();
  const result = await assembleMorningBrief();
  assert.match(result.text, /DEEP SCAN PICKS/);
  assert.match(result.text, /SMCI/);
  assert.match(result.text, /RS 98/);
});

test('morning: data summary has correct counts', async () => {
  setMorningDb();
  const result = await assembleMorningBrief();
  assert.equal(result.data.cycleMode, 'FTD_CONFIRMED');
  assert.equal(result.data.distDays, 2);
  assert.equal(result.data.openPositions, 2);
  assert.equal(result.data.heatPct, 4.2);
  assert.equal(result.data.stagedOrders, 1);
});

test('morning: handles no open positions gracefully', async () => {
  dbQueryMap = {
    'FROM trades WHERE exit_date IS NULL': { all: [] },
    'FROM staged_orders': { all: [] },
    'MAX(date)': { get: null },
  };
  regimeOverride = null;
  const result = await assembleMorningBrief();
  assert.match(result.text, /fully in cash/);
  assert.equal(result.data.openPositions, 0);
});

test('morning: handles regime failure gracefully', async () => {
  setMorningDb();
  // Override regime to throw on this single call.
  const regimeMod = require.cache[require.resolve('../../src/risk/regime')].exports;
  const prev = regimeMod.getMarketRegime;
  regimeMod.getMarketRegime = async () => { throw new Error('network'); };
  try {
    const result = await assembleMorningBrief();
    assert.match(result.text, /MARKET REGIME/);
    assert.ok('text' in result);
  } finally {
    regimeMod.getMarketRegime = prev;
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Weekly Digest Tests
// ═════════════════════════════════════════════════════════════════════════

test('weekly: returns subject, text, html, and data', async () => {
  setWeeklyDb();
  const result = await assembleWeeklyDigest();
  assert.ok('subject' in result);
  assert.ok('text' in result);
  assert.ok('html' in result);
  assert.ok('data' in result);
  assert.match(result.subject, /Weekly Digest/);
});

test('weekly: includes week performance section', async () => {
  setWeeklyDb();
  const result = await assembleWeeklyDigest();
  assert.match(result.text, /WEEK PERFORMANCE/);
});

test('weekly: includes trades this week', async () => {
  setWeeklyDb();
  const result = await assembleWeeklyDigest();
  assert.match(result.text, /TRADES THIS WEEK/);
  assert.match(result.text, /1 entries/);
  assert.match(result.text, /1 exits/);
  assert.match(result.text, /NVDA/);
  assert.match(result.text, /MSFT/);
  assert.match(result.text, /EXIT/);
});

test('weekly: includes trade stats with win rate', async () => {
  setWeeklyDb();
  const result = await assembleWeeklyDigest();
  assert.match(result.text, /TRADE STATS/);
  assert.match(result.text, /Win rate: 60%/);
  assert.match(result.text, /3W \/ 2L/);
});

test('weekly: includes regime log', async () => {
  setWeeklyDb();
  const result = await assembleWeeklyDigest();
  assert.match(result.text, /REGIME LOG/);
  assert.match(result.text, /FTD_CONFIRMED/);
  assert.match(result.text, /75%/);
});

test('weekly: handles empty week gracefully', async () => {
  dbQueryMap = {
    'entry_date BETWEEN': { all: [] },
    'exit_date BETWEEN': { all: [] },
    'FROM trades WHERE exit_date IS NOT NULL': { all: [] },
    'FROM regime_log': { all: [] },
  };
  regimeOverride = null;
  const result = await assembleWeeklyDigest();
  assert.match(result.text, /No trades this week/);
  assert.match(result.text, /No regime entries this week/);
  assert.ok('data' in result);
});

test('weekly: data summary tracks counts', async () => {
  setWeeklyDb();
  const result = await assembleWeeklyDigest();
  assert.equal(result.data.entries, 1);
  assert.equal(result.data.exits, 1);
  assert.equal(result.data.regimeChanges, 1);
});
