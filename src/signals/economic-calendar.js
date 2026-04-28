// ─── US Economic Events Calendar ─────────────────────────────────────────
//
// Hardcoded calendar of high-signal US economic releases. Used by the
// Market Pulse tab to surface "what binary events are coming up" so the
// trader can avoid sizing into a print or know to clip risk before NFP /
// CPI / FOMC.
//
// No paid API: BLS / Fed / BEA all publish on predictable cadences
// (first-Friday NFP, mid-month CPI, end-of-month PCE, Fed-published FOMC
// dates). Recurring events are computed; FOMC dates are explicit since
// they don't follow a clean rule.
//
// Updating: as the Fed publishes the next-year FOMC schedule (typically
// every June), append the new dates to FOMC_DATES below. Recurring events
// just keep working into future years.

// FOMC meeting dates (Fed-published schedule). The market reaction usually
// hits on Day 2 (Wednesday) when Powell speaks at 14:00 ET. Day 1 is
// included so traders see the two-day window blocked off.
//
// Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
// Format: { date: 'YYYY-MM-DD', day: 1|2 }
const FOMC_DATES = [
  // 2026 — schedule published mid-2025
  { date: '2026-01-27', day: 1 }, { date: '2026-01-28', day: 2 },
  { date: '2026-03-17', day: 1 }, { date: '2026-03-18', day: 2 },
  { date: '2026-04-28', day: 1 }, { date: '2026-04-29', day: 2 },
  { date: '2026-06-16', day: 1 }, { date: '2026-06-17', day: 2 },
  { date: '2026-07-28', day: 1 }, { date: '2026-07-29', day: 2 },
  { date: '2026-09-15', day: 1 }, { date: '2026-09-16', day: 2 },
  { date: '2026-10-27', day: 1 }, { date: '2026-10-28', day: 2 },
  { date: '2026-12-15', day: 1 }, { date: '2026-12-16', day: 2 },
  // 2027 — adds when the Fed publishes the schedule
];

// Recurring-event patterns. Each entry returns boolean for "does this date
// have this release". Cadence rules verified against bls.gov / bea.gov /
// federalreserve.gov calendars.
//
// All US releases land at fixed NY-time clocks. The `time` field is
// informational — the front-end shows it.

function dayOfWeek(d) {
  // 0=Sun ... 6=Sat. Use UTC since release dates are date-only.
  return new Date(d + 'T12:00:00Z').getUTCDay();
}

// Nth weekday of the month for the current year+month: e.g. firstFridayOf(YYYY,MM).
function nthWeekdayOfMonth(year, month, weekday, n) {
  // weekday: 0=Sun..6=Sat. n: 1..5
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  return d.toISOString().slice(0, 10);
}

// Last weekday of the month (e.g. last Tuesday for Consumer Confidence).
function lastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  const diff = (last.getUTCDay() - weekday + 7) % 7;
  const d = new Date(Date.UTC(year, month - 1, last.getUTCDate() - diff));
  return d.toISOString().slice(0, 10);
}

// First business day of month — skips Sat/Sun. Doesn't account for federal
// holidays; close enough for a heads-up panel.
function firstBusinessDayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Build an event entry. Categories drive UI color; importance drives sort
// order (high first within a date).
function evt(date, name, category, importance, time, note) {
  return { date, name, category, importance, time, note };
}

