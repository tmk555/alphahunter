// ─── Morning Brief & Weekly Digest — Unit Tests ─────────────────────────────

// Mocks must be declared before require()'s — Jest hoists them.
const mockDatabase = {
  prepare: jest.fn(() => ({
    all: jest.fn(() => []),
    get: jest.fn(() => null),
    run: jest.fn(),
  })),
};

jest.mock('../../src/data/database', () => ({
  getDB: () => mockDatabase,
}));

jest.mock('../../src/data/cache', () => ({
  cacheGet: jest.fn(() => null),
  cacheSet: jest.fn(),
  cacheClear: jest.fn(),
  TTL_QUOTE: 30000,
}));

jest.mock('../../src/data/providers/manager', () => ({
  getQuotes: jest.fn(async () => []),
}));

jest.mock('../../src/risk/regime', () => ({
  getMarketRegime: jest.fn(async () => ({
    regime: 'BULL / RISK ON',
    spyPrice: 540.50,
    vixLevel: 16.2,
    warning: null,
  })),
  autoDetectCycleState: jest.fn(async () => ({
    mode: 'FTD_CONFIRMED',
    confidence: 75,
    action: 'Pilot buys allowed',
    signals: ['SPY > 50MA', 'SPY > 200MA'],
    distributionDays: { count: 2, spy: { count: 1 }, qqq: { count: 1 } },
    ftd: { fired: true, date: '2025-04-08', index: 'SPY', confirmed: true, failed: false },
    spy: { price: 540.50, above50: true, above200: true },
    qqq: { price: 462.15, above50: true, above200: true },
    vixLevel: 16.2,
  })),
}));

jest.mock('../../src/risk/portfolio', () => ({
  getPortfolioHeat: jest.fn(() => ({
    heatPct: 4.2,
    totalDollarRisk: 4200,
    positionCount: 2,
    maxHeat: 8,
    withinLimits: true,
    details: [],
  })),
  getConfig: jest.fn(() => ({ accountSize: 100000 })),
}));

jest.mock('../../src/risk/alpha-tracker', () => ({
  getEquitySnapshots: jest.fn(() => [
    { date: '2025-04-07', equity: 100000, spy_close: 530 },
    { date: '2025-04-08', equity: 100500, spy_close: 533 },
    { date: '2025-04-09', equity: 100800, spy_close: 535 },
    { date: '2025-04-10', equity: 101200, spy_close: 538 },
    { date: '2025-04-11', equity: 101500, spy_close: 540 },
  ]),
  computePeriodReturn: jest.fn(() => 1.5),
}));

const { assembleMorningBrief, assembleWeeklyDigest } = require('../../src/notifications/briefs');

