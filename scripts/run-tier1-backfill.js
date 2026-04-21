// Tier 1 historical backfill: populate the three empty/sparse factor tables
// that deep_scan's composite ranker depends on, using ONLY data we already
// have (price+volume + rs_snapshots). No paid feeds, no external scrapes.
//
//   1. institutional_flow     — accum/dist/power days, flow_score, net_flow
//   2. pattern_detections     — extend back from 2019-09 to 2016
//   3. breadth_snapshots      — extend back from 2020-10 to 2016
//
// Sequential (not parallel) — inst+patterns both walk 358×~2500 bar slices,
// and running them concurrently would just thrash the disk/CPU. Breadth is
// cheap (reads pre-computed rs_snapshots) so it goes last.
//
// Logs to stdout; redirect to /tmp/ah-tier1.log when running in background.

require('dotenv').config();

const { runInstitutionalBackfill } = require('../src/signals/backfillInstitutional');
const { runPatternBackfill }       = require('../src/signals/backfillPatterns');
const { backfillBreadthHistory }   = require('../src/signals/breadth');
const { FULL_UNIVERSE }            = require('../universe');

const symbols = Object.keys(FULL_UNIVERSE);

// Match the 2500-day price backfill window — deep_scan replay goes back to
// 2016-10, so compute factors for the same range.
const LOOKBACK_DAYS = 2500;

function banner(title) {
  const line = '═'.repeat(title.length + 8);
  console.log(`\n${line}\n═══ ${title} ═══\n${line}`);
}

function progressLogger(stage) {
  return (p) => {
    if (!p || p.total == null) return;
    const step = p.stage === 'fetch' ? 25 : 100;
    if (p.current === 0 || p.current === p.total || p.current % step === 0) {
      const pct = ((p.current / p.total) * 100).toFixed(1);
      console.log(`[${stage}:${p.stage || '?'}] ${p.current}/${p.total} (${pct}%) ${p.message || ''}`);
    }
  };
}

(async () => {
  const t0 = Date.now();

  // ─── 1. institutional_flow ─────────────────────────────────────────────
  banner('STEP 1/3  institutional_flow backfill');
  console.log(`target: ${symbols.length} symbols × ${LOOKBACK_DAYS}d lookback`);
  const t1 = Date.now();
  const inst = await runInstitutionalBackfill({
    symbols,
    lookbackDays: LOOKBACK_DAYS,
    concurrency: 5,
    onProgress: progressLogger('inst'),
  });
  console.log('\n[inst] summary:', JSON.stringify({
    ...inst, durationMin: ((Date.now() - t1) / 60000).toFixed(1),
  }, null, 2));

  // ─── 2. pattern_detections ─────────────────────────────────────────────
  banner('STEP 2/3  pattern_detections backfill');
  console.log(`target: ${symbols.length} symbols × ${LOOKBACK_DAYS}d lookback`);
  const t2 = Date.now();
  const pat = await runPatternBackfill({
    symbols,
    lookbackDays: LOOKBACK_DAYS,
    concurrency: 5,
    onProgress: progressLogger('pat'),
  });
  console.log('\n[pat] summary:', JSON.stringify({
    ...pat, durationMin: ((Date.now() - t2) / 60000).toFixed(1),
  }, null, 2));

  // ─── 3. breadth_snapshots ──────────────────────────────────────────────
  banner('STEP 3/3  breadth_snapshots backfill');
  const t3 = Date.now();
  const breadth = backfillBreadthHistory();   // sync; walks rs_snapshots
  console.log('[breadth] summary:', JSON.stringify({
    ...breadth, durationSec: ((Date.now() - t3) / 1000).toFixed(1),
  }, null, 2));

  banner('TIER 1 COMPLETE');
  console.log(`total: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
})().catch(e => {
  console.error('TIER1 FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
