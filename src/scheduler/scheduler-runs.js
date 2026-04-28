// ─── Scheduler Run Tracker ─────────────────────────────────────────────────
//
// Background tracker for "Run All / Run Group" multi-job invocations from the
// Settings → Job Scheduler UI. Pattern mirrors src/signals/replay-jobs.js:
// an in-memory map of runs, started detached via setImmediate so the POST
// returns instantly, with progress polled by the client.
//
// Why this exists: previously the Settings UI fired N sequential fetches
// (one per job in the group) from the React component. Navigating away
// unmounted the component, the visual "running" badge disappeared, and even
// though the in-flight HTTPs kept going, the user had no way to come back
// and see "still in progress on job 4 of 8". Now the iteration runs
// server-side; the UI just polls a single run id.
//
// Each run holds:
//   id, label, jobIds[], status, startedAt, finishedAt, current?, total,
//   done, failed, results: [{ jobId, name, ok, error?, durationMs, ranAt }]
//
// `cancelRequested` is a soft cancel flag the loop checks between jobs —
// we can't actually abort an in-flight `runJobNow()` (the engine handlers
// don't take an AbortSignal), so cancel just stops further iteration.

const { runJobNow } = require('./engine');
const { getDB } = require('../data/database');
function db() { return getDB(); }

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS   = 50;

const runs = new Map();
let nextId = 1;

function _prune() {
  const now = Date.now();
  for (const [id, r] of runs) {
    if (r.finishedAt && (now - r.finishedAt) > MAX_AGE_MS) runs.delete(id);
  }
  if (runs.size > MAX_RUNS) {
    const finished = [...runs.values()].filter(r => r.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
    const toDrop = runs.size - MAX_RUNS;
    for (let i = 0; i < toDrop && i < finished.length; i++) runs.delete(finished[i].id);
  }
}

/**
 * Start a multi-job run.
 *
 * @param {object} opts
 * @param {number[]} opts.jobIds - scheduler job ids to run, sequentially
 * @param {string} [opts.label] - human-readable group label (e.g. 'Daily Scans')
 * @returns {object} the run record (status: 'running')
 */
function startRun({ jobIds, label = 'Custom group' } = {}) {
  if (!Array.isArray(jobIds) || !jobIds.length) {
    throw new Error('jobIds[] required');
  }
  _prune();
  const id = String(nextId++);

  // Resolve job names up-front so the UI can show "Running rs_scan_daily"
  // even if the row is later renamed. Falls back to the bare id when the
  // row is missing (caller passed a stale id).
  const nameById = new Map();
  try {
    const placeholders = jobIds.map(() => '?').join(',');
    const rows = db().prepare(`SELECT id, name FROM scheduled_jobs WHERE id IN (${placeholders})`).all(...jobIds);
    for (const r of rows) nameById.set(r.id, r.name);
  } catch (_) { /* fail-soft — name lookup is decorative */ }

  const run = {
    id,
    label,
    jobIds: jobIds.slice(),
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    current: null,    // {jobId, name, startedAt} while a job is running
    total: jobIds.length,
    done: 0,
    failed: 0,
    cancelRequested: false,
    results: [],      // [{jobId, name, ok, error?, durationMs, ranAt}]
  };
  runs.set(id, run);

  // Detached server-side iteration. setImmediate so the POST that creates
  // the run returns ~instantly with the run id.
  setImmediate(async () => {
    for (const jobId of jobIds) {
      if (run.cancelRequested) break;
      const name = nameById.get(jobId) || `job#${jobId}`;
      run.current = { jobId, name, startedAt: Date.now() };
      const t0 = Date.now();
      let ok = true, error = null, result = null;
      try {
        result = await runJobNow(jobId);
        if (result?.error) { ok = false; error = String(result.error); }
      } catch (e) {
        ok = false;
        error = e?.message || String(e);
      }
      const durationMs = Date.now() - t0;
      run.results.push({ jobId, name, ok, error, durationMs, ranAt: Date.now() });
      if (ok) run.done++;
      else    run.failed++;
      run.current = null;
    }
    run.status = run.cancelRequested ? 'cancelled' : (run.failed === 0 ? 'done' : 'completed_with_errors');
    run.finishedAt = Date.now();
  });

  return run;
}

function getRun(id) {
  _prune();
  return runs.get(String(id)) || null;
}

function listRuns(limit = 20) {
  _prune();
  return [...runs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map(r => ({
      id: r.id,
      label: r.label,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      total: r.total,
      done: r.done,
      failed: r.failed,
    }));
}

/** Soft cancel — the in-flight job finishes, then the loop stops. */
function cancelRun(id) {
  const r = runs.get(String(id));
  if (!r) return false;
  if (r.status === 'running') r.cancelRequested = true;
  return true;
}

module.exports = { startRun, getRun, listRuns, cancelRun };
