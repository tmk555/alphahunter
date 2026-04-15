// ─── Tests: FRED macro series (parser + point-in-time queries) ─────────────
//
// Two fixtures cover the cases that matter for backtests:
//
//   • fred-tiny-daily.csv   — header "DATE,...", two "." missing sentinels,
//                              gaps over weekends (Jan 6-7, 2024 absent).
//   • fred-tiny-monthly.csv — header "observation_date,...", one row per
//                              month-start (like real UNRATE / CPIAUCSL).
//
// The monthly fixture is the crucial one: forward-fill is the reason this
// module exists, and the test must confirm that a query on Jan 15 returns
// the Jan 1 value (not null, not Feb 1).

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const macro = require('../../src/signals/macro-fred');

const DAILY_CSV   = path.join(__dirname, '..', 'fixtures', 'fred-tiny-daily.csv');
const MONTHLY_CSV = path.join(__dirname, '..', 'fixtures', 'fred-tiny-monthly.csv');

// Each test starts from a clean slate for the synthetic series so state
// from earlier cases doesn't bleed in.
function resetFixtures() {
  macro.clearSeries('TINY10Y');
  macro.clearSeries('TINYUNRATE');
  macro.loadFromCsvFile(DAILY_CSV,   'TINY10Y');
  macro.loadFromCsvFile(MONTHLY_CSV, 'TINYUNRATE');
}

// ─── parseFredCsv ──────────────────────────────────────────────────────────

test('parseFredCsv: parses DATE header and numeric values', () => {
  const text = fs.readFileSync(DAILY_CSV, 'utf8');
  const rows = macro.parseFredCsv(text, 'TINY10Y');
  // 8 data lines in fixture, all with valid date format.
  assert.equal(rows.length, 8);
  assert.equal(rows[0].date, '2024-01-02');
  assert.equal(rows[0].value, 4.05);
  assert.equal(rows[0].series_id, 'TINY10Y');
});

test('parseFredCsv: "." missing sentinel becomes null', () => {
  const text = fs.readFileSync(DAILY_CSV, 'utf8');
  const rows = macro.parseFredCsv(text, 'TINY10Y');
  const jan4 = rows.find(r => r.date === '2024-01-04');
  const jan10 = rows.find(r => r.date === '2024-01-10');
  assert.equal(jan4.value, null);
  assert.equal(jan10.value, null);
});

test('parseFredCsv: parses observation_date header (monthly series)', () => {
  const text = fs.readFileSync(MONTHLY_CSV, 'utf8');
  const rows = macro.parseFredCsv(text, 'TINYUNRATE');
  assert.equal(rows.length, 6);
  assert.equal(rows[0].date, '2024-01-01');
  assert.equal(rows[0].value, 3.7);
});

test('parseFredCsv: uppercases series_id regardless of input case', () => {
  const rows = macro.parseFredCsv('DATE,anything\n2024-01-02,1.0\n', 'tinylower');
  assert.equal(rows[0].series_id, 'TINYLOWER');
});

test('parseFredCsv: throws when seriesId missing', () => {
  assert.throws(() => macro.parseFredCsv('DATE,X\n2024-01-02,1\n'), /seriesId/);
});

test('parseFredCsv: ignores malformed lines', () => {
  const text = 'DATE,X\n2024-01-02,1.5\nnot-a-date,2.0\n2024-01-03,\n';
  const rows = macro.parseFredCsv(text, 'X');
  // "not-a-date" dropped; blank value on 2024-01-03 becomes null but row kept.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].value, 1.5);
  assert.equal(rows[1].value, null);
});

// ─── importSeries ──────────────────────────────────────────────────────────

test('importSeries: bulk insert returns count and persists rows', () => {
  macro.clearSeries('TINY10Y');
  const result = macro.loadFromCsvFile(DAILY_CSV, 'TINY10Y');
  assert.equal(result.inserted, 8);
  assert.equal(result.skipped, 0);
  const avail = macro.getAvailableSeries().find(s => s.series_id === 'TINY10Y');
  // Of 8 rows, 2 are null ("." sentinel), so 6 observations are non-null.
  assert.equal(avail.observations, 6);
  assert.equal(avail.earliest, '2024-01-02');
  assert.equal(avail.latest,   '2024-01-11');
});

