// ─── Edge Telemetry — Layer 1 ────────────────────────────────────────────────
// Every signal the app emits (LLM-generated trade brief, staged order,
// pullback alert, etc.) is logged here with its reference context. The
// nightly closer (edge-closer.js) resolves each row's forward outcome so
// calibration.js can answer: "Does confidence:high actually outperform
// confidence:low? Is strategy X still working?"
//
// This is the one module that must NEVER throw from its public API — signal
// emission paths (tradeSetups, staging) call logSignal() in non-critical
// try/catch blocks; a telemetry failure must not block a real trade decision.

const { getDB } = require('../data/database');

function db() { return getDB(); }

function marketDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Map qualitative confidence strings to the [0,1] probability needed for
// Brier scoring. We calibrate these against realized hit rate in calibration.js
// — if 'high' empirically hits 52% instead of 75%, the Brier score surfaces
// the miscalibration. Numbers here are priors, not truth.
const CONFIDENCE_PROB = { high: 0.75, medium: 0.50, low: 0.25 };

function confidenceToProb(confidence) {
  if (confidence == null) return null;
  const key = String(confidence).toLowerCase().trim();
  return CONFIDENCE_PROB[key] ?? null;
}

// Parse a price string like "$185.50" or "$180-$185" → number.
// Setup objects coming from the LLM use string prices; staging uses numbers.
// Both paths funnel through logSignal, so we normalize here.
function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).match(/-?\$?\s*([\d.]+)/);
  return m ? +m[1] : null;
}

// ─── Insert ─────────────────────────────────────────────────────────────────

const INSERT_SIGNAL_SQL = `
  INSERT INTO signal_outcomes (
    emission_date, source, symbol, strategy, setup_type, side, verdict,
    confidence, confidence_prob, conviction_score,
    entry_price, stop_price, target1_price, target2_price,
    rs_rank, swing_momentum, sepa_score, stage, regime, atr_pct,
    horizon_days, meta
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?
  )
`;

function buildParams(signal) {
  const confidence = signal.confidence ?? null;
  return [
    signal.emission_date || marketDate(),
    signal.source,
    String(signal.symbol || '').toUpperCase(),
    signal.strategy || null,
    signal.setup_type || null,
    signal.side || 'long',
    signal.verdict || null,
    confidence,
    signal.confidence_prob ?? confidenceToProb(confidence),
    signal.conviction_score ?? null,
    parsePrice(signal.entry_price),
    parsePrice(signal.stop_price),
    parsePrice(signal.target1_price),
    parsePrice(signal.target2_price),
    signal.rs_rank ?? null,
    signal.swing_momentum ?? null,
    signal.sepa_score ?? null,
    signal.stage ?? null,
    signal.regime || null,
    signal.atr_pct ?? null,
    signal.horizon_days ?? 20,
    signal.meta ? JSON.stringify(signal.meta) : null,
  ];
}

// Required fields: source, symbol. Without a symbol we can't resolve outcome.
// Returns the row id, or null on validation / db failure (never throws).
function logSignal(signal) {
  if (!signal || !signal.source || !signal.symbol) return null;
  try {
    const res = db().prepare(INSERT_SIGNAL_SQL).run(...buildParams(signal));
    return res.lastInsertRowid;
  } catch (e) {
    // Never block emission path. Log to stderr so ops can notice.
    console.error(`edge-telemetry: logSignal failed: ${e.message}`);
    return null;
  }
}

// Batch insert in a single transaction. Returns array of ids (same order as
// input). Entries that fail validation get `null` in the result slot.
function logSignalsBatch(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  const ids = new Array(signals.length).fill(null);
  try {
    const stmt = db().prepare(INSERT_SIGNAL_SQL);
    const txn = db().transaction((rows) => {
      for (let i = 0; i < rows.length; i++) {
        const s = rows[i];
        if (!s || !s.source || !s.symbol) continue;
        try {
          ids[i] = stmt.run(...buildParams(s)).lastInsertRowid;
        } catch (_) { /* per-row swallow */ }
      }
    });
    txn(signals);
  } catch (e) {
    console.error(`edge-telemetry: logSignalsBatch failed: ${e.message}`);
  }
  return ids;
}

// ─── Query ──────────────────────────────────────────────────────────────────

