// ─── /api/replay/* routes ───────────────────────────────────────────────────
// Signal replay / backtest engine
const express = require('express');
const router  = express.Router();

const {
  BUILT_IN_STRATEGIES,
  getAvailableDateRange,
  runReplay,
  runWalkForward,
  runMonteCarlo,
  compareStrategies,
  getReplayHistory,
  getReplayResult,
  deleteReplayResult,
  saveMCResult,
  getMCHistory,
  getMCResult,
  saveWFResult,
  getWFHistory,
  getWFResult,
} = require('../signals/replay');
const { runBackfill } = require('../signals/backfill');
const { runInstitutionalBackfill } = require('../signals/backfillInstitutional');
const { runEarningsDriftBackfill } = require('../signals/backfillEarningsDrift');
const { runRevisionsBackfill } = require('../signals/backfillRevisions');
const { startJob, getJob, listJobs, cancelJob } = require('../signals/replay-jobs');
const { runSweep, previewSweep, STRATEGY_GRIDS, DEFAULT_SHORT_TERM_RATE, DEFAULT_LONG_TERM_RATE } = require('../signals/replay-sweep');
const { FULL_UNIVERSE } = require('../../universe');

// ─── Available strategies ─────────────────────────────────────────────────
router.get('/replay/strategies', (req, res) => {
  try {
    const strategies = Object.entries(BUILT_IN_STRATEGIES).map(([key, s]) => ({
      key, ...s,
    }));
    res.json({ strategies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Available data range ─────────────────────────────────────────────────
router.get('/replay/range', (req, res) => {
  try {
    res.json(getAvailableDateRange());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Run replay ───────────────────────────────────────────────────────────
router.post('/replay/run', (req, res) => {
  try {
    const { strategy, tradeMode, params, startDate, endDate, maxPositions, initialCapital, execution, indexName } = req.body;
    if (!strategy || !startDate || !endDate) {
      return res.status(400).json({ error: 'strategy, startDate, and endDate required' });
    }
    const result = runReplay({
      strategy, tradeMode: tradeMode || undefined, params, startDate, endDate,
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
      execution: execution || {},
      indexName: indexName || 'SP500',
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Compare strategies ───────────────────────────────────────────────────
router.post('/replay/compare', (req, res) => {
  try {
    const { strategies, startDate, endDate, maxPositions, initialCapital, tradeMode } = req.body;
    if (!strategies || !startDate || !endDate) {
      return res.status(400).json({ error: 'strategies[], startDate, and endDate required' });
    }
    const result = compareStrategies({
      strategies, startDate, endDate, tradeMode: tradeMode || undefined,
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Walk-forward optimization ────────────────────────────────────────────
router.post('/replay/walk-forward', async (req, res) => {
  try {
    const {
      strategy, tradeMode, startDate, endDate,
      trainDays, testDays, paramGrid,
      optimizeMetric, maxPositions, initialCapital, execution,
    } = req.body;
    if (!strategy || !startDate || !endDate) {
      return res.status(400).json({ error: 'strategy, startDate, and endDate required' });
    }
    if (!paramGrid || typeof paramGrid !== 'object') {
      return res.status(400).json({ error: 'paramGrid object required (e.g. { minRS: [70,80,90] })' });
    }
    const result = await runWalkForward({
      strategy, tradeMode: tradeMode || undefined,
      startDate, endDate,
      trainDays: trainDays || 120,
      testDays: testDays || 60,
      paramGrid,
      optimizeMetric: optimizeMetric || 'sharpeRatio',
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
      execution: execution || {},
    });
    // Persist WF result
    try {
      result.config = { ...result.config, startDate, endDate };
      const wfId = saveWFResult(result);
      result.id = wfId;
    } catch (_) { /* non-critical */ }
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Monte Carlo simulation ───────────────────────────────────────────────
router.post('/replay/monte-carlo', (req, res) => {
  try {
    const { replayId, trades, iterations, method, positionFraction, initialCapital } = req.body;
    if (replayId == null && (!trades || !trades.length)) {
      return res.status(400).json({ error: 'replayId or trades[] required' });
    }
    const result = runMonteCarlo({
      replayId: replayId != null ? +replayId : null,
      trades: trades || null,
      iterations: iterations || 1000,
      method: method || 'permutation',
      positionFraction: positionFraction != null ? +positionFraction : 0.10,
      initialCapital: initialCapital || 100000,
    });
    // Persist MC result
    try {
      const mcId = saveMCResult(replayId, result);
      result.id = mcId;
    } catch (_) { /* non-critical */ }
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Historical snapshot backfill ─────────────────────────────────────────
// Walks the past N trading days using each universe symbol's 1-year OHLCV
// from the provider layer, recomputes the full signal stack, and persists
// to rs_snapshots so the replay/walk-forward/monte-carlo engines can run on
// real historical data instead of just today's tail.
router.post('/replay/backfill', async (req, res) => {
  try {
    const { lookbackDays = 365, symbols, concurrency = 5 } = req.body || {};
    const useSymbols = Array.isArray(symbols) && symbols.length
      ? symbols
      : Object.keys(FULL_UNIVERSE);
    if (!useSymbols.length) {
      return res.status(400).json({ error: 'no symbols available — provide symbols[] or populate universe' });
    }
    if (lookbackDays < 1 || lookbackDays > 2500) {
      return res.status(400).json({ error: 'lookbackDays must be between 1 and 2500 (Alpaca: ~9 years / Yahoo: 2 years)' });
    }
    const summary = await runBackfill({
      symbols: useSymbols,
      lookbackDays: +lookbackDays,
      concurrency: +concurrency || 5,
    });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── institutional_flow backfill ─────────────────────────────────────────
// Same shape as /replay/backfill but targets the institutional_flow table.
// Runs detectUnusualVolume + detectDarkPoolProxy on truncated bar slices so
// every (symbol, date) in the lookback window gets a flow score the deep_scan
// replay strategy can JOIN against.
router.post('/replay/backfill-institutional', async (req, res) => {
  try {
    const { lookbackDays = 252, symbols, concurrency = 5 } = req.body || {};
    const useSymbols = Array.isArray(symbols) && symbols.length
      ? symbols
      : Object.keys(FULL_UNIVERSE);
    if (!useSymbols.length) {
      return res.status(400).json({ error: 'no symbols available — provide symbols[] or populate universe' });
    }
    if (lookbackDays < 1 || lookbackDays > 2500) {
      return res.status(400).json({ error: 'lookbackDays must be between 1 and 2500' });
    }
    const summary = await runInstitutionalBackfill({
      symbols: useSymbols,
      lookbackDays: +lookbackDays,
      concurrency: +concurrency || 5,
    });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── earnings_drift_snapshots backfill ────────────────────────────────────
// Walks each universe symbol's bars, re-runs calcEarningsDrift for every
// historical date (using the "biggest gap in last 30 bars" fallback since
// historical earnings timestamps aren't captured), and persists the score.
router.post('/replay/backfill-earnings-drift', async (req, res) => {
  try {
    const { lookbackDays = 252, symbols, concurrency = 5 } = req.body || {};
    const useSymbols = Array.isArray(symbols) && symbols.length
      ? symbols
      : Object.keys(FULL_UNIVERSE);
    if (!useSymbols.length) {
      return res.status(400).json({ error: 'no symbols available — provide symbols[] or populate universe' });
    }
    if (lookbackDays < 1 || lookbackDays > 2500) {
      return res.status(400).json({ error: 'lookbackDays must be between 1 and 2500' });
    }
    const summary = await runEarningsDriftBackfill({
      symbols: useSymbols,
      lookbackDays: +lookbackDays,
      concurrency: +concurrency || 5,
    });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── revision_scores backfill ────────────────────────────────────────────
// Uses Yahoo's earningsTrend.epsTrend 5-anchor history (current/7/30/60/90d)
// to reconstruct 4 real revision-score transitions per symbol. Expensive:
// one Yahoo call per symbol, so prefer a trimmed top-RS list rather than the
// full universe.
router.post('/replay/backfill-revisions', async (req, res) => {
  try {
    const { symbols, concurrency = 3 } = req.body || {};
    const useSymbols = Array.isArray(symbols) && symbols.length
      ? symbols
      : Object.keys(FULL_UNIVERSE);
    if (!useSymbols.length) {
      return res.status(400).json({ error: 'no symbols available — provide symbols[] or populate universe' });
    }
    const summary = await runRevisionsBackfill({
      symbols: useSymbols,
      concurrency: +concurrency || 3,
    });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Replay history ───────────────────────────────────────────────────────
router.get('/replay/history', (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const history = getReplayHistory(+limit);
    res.json({ history, count: history.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Monte Carlo history & view (before :id catch-all) ──────────────────
router.get('/replay/mc/history', (req, res) => {
  try {
    const { limit = 10 } = req.query;
    res.json({ history: getMCHistory(+limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/replay/mc/:id', (req, res) => {
  try {
    const result = getMCResult(+req.params.id);
    if (!result) return res.status(404).json({ error: 'MC result not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Background-job control surface ──────────────────────────────────────
// POST /replay/jobs        body: { kind, body }   → 202 + { jobId, status }
// GET  /replay/jobs/:id                            → full job state
// GET  /replay/jobs                                → recent jobs list
// DELETE /replay/jobs/:id                          → cancel hint
//
// `kind` selects which engine call to run; `body` is the same shape that
// kind's synchronous endpoint would take. The synchronous endpoints
// (/replay/run, /replay/compare, /replay/walk-forward, /replay/monte-carlo)
// remain available for scripts/tests that prefer the simpler request/response
// model. The UI uses the job model so backtests survive tab switches and
// page reloads.

const JOB_KINDS = {
  run: (body) => {
    const { strategy, tradeMode, params, startDate, endDate, maxPositions, initialCapital, execution, indexName } = body || {};
    if (!strategy || !startDate || !endDate) throw new Error('strategy, startDate, and endDate required');
    return runReplay({
      strategy, tradeMode: tradeMode || undefined, params, startDate, endDate,
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
      execution: execution || {},
      indexName: indexName || 'SP500',
    });
  },
  compare: (body) => {
    const { strategies, startDate, endDate, maxPositions, initialCapital, tradeMode } = body || {};
    if (!strategies || !startDate || !endDate) throw new Error('strategies[], startDate, and endDate required');
    return compareStrategies({
      strategies, startDate, endDate, tradeMode: tradeMode || undefined,
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
    });
  },
  'walk-forward': async (body) => {
    const { strategy, tradeMode, startDate, endDate, trainDays, testDays, paramGrid, optimizeMetric, maxPositions, initialCapital, execution } = body || {};
    if (!strategy || !startDate || !endDate) throw new Error('strategy, startDate, and endDate required');
    if (!paramGrid || typeof paramGrid !== 'object') throw new Error('paramGrid object required');
    const result = await runWalkForward({
      strategy, tradeMode: tradeMode || undefined,
      startDate, endDate,
      trainDays: trainDays || 120, testDays: testDays || 60,
      paramGrid, optimizeMetric: optimizeMetric || 'sharpeRatio',
      maxPositions: maxPositions || 10,
      initialCapital: initialCapital || 100000,
      execution: execution || {},
    });
    try {
      result.config = { ...result.config, startDate, endDate };
      result.id = saveWFResult(result);
    } catch (_) {}
    return result;
  },
  'monte-carlo': (body) => {
    const { replayId, trades, iterations, method, positionFraction, initialCapital } = body || {};
    if (replayId == null && (!trades || !trades.length)) throw new Error('replayId or trades[] required');
    const result = runMonteCarlo({
      replayId: replayId != null ? +replayId : null,
      trades: trades || null,
      iterations: iterations || 1000,
      method: method || 'permutation',
      positionFraction: positionFraction != null ? +positionFraction : 0.10,
      initialCapital: initialCapital || 100000,
    });
    try { result.id = saveMCResult(replayId, result); } catch (_) {}
    return result;
  },
  // Auto-Sweep — exhaustive per-strategy combo evaluation with after-tax
  // alpha vs SPY long-term hold as the primary sort key. Long-running
  // (~5-15 min depending on date range and whether WF/MC deep-dive is
  // enabled). Runs in a Worker thread so the main event loop stays
  // responsive — without this, every other UI tab took seconds to load
  // while a sweep was in flight, and node-cron missed scheduled ticks.
  sweep: (body, setProgress, setCheckpoint, jobRecord) => {
    const {
      strategies, startDate, endDate,
      maxPositions, initialCapital, execution,
      taxRates, topK, runWalkForward: doWF, runMonteCarlo: doMC,
      mcIterations, randomSamples, slippageSweep,
    } = body || {};
    if (!startDate || !endDate) throw new Error('startDate and endDate required');
    // Resume support: if the caller passed a checkpoint (via the
    // /resume route), feed it through to the worker so the engine
    // skips already-evaluated combos and continues at queue[done+1].
    const resumeFrom = body?._resumeFrom || jobRecord?.checkpoint || null;
    return runInWorker('sweep', {
      strategies: strategies && strategies.length ? strategies : Object.keys(STRATEGY_GRIDS),
      startDate, endDate,
      maxPositions: maxPositions || 5,
      initialCapital: initialCapital || 100_000,
      execution: execution || {},
      taxRates: {
        short: (taxRates?.short ?? DEFAULT_SHORT_TERM_RATE),
        long:  (taxRates?.long  ?? DEFAULT_LONG_TERM_RATE),
      },
      topK: topK || 10,
      runWalkForward: !!doWF,
      runMonteCarlo:  !!doMC,
      mcIterations:   +mcIterations  || 1000,
      randomSamples:  +randomSamples || 0,
      slippageSweep:  !!slippageSweep,
      resumeFrom,
    }, setProgress, setCheckpoint);
  },
};

// ── Worker-thread runner ───────────────────────────────────────────────────
// Spawns src/signals/replay-worker.js, forwards engine progress to the
// caller's setProgress, resolves with the worker's final result. Live for
// the duration of one engine run; the OS scheduler runs it on a separate
// thread so the main event loop stays responsive even during a 30-minute
// sweep. Cancellation: cancelJob can store/retrieve the Worker via the
// job record's `_worker` field and call .terminate() — TODO once we wire
// that into the cancel path.
const { Worker } = require('worker_threads');
const path = require('path');
function runInWorker(kind, params, setProgress, setCheckpoint) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.join(__dirname, '..', 'signals', 'replay-worker.js'),
      { workerData: { kind, params } }
    );
    worker.on('message', msg => {
      if (msg.type === 'progress') {
        setProgress?.(msg.progress);
      } else if (msg.type === 'checkpoint') {
        setCheckpoint?.(msg.checkpoint);
      } else if (msg.type === 'done') {
        resolve(msg.result);
      } else if (msg.type === 'error') {
        reject(new Error(msg.error));
      }
    });
    worker.on('error', err => reject(err));
    worker.on('exit', code => {
      // If the worker exited without a 'done' or 'error' message and we
      // haven't resolved yet, treat as a crash.
      if (code !== 0) reject(new Error(`replay-worker exited with code ${code}`));
    });
  });
}

router.post('/replay/jobs', (req, res) => {
  try {
    const { kind, body } = req.body || {};
    if (!kind || !JOB_KINDS[kind]) {
      return res.status(400).json({ error: `kind must be one of: ${Object.keys(JOB_KINDS).join(', ')}` });
    }
    const runner = JOB_KINDS[kind];
    // The runner gets setProgress + setCheckpoint (sweep uses both, others
    // ignore the extras) and the live job record (so handlers can read
    // job.checkpoint when resuming).
    const job = startJob(kind, body || {},
      (setProgress, setCheckpoint, jobRecord) =>
        runner(body || {}, setProgress, setCheckpoint, jobRecord)
    );
    res.status(202).json({ id: job.id, kind: job.kind, status: job.status, startedAt: job.startedAt });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Resume an interrupted sweep from its last checkpoint. The new job is
// started with status='running', original params PLUS the persisted
// checkpoint blob (queue + partial results), and continues the engine
// loop at the next un-evaluated combo. The original interrupted row
// stays as historical breadcrumb (status='interrupted').
router.post('/replay/jobs/:id/resume', (req, res) => {
  try {
    const old = getJob(req.params.id);
    if (!old) return res.status(404).json({ error: 'Job not found' });
    if (old.status !== 'interrupted') {
      return res.status(400).json({ error: `Cannot resume job in status '${old.status}' (only 'interrupted')` });
    }
    if (old.kind !== 'sweep') {
      return res.status(400).json({ error: `Resume only supported for kind='sweep' (got '${old.kind}')` });
    }
    if (!old.checkpoint || !Array.isArray(old.checkpoint.queue)) {
      return res.status(400).json({ error: 'No checkpoint available to resume from (job interrupted before first checkpoint tick)' });
    }
    const runner = JOB_KINDS.sweep;
    const body = { ...(old.params || {}), _resumeFrom: old.checkpoint };
    const job = startJob('sweep', body,
      (setProgress, setCheckpoint, jobRecord) =>
        runner(body, setProgress, setCheckpoint, jobRecord)
    );
    res.status(202).json({
      id: job.id, kind: job.kind, status: job.status, startedAt: job.startedAt,
      resumedFrom: old.id, resumedAt: old.checkpoint.results?.length || 0,
      total: old.checkpoint.total || 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/replay/jobs', (req, res) => {
  try {
    const { limit = 20 } = req.query;
    res.json({ jobs: listJobs(+limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/replay/jobs/:id', (req, res) => {
  try {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found (server may have restarted, or job pruned)' });
    res.json(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/replay/jobs/:id', (req, res) => {
  try {
    const ok = cancelJob(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true, cancelled: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sweep coverage preview — cheap (no engine calls) so the UI can show
// "1,350 combos · ~9 min" before the user clicks START.
router.post('/replay/sweep/preview', (req, res) => {
  try {
    const { strategies, slippageSweep, randomSamples } = req.body || {};
    res.json(previewSweep({
      strategies: strategies && strategies.length ? strategies : Object.keys(STRATEGY_GRIDS),
      slippageSweep: !!slippageSweep,
      randomSamples: +randomSamples || 0,
    }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Walk-Forward history & view ─────────────────────────────────────────
router.get('/replay/wf/history', (req, res) => {
  try {
    const { limit = 10 } = req.query;
    res.json({ history: getWFHistory(+limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/replay/wf/:id', (req, res) => {
  try {
    const result = getWFResult(+req.params.id);
    if (!result) return res.status(404).json({ error: 'WF result not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a WF result. UI's REPLAY-history table grew unbounded before this
// because there was no way to prune from the dashboard.
router.delete('/replay/wf/:id', (req, res) => {
  try {
    const { deleteWFResult } = require('../signals/replay');
    deleteWFResult(+req.params.id);
    res.json({ ok: true, deleted: +req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/replay/mc/:id', (req, res) => {
  try {
    const { deleteMCResult } = require('../signals/replay');
    deleteMCResult(+req.params.id);
    res.json({ ok: true, deleted: +req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get specific replay result ───────────────────────────────────────────
router.get('/replay/:id', (req, res) => {
  try {
    const result = getReplayResult(+req.params.id);
    if (!result) return res.status(404).json({ error: 'Replay not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Delete replay result ─────────────────────────────────────────────────
router.delete('/replay/:id', (req, res) => {
  try {
    deleteReplayResult(+req.params.id);
    res.json({ ok: true, deleted: +req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