test('importSeries: idempotent — re-import overwrites, does not duplicate', () => {
  macro.clearSeries('TINY10Y');
  macro.loadFromCsvFile(DAILY_CSV, 'TINY10Y');
  macro.loadFromCsvFile(DAILY_CSV, 'TINY10Y');
  macro.loadFromCsvFile(DAILY_CSV, 'TINY10Y');
  const avail = macro.getAvailableSeries().find(s => s.series_id === 'TINY10Y');
  // Three imports of the same 8-row file → still 6 non-null rows, no dupes.
  assert.equal(avail.observations, 6);
});

test('importSeries: rejects non-array input', () => {
  assert.throws(() => macro.importSeries(null), /array/);
  assert.throws(() => macro.importSeries({}), /array/);
});

test('importSeries: empty array is a no-op', () => {
  const result = macro.importSeries([]);
  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 0);
});

test('importSeries: skips rows missing series_id or date', () => {
  macro.clearSeries('JUNK');
  const result = macro.importSeries([
    { series_id: 'JUNK', date: '2024-01-01', value: 1 },
    { series_id: null,  date: '2024-01-02', value: 2 }, // missing id
    { series_id: 'JUNK', date: null,        value: 3 }, // missing date
  ]);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 2);
  macro.clearSeries('JUNK');
});

// ─── getLatest ──────────────────────────────────────────────────────────────

test('getLatest: returns most recent non-null observation', () => {
  resetFixtures();
  const latest = macro.getLatest('TINY10Y');
  // Jan 11 is the last row and is non-null (4.15).
  assert.equal(latest.date, '2024-01-11');
  assert.equal(latest.value, 4.15);
});

test('getLatest: null for unknown series', () => {
  resetFixtures();
  assert.equal(macro.getLatest('DOES_NOT_EXIST'), null);
});

// ─── getValueOn: forward-fill ───────────────────────────────────────────────

test('getValueOn: exact date match returns that value', () => {
  resetFixtures();
  const row = macro.getValueOn('TINY10Y', '2024-01-03');
  assert.equal(row.date, '2024-01-03');
  assert.equal(row.value, 4.02);
});

test('getValueOn: forward-fills over a null-sentinel day', () => {
  resetFixtures();
  // 2024-01-04 is "." in the fixture — query should return Jan 3's value.
  const row = macro.getValueOn('TINY10Y', '2024-01-04');
  assert.equal(row.date, '2024-01-03');
  assert.equal(row.value, 4.02);
});

test('getValueOn: monthly series forward-fills between observation dates', () => {
  resetFixtures();
  // TINYUNRATE has 2024-01-01, 2024-02-01, ... — a query on Jan 15 must
  // return the Jan 1 value, not null, not Feb 1.
  const row = macro.getValueOn('TINYUNRATE', '2024-01-15');
  assert.equal(row.date, '2024-01-01');
  assert.equal(row.value, 3.7);
});

test('getValueOn: returns null before series start', () => {
  resetFixtures();
  assert.equal(macro.getValueOn('TINY10Y', '2023-12-31'), null);
  assert.equal(macro.getValueOn('TINYUNRATE', '2023-06-01'), null);
});

test('getValueOn: queries after the latest observation carry the latest forward', () => {
  resetFixtures();
  // Long after the fixture's latest row — forward-fill still carries it.
  const row = macro.getValueOn('TINYUNRATE', '2099-12-31');
  assert.equal(row.date, '2024-06-01');
  assert.equal(row.value, 4.1);
});

test('getValueOn: throws when seriesId or date missing', () => {
  assert.throws(() => macro.getValueOn(), /seriesId/);
  assert.throws(() => macro.getValueOn('TINY10Y'), /date/);
});

// ─── getMacroSnapshot ──────────────────────────────────────────────────────

