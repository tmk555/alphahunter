// ─── Tests for Phase 3.11 (Distribution Days) & Phase 3.12 (FTD) ────────────
// Unit-tests the extracted helper functions on regime.js: _countDistributionDays,
// _detectFTD, _confirmFTD. These are the pure-computation cores that don't need
// network or database access.

const { autoDetectCycleState } = require('../../src/risk/regime');
const { _countDistributionDays, _detectFTD, _confirmFTD, FTD_GAIN_THRESHOLD } =
  autoDetectCycleState;

// ─── Bar factory ──────────────────────────────────────────────────────────────
// Generate a series of daily OHLCV bars with controlled price moves & volumes.
function makeBars(specs) {
  // specs: array of { chg, vol } — percentage change and volume for each day
  // First bar anchored at price=100, vol=1_000_000
  const bars = [{ date: '2025-01-02', open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 }];
  let price = 100;
  for (let i = 0; i < specs.length; i++) {
    const { chg = 0, vol = 1_000_000 } = specs[i];
    const newPrice = +(price * (1 + chg)).toFixed(4);
    const d = new Date(2025, 0, 3 + i); // Jan 3 onwards
    bars.push({
      date: d.toISOString().split('T')[0],
      open: price,
      high: Math.max(price, newPrice) * 1.002,
      low: Math.min(price, newPrice) * 0.998,
      close: newPrice,
      volume: vol,
    });
    price = newPrice;
  }
  return bars;
}

// Build 60 neutral bars to establish a baseline, then append custom specs.
function buildBarsWithHistory(customSpecs) {
  const history = [];
  for (let i = 0; i < 55; i++) {
    history.push({ chg: 0.001, vol: 1_000_000 }); // slight drift up, avg volume
  }
  return makeBars([...history, ...customSpecs]);
}

// ─── 3.11: Distribution Day Tests ────────────────────────────────────────────

