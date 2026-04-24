// ─── /api/scheduler/* routes ────────────────────────────────────────────────
// Job Scheduler management: CRUD, run-now, history, status
const express = require('express');
const router  = express.Router();

const {
  getAllJobs, getJob, createJob, updateJob, deleteJob, toggleJob,
  runJobNow, getJobTypes, getSchedulerStatus,
  getJobHistory, getRecentHistory, clearHistory,
} = require('../scheduler/engine');
const { seedDefaultJobs, DEFAULT_JOBS } = require('../scheduler/jobs');
const { getDB } = require('../data/database');

// Legacy job names that were created by an earlier hard-coded seed list in
// this route. Each maps to the canonical DEFAULT_JOBS job_type that now
// replaces it. When the canonical row exists, the legacy row is a pure
// duplicate and should be removed so the UI isn't cluttered with two rows
// firing the same handler.
//
// Intentionally excluded:
//   • "Stop Monitor" (stop_monitor)       — no canonical replacement
//   • "RS History Cleanup" (rs_history_cleanup) — no canonical replacement
// Those two stay as-is until explicitly promoted into DEFAULT_JOBS.
const LEGACY_TO_CANONICAL = {
  'Daily RS Scan':          'rs_scan',
  'Expire Stale Orders':    'expire_stale_orders',
  'Portfolio Reconcile':    'portfolio_reconcile',
  'Job Log Cleanup':        'job_history_cleanup',
  'equity_snapshot_daily':  'equity_snapshot',  // stale-cron orphan from an older DEFAULT_JOBS
};

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
// Delegates to the canonical seedDefaultJobs() in src/scheduler/jobs.js so the
// UI button and the server-startup seed path share ONE source of truth. Before
// this was consolidated, the UI seed used a 6-row list with legacy PascalCase
// names ("Daily RS Scan") while startup seeded the 24-row DEFAULT_JOBS list
// with snake_case names ("rs_scan_daily"). Clicking "SEED DEFAULTS" therefore
// created duplicate rows firing the same handler on the same schedule.
//
// On each call we also sweep any known legacy-name duplicates whose canonical
// equivalent now exists — that's how an already-polluted DB self-heals when
// the user clicks the button.
router.post('/scheduler/seed', (req, res) => {
  try {
    const { seeded, skipped } = seedDefaultJobs();

    // Sweep legacy duplicates. We only delete a legacy row when at least one
    // canonical row of the same job_type exists — that guarantees we never
    // drop the last scheduler for a given handler.
    const db = getDB();
    const existingTypes = new Set(
      db.prepare('SELECT DISTINCT job_type FROM scheduled_jobs').all().map(r => r.job_type)
    );
    const removedLegacy = [];
    for (const [legacyName, canonicalType] of Object.entries(LEGACY_TO_CANONICAL)) {
      if (!existingTypes.has(canonicalType)) continue;  // safety: canonical missing
      // Verify at least one canonical (non-legacy) row for this type exists.
      const canonicalExists = db.prepare(
        'SELECT 1 FROM scheduled_jobs WHERE job_type = ? AND name != ? LIMIT 1'
      ).get(canonicalType, legacyName);
      if (!canonicalExists) continue;
      try {
        const row = db.prepare('SELECT id FROM scheduled_jobs WHERE name = ?').get(legacyName);
        if (row) {
          deleteJob(row.id);  // use engine's deleteJob so the cron task is also stopped
          removedLegacy.push(legacyName);
        }
      } catch (_) { /* row may have already been removed — ignore */ }
    }

    const msg = [
      `Seeded ${seeded.length}`,
      `skipped ${skipped.length} existing`,
      removedLegacy.length ? `removed ${removedLegacy.length} legacy duplicate(s)` : null,
    ].filter(Boolean).join(', ');

    res.json({
      created: seeded,         // preserve legacy response shape for the UI
      skipped,
      removedLegacy,
      message: msg,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