test('getMacroSnapshot: cross-series lookup with explicit allow-list', () => {
  resetFixtures();
  const snap = macro.getMacroSnapshot('2024-03-15', ['TINY10Y', 'TINYUNRATE']);
  // TINY10Y fixture ends 2024-01-11, so it should carry 4.15 forward.
  assert.equal(snap.TINY10Y, 4.15);
  // TINYUNRATE on 2024-03-15 forward-fills to the March 1 value.
  assert.equal(snap.TINYUNRATE, 3.8);
});

test('getMacroSnapshot: missing series in the allow-list map to null', () => {
  resetFixtures();
  const snap = macro.getMacroSnapshot('2024-03-15', ['TINY10Y', 'NOPE']);
  assert.equal(snap.TINY10Y, 4.15);
  assert.equal(snap.NOPE, null);
});

test('getMacroSnapshot: default series list pulls every distinct series in DB', () => {
  resetFixtures();
  const snap = macro.getMacroSnapshot('2024-06-01');
  assert.ok('TINY10Y' in snap);
  assert.ok('TINYUNRATE' in snap);
});

// ─── getSeriesRange ────────────────────────────────────────────────────────

test('getSeriesRange: returns non-null rows within inclusive window, ordered by date', () => {
  resetFixtures();
  const rows = macro.getSeriesRange('TINY10Y', '2024-01-03', '2024-01-09');
  // Jan 3, 5, 8, 9 — Jan 4 is null (dropped), Jan 6-7 absent (weekend).
  assert.deepEqual(rows.map(r => r.date), [
    '2024-01-03', '2024-01-05', '2024-01-08', '2024-01-09',
  ]);
});

test('getSeriesRange: throws on missing params', () => {
  assert.throws(() => macro.getSeriesRange(), /seriesId/);
  assert.throws(() => macro.getSeriesRange('TINY10Y'), /startDate/);
  assert.throws(() => macro.getSeriesRange('TINY10Y', '2024-01-01'), /endDate/);
});

// ─── clearSeries ───────────────────────────────────────────────────────────

test('clearSeries: only wipes the named series', () => {
  resetFixtures();
  macro.clearSeries('TINY10Y');
  assert.equal(macro.getLatest('TINY10Y'), null);
  // The other series is untouched.
  assert.ok(macro.getLatest('TINYUNRATE'));
});

// ─── Release-lag table ─────────────────────────────────────────────────────
//
// These tests cover the production-safety layer that prevents look-ahead
// bias when a backtest queries monthly macro. The pattern: import synthetic
// data UNDER a real series_id (UNRATE, CPIAUCSL, DGS10) so the lag table
// kicks in, then verify the query shifts the effective date backward.

function importAs(seriesId, rows) {
  macro.clearSeries(seriesId);
  macro.importSeries(rows.map(r => ({ ...r, series_id: seriesId })));
}

test('getReleaseLag: known monthly series return their hardcoded lag', () => {
  assert.equal(macro.getReleaseLag('UNRATE'), 35);
  assert.equal(macro.getReleaseLag('CPIAUCSL'), 45);
  assert.equal(macro.getReleaseLag('INDPRO'), 50);
  assert.equal(macro.getReleaseLag('FEDFUNDS'), 32);
});

test('getReleaseLag: daily market series have 0 lag', () => {
  assert.equal(macro.getReleaseLag('DGS10'), 0);
  assert.equal(macro.getReleaseLag('DGS2'), 0);
  assert.equal(macro.getReleaseLag('T10Y2Y'), 0);
  assert.equal(macro.getReleaseLag('BAMLH0A0HYM2'), 0);
  assert.equal(macro.getReleaseLag('VIXCLS'), 0);
});

test('getReleaseLag: DFF has a 2-day buffer for weekend publication', () => {
  assert.equal(macro.getReleaseLag('DFF'), 2);
});

test('getReleaseLag: unknown series defaults to 0', () => {
  assert.equal(macro.getReleaseLag('NOT_A_REAL_SERIES'), 0);
  assert.equal(macro.getReleaseLag('TINY10Y'), 0);
  assert.equal(macro.getReleaseLag(''), 0);
});