describe('Phase 3.11: Distribution Day Detection', () => {
  test('counts a dist day when close drops ≥0.2% on above-average volume', () => {
    // 55 neutral bars, then 1 dist day: -0.5% on 1.5M vol (avg is ~1M)
    const bars = buildBarsWithHistory([
      { chg: -0.005, vol: 1_500_000 },
    ]);
    const result = _countDistributionDays(bars, 'SPY');
    expect(result.count).toBe(1);
    expect(result.active.length).toBe(1);
    expect(result.all.length).toBeGreaterThanOrEqual(1);
    expect(result.all[result.all.length - 1].index).toBe('SPY');
  });

  test('does NOT count a down day on below-average volume', () => {
    const bars = buildBarsWithHistory([
      { chg: -0.005, vol: 500_000 }, // below average
    ]);
    const result = _countDistributionDays(bars, 'SPY');
    // The specific day with below-avg volume should not count
    const lastDate = bars[bars.length - 1].date;
    expect(result.active.includes(lastDate)).toBe(false);
  });

  test('does NOT count an up day on high volume', () => {
    const bars = buildBarsWithHistory([
      { chg: 0.005, vol: 2_000_000 }, // up day, high volume
    ]);
    const result = _countDistributionDays(bars, 'QQQ');
    const lastDate = bars[bars.length - 1].date;
    expect(result.active.includes(lastDate)).toBe(false);
  });

  test('does NOT count a tiny decline (-0.1%) even on high volume', () => {
    const bars = buildBarsWithHistory([
      { chg: -0.001, vol: 2_000_000 }, // -0.1%, below threshold
    ]);
    const result = _countDistributionDays(bars, 'SPY');
    const lastDate = bars[bars.length - 1].date;
    expect(result.active.includes(lastDate)).toBe(false);
  });

  test('counts multiple distribution days correctly', () => {
    const specs = [];
    // 5 dist days interspersed with normal days
    for (let i = 0; i < 20; i++) {
      if (i % 4 === 0) {
        specs.push({ chg: -0.003, vol: 1_500_000 }); // dist day
      } else {
        specs.push({ chg: 0.002, vol: 900_000 });
      }
    }
    const bars = buildBarsWithHistory(specs);
    const result = _countDistributionDays(bars, 'SPY');
    expect(result.count).toBe(5);
  });

  test('expires dist days outside 25-session window', () => {
    // Put dist days far back (>25 sessions ago), then neutral recent
    const oldDist = [];
    for (let i = 0; i < 30; i++) {
      oldDist.push({ chg: -0.005, vol: 1_500_000 }); // all dist days
    }
    // Then 25 clean sessions
    const clean = [];
    for (let i = 0; i < 25; i++) {
      clean.push({ chg: 0.001, vol: 900_000 });
    }
    const bars = makeBars([...new Array(5).fill({ chg: 0.001, vol: 1_000_000 }), ...oldDist, ...clean]);
    const result = _countDistributionDays(bars, 'SPY');
    // Active (25-session) should have 0 since clean period is 25 days
    expect(result.count).toBe(0);
    // But "all" (50-session) should have the old ones
    expect(result.all.length).toBeGreaterThan(0);
  });

  test('returns 0 for insufficient data', () => {
    const bars = makeBars([{ chg: 0.001, vol: 1_000_000 }]); // only 2 bars
    const result = _countDistributionDays(bars, 'SPY');
    expect(result.count).toBe(0);
  });

  // ── O'Neil +5% recovery-scrub rule ──────────────────────────────────────
  test('scrubs a dist day when index subsequently closes ≥+5% above that close', () => {
    // Early dist day, then a long rally that closes >5% above the dist close.
    // O'Neil: the market absorbed the selling — that dist day is invalidated.
    const specs = [
      { chg: -0.01,  vol: 1_500_000 },  // dist day #1 — should be scrubbed
      // Now rally +6% cumulatively — last close > dist close × 1.05
      { chg: 0.015, vol: 900_000 },
      { chg: 0.015, vol: 900_000 },
      { chg: 0.015, vol: 900_000 },
      { chg: 0.015, vol: 900_000 },      // cumulative ~+6.1%
      // More quiet sessions so we stay inside 25-session window
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
    ];
    const bars = buildBarsWithHistory(specs);
    const result = _countDistributionDays(bars, 'SPY');
    expect(result.rawCount).toBe(1);            // raw O'Neil count = 1
    expect(result.count).toBe(0);               // after scrub = 0
    expect(result.scrubbedCount).toBe(1);
    expect(result.scrubbed.length).toBe(1);
  });

  test('does NOT scrub a dist day when subsequent recovery < +5%', () => {
    const specs = [
      { chg: -0.01,  vol: 1_500_000 },  // dist day
      // Shallow bounce — only ~+2% total, well below +5% scrub threshold
      { chg: 0.005, vol: 900_000 },
      { chg: 0.005, vol: 900_000 },
      { chg: 0.005, vol: 900_000 },
      { chg: 0.005, vol: 900_000 },
    ];
    const bars = buildBarsWithHistory(specs);
    const result = _countDistributionDays(bars, 'SPY');
    expect(result.rawCount).toBe(1);
    expect(result.count).toBe(1);               // still counting — not scrubbed
    expect(result.scrubbedCount).toBe(0);
  });

  test('scrubs some dist days but keeps fresh ones (mixed case)', () => {
    // Early dist day → rally +6% (scrubs it) → fresh dist day right at end
    const specs = [
      { chg: -0.01,  vol: 1_500_000 },  // old dist day — will be scrubbed
      { chg: 0.015, vol: 900_000 },
      { chg: 0.015, vol: 900_000 },
      { chg: 0.015, vol: 900_000 },
      { chg: 0.015, vol: 900_000 },
      // +5% recovery complete. Now some quiet days.
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: -0.005, vol: 1_500_000 }, // FRESH dist day — no further +5% recovery possible
    ];
    const bars = buildBarsWithHistory(specs);
    const result = _countDistributionDays(bars, 'SPY');
    expect(result.rawCount).toBe(2);            // both raw dist days
    expect(result.count).toBe(1);               // only fresh one remains
    expect(result.scrubbedCount).toBe(1);       // old one scrubbed
  });

  test('recent10Count counts only active (non-scrubbed) dist days in last 10 sessions', () => {
    // Layout: old dist day that gets scrubbed (>10 sessions ago),
    // then a fresh dist day inside the last 10.
    const specs = [
      { chg: -0.01,  vol: 1_500_000 },  // old dist day — will be scrubbed
      { chg: 0.015, vol: 900_000 },
      { chg: 0.015, vol: 900_000 },
      { chg: 0.015, vol: 900_000 },
      { chg: 0.015, vol: 900_000 },     // +6% recovery
      // These push the old dist day beyond the last-10 window
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },
      { chg: 0.001, vol: 900_000 },     // now old dist day is ~12 sessions back
      // Fresh dist day — in last 10 sessions, cannot be scrubbed yet
      { chg: -0.005, vol: 1_500_000 },
    ];
    const bars = buildBarsWithHistory(specs);
    const result = _countDistributionDays(bars, 'SPY');
    expect(result.count).toBe(1);               // fresh only (old was scrubbed)
    expect(result.recent10Count).toBe(1);       // the fresh one is in last 10
  });

  test('returns 0 recent10 when all active dist days are older than 10 sessions', () => {
    // A single non-scrubbed dist day placed ~15 sessions ago, no recovery to scrub it
    const specs = [];
    specs.push({ chg: -0.005, vol: 1_500_000 });   // dist day
    // 15 quiet sessions with small drift — never reaches +5% above dist close
    for (let i = 0; i < 15; i++) specs.push({ chg: 0.001, vol: 900_000 });

    const bars = buildBarsWithHistory(specs);
    const result = _countDistributionDays(bars, 'SPY');
    expect(result.count).toBe(1);               // still active
    expect(result.scrubbedCount).toBe(0);       // not enough bounce
    expect(result.recent10Count).toBe(0);       // but older than last 10
  });
});