// ─── Helper to set up DB mock returns per query pattern ──────────────────────
function setupDbMock(queryMap) {
  mockDatabase.prepare.mockImplementation((sql) => {
    // Match partial SQL patterns
    for (const [pattern, result] of Object.entries(queryMap)) {
      if (sql.includes(pattern)) {
        return {
          all: jest.fn(() => result.all || []),
          get: jest.fn(() => result.get || null),
          run: jest.fn(),
        };
      }
    }
    return { all: jest.fn(() => []), get: jest.fn(() => null), run: jest.fn() };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Morning Brief Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('assembleMorningBrief', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDbMock({
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
      'FROM rs_snapshots': {
        all: [
          { ticker: 'SMCI', rsRank: 98, stage: 2, vcpForming: 1, rsLineNewHigh: 0, vsMA50: 3.2, swingMomentum: 72 },
          { ticker: 'CRWD', rsRank: 95, stage: 2, vcpForming: 0, rsLineNewHigh: 1, vsMA50: 5.1, swingMomentum: 68 },
        ],
      },
    });
  });

  test('returns subject, text, html, and data', async () => {
    const result = await assembleMorningBrief();

    expect(result).toHaveProperty('subject');
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('html');
    expect(result).toHaveProperty('data');
    expect(result.subject).toContain('Morning Brief');
  });

  test('includes regime status in output', async () => {
    const result = await assembleMorningBrief();

    expect(result.text).toContain('MARKET REGIME');
    expect(result.text).toContain('FTD_CONFIRMED');
    expect(result.text).toContain('75%');
    expect(result.html).toContain('<b>MARKET REGIME</b>');
  });

  test('includes distribution days and FTD', async () => {
    const result = await assembleMorningBrief();

    expect(result.text).toContain('DISTRIBUTION / FTD');
    expect(result.text).toContain('Dist days (25-session): 2');
    expect(result.text).toContain('Confirmed');
    expect(result.text).toContain('SPY');
  });

  test('includes portfolio heat and positions', async () => {
    const result = await assembleMorningBrief();

    expect(result.text).toContain('PORTFOLIO HEAT');
    expect(result.text).toContain('2 open positions');
    expect(result.text).toContain('4.2%');
    expect(result.text).toContain('NVDA');
    expect(result.text).toContain('AAPL');
  });

  test('includes staged orders', async () => {
    const result = await assembleMorningBrief();

    expect(result.text).toContain('STAGED ORDERS');
    expect(result.text).toContain('MSFT');
    expect(result.text).toContain('$425.00');
  });

  test('includes top scan picks from DB snapshots', async () => {
    const result = await assembleMorningBrief();

    expect(result.text).toContain('TOP SCAN PICKS');
    expect(result.text).toContain('SMCI');
    expect(result.text).toContain('RS 98');
  });

  test('data summary has correct counts', async () => {
    const result = await assembleMorningBrief();

    expect(result.data.cycleMode).toBe('FTD_CONFIRMED');
    expect(result.data.distDays).toBe(2);
    expect(result.data.openPositions).toBe(2);
    expect(result.data.heatPct).toBe(4.2);
    expect(result.data.stagedOrders).toBe(1);
  });

  test('handles no open positions gracefully', async () => {
    setupDbMock({
      'FROM trades WHERE exit_date IS NULL': { all: [] },
      'FROM staged_orders': { all: [] },
      'MAX(date)': { get: null },
    });

    const result = await assembleMorningBrief();

    expect(result.text).toContain('fully in cash');
    expect(result.data.openPositions).toBe(0);
  });

  test('handles regime failure gracefully', async () => {
    const { getMarketRegime } = require('../../src/risk/regime');
    getMarketRegime.mockRejectedValueOnce(new Error('network'));

    const result = await assembleMorningBrief();

    expect(result.text).toContain('MARKET REGIME');
    // Should not throw — regime section shows UNAVAILABLE
    expect(result).toHaveProperty('text');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Weekly Digest Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('assembleWeeklyDigest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDbMock({
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
      // RS snapshot queries for movers
      "date = ? AND type = 'stock' AND rs_rank": {
        all: [],
      },
    });
  });

  test('returns subject, text, html, and data', async () => {
    const result = await assembleWeeklyDigest();

    expect(result).toHaveProperty('subject');
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('html');
    expect(result).toHaveProperty('data');
    expect(result.subject).toContain('Weekly Digest');
  });

  test('includes week performance section', async () => {
    const result = await assembleWeeklyDigest();

    expect(result.text).toContain('WEEK PERFORMANCE');
  });

  test('includes trades this week', async () => {
    const result = await assembleWeeklyDigest();

    expect(result.text).toContain('TRADES THIS WEEK');
    expect(result.text).toContain('1 entries');
    expect(result.text).toContain('1 exits');
    expect(result.text).toContain('NVDA');
    expect(result.text).toContain('MSFT');
    expect(result.text).toContain('EXIT');
  });

  test('includes trade stats with win rate', async () => {
    const result = await assembleWeeklyDigest();

    expect(result.text).toContain('TRADE STATS');
    expect(result.text).toContain('Win rate: 60%');  // 3 winners out of 5
    expect(result.text).toContain('3W / 2L');
  });

  test('includes regime log', async () => {
    const result = await assembleWeeklyDigest();

    expect(result.text).toContain('REGIME LOG');
    expect(result.text).toContain('FTD_CONFIRMED');
    expect(result.text).toContain('75%');
  });

  test('handles empty week gracefully', async () => {
    setupDbMock({
      'entry_date BETWEEN': { all: [] },
      'exit_date BETWEEN': { all: [] },
      'FROM trades WHERE exit_date IS NOT NULL': { all: [] },
      'FROM regime_log': { all: [] },
    });

    const result = await assembleWeeklyDigest();

    expect(result.text).toContain('No trades this week');
    expect(result.text).toContain('No regime entries this week');
    expect(result).toHaveProperty('data');
  });

  test('data summary tracks counts', async () => {
    const result = await assembleWeeklyDigest();

    expect(result.data.entries).toBe(1);
    expect(result.data.exits).toBe(1);
    expect(result.data.regimeChanges).toBe(1);
  });
});