test('getValueOn: UNRATE query applies 35-day lag (March 2020 not visible Mar 23)', () => {
  // Reproduces the COVID case from the user-visible report. Monthly data
  // labeled 2020-03-01 (the March unemployment rate) wasn't publicly
  // released until ~April 3. A backtest running on 2020-03-23 must see
  // the February reading, not March.
  importAs('UNRATE', [
    { date: '2020-02-01', value: 3.5 },  // Feb: released ~Mar 6
    { date: '2020-03-01', value: 4.4 },  // Mar: released ~Apr 3
    { date: '2020-04-01', value: 14.8 }, // Apr: released ~May 8
  ]);

  // March 23, 2020: only the Feb reading was actually public.
  // Lag-shifted date = Mar 23 - 35d = Feb 16 → forward-fill to Feb 1 = 3.5%.
  const mar23 = macro.getValueOn('UNRATE', '2020-03-23');
  assert.equal(mar23.date, '2020-02-01');
  assert.equal(mar23.value, 3.5);

  // April 15, 2020: March reading is public. Lag-shifted Apr 15 - 35d =
  // Mar 11 → forward-fill to Mar 1 = 4.4%.
  const apr15 = macro.getValueOn('UNRATE', '2020-04-15');
  assert.equal(apr15.date, '2020-03-01');
  assert.equal(apr15.value, 4.4);

  // May 15, 2020: April reading is public. Lag-shifted May 15 - 35d =
  // Apr 10 → forward-fill to Apr 1 = 14.8%.
  const may15 = macro.getValueOn('UNRATE', '2020-05-15');
  assert.equal(may15.date, '2020-04-01');
  assert.equal(may15.value, 14.8);

  macro.clearSeries('UNRATE');
});

test('getValueOn: CPIAUCSL applies 45-day lag (mid-next-month release)', () => {
  importAs('CPIAUCSL', [
    { date: '2024-01-01', value: 300.0 }, // Jan CPI, released ~Feb 13
    { date: '2024-02-01', value: 301.5 }, // Feb CPI, released ~Mar 12
  ]);

  // Feb 20: lag-shifted = Feb 20 - 45d = Jan 6 → no row before that, but
  // the closest previous observation is actually the query-date minus lag.
  // Jan 1 is BEFORE Jan 6 so forward-fill would pick it. Let's verify.
  const feb20 = macro.getValueOn('CPIAUCSL', '2024-02-20');
  assert.equal(feb20.date, '2024-01-01');
  assert.equal(feb20.value, 300.0);

  // Feb 13 itself: shifted = Feb 13 - 45d = Dec 30, 2023. No rows.
  // But Jan 1 row is too new after the shift — so we get null.
  assert.equal(macro.getValueOn('CPIAUCSL', '2024-02-13'), null);

  macro.clearSeries('CPIAUCSL');
});

test('getValueOn: DGS10 (daily, lag=0) behaves identically to legacy lookup', () => {
  // Daily series with lag=0 should get the exact same result as before
  // the release-lag feature existed. This is the backward-compat guarantee.
  importAs('DGS10', [
    { date: '2024-03-14', value: 4.30 },
    { date: '2024-03-15', value: 4.31 },
    { date: '2024-03-18', value: 4.33 }, // Mar 16-17 weekend
  ]);

  const sat = macro.getValueOn('DGS10', '2024-03-16');
  assert.equal(sat.date, '2024-03-15'); // Forward-fill over weekend.
  assert.equal(sat.value, 4.31);

  const exact = macro.getValueOn('DGS10', '2024-03-18');
  assert.equal(exact.date, '2024-03-18');
  assert.equal(exact.value, 4.33);

  macro.clearSeries('DGS10');
});

test('getValueOn: lagDays:0 override disables shift for charting/history', () => {
  importAs('UNRATE', [
    { date: '2020-02-01', value: 3.5 },
    { date: '2020-03-01', value: 4.4 },
  ]);

  // Default (lag=35): Mar 23 resolves to Feb reading.
  assert.equal(macro.getValueOn('UNRATE', '2020-03-23').date, '2020-02-01');
  // Override (lag=0): Mar 23 sees the March-labeled row — fine for charting
  // known history where look-ahead isn't a concern.
  assert.equal(
    macro.getValueOn('UNRATE', '2020-03-23', { lagDays: 0 }).date,
    '2020-03-01',
  );

  macro.clearSeries('UNRATE');
});