// Generate recurring events for a given calendar month.
function recurringEventsForMonth(year, month) {
  const out = [];

  // ── Jobs ──
  // NFP / Employment Situation: first Friday of the month, 8:30 ET
  const nfp = nthWeekdayOfMonth(year, month, 5, 1);
  if (nfp) out.push(evt(nfp, 'Nonfarm Payrolls (NFP)', 'jobs', 'high', '08:30 ET', 'Headline jobs print — biggest single macro tape mover most months.'));

  // ADP Employment: typically the Wednesday before NFP (so first Wed of
  // month if NFP is Fri-of-1st-week). Approximation.
  const adp = (() => {
    const wed1 = nthWeekdayOfMonth(year, month, 3, 1);
    return wed1;
  })();
  if (adp) out.push(evt(adp, 'ADP Employment', 'jobs', 'medium', '08:15 ET', 'Private payrolls — preview for NFP, often diverges.'));

  // Initial Jobless Claims: every Thursday, 8:30 ET. Generated separately
  // in the date-range walker (not here).

  // JOLTS: usually first Tuesday of month at 10:00 ET — covers prior-prior month.
  const jolts = nthWeekdayOfMonth(year, month, 2, 1);
  if (jolts) out.push(evt(jolts, 'JOLTS Job Openings', 'jobs', 'medium', '10:00 ET', 'Vacancy data — Fed watches closely.'));

  // ── Inflation ──
  // CPI: typically the Wednesday of the second full week, 8:30 ET. Use
  // the second Wednesday as a robust approximation.
  const cpi = nthWeekdayOfMonth(year, month, 3, 2);
  if (cpi) out.push(evt(cpi, 'CPI (Consumer Price Index)', 'inflation', 'high', '08:30 ET', 'Headline + Core inflation — primary Fed input.'));

  // PPI: usually the day after CPI (Thursday of the second week)
  const ppi = nthWeekdayOfMonth(year, month, 4, 2);
  if (ppi) out.push(evt(ppi, 'PPI (Producer Price Index)', 'inflation', 'medium', '08:30 ET', 'Producer-side inflation, leads CPI by 1-2 months.'));

  // PCE: last business Friday of month, 8:30 ET. Use last Friday as proxy.
  const pce = lastWeekdayOfMonth(year, month, 5);
  if (pce) out.push(evt(pce, 'PCE / Personal Income', 'inflation', 'high', '08:30 ET', "Fed's preferred inflation gauge — Core PCE is THE number."));

  // ── Growth / Activity ──
  // Retail Sales: ~mid-month (15th-ish), 8:30 ET. Use 2nd Tuesday as proxy.
  const retail = nthWeekdayOfMonth(year, month, 2, 2);
  if (retail) out.push(evt(retail, 'Retail Sales', 'growth', 'medium', '08:30 ET', 'Consumer spending snapshot — drives Q-by-Q GDP nowcast.'));

  // ISM Manufacturing PMI: 1st business day of month, 10:00 ET
  const ismMfg = firstBusinessDayOfMonth(year, month);
  out.push(evt(ismMfg, 'ISM Manufacturing PMI', 'growth', 'medium', '10:00 ET', '50 = expansion/contraction line; below 47 historically recessionary.'));

  // ISM Services PMI: ~3rd business day of month, 10:00 ET
  const ismSvc = (() => {
    const d = new Date(Date.UTC(year, month - 1, 1));
    let count = 0;
    while (count < 3) {
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) count++;
      if (count < 3) d.setUTCDate(d.getUTCDate() + 1);
    }
    return d.toISOString().slice(0, 10);
  })();
  out.push(evt(ismSvc, 'ISM Services PMI', 'growth', 'medium', '10:00 ET', 'Services sector activity — larger weight in modern US economy.'));

  // GDP advance/revision: end of month for prior quarter — last Thursday-ish.
  // Only relevant on quarter-end+1 month, but include a placeholder for the
  // last Thu of every month (BEA releases at varying granularities).
  const gdp = lastWeekdayOfMonth(year, month, 4);
  // GDP only really posts in Jan/Feb/Mar/Apr cycle — use the rough rule:
  // include for months 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 but lower
  // importance most months and high in the actual release months.
  // Simpler: only push for Jan/Apr/Jul/Oct (advance estimates) + Feb/May/Aug/Nov (second).
  if ([1, 2, 4, 5, 7, 8, 10, 11].includes(month)) {
    out.push(evt(gdp, 'GDP (advance / revision)', 'growth', 'medium', '08:30 ET', 'Quarterly GDP estimate. Advance, second, and third releases land in successive months.'));
  }

  // ── Sentiment ──
  // Consumer Confidence (Conference Board): last Tuesday of month, 10:00 ET
  const ccc = lastWeekdayOfMonth(year, month, 2);
  out.push(evt(ccc, 'Consumer Confidence', 'sentiment', 'medium', '10:00 ET', 'Conference Board reading — broadly tracked but rarely market-moving alone.'));

  // U-Mich Consumer Sentiment: preliminary mid-month (2nd Friday), final
  // last Friday. We surface the final reading.
  const umichFinal = lastWeekdayOfMonth(year, month, 5);
  out.push(evt(umichFinal, 'UMich Sentiment (Final)', 'sentiment', 'low', '10:00 ET', 'Consumer expectations — embedded inflation expectations occasionally move bond market.'));

  // ── Housing ──
  // Housing Starts: ~3rd Tuesday, 8:30 ET
  const housing = nthWeekdayOfMonth(year, month, 2, 3);
  if (housing) out.push(evt(housing, 'Housing Starts & Permits', 'growth', 'low', '08:30 ET', 'Leading housing-cycle indicator.'));

  return out;
}

