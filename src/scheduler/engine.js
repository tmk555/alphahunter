// ─── Job Scheduler Engine (Tier 5) ──────────────────────────────────────────
// Manages cron-based scheduled jobs with persistence, history, and built-in job types
const cron = require('node-cron');
const { getDB } = require('../data/database');

function db() { return getDB(); }

// Active cron tasks keyed by job id
const activeTasks = new Map();

// Registry of built-in job type handlers
const jobHandlers = new Map();

// In-flight guard: keyed by job.id while executeJob is mid-run. Prevents the
// same job from firing twice concurrently — a real risk because the startup
// catch-up runner can overlap with a cron tick (e.g. the */2 pullback_watch
// cron fires while catchup is still working through the queue and reaches
// pullback_watch). Without this guard we'd double-update last_run_at, double
// emit phone alerts, and double-bill any provider-call inside the handler.
const inFlight = new Set();

// ─── Job Type Registry ─────────────────────────────────────────────────────

function registerJobType(type, { handler, description, defaultConfig = {} }) {
  jobHandlers.set(type, { handler, description, defaultConfig });
}

function getJobTypes() {
  const types = {};
  for (const [type, { description, defaultConfig }] of jobHandlers) {
    types[type] = { description, defaultConfig };
  }
  return types;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

function getAllJobs() {
  return db().prepare('SELECT * FROM scheduled_jobs ORDER BY created_at DESC').all()
    .map(j => ({ ...j, config: JSON.parse(j.config || '{}') }));
}

function getJob(id) {
  const job = db().prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id);
  if (job) job.config = JSON.parse(job.config || '{}');
  return job;
}

function getJobByName(name) {
  const job = db().prepare('SELECT * FROM scheduled_jobs WHERE name = ?').get(name);
  if (job) job.config = JSON.parse(job.config || '{}');
  return job;
}