test('getValueOn: custom positive lagDays override (e.g. testing 60-day shift)', () => {
  importAs('UNRATE', [
    { date: '2020-01-01', value: 3.6 },
    { date: '2020-02-01', value: 3.5 },
  ]);

  // With a 60-day custom lag, Mar 23 - 60d = Jan 22 → Jan 1 row.
  const row = macro.getValueOn('UNRATE', '2020-03-23', { lagDays: 60 });
  assert.equal(row.date, '2020-01-01');
  assert.equal(row.value, 3.6);

  macro.clearSeries('UNRATE');
});

test('getMacroSnapshot: applies per-series lag independently', () => {
  // DGS10 (daily, lag=0) and UNRATE (monthly, lag=35) in one snapshot.
  importAs('DGS10', [
    { date: '2020-03-20', value: 0.85 },
    { date: '2020-03-23', value: 0.76 },
  ]);
  importAs('UNRATE', [
    { date: '2020-02-01', value: 3.5 },
    { date: '2020-03-01', value: 4.4 },
  ]);

  const snap = macro.getMacroSnapshot('2020-03-23', ['DGS10', 'UNRATE']);
  // DGS10: no shift → exact-date match.
  assert.equal(snap.DGS10, 0.76);
  // UNRATE: 35-day shift → Feb reading.
  assert.equal(snap.UNRATE, 3.5);

  macro.clearSeries('DGS10');
  macro.clearSeries('UNRATE');
});

test('getMacroSnapshot: lagDays:0 override disables shift across all series', () => {
  importAs('UNRATE', [
    { date: '2020-02-01', value: 3.5 },
    { date: '2020-03-01', value: 4.4 },
  ]);

  // With the override, Mar 23 query sees the March-labeled row.
  const snap = macro.getMacroSnapshot('2020-03-23', ['UNRATE'], { lagDays: 0 });
  assert.equal(snap.UNRATE, 4.4);

  macro.clearSeries('UNRATE');
});

test('getLatest: does NOT apply release-lag (UI/diagnostics use)', () => {
  // getLatest is documented to NOT apply the release-lag — it answers
  // "newest row we have" for UI/status, not backtest-safe lookups.
  importAs('UNRATE', [
    { date: '2020-03-01', value: 4.4 },
    { date: '2020-04-01', value: 14.8 },
  ]);
  assert.equal(macro.getLatest('UNRATE').value, 14.8);
  macro.clearSeries('UNRATE');
});

// ─── classifyRegime ────────────────────────────────────────────────────────
//
// Pure function over a dailyStats-shaped object. No DB touch — easy to
// unit-test directly with synthetic stats.

test('classifyRegime: returns UNKNOWN when VIX/curve/OAS are all missing', () => {
  assert.equal(macro.classifyRegime({}), 'UNKNOWN');
  assert.equal(macro.classifyRegime({ DGS10: { mean: 4 } }), 'UNKNOWN');
});

test('classifyRegime: RISK_OFF when VIX mean ≥ 25', () => {
  const r = macro.classifyRegime({
    VIXCLS:       { mean: 28 },
    T10Y2Y:       { mean: 1.2 },
    BAMLH0A0HYM2: { mean: 3.5 },
  });
  assert.equal(r, 'RISK_OFF');
});

test('classifyRegime: RISK_OFF when curve is inverted even with quiet VIX/OAS', () => {
  const r = macro.classifyRegime({
    VIXCLS:       { mean: 15 },
    T10Y2Y:       { mean: -0.30 },
    BAMLH0A0HYM2: { mean: 3.5 },
  });
  assert.equal(r, 'RISK_OFF');
});

test('classifyRegime: RISK_OFF when HY OAS ≥ 6', () => {
  const r = macro.classifyRegime({
    VIXCLS:       { mean: 15 },
    T10Y2Y:       { mean: 1.0 },
    BAMLH0A0HYM2: { mean: 7.5 },
  });
  assert.equal(r, 'RISK_OFF');
});