// Walk a date range and emit weekly events (Initial Jobless Claims).
function weeklyEvents(startISO, endISO) {
  const out = [];
  const start = new Date(startISO + 'T12:00:00Z');
  const end = new Date(endISO + 'T12:00:00Z');
  const d = new Date(start);
  while (d <= end) {
    if (d.getUTCDay() === 4) {
      out.push(evt(d.toISOString().slice(0, 10), 'Initial Jobless Claims', 'jobs', 'low', '08:30 ET', 'Weekly print — trend matters more than any single week.'));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Return events between [startISO, endISO] inclusive, sorted ascending by
 * (date, importance). UI consumes this directly.
 */
function getUpcomingEvents(startISO, endISO) {
  const out = [];

  // Recurring events for each month touched by the range
  const startMs = Date.parse(startISO + 'T00:00:00Z');
  const endMs = Date.parse(endISO + 'T23:59:59Z');
  const cur = new Date(startMs);
  cur.setUTCDate(1);
  while (cur.getTime() <= endMs) {
    const events = recurringEventsForMonth(cur.getUTCFullYear(), cur.getUTCMonth() + 1);
    for (const e of events) {
      const t = Date.parse(e.date + 'T00:00:00Z');
      if (t >= startMs && t <= endMs) out.push(e);
    }
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }

  // Weekly Jobless Claims
  out.push(...weeklyEvents(startISO, endISO).filter(e => {
    const t = Date.parse(e.date + 'T00:00:00Z');
    return t >= startMs && t <= endMs;
  }));

  // FOMC scheduled meetings within range
  for (const f of FOMC_DATES) {
    const t = Date.parse(f.date + 'T00:00:00Z');
    if (t >= startMs && t <= endMs) {
      const isDay2 = f.day === 2;
      out.push(evt(
        f.date,
        isDay2 ? 'FOMC Decision + Powell Press Conf' : 'FOMC Day 1 (no statement)',
        'monetary_policy',
        isDay2 ? 'high' : 'medium',
        isDay2 ? '14:00 ET' : '—',
        isDay2
          ? 'Rate decision + statement at 14:00, press conference at 14:30. Largest single-day macro tape mover.'
          : 'First day of two-day meeting — no statement, but post-day press leaks occasionally move markets.',
      ));
    }
  }

  // Sort ascending by date, then importance (high first within a date)
  const importanceWeight = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return importanceWeight[a.importance] - importanceWeight[b.importance];
  });

  // Add daysOut + dayOfWeek for the UI
  const today = new Date().toISOString().slice(0, 10);
  for (const e of out) {
    const t = Date.parse(e.date + 'T00:00:00Z');
    const todayMs = Date.parse(today + 'T00:00:00Z');
    e.daysOut = Math.round((t - todayMs) / 86400000);
    e.dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayOfWeek(e.date)];
  }

  return out;
}

module.exports = {
  getUpcomingEvents,
  // exported for tests
  recurringEventsForMonth,
  FOMC_DATES,
};