function createJob({ name, description, job_type, cron_expression, config = {}, enabled = true }) {
  if (!name || !job_type || !cron_expression) {
    throw new Error('name, job_type, and cron_expression are required');
  }
  if (!cron.validate(cron_expression)) {
    throw new Error(`Invalid cron expression: ${cron_expression}`);
  }
  if (!jobHandlers.has(job_type)) {
    throw new Error(`Unknown job type: ${job_type}. Available: ${[...jobHandlers.keys()].join(', ')}`);
  }

  const stmt = db().prepare(`
    INSERT INTO scheduled_jobs (name, description, job_type, cron_expression, config, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(name, description || null, job_type, cron_expression, JSON.stringify(config), enabled ? 1 : 0);
  const job = getJob(result.lastInsertRowid);

  // Auto-schedule if enabled
  if (job.enabled) scheduleJob(job);
  return job;
}

function updateJob(id, updates) {
  const job = getJob(id);
  if (!job) throw new Error(`Job ${id} not found`);

  const fields = [];
  const values = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.cron_expression !== undefined) {
    if (!cron.validate(updates.cron_expression)) throw new Error(`Invalid cron expression: ${updates.cron_expression}`);
    fields.push('cron_expression = ?'); values.push(updates.cron_expression);
  }
  if (updates.config !== undefined) { fields.push('config = ?'); values.push(JSON.stringify(updates.config)); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
  fields.push("updated_at = datetime('now')");

  if (fields.length === 1) return job; // Only updated_at

  values.push(id);
  db().prepare(`UPDATE scheduled_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // Reschedule
  unscheduleJob(id);
  const updated = getJob(id);
  if (updated.enabled) scheduleJob(updated);
  return updated;
}

function deleteJob(id) {
  unscheduleJob(id);
  db().prepare('DELETE FROM job_history WHERE job_id = ?').run(id);
  db().prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
}

function toggleJob(id, enabled) {
  db().prepare("UPDATE scheduled_jobs SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id);
  if (enabled) {
    const job = getJob(id);
    scheduleJob(job);
  } else {
    unscheduleJob(id);
  }
  return getJob(id);
}

// ─── Execution ──────────────────────────────────────────────────────────────

async function executeJob(job) {
  // Skip if the same job is already mid-execution (catchup vs cron race).
  // Returning a benign skip object — not throwing — keeps the cron task
  // wrapper happy and the catchup runner's serial loop moving.
  if (inFlight.has(job.id)) {
    console.log(`  Scheduler: ⤳ ${job.name} already running — skipping concurrent fire`);
    return { status: 'skipped', reason: 'in-flight' };
  }
  inFlight.add(job.id);
  try {
    return await _executeJobBody(job);
  } finally {
    inFlight.delete(job.id);
  }
}

async function _executeJobBody(job) {
  const handler = jobHandlers.get(job.job_type);
  if (!handler) throw new Error(`No handler for job type: ${job.job_type}`);

  const startTime = Date.now();
  const historyId = db().prepare(`
    INSERT INTO job_history (job_id, job_name, started_at, status)
    VALUES (?, ?, datetime('now'), 'running')
  `).run(job.id, job.name).lastInsertRowid;

  try {
    const result = await handler.handler(job.config, job);
    const duration = Date.now() - startTime;

    db().prepare(`
      UPDATE job_history SET status = 'success', finished_at = datetime('now'),
        duration_ms = ?, result = ? WHERE id = ?
    `).run(duration, JSON.stringify(result || {}), historyId);

    db().prepare(`
      UPDATE scheduled_jobs SET last_run_at = datetime('now'), last_run_status = 'success',
        last_run_duration_ms = ?, last_error = NULL, run_count = run_count + 1,
        updated_at = datetime('now') WHERE id = ?
    `).run(duration, job.id);

    console.log(`  Scheduler: ✓ ${job.name} completed (${duration}ms)`);
    return { status: 'success', duration_ms: duration, result };
  } catch (e) {
    const duration = Date.now() - startTime;

    db().prepare(`
      UPDATE job_history SET status = 'error', finished_at = datetime('now'),
        duration_ms = ?, error = ? WHERE id = ?
    `).run(duration, e.message, historyId);

    db().prepare(`
      UPDATE scheduled_jobs SET last_run_at = datetime('now'), last_run_status = 'error',
        last_run_duration_ms = ?, last_error = ?, run_count = run_count + 1,
        updated_at = datetime('now') WHERE id = ?
    `).run(duration, e.message, job.id);

    console.error(`  Scheduler: ✗ ${job.name} failed: ${e.message}`);
    return { status: 'error', duration_ms: duration, error: e.message };
  }
}

// Run a job immediately (on-demand)
async function runJobNow(id) {
  const job = getJob(id);
  if (!job) throw new Error(`Job ${id} not found`);
  return executeJob(job);
}

// ─── Scheduling ─────────────────────────────────────────────────────────────

function scheduleJob(job) {
  if (activeTasks.has(job.id)) return; // Already scheduled

  const task = cron.schedule(job.cron_expression, () => {
    executeJob(job).catch(e => console.error(`  Scheduler: unhandled error in ${job.name}: ${e.message}`));
  }, { scheduled: true });

  activeTasks.set(job.id, task);
}

function unscheduleJob(id) {
  const task = activeTasks.get(id);
  if (task) {
    task.stop();
    activeTasks.delete(id);
  }
}

// ─── History ────────────────────────────────────────────────────────────────

function getJobHistory(jobId, limit = 25) {
  const rows = db().prepare(
    'SELECT * FROM job_history WHERE job_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(jobId, limit);
  return rows.map(r => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
}

function getRecentHistory(limit = 50) {
  const rows = db().prepare(
    'SELECT * FROM job_history ORDER BY started_at DESC LIMIT ?'
  ).all(limit);
  return rows.map(r => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
}

function clearHistory(jobId) {
  if (jobId) {
    db().prepare('DELETE FROM job_history WHERE job_id = ?').run(jobId);
  } else {
    db().prepare('DELETE FROM job_history').run();
  }
}

// ─── Startup Catch-up Runner ────────────────────────────────────────────────
//
// Cron has no replay. If the process is down through a scheduled fire time,
// that fire is just lost — node-cron does not check "did I miss anything?"
// when it boots. For this user that meant: come back from a long weekend
// or a server restart and the Friday-evening rs_scan_daily, the Sunday
// weekly_digest, and Saturday's job_history_cleanup all silently never ran.
// The Morning Brief on Monday then reads stale RS data and the user has no
// signal that anything is wrong.
//
// runMissedJobsOnStartup walks every enabled job, classifies its cron's
// natural cadence, computes the moment that job *should* have fired next
// after its last_run_at, and fires it now if that moment is in the past.
//
// Cadence classification (NOT a full cron parser — just the four shapes
// used by DEFAULT_JOBS):
//   • "*/N * * * ..."     → minutes, interval = N min
//   • "M * * * ..."       → hourly,  interval = 1 h
//   • "M H * * 1-5" / "M H * * *" → daily, interval = 1 day
//   • "M H * * D" (single dow) → weekly
//
// Daily rule (user-specified): fire if EITHER ≥24h have elapsed since
// last_run_at OR a calendar day boundary (local midnight) has been crossed,
// whichever comes first. A 16-hour overnight gap (yesterday 4:30 PM →
// today 9 AM) is < 24 h but is a "new trading day", so the daily job
// should still fire on the morning app-load.
//
// Weekly rule (user-specified): fire if EITHER ≥7 days have elapsed since
// last_run_at OR a Monday boundary has been crossed since last_run_at,
// whichever comes first. Anchoring weekly catch-up to "next Monday" keeps
// the trading-week cadence intact even if last_run_at drifts off the
// originally-scheduled day.
//
// First-run case (last_run_at IS NULL): always fire. This is the
// "fresh install" path — the seed just inserted the row, the user wants
// populated data on first pageview without waiting until the next cron.

function classifyCadence(cronExpr) {
  if (!cronExpr || typeof cronExpr !== 'string') return { cadence: 'unknown' };
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return { cadence: 'unknown' };
  const [min, hour, , , dow] = parts;

  // Step minute (e.g. "*/2", "*/15") → fast intraday cadence
  const stepMin = min.match(/^\*\/(\d+)$/);
  if (stepMin) {
    const n = parseInt(stepMin[1], 10);
    if (n > 0) return { cadence: 'minutes', intervalMs: n * 60 * 1000 };
  }

  // Specific minute, hour wildcard or range → hourly
  if (/^\d+$/.test(min) && (hour === '*' || /^\d+-\d+$/.test(hour) || /^\*\//.test(hour))) {
    return { cadence: 'hourly', intervalMs: 60 * 60 * 1000 };
  }

  // Specific minute + hour + single-digit dow → weekly
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dow)) {
    return { cadence: 'weekly', dow: parseInt(dow, 10), intervalMs: 7 * 24 * 60 * 60 * 1000 };
  }

  // Specific minute + hour, dow wildcard or range (e.g. "1-5") → daily
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return { cadence: 'daily', intervalMs: 24 * 60 * 60 * 1000 };
  }

  return { cadence: 'unknown' };
}

// Parse a cron field's day-of-week constraint and check whether `date`
// satisfies it. Supports the four shapes used by DEFAULT_JOBS:
//   • "*"        → all days
//   • "0".."6"   → single dow (0=Sun, 6=Sat)
//   • "a-b"      → inclusive range (e.g. "1-5" = Mon-Fri)
//   • "a,b,c"    → comma-separated list (e.g. "0,6" = weekends)
// Returns true when the field permits firing on `date`. Anything we don't
// recognize is treated as permissive (fail-open) — better to fire a
// suspect job once than silently miss a known-good one.
//
// Why this exists: pre-fix, my catch-up runner classified `30 16 * * 1-5`
// as cadence="daily" and ignored the `1-5` weekday-only constraint. On a
// Saturday morning app-load, rs_scan_daily and breadth_snapshot_daily
// both fired — they wrote new rs_snapshots/breadth_snapshots rows using
// live (Saturday) provider quotes, which differ subtly from Friday's
// closing prints. The user's composite breadth score moved overnight on
// a closed market. Honoring the dow constraint stops weekday-only jobs
// from running on weekends.
function cronAllowsDay(cronExpr, date) {
  if (!cronExpr || typeof cronExpr !== 'string') return true;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return true;
  const dow = parts[4];
  if (!dow || dow === '*') return true;

  const today = date.getDay(); // 0=Sun..6=Sat (local time, matches node-cron)

  // Comma list: "0,6"
  if (dow.includes(',')) {
    return dow.split(',').some(p => _dowAtomMatches(p.trim(), today));
  }
  return _dowAtomMatches(dow, today);
}

function _dowAtomMatches(atom, today) {
  // Single digit
  if (/^\d+$/.test(atom)) return parseInt(atom, 10) === today;
  // Range "a-b"
  const range = atom.match(/^(\d+)-(\d+)$/);
  if (range) {
    const lo = parseInt(range[1], 10);
    const hi = parseInt(range[2], 10);
    if (lo <= hi) return today >= lo && today <= hi;
    // Wrap-around (e.g. "5-1" = Fri,Sat,Sun,Mon) — uncommon but valid cron.
    return today >= lo || today <= hi;
  }
  return true; // unknown atom → fail-open
}

// First Monday strictly after `date` (server local time). Used as the
// "Monday boundary" for the weekly catch-up rule.
function nextMondayMidnightAfter(date) {
  const d = new Date(date.getTime());
  const day = d.getDay();         // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilMon = ((1 - day + 7) % 7) || 7;  // strictly future — never 0
  d.setDate(d.getDate() + daysUntilMon);
  d.setHours(0, 0, 0, 0);
  return d;
}

// First local-midnight strictly after `date`. Used as the "day boundary"
// for the daily catch-up rule — a daily job that ran at 4:30 PM yesterday
// has crossed a day boundary at next midnight, so an app-load at 9 AM
// today (only 16.5 h elapsed, < 24 h) should still fire it. Without this
// the daily catchup silently skips the morning restart and the user's
// data stays one trading day stale.
function nextMidnightAfter(date) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Decide whether a job should fire on startup based on its cadence and last
// run. Pure function (no DB / clock side-effects beyond the optional `now`),
// so it's straightforward to unit-test.
function shouldCatchUp(lastRunAt, cronExpr, now = new Date()) {
  const cls = classifyCadence(cronExpr);
  if (cls.cadence === 'unknown') {
    return { fire: false, reason: 'cadence-unknown', cadence: 'unknown' };
  }
  // Honor the cron's day-of-week constraint. Catch-up runs on app load,
  // not at scheduled times, so a Saturday morning restart would otherwise
  // fire weekday-only jobs (rs_scan_daily, breadth_snapshot_daily, …).
  // That's how the user's composite breadth score moved 48→51 overnight
  // on a closed market: catchup wrote a fresh row using live Saturday
  // VIX quotes that diverge from Friday's at-close print. Skip when the
  // dow excludes today.
  //
  // Weekly jobs (single-dow crons) are exempt: they intentionally fire
  // on a non-matching day to fill in a missed slot, and the weekly
  // threshold logic below already gates correctness.
  if (cls.cadence !== 'weekly' && !cronAllowsDay(cronExpr, now)) {
    return { fire: false, reason: 'dow-excludes-today', cadence: cls.cadence };
  }
  if (!lastRunAt) {
    return { fire: true, reason: 'never-run', cadence: cls.cadence };
  }

  // SQLite datetime('now') is UTC, stored without a 'Z' suffix.
  // Append 'Z' so JS parses it as UTC instead of local time.
  const last = new Date(lastRunAt.endsWith('Z') ? lastRunAt : lastRunAt + 'Z');
  if (Number.isNaN(last.getTime())) {
    return { fire: true, reason: 'invalid-last-run', cadence: cls.cadence };
  }

  if (cls.cadence === 'weekly') {
    const sevenDays = new Date(last.getTime() + 7 * 24 * 60 * 60 * 1000);
    const nextMon   = nextMondayMidnightAfter(last);
    const threshold = sevenDays < nextMon ? sevenDays : nextMon;
    if (now >= threshold) {
      return {
        fire: true,
        reason: `weekly-threshold-passed (${threshold.toISOString()})`,
        cadence: 'weekly',
      };
    }
    return { fire: false, reason: 'within-weekly-cadence', cadence: 'weekly' };
  }

  if (cls.cadence === 'daily') {
    // Mirror the weekly rule at day-granularity: 24h elapsed OR a calendar
    // day boundary crossed — whichever comes first. This catches the
    // overnight-gap case where the trader restarts the app in the morning
    // and the daily job last ran at the previous afternoon's close (only
    // ~16 h ago, but a "new day" by every other measure that matters).
    const oneDay     = new Date(last.getTime() + 24 * 60 * 60 * 1000);
    const nextMid    = nextMidnightAfter(last);
    const threshold  = oneDay < nextMid ? oneDay : nextMid;
    if (now >= threshold) {
      return {
        fire: true,
        reason: `daily-threshold-passed (${threshold.toISOString()})`,
        cadence: 'daily',
      };
    }
    return { fire: false, reason: 'within-daily-cadence', cadence: 'daily' };
  }

  // minutes / hourly — straightforward elapsed check (no boundary concept;
  // these fire many times a day, so calendar-day rollover is irrelevant).
  const ageMs = now.getTime() - last.getTime();
  if (ageMs >= cls.intervalMs) {
    return {
      fire: true,
      reason: `elapsed ${Math.round(ageMs / 1000)}s ≥ ${Math.round(cls.intervalMs / 1000)}s`,
      cadence: cls.cadence,
    };
  }
  return { fire: false, reason: 'within-cadence', cadence: cls.cadence };
}

// Walk every enabled scheduled_jobs row and execute the ones whose cadence
// has lapsed. Serial (not parallel) — most of these jobs hit the same
// upstream providers (Yahoo / Polygon / Alpaca) and the same SQLite handle,
// so parallel kickoff would either rate-limit us or contend on writes.
// `delayMs` is a small spacer between fires to be polite to those providers.
async function runMissedJobsOnStartup({ delayMs = 250, now = new Date() } = {}) {
  let rows;
  try {
    rows = db().prepare('SELECT * FROM scheduled_jobs WHERE enabled = 1').all();
  } catch (e) {
    console.error(`  Scheduler catchup: could not read scheduled_jobs: ${e.message}`);
    return { fired: [], skipped: [], errored: [] };
  }

  const fired = [];
  const skipped = [];
  const errored = [];

  for (const row of rows) {
    const decision = shouldCatchUp(row.last_run_at, row.cron_expression, now);
    if (!decision.fire) {
      skipped.push({ name: row.name, cadence: decision.cadence, reason: decision.reason });
      continue;
    }

    try {
      const job = { ...row, config: JSON.parse(row.config || '{}') };
      console.log(`  Scheduler catchup: ▶ ${row.name} [${decision.cadence}] ${decision.reason}`);
      await executeJob(job);
      fired.push({ name: row.name, cadence: decision.cadence, reason: decision.reason });
    } catch (e) {
      console.error(`  Scheduler catchup: ✗ ${row.name} threw: ${e.message}`);
      errored.push({ name: row.name, error: e.message });
    }

    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  if (fired.length) {
    console.log(`   Scheduler catchup: ✓ fired ${fired.length} missed job(s) [${fired.map(f => f.name).join(', ')}]`);
  } else {
    console.log(`   Scheduler catchup: ✓ no missed jobs (${skipped.length} within cadence)`);
  }
  if (errored.length) {
    console.error(`   Scheduler catchup: ✗ ${errored.length} job(s) errored: ${errored.map(e => e.name).join(', ')}`);
  }

  return { fired, skipped, errored };
}

// ─── Startup ────────────────────────────────────────────────────────────────

function startScheduler() {
  const jobs = db().prepare('SELECT * FROM scheduled_jobs WHERE enabled = 1').all();
  for (const job of jobs) {
    job.config = JSON.parse(job.config || '{}');
    scheduleJob(job);
  }
  console.log(`   Scheduler: ✓ ${jobs.length} job(s) active`);
}

function stopScheduler() {
  for (const [id, task] of activeTasks) {
    task.stop();
  }
  activeTasks.clear();
}

function getSchedulerStatus() {
  const jobs = getAllJobs();
  return {
    running: activeTasks.size,
    totalJobs: jobs.length,
    enabledJobs: jobs.filter(j => j.enabled).length,
    activeTaskIds: [...activeTasks.keys()],
    jobTypes: [...jobHandlers.keys()],
  };
}

module.exports = {
  registerJobType, getJobTypes,
  getAllJobs, getJob, getJobByName, createJob, updateJob, deleteJob, toggleJob,
  executeJob, runJobNow,
  getJobHistory, getRecentHistory, clearHistory,
  startScheduler, stopScheduler, getSchedulerStatus,
  // Catch-up runner (called once at boot from server.js)
  runMissedJobsOnStartup, classifyCadence, shouldCatchUp, cronAllowsDay,
};