test('classifyRegime: RISK_ON requires VIX < 18 AND curve > 0 AND OAS < 4', () => {
  const r = macro.classifyRegime({
    VIXCLS:       { mean: 14 },
    T10Y2Y:       { mean: 0.80 },
    BAMLH0A0HYM2: { mean: 3.2 },
  });
  assert.equal(r, 'RISK_ON');
});

test('classifyRegime: NEUTRAL for the gap between risk-on and risk-off', () => {
  const r = macro.classifyRegime({
    VIXCLS:       { mean: 20 },   // too high for risk_on
    T10Y2Y:       { mean: 0.50 }, // positive → not risk_off
    BAMLH0A0HYM2: { mean: 4.5 },  // too high for risk_on
  });
  assert.equal(r, 'NEUTRAL');
});

// ─── getMacroContextForRange ───────────────────────────────────────────────
//
// Imports small synthetic windows under real series names so the aggregator
// exercises the same DAILY_IDS / MONTHLY_IDS constants and regime classifier
// that production code uses.

function seedContextWindow() {
  // 5 daily observations each for a tight window — easy to reason about by hand.
  importAs('DGS10',        [
    { date: '2020-03-16', value: 0.95 },
    { date: '2020-03-17', value: 0.80 },
    { date: '2020-03-18', value: 1.20 },
    { date: '2020-03-19', value: 1.10 },
    { date: '2020-03-20', value: 0.94 },
  ]);
  importAs('DGS2',         [
    { date: '2020-03-16', value: 0.45 },
    { date: '2020-03-17', value: 0.35 },
    { date: '2020-03-18', value: 0.55 },
    { date: '2020-03-19', value: 0.40 },
    { date: '2020-03-20', value: 0.32 },
  ]);
  importAs('T10Y2Y',       [
    { date: '2020-03-16', value:  0.50 },
    { date: '2020-03-17', value:  0.45 },
    { date: '2020-03-18', value:  0.65 },
    { date: '2020-03-19', value: -0.10 },  // one inverted day
    { date: '2020-03-20', value:  0.62 },
  ]);
  importAs('VIXCLS',       [
    { date: '2020-03-16', value: 82.69 },
    { date: '2020-03-17', value: 75.91 },
    { date: '2020-03-18', value: 76.45 },
    { date: '2020-03-19', value: 72.00 },
    { date: '2020-03-20', value: 66.04 },
  ]);
  importAs('BAMLH0A0HYM2', [
    { date: '2020-03-16', value: 7.50 },
    { date: '2020-03-17', value: 8.20 },
    { date: '2020-03-18', value: 9.10 },
    { date: '2020-03-19', value: 10.87 },
    { date: '2020-03-20', value: 10.15 },
  ]);
  importAs('UNRATE',       [
    { date: '2020-02-01', value: 3.5 },
    { date: '2020-03-01', value: 4.4 },
  ]);
  importAs('CPIAUCSL',     [
    { date: '2020-02-01', value: 259.0 },
    { date: '2020-03-01', value: 258.1 },
  ]);
}

function clearContextWindow() {
  for (const id of ['DGS10','DGS2','T10Y2Y','VIXCLS','BAMLH0A0HYM2','UNRATE','CPIAUCSL','INDPRO','FEDFUNDS','DFF']) {
    macro.clearSeries(id);
  }
}

test('getMacroContextForRange: returns structured summary for a daily window', () => {
  seedContextWindow();
  const ctx = macro.getMacroContextForRange('2020-03-16', '2020-03-20');

  assert.equal(ctx.startDate, '2020-03-16');
  assert.equal(ctx.endDate,   '2020-03-20');
  assert.equal(ctx.tradingDays, 5);

  // DGS10 aggregate — 5 points, mean ~1.00 (exact: 4.99/5 = 0.998)
  assert.equal(ctx.dailyStats.DGS10.count, 5);
  assert.equal(ctx.dailyStats.DGS10.first, 0.95);
  assert.equal(ctx.dailyStats.DGS10.last,  0.94);
  assert.equal(ctx.dailyStats.DGS10.min,   0.80);
  assert.equal(ctx.dailyStats.DGS10.max,   1.20);
  assert.ok(Math.abs(ctx.dailyStats.DGS10.mean - 0.998) < 1e-3);

  clearContextWindow();
});