// ─── 3.12: Follow-Through Day Tests ─────────────────────────────────────────

describe('Phase 3.12: Follow-Through Day Detection', () => {
  test('FTD_GAIN_THRESHOLD is 1.5%', () => {
    expect(FTD_GAIN_THRESHOLD).toBe(0.015);
  });

  test('detects FTD on day 4 with ≥1.5% gain and higher volume', () => {
    // Swing low at day 0, then 3 small up days, then day 4 = FTD
    const specs = [];
    // Drop to create swing low
    for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
    // Swing low established, now rally:
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 1
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 2
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 3
    specs.push({ chg: 0.020, vol: 1_500_000 }); // day 4 — FTD! (+2%, vol > prior)

    const bars = buildBarsWithHistory(specs);
    const result = _detectFTD(bars, 'SPY');
    expect(result.fired).toBe(true);
    expect(result.index).toBe('SPY');
    expect(result.date).toBeTruthy();
  });

  test('does NOT fire FTD before day 4', () => {
    // Big gain on day 2 — too early
    const specs = [];
    for (let i = 0; i < 10; i++) specs.push({ chg: -0.01, vol: 1_000_000 }); // big drop
    specs.push({ chg: 0.005, vol: 1_000_000 }); // day 1
    specs.push({ chg: 0.025, vol: 1_500_000 }); // day 2 — big gain but too early
    specs.push({ chg: 0.005, vol: 1_000_000 }); // day 3

    const bars = buildBarsWithHistory(specs);
    const result = _detectFTD(bars, 'QQQ');
    // Rally day = 3, which is < 4, so no FTD window to check
    // (The swing low is recent enough that rallyDay < 4)
    expect(result.rallyDay).toBeLessThan(4);
  });

  test('does NOT fire FTD after day 7', () => {
    // Only a big gain on day 8 — too late
    const specs = [];
    for (let i = 0; i < 5; i++) specs.push({ chg: -0.02, vol: 1_000_000 }); // drop
    for (let i = 0; i < 8; i++) specs.push({ chg: 0.003, vol: 900_000 }); // slow rally, days 1-8
    // Now if we're on day 8+, the FTD window (day 4-7) is checked against past bars
    // Since none of day 4-7 had ≥1.5% + higher volume, no FTD
    const bars = buildBarsWithHistory(specs);
    const result = _detectFTD(bars, 'SPY');
    expect(result.fired).toBe(false);
  });

  test('does NOT fire if gain is below 1.5% threshold', () => {
    const specs = [];
    for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 1
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 2
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 3
    specs.push({ chg: 0.010, vol: 1_500_000 }); // day 4 — only 1.0%, below threshold

    const bars = buildBarsWithHistory(specs);
    const result = _detectFTD(bars, 'SPY');
    expect(result.fired).toBe(false);
  });

  test('does NOT fire if volume is lower than prior day', () => {
    const specs = [];
    for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
    specs.push({ chg: 0.003, vol: 2_000_000 }); // day 1 with high vol
    specs.push({ chg: 0.003, vol: 2_000_000 }); // day 2
    specs.push({ chg: 0.003, vol: 2_000_000 }); // day 3 with high vol
    specs.push({ chg: 0.020, vol: 1_500_000 }); // day 4 — good gain but vol < prior day

    const bars = buildBarsWithHistory(specs);
    const result = _detectFTD(bars, 'SPY');
    expect(result.fired).toBe(false);
  });

  test('FTD fires on QQQ index label', () => {
    const specs = [];
    for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
    specs.push({ chg: 0.003, vol: 1_000_000 });
    specs.push({ chg: 0.003, vol: 1_000_000 });
    specs.push({ chg: 0.003, vol: 1_000_000 });
    specs.push({ chg: 0.020, vol: 1_500_000 }); // FTD day 4

    const bars = buildBarsWithHistory(specs);
    const result = _detectFTD(bars, 'QQQ');
    expect(result.fired).toBe(true);
    expect(result.index).toBe('QQQ');
  });
});

