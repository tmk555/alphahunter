// ─── Job Scheduler Engine (Tier 5) ──────────────────────────────────────────
// Manages cron-based scheduled jobs with persistence, history, and built-in job types
const cron = require('node-cron');
const { getDB } = require('../data/database');

function db() { return getDB(); }

// Active cron tasks keyed by job id
const activeTasks = new Map();

// Registry of built-in job type handlers
const jobHandlers = new Map();

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
};
