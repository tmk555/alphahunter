// ─── Replay Worker — runs heavy replay jobs off the main thread ────────────
//
// Why this exists: the replay engine (runReplay, runSweep, runWalkForward,
// runMonteCarlo) is fully synchronous CPU. Even with the per-combo yields
// shipped earlier, a single combo can take 200–800ms; a sweep runs hundreds
// of combos. The main thread runs Express route handlers, node-cron, the
// browser's HTTP polls. Result: while a sweep is in flight every other UI
// tab takes seconds to load, sometimes hangs. Hard problem to solve in
// JavaScript without parallelism.
//
// Worker threads are the textbook fix. The OS scheduler runs the worker on
// a separate thread, so the main event loop stays responsive even during
// the heaviest sweep. Each worker has its own V8 isolate, its own
// better-sqlite3 connection (WAL mode allows concurrent readers without
// contention), and communicates with the main thread via structured-clone
// postMessage.
//
// Protocol (parent → worker via workerData):
//   { kind: 'sweep' | 'walk-forward' | 'run' | 'compare' | 'monte-carlo',
//     params: { ... } /* engine-specific opts */ }
//
// Protocol (worker → parent via postMessage):
//   { type: 'progress', progress: { done, total, outperforming, current, ... } }
//   { type: 'done',     result:   <engine return value> }
//   { type: 'error',    error:    string }
//
// Cancellation: parent calls worker.terminate() (in cancelJob). Worker
// is killed forcibly — no clean shutdown needed because all engine state
// is in JS memory and discarded with the thread.

const { parentPort, workerData } = require('worker_threads');

if (!parentPort) {
  // Not running as a worker — refuse to execute. (Defends against someone
  // requiring this file directly via the engine path.)
  throw new Error('replay-worker.js can only be run as a worker_threads Worker');
}

const { kind, params } = workerData || {};

async function main() {
  // Lazy require so the module is loaded INSIDE the worker isolate, not
  // accidentally pulled into the main thread's bundle when someone
  // requires('./replay-worker').
  const {
    runReplay, runWalkForward, runMonteCarlo, compareStrategies,
  } = require('./replay');
  const { runSweep } = require('./replay-sweep');

  // Forward engine progress to the parent thread. The engine fires this on
  // every combo (sweep) or window (walk-forward); main thread updates
  // job.progress so the JOB RUNNING badge stays live.
  const onProgress = (p) => {
    try { parentPort.postMessage({ type: 'progress', progress: p }); }
    catch (_) { /* parent gone — terminate path */ }
  };

  switch (kind) {
    case 'sweep':
      return runSweep({ ...params, onProgress });
    case 'walk-forward':
      return runWalkForward(params);
    case 'monte-carlo':
      return runMonteCarlo(params);
    case 'compare':
      return compareStrategies(params);
    case 'run':
      return runReplay(params);
    default:
      throw new Error(`replay-worker: unknown kind "${kind}"`);
  }
}

main()
  .then(result => {
    parentPort.postMessage({ type: 'done', result });
  })
  .catch(err => {
    parentPort.postMessage({
      type: 'error',
      error: err?.message || String(err),
      stack: err?.stack || null,
    });
  });
