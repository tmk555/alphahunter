// ─── Tests: seedDefaultJobs idempotency (src/scheduler/jobs.js) ────────────
//
// Verifies that:
//   1. First call inserts all DEFAULT_JOBS rows into scheduled_jobs.
//   2. Second call is a no-op — no duplicates, no errors.
//   3. Partial state (some jobs pre-existing) correctly inserts only the
//      missing ones and reports them in `seeded`.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { seedDefaultJobs, DEFAULT_JOBS } = require('../../src/scheduler/jobs');
const { getDB } = require('../../src/data/database');

function allJobs() {
  return getDB().prepare('SELECT name FROM scheduled_jobs ORDER BY name').all();
}

function clearJobs() {
  getDB().prepare('DELETE FROM scheduled_jobs').run();
}

test('seedDefaultJobs: first call inserts all DEFAULT_JOBS', () => {
  clearJobs();
  const result = seedDefaultJobs();
  assert.equal(result.seeded.length, DEFAULT_JOBS.length);
  assert.equal(result.skipped.length, 0);

  const rows = allJobs();
  assert.equal(rows.length, DEFAULT_JOBS.length);

  // Verify pullback_watch_intraday is present — the core job for Phase 1.2
  const names = new Set(rows.map(r => r.name));
  assert.ok(names.has('pullback_watch_intraday'),
    'pullback_watch_intraday must be seeded on first boot');
  assert.ok(names.has('rs_scan_daily'),
    'rs_scan_daily must be seeded so pullback monitor has snapshot data');
});

test('seedDefaultJobs: second call is a no-op (idempotent)', () => {
  // First seed
  clearJobs();
  const first = seedDefaultJobs();
  assert.equal(first.seeded.length, DEFAULT_JOBS.length);

  // Second seed on same DB — nothing new should be inserted
  const second = seedDefaultJobs();
  assert.equal(second.seeded.length, 0, 'second call must insert nothing');
  assert.equal(second.skipped.length, DEFAULT_JOBS.length);

  const rows = allJobs();
  assert.equal(rows.length, DEFAULT_JOBS.length,
    'row count must not grow after repeat seeding');
});

test('seedDefaultJobs: partial state inserts only missing jobs', () => {
  clearJobs();

  // Pre-insert one of the default jobs manually to simulate a DB that
  // already has it (e.g. a user created it via /api, or a prior partial
  // seed from a different code version).
  getDB().prepare(`
    INSERT INTO scheduled_jobs (name, description, job_type, cron_expression, config, enabled)
    VALUES ('pullback_watch_intraday', 'user-created', 'pullback_watch', '*/5 * * * *', '{}', 1)
  `).run();

  const result = seedDefaultJobs();
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped.includes('pullback_watch_intraday'));
  assert.equal(result.seeded.length, DEFAULT_JOBS.length - 1,
    'should seed every default except the pre-existing one');

  // Verify the pre-existing row was NOT overwritten with our default
  const preserved = getDB()
    .prepare("SELECT description, cron_expression FROM scheduled_jobs WHERE name = 'pullback_watch_intraday'")
    .get();
  assert.equal(preserved.description, 'user-created',
    'existing row must not be clobbered');
  assert.equal(preserved.cron_expression, '*/5 * * * *',
    'existing cron must not be rewritten');
});

test('seedDefaultJobs: every DEFAULT_JOBS entry has a valid shape', () => {
  // Schema sanity — catches typos that would corrupt the jobs table
  for (const j of DEFAULT_JOBS) {
    assert.ok(j.name && typeof j.name === 'string', `name required: ${JSON.stringify(j)}`);
    assert.ok(j.job_type && typeof j.job_type === 'string', `job_type required: ${j.name}`);
    assert.ok(j.cron_expression && typeof j.cron_expression === 'string', `cron_expression required: ${j.name}`);
    assert.ok(j.config && typeof j.config === 'object', `config required: ${j.name}`);
  }
});