test('getMacroContextForRange: T10Y2Y stress counter counts inverted days', () => {
  seedContextWindow();
  const ctx = macro.getMacroContextForRange('2020-03-16', '2020-03-20');
  // 1 of 5 days inverted (2020-03-19 with -0.10).
  assert.equal(ctx.dailyStats.T10Y2Y.daysInverted, 1);
  clearContextWindow();
});

test('getMacroContextForRange: VIX counts elevated (≥20) and stressed (≥30) days', () => {
  seedContextWindow();
  const ctx = macro.getMacroContextForRange('2020-03-16', '2020-03-20');
  // All 5 days were 66-82, so every day is both elevated and stressed.
  assert.equal(ctx.dailyStats.VIXCLS.daysElevated, 5);
  assert.equal(ctx.dailyStats.VIXCLS.daysStressed, 5);
  clearContextWindow();
});

test('getMacroContextForRange: HY OAS counts days ≥ 6 as stressed', () => {
  seedContextWindow();
  const ctx = macro.getMacroContextForRange('2020-03-16', '2020-03-20');
  // All 5 days were 7.5-10.87 → all stressed.
  assert.equal(ctx.dailyStats.BAMLH0A0HYM2.daysStressed, 5);
  clearContextWindow();
});

test('getMacroContextForRange: monthly stats return first/last/change', () => {
  seedContextWindow();
  const ctx = macro.getMacroContextForRange('2020-02-01', '2020-04-01');
  // UNRATE: Feb 3.5 → Mar 4.4 (window ends Apr 1 — CPI entry within)
  assert.equal(ctx.monthlyStats.UNRATE.first, 3.5);
  assert.equal(ctx.monthlyStats.UNRATE.last,  4.4);
  assert.equal(ctx.monthlyStats.UNRATE.change, 0.9);
  // CPI pctChange — 259.0 → 258.1 ≈ -0.35%
  assert.ok(ctx.monthlyStats.CPIAUCSL.pctChange < 0);
  assert.ok(Math.abs(ctx.monthlyStats.CPIAUCSL.pctChange + 0.35) < 0.05);
  clearContextWindow();
});

test('getMacroContextForRange: COVID window classified as RISK_OFF', () => {
  seedContextWindow();
  const ctx = macro.getMacroContextForRange('2020-03-16', '2020-03-20');
  // VIX mean ≈ 74.6 (≥25) AND HY OAS mean ≈ 9.16 (≥6) → RISK_OFF
  assert.equal(ctx.regime, 'RISK_OFF');
  clearContextWindow();
});

test('getMacroContextForRange: snapshots present at start/mid/end with same shape', () => {
  seedContextWindow();
  const ctx = macro.getMacroContextForRange('2020-03-16', '2020-03-20');
  assert.equal(ctx.snapshots.start.date, '2020-03-16');
  assert.equal(ctx.snapshots.end.date,   '2020-03-20');
  // mid date = 2020-03-18 (exact midpoint)
  assert.equal(ctx.snapshots.mid.date, '2020-03-18');
  // start snapshot carries DGS10 value available by that date
  assert.ok('DGS10' in ctx.snapshots.start.values);
  clearContextWindow();
});

test('getMacroContextForRange: missing series return null in stats, no crash', () => {
  // Fresh, empty window — no data seeded. Range aggregator should produce
  // a well-formed object with null-valued entries.
  clearContextWindow();
  const ctx = macro.getMacroContextForRange('2099-01-01', '2099-06-30');
  assert.equal(ctx.regime, 'UNKNOWN');
  assert.equal(ctx.tradingDays, 0);
  assert.equal(ctx.dailyStats.DGS10, null);
  assert.equal(ctx.monthlyStats.UNRATE, null);
});

test('getMacroContextForRange: throws when startDate or endDate missing', () => {
  assert.throws(() => macro.getMacroContextForRange(null, '2024-01-01'),  /startDate required/);
  assert.throws(() => macro.getMacroContextForRange('2024-01-01', null),  /endDate required/);
});
