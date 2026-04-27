// ─── Replay Background Job Store ─────────────────────────────────────────
// In-memory job tracker for long-running replay-tab calls (run / compare /
// walk-forward / monte-carlo).
//
// Why this exists: a Compare All on a 10-year window can take 90+ seconds.
// A Walk-Forward sweep with a 256-combo grid can take many minutes. Holding
// the user's HTTP fetch open for that long means:
//   • Browser tab switch / sleep → fetch is paused or aborted (Safari)
//   • Refresh → progress lost
//   • Network hiccup → "Fetch is aborted" with no recovery
//
// The fix: caller POSTs the job, gets back a {jobId} immediately, and polls
// (2s interval). The actual work runs detached on the server. Even if the
// user navigates away and comes back, they can re-fetch the job by ID and
// pick up the result. Persist the jobId in localStorage on the UI side and
// page reloads also recover.
//
// Lifecycle:
//   running → done | error
// Jobs older than `MAX_AGE_MS` are pruned on every read so the map can't
// grow unbounded. Server restart clears everything (fresh map) — the UI
// handles 404 by showing a "job not found, try again" toast.

const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 24h
const MAX_JOBS   = 200;                   // hard cap on retained jobs

const jobs = new Map();
let nextId = 1;

function _prune() {
  const now = Date.now();
  // Drop anything older than MAX_AGE_MS first.
  for (const [id, j] of jobs) {
    if (j.finishedAt && (now - j.finishedAt) > MAX_AGE_MS) jobs.delete(id);
  }
  // Then enforce the hard cap by dropping oldest finished jobs.
  if (jobs.size > MAX_JOBS) {
    const finished = [...jobs.values()]
      .filter(j => j.finishedAt)
      .sort((a, b) => a.finishedAt - b.finishedAt);
    const toDrop = jobs.size - MAX_JOBS;
    for (let i = 0; i < toDrop && i < finished.length; i++) {
      jobs.delete(finished[i].id);
    }
  }
}

/**
 * Start a new background job.
 *
 * @param {string} kind   — 'run' | 'compare' | 'walk-forward' | 'monte-carlo'
 * @param {object} params — opaque, echoed back in the job record
 * @param {function} runFn — async function returning the result
 * @returns {object} the job record (status: 'running')
 */
function startJob(kind, params, runFn) {
  _prune();
  const id = String(nextId++);
  const job = {
    id,
    kind,
    status: 'running',
    params,
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  // setImmediate so the caller's response is sent before the work begins —
  // otherwise the POST that creates the job would block on the work and
  // we'd lose the whole point of background execution.
  setImmediate(async () => {
    try {
      const r = await runFn();
      job.result = r;
      job.status = 'done';
    } catch (e) {
      job.error  = e?.message || String(e);
      job.status = 'error';
      // Stack trace to server log only — too noisy to ship over the wire.
      console.error(`[replay-jobs] job ${id} (${kind}) failed:`, e);
    } finally {
      job.finishedAt = Date.now();
    }
  });
  return job;
}

function getJob(id) {
  _prune();
  return jobs.get(String(id)) || null;
}

function listJobs(limit = 20) {
  _prune();
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map(j => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      // Don't include `result` in list view — can be MB-sized.
      error: j.error,
    }));
}

/**
 * Cancel hint — best-effort. We can't actually cancel an in-flight
 * synchronous engine call (the engine doesn't take an AbortSignal), so we
 * just mark the job and let the result be discarded when it finishes.
 * Useful so the UI can stop polling and free its job slot.
 */
function cancelJob(id) {
  const j = jobs.get(String(id));
  if (!j) return false;
  if (j.status === 'running') {
    j.status = 'cancelled';
    j.finishedAt = Date.now();
  }
  return true;
}

module.exports = { startJob, getJob, listJobs, cancelJob };
