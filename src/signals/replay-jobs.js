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

// ─── Persistence ────────────────────────────────────────────────────────
// Pre-fix the job map was 100% in-memory. A server restart mid-sweep
// wiped every running job. From the user's POV: "I clicked Auto-Sweep
// 8 minutes ago, server restarted, badge says 'Job N no longer
// available'." Now we mirror to a SQLite table so:
//   • Done / error / cancelled jobs survive restart (history preserved)
//   • Running jobs get marked 'interrupted' on startup so the UI can
//     show a clear "RESTARTED — click to retry" affordance instead of
//     a generic 404
//   • The id sequence picks up where it left off so no collisions
//
// We don't try to RESUME a running job — the engine state (in-flight
// loops, partial results, etc.) is in JS memory and gone. The job's
// params are persisted, so the UI can offer one-click retry.
let _db = null;
function _ensureDb() {
  if (_db) return _db;
  try {
    const { getDB } = require('../data/database');
    _db = getDB();
    _db.prepare(`
      CREATE TABLE IF NOT EXISTS replay_jobs_state (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        status       TEXT NOT NULL,
        params       TEXT,
        result       TEXT,
        error        TEXT,
        progress     TEXT,
        checkpoint   TEXT,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER
      )
    `).run();
    // Best-effort schema upgrade for existing installs — adds checkpoint
    // column if the table predates this commit. Failures are swallowed
    // (likely 'duplicate column' on already-migrated DBs).
    try { _db.prepare(`ALTER TABLE replay_jobs_state ADD COLUMN checkpoint TEXT`).run(); }
    catch (_) { /* already exists */ }
  } catch (_) { _db = null; }
  return _db;
}

function _persist(job) {
  const db = _ensureDb();
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO replay_jobs_state (id, kind, status, params, result, error, progress, checkpoint, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, result=excluded.result, error=excluded.error,
        progress=excluded.progress, checkpoint=excluded.checkpoint,
        finished_at=excluded.finished_at
    `).run(
      job.id, job.kind, job.status,
      job.params ? JSON.stringify(job.params) : null,
      job.result ? JSON.stringify(job.result) : null,
      job.error || null,
      job.progress ? JSON.stringify(job.progress) : null,
      job.checkpoint ? JSON.stringify(job.checkpoint) : null,
      job.startedAt, job.finishedAt
    );
  } catch (e) {
    if (process.env.DEBUG_REPLAY_JOBS) console.warn('[replay-jobs] persist failed:', e.message);
  }
}

// Called on server boot from server.js. Loads finished jobs into the
// in-memory map (so the UI can fetch their results) and marks any
// 'running' rows as 'interrupted' (the runtime that owned them is gone).
function loadPersistedJobs() {
  const db = _ensureDb();
  if (!db) return { loaded: 0, interrupted: 0 };
  let interrupted = 0;
  try {
    db.prepare(`
      UPDATE replay_jobs_state
         SET status = 'interrupted', finished_at = ?
       WHERE status = 'running'
    `).run(Date.now());
    interrupted = db.prepare(
      `SELECT COUNT(*) AS c FROM replay_jobs_state WHERE status = 'interrupted' AND finished_at >= ?`
    ).get(Date.now() - 5_000)?.c || 0;
    const rows = db.prepare(
      `SELECT * FROM replay_jobs_state WHERE finished_at IS NOT NULL OR status = 'running'
        ORDER BY started_at DESC LIMIT ?`
    ).all(MAX_JOBS);
    for (const r of rows) {
      jobs.set(r.id, {
        id: r.id, kind: r.kind, status: r.status,
        params: r.params ? JSON.parse(r.params) : null,
        result: r.result ? JSON.parse(r.result) : null,
        error: r.error,
        progress: r.progress ? JSON.parse(r.progress) : null,
        checkpoint: r.checkpoint ? JSON.parse(r.checkpoint) : null,
        startedAt: r.started_at, finishedAt: r.finished_at,
      });
      const numericId = +r.id;
      if (Number.isFinite(numericId) && numericId >= nextId) nextId = numericId + 1;
    }
    return { loaded: rows.length, interrupted };
  } catch (e) {
    if (process.env.DEBUG_REPLAY_JOBS) console.warn('[replay-jobs] loadPersistedJobs failed:', e.message);
    return { loaded: 0, interrupted: 0 };
  }
}

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
    // Optional progress object the runner may populate via setProgress()
    // during a long sweep (e.g. { done, total, current, ... }). Polled
    // by the UI to drive the JOB RUNNING badge's live status text.
    progress: null,
  };
  jobs.set(id, job);
  _persist(job);
  // Runner gets a setProgress(obj) helper. Anything passed gets merged
  // into job.progress; null clears it.
  // Persist progress every 10s while the job runs so UI polls hit fresh
  // data even if our setProgress fires faster (per-combo). Reads of the
  // in-memory map are cheap; writes are 10s-throttled to keep DB pressure
  // low during a 2700-combo sweep.
  let lastProgressPersist = 0;
  const setProgress = (obj) => {
    if (obj == null) job.progress = null;
    else job.progress = { ...(job.progress || {}), ...obj, ts: Date.now() };
    if (Date.now() - lastProgressPersist > 10_000) {
      lastProgressPersist = Date.now();
      _persist(job);
    }
  };
  // Checkpoint sink — sweep emits a serializable {queue, results,
  // outperforming, total} blob every N combos. We stash it on the job
  // and persist alongside progress so a crash/restart can resume.
  // Stored separately from `result` (final value) and `progress`
  // (transient UI state) — restoring an interrupted sweep needs the full
  // accumulator.
  job.checkpoint = null;
  const setCheckpoint = (cp) => {
    job.checkpoint = cp;
    // Persist immediately — a checkpoint fires every 25 combos by default
    // (~5-15 seconds), so this isn't hot-path enough to need throttling.
    _persist(job);
  };
  // setImmediate so the caller's response is sent before the work begins —
  // otherwise the POST that creates the job would block on the work and
  // we'd lose the whole point of background execution.
  setImmediate(async () => {
    try {
      // Runner gets both setProgress and setCheckpoint helpers. setProgress
      // drives the badge; setCheckpoint persists the resume blob (sweep
      // only — other kinds ignore it).
      const r = await runFn(setProgress, setCheckpoint, job);
      job.result = r;
      job.status = 'done';
      // Clear checkpoint on success — no need to keep the queue+results
      // accumulator around once we have the final result.
      job.checkpoint = null;
    } catch (e) {
      job.error  = e?.message || String(e);
      job.status = 'error';
      console.error(`[replay-jobs] job ${id} (${kind}) failed:`, e);
    } finally {
      job.finishedAt = Date.now();
      _persist(job);
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
    _persist(j);
  }
  return true;
}

module.exports = { startJob, getJob, listJobs, cancelJob, loadPersistedJobs };