// ─── 3.12: FTD Confirmation Tests ────────────────────────────────────────────

describe('Phase 3.12: FTD Confirmation', () => {
  test('confirms FTD when ≤1 dist day follows in 3-5 sessions', () => {
    // Build bars with an FTD at a known date, then clean follow-through
    const specs = [];
    for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 1
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 2
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 3
    specs.push({ chg: 0.020, vol: 1_500_000 }); // day 4 = FTD
    // 5 clean sessions after FTD
    for (let i = 0; i < 5; i++) specs.push({ chg: 0.005, vol: 900_000 });

    const bars = buildBarsWithHistory(specs);
    const ftdResult = _detectFTD(bars, 'SPY');
    expect(ftdResult.fired).toBe(true);

    const vol50Avg = bars.slice(-50).reduce((s, b) => s + b.volume, 0) / 50;
    const confirm = _confirmFTD(bars, ftdResult.date, vol50Avg);
    expect(confirm.confirmed).toBe(true);
    expect(confirm.failed).toBe(false);
  });

  test('FTD fails when 2+ dist days follow', () => {
    const specs = [];
    for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 1
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 2
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 3
    specs.push({ chg: 0.020, vol: 1_500_000 }); // day 4 = FTD
    // 5 dist days after FTD (market breaks down)
    for (let i = 0; i < 5; i++) specs.push({ chg: -0.005, vol: 1_500_000 });

    const bars = buildBarsWithHistory(specs);
    const ftdResult = _detectFTD(bars, 'SPY');
    expect(ftdResult.fired).toBe(true);

    const vol50Avg = bars.slice(-50).reduce((s, b) => s + b.volume, 0) / 50;
    const confirm = _confirmFTD(bars, ftdResult.date, vol50Avg);
    expect(confirm.confirmed).toBe(false);
    expect(confirm.failed).toBe(true);
    expect(confirm.postFTDDistDays).toBeGreaterThanOrEqual(2);
  });

  test('returns pending when fewer than 3 sessions after FTD', () => {
    const specs = [];
    for (let i = 0; i < 5; i++) specs.push({ chg: -0.01, vol: 1_000_000 });
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 1
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 2
    specs.push({ chg: 0.003, vol: 1_000_000 }); // day 3
    specs.push({ chg: 0.020, vol: 1_500_000 }); // day 4 = FTD
    specs.push({ chg: 0.005, vol: 900_000 });   // only 1 session after

    const bars = buildBarsWithHistory(specs);
    const ftdResult = _detectFTD(bars, 'SPY');
    expect(ftdResult.fired).toBe(true);

    const vol50Avg = bars.slice(-50).reduce((s, b) => s + b.volume, 0) / 50;
    const confirm = _confirmFTD(bars, ftdResult.date, vol50Avg);
    expect(confirm.confirmed).toBe(false);
    expect(confirm.failed).toBe(false);
    expect(confirm.pending).toBe(true);
  });

  test('returns no-op for null ftdDate', () => {
    const bars = buildBarsWithHistory([]);
    const confirm = _confirmFTD(bars, null, 1_000_000);
    expect(confirm.confirmed).toBe(false);
    expect(confirm.failed).toBe(false);
  });
});