// Signals eligible for outcome closing: status='open' and emission_date at
// least `minAgeDays` ago. Default 5 because ret_5d is our first horizon —
// anything younger has no bars to resolve. We deliberately DO NOT filter by
// a max age here so the closer can catch up on rows that were skipped
// (e.g. provider outages) whenever it runs.
function getOpenSignals({ minAgeDays = 5, limit = 500 } = {}) {
  return db().prepare(`
    SELECT * FROM signal_outcomes
    WHERE status = 'open'
      AND date(emission_date) <= date('now', '-' || ? || ' days')
    ORDER BY emission_date ASC, id ASC
    LIMIT ?
  `).all(minAgeDays, limit);
}

function getSignal(id) {
  return db().prepare('SELECT * FROM signal_outcomes WHERE id = ?').get(id);
}

// Read-only list for telemetry UI. Filters are all optional.
function listSignals({ source, strategy, symbol, status, since, limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (source)   { where.push('source = ?');        params.push(source); }
  if (strategy) { where.push('strategy = ?');      params.push(strategy); }
  if (symbol)   { where.push('symbol = ?');        params.push(String(symbol).toUpperCase()); }
  if (status)   { where.push('status = ?');        params.push(status); }
  if (since)    { where.push('emission_date >= ?'); params.push(since); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db().prepare(
    `SELECT * FROM signal_outcomes ${clause} ORDER BY emission_date DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  // Decode meta JSON for downstream convenience.
  return rows.map(r => ({ ...r, meta: r.meta ? safeJson(r.meta) : null }));
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// ─── Outcome resolution ────────────────────────────────────────────────────

const UPDATE_OUTCOME_SQL = `
  UPDATE signal_outcomes SET
    status = ?,
    closed_at = ?,
    close_price_5d = ?,
    close_price_10d = ?,
    close_price_20d = ?,
    ret_5d = ?,
    ret_10d = ?,
    ret_20d = ?,
    max_favorable = ?,
    max_adverse = ?,
    hit_stop = ?,
    hit_target1 = ?,
    hit_target2 = ?,
    realized_r = ?,
    outcome_label = ?
  WHERE id = ?
`;

// outcome = { status, close_price_5d, ..., outcome_label }
// Any missing field becomes NULL / 0 (for hit flags).
function resolveOutcome(id, outcome) {
  if (!id || !outcome) return false;
  try {
    const res = db().prepare(UPDATE_OUTCOME_SQL).run(
      outcome.status || 'resolved',
      outcome.closed_at || new Date().toISOString(),
      outcome.close_price_5d ?? null,
      outcome.close_price_10d ?? null,
      outcome.close_price_20d ?? null,
      outcome.ret_5d ?? null,
      outcome.ret_10d ?? null,
      outcome.ret_20d ?? null,
      outcome.max_favorable ?? null,
      outcome.max_adverse ?? null,
      outcome.hit_stop ? 1 : 0,
      outcome.hit_target1 ? 1 : 0,
      outcome.hit_target2 ? 1 : 0,
      outcome.realized_r ?? null,
      outcome.outcome_label || null,
      id,
    );
    return res.changes > 0;
  } catch (e) {
    console.error(`edge-telemetry: resolveOutcome failed for id=${id}: ${e.message}`);
    return false;
  }
}

// ─── Counts / stats for quick dashboards ───────────────────────────────────

function summary({ since } = {}) {
  const sinceClause = since ? 'WHERE emission_date >= ?' : '';
  const params = since ? [since] : [];
  const row = db().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open'     THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count,
      SUM(CASE WHEN outcome_label = 'winner' THEN 1 ELSE 0 END) AS winners,
      SUM(CASE WHEN outcome_label = 'loser'  THEN 1 ELSE 0 END) AS losers
    FROM signal_outcomes ${sinceClause}
  `).get(...params);
  return row || { total: 0, open_count: 0, resolved_count: 0, winners: 0, losers: 0 };
}

module.exports = {
  confidenceToProb,
  parsePrice,
  logSignal,
  logSignalsBatch,
  getOpenSignals,
  getSignal,
  listSignals,
  resolveOutcome,
  summary,
  // Exposed for tests/introspection
  CONFIDENCE_PROB,
};
