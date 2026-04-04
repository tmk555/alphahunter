// ─── /api/scheduler/* routes ────────────────────────────────────────────────
// Job Scheduler management: CRUD, run-now, history, status
const express = require('express');
const router  = express.Router();

const {
  getAllJobs, getJob, createJob, updateJob, deleteJob, toggleJob,
  runJobNow, getJobTypes, getSchedulerStatus,
  getJobHistory, getRecentHistory, clearHistory,
} = require('../scheduler/engine');

// ─── Status ─────────────────────────────────────────────────────────────────
router.get('/scheduler/status', (req, res) => {
  try {
    res.json(getSchedulerStatus());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Available job types ────────────────────────────────────────────────────
router.get('/scheduler/types', (req, res) => {
  try {
    res.json({ types: getJobTypes() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── List all jobs ──────────────────────────────────────────────────────────
router.get('/scheduler/jobs', (req, res) => {
  try {
    const jobs = getAllJobs();
    res.json({ jobs, count: jobs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get single job ────────────────────────────────────────────────────────
router.get('/scheduler/jobs/:id', (req, res) => {
  try {
    const job = getJob(+req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Create job ─────────────────────────────────────────────────────────────
router.post('/scheduler/jobs', (req, res) => {
  try {
    const { name, description, job_type, cron_expression, config, enabled } = req.body;
    const job = createJob({ name, description, job_type, cron_expression, config, enabled });
    res.status(201).json(job);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Update job ─────────────────────────────────────────────────────────────
router.put('/scheduler/jobs/:id', (req, res) => {
  try {
    const job = updateJob(+req.params.id, req.body);
    res.json(job);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Delete job ─────────────────────────────────────────────────────────────
router.delete('/scheduler/jobs/:id', (req, res) => {
  try {
    deleteJob(+req.params.id);
    res.json({ ok: true, deleted: +req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Toggle enabled/disabled ────────────────────────────────────────────────
router.post('/scheduler/jobs/:id/toggle', (req, res) => {
  try {
    const { enabled } = req.body;
    const job = toggleJob(+req.params.id, enabled !== false);
    res.json(job);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Run job immediately ────────────────────────────────────────────────────
router.post('/scheduler/jobs/:id/run', async (req, res) => {
  try {
    const result = await runJobNow(+req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Job history ────────────────────────────────────────────────────────────
router.get('/scheduler/jobs/:id/history', (req, res) => {
  try {
    const { limit = 25 } = req.query;
    const history = getJobHistory(+req.params.id, +limit);
    res.json({ history, count: history.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── All recent history ─────────────────────────────────────────────────────
router.get('/scheduler/history', (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const history = getRecentHistory(+limit);
    res.json({ history, count: history.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Clear history ──────────────────────────────────────────────────────────
router.delete('/scheduler/history', (req, res) => {
  try {
    const { job_id } = req.query;
    clearHistory(job_id ? +job_id : null);
    res.json({ ok: true, cleared: job_id ? `job ${job_id}` : 'all' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Seed default jobs (convenience endpoint) ───────────────────────────────
router.post('/scheduler/seed', (req, res) => {
  try {
    const defaults = [
      { name: 'Daily RS Scan', description: 'Full universe RS scan at market close', job_type: 'rs_scan', cron_expression: '0 16 * * 1-5', config: { persist: true } },
      { name: 'Stop Monitor', description: 'Check stop alerts every 5 minutes', job_type: 'stop_monitor', cron_expression: '*/5 * * * 1-5', config: { marketHoursOnly: true } },
      { name: 'Expire Stale Orders', description: 'Clean up old staged orders hourly', job_type: 'expire_stale_orders', cron_expression: '0 * * * *', config: { maxAgeHours: 24 } },
      { name: 'Portfolio Reconcile', description: 'Sync trades with broker at close', job_type: 'portfolio_reconcile', cron_expression: '30 16 * * 1-5', config: {} },
      { name: 'RS History Cleanup', description: 'Prune RS snapshots older than 1 year', job_type: 'rs_history_cleanup', cron_expression: '0 2 * * 0', config: { keepDays: 365 } },
      { name: 'Job Log Cleanup', description: 'Prune job history older than 30 days', job_type: 'job_history_cleanup', cron_expression: '0 3 * * 0', config: { keepDays: 30 } },
    ];

    const created = [];
    const skipped = [];
    for (const def of defaults) {
      try {
        const job = createJob(def);
        created.push(job.name);
      } catch (e) {
        if (e.message.includes('UNIQUE')) skipped.push(def.name);
        else throw e;
      }
    }
    res.json({ created, skipped, message: `Seeded ${created.length} jobs, skipped ${skipped.length} existing` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
