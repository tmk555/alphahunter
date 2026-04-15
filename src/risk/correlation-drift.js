// ─── Continuous Correlation Drift Watcher (Phase 2.8) ─────────────────────
//
// Problem this solves:
//   Two positions entered with a 0.25 correlation can converge to 0.85 during
//   a sector rotation, a Fed decision, or a factor unwind — and suddenly your
//   "diversified 8-position book" is actually 3 independent bets with triple
//   the concentration risk you signed up for. The existing `correlation.js`
//   analyzer computes a point-in-time snapshot (it answers "are my positions
//   correlated TODAY"), but nothing in the codebase notices DRIFT: positions
//   that WEREN'T correlated when you entered them but have since become so.
//
//   The audit explicitly flagged this as a silent bug. Retail traders rarely
//   notice until the coincident drawdown hits, at which point it's too late.
//
// Design:
//   1. Persist an "entry baseline" correlation the first time we observe a
//      pair of open positions. This becomes the reference point for drift.
//   2. Every time the watcher runs, recompute current pair correlations on
//      the trailing 30-bar window. Compare to baseline.
//   3. Gate an alert on THREE conjunctive conditions:
//         a) Current correlation ≥ 0.80          (absolute "lockstep" check)
//         b) Current - baseline ≥ 0.20           (actual DRIFT, not just a
//                                                  pair that was always correlated
//                                                  — that was already known at entry)
//         c) Each position ≥ 3% of the total book weight (ignore pennies)
//   4. Throttle: don't fire the same pair more than once per 24h — the
//      watcher runs hourly and a pair that hit threshold at 10am will still
//      be above threshold at 11am unless something actually changes.
//   5. Fire a `correlation_drift` event via notifyTradeEvent so the existing
//      priority/channel plumbing handles delivery. It maps to priority 1
//      (alongside stop_violation, gap_cancel, etc.) — the user needs to see
//      this BEFORE the coincident drawdown, not after.
//
// Baseline storage:
//   We create a `correlation_baselines` table if it doesn't already exist.
//   Keyed on (symbol_a, symbol_b) with symbol_a < symbol_b canonical order so
//   we don't double-store (AAPL,MSFT) + (MSFT,AAPL). Baseline is the pairwise
//   correlation computed at the moment the pair first co-existed in the book.
//
// Data dependencies:
//   - Daily snapshot closes from rs_snapshots (30 trailing bars per symbol)
//   - Open positions from trades table (exit_date IS NULL)
//   - Live quotes optional — used only if caller passes them, to price the
//     book for weight calculations. Falls back to entry price if not given.
//
// This module is PURE with respect to I/O — all DB access is behind function
// calls that can be stubbed in tests. No network fetches, no cron coupling —
// the scheduler just calls `runCorrelationDriftCheck()` and gets a report.

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Constants ─────────────────────────────────────────────────────────────

// Minimum bars of history required to compute a correlation. 30 is the
// "sane floor" — fewer and a single outlier dominates the number.
const MIN_BARS = 30;

// Current-correlation threshold above which a pair is "in lockstep".
// Matches the value `analyzePortfolioCorrelation` flags as "redundant" so
// the drift watcher and the static analyzer agree on what "correlated" means.
const CORR_THRESHOLD = 0.80;

// Additional drift over baseline. 0.20 is half a std-dev of daily correlations
// in S&P 500 pairs (empirical) — enough to be a real move, not noise.
const DRIFT_THRESHOLD = 0.20;

// Minimum book weight for either leg of the pair. A pair where one side is
// a 0.5% residual doesn't concentrate the book even at 0.99 correlation —
// the dollar exposure isn't there.
const MIN_WEIGHT_PCT = 3.0;

// Cool-down between alerts for the same pair. The watcher runs hourly; we
// don't want to ping the user 12× for a single drift event.
const ALERT_COOLDOWN_HOURS = 24;

// ─── Schema bootstrap ──────────────────────────────────────────────────────
// Create the baselines + alert-log tables on first use. Safe to call
// repeatedly — `CREATE TABLE IF NOT EXISTS` is idempotent.

function ensureSchema() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS correlation_baselines (
      symbol_a TEXT NOT NULL,
      symbol_b TEXT NOT NULL,
      baseline REAL NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (symbol_a, symbol_b)
    );

    CREATE TABLE IF NOT EXISTS correlation_drift_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol_a TEXT NOT NULL,
      symbol_b TEXT NOT NULL,
      baseline REAL,
      current REAL,
      drift REAL,
      weight_a REAL,
      weight_b REAL,
      fired_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ─── Canonical pair key ────────────────────────────────────────────────────
// Sort symbols alphabetically so (AAPL,MSFT) and (MSFT,AAPL) map to the same
// baseline row. No more drift-report duplication.

function canonPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// ─── Pair correlation on log returns ───────────────────────────────────────
// Takes two arrays of closing prices, computes pairwise Pearson correlation
// of their log returns on the shorter array's length (tail-aligned).

function pairCorrelation(closesA, closesB) {
  if (!closesA || !closesB) return null;
  const n = Math.min(closesA.length, closesB.length);
  if (n < MIN_BARS) return null;

  const a = closesA.slice(-n);
  const b = closesB.slice(-n);

  const retsA = [];
  const retsB = [];
  for (let i = 1; i < n; i++) {
    if (a[i - 1] > 0 && b[i - 1] > 0) {
      retsA.push(Math.log(a[i] / a[i - 1]));
      retsB.push(Math.log(b[i] / b[i - 1]));
    }
  }
  const N = retsA.length;
  if (N < 5) return null;

  let meanA = 0, meanB = 0;
  for (let i = 0; i < N; i++) { meanA += retsA[i]; meanB += retsB[i]; }
  meanA /= N; meanB /= N;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < N; i++) {
    const da = retsA[i] - meanA;
    const db2 = retsB[i] - meanB;
    cov += da * db2;
    varA += da * da;
    varB += db2 * db2;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

// ─── DB helpers ────────────────────────────────────────────────────────────

function getOpenPositions() {
  return db().prepare(`
    SELECT symbol, side, entry_price, shares, remaining_shares, entry_date
    FROM trades
    WHERE exit_date IS NULL
  `).all();
}

// Pull the last `bars` closing prices for a symbol from rs_snapshots.
// Ordered oldest → newest so pairCorrelation's tail-align math works.
function getSnapshotCloses(symbol, bars = 60) {
  return db().prepare(`
    SELECT price FROM rs_snapshots
    WHERE symbol = ? AND type = 'stock' AND price IS NOT NULL
    ORDER BY date DESC
    LIMIT ?
  `).all(symbol, bars).reverse().map(r => r.price);
}

function getBaseline(a, b) {
  const row = db().prepare(
    'SELECT baseline FROM correlation_baselines WHERE symbol_a = ? AND symbol_b = ?'
  ).get(a, b);
  return row ? row.baseline : null;
}

function setBaseline(a, b, value) {
  db().prepare(`
    INSERT OR REPLACE INTO correlation_baselines (symbol_a, symbol_b, baseline, observed_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(a, b, value);
}

// Has this pair already been alerted within the cooldown window? Returns the
// timestamp of the most recent alert if yes, else null.
function recentAlert(a, b, hours = ALERT_COOLDOWN_HOURS) {
  const row = db().prepare(`
    SELECT fired_at FROM correlation_drift_alerts
    WHERE symbol_a = ? AND symbol_b = ?
      AND fired_at >= datetime('now', ?)
    ORDER BY fired_at DESC LIMIT 1
  `).get(a, b, `-${hours} hours`);
  return row ? row.fired_at : null;
}

function recordAlert(pair) {
  db().prepare(`
    INSERT INTO correlation_drift_alerts
      (symbol_a, symbol_b, baseline, current, drift, weight_a, weight_b)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    pair.symbol_a, pair.symbol_b,
    pair.baseline, pair.current, pair.drift,
    pair.weight_a, pair.weight_b,
  );
}

// ─── Position weights ──────────────────────────────────────────────────────
// Book weight = position notional / total portfolio notional. We price each
// position at its current mark if the caller supplied quotes, else at the
// entry price (pessimistic but safe — pre-drift weights are fine for a
// weight-gate sanity check).

function computeWeights(positions, quotes = {}) {
  const enriched = positions.map(p => {
    const shares = p.remaining_shares || p.shares || 0;
    const price = quotes[p.symbol] ?? p.entry_price ?? 0;
    const notional = shares * price;
    return { ...p, shares, price, notional };
  });
  const total = enriched.reduce((s, p) => s + p.notional, 0);
  if (total <= 0) {
    return enriched.map(p => ({ ...p, weightPct: 0 }));
  }
  return enriched.map(p => ({ ...p, weightPct: (p.notional / total) * 100 }));
}

// ─── Main watcher ─────────────────────────────────────────────────────────

/**
 * Run one drift-check pass over the current portfolio.
 *
 * @param {Object} [options]
 * @param {number} [options.bars=60]              Trailing bars of history to
 *                                                 pull per symbol.
 * @param {number} [options.corrThreshold=0.80]   Absolute correlation threshold.
 * @param {number} [options.driftThreshold=0.20]  Minimum drift above baseline.
 * @param {number} [options.minWeightPct=3.0]     Minimum book weight per leg.
 * @param {number} [options.cooldownHours=24]     Alert throttle per pair.
 * @param {Object<string,number>} [options.quotes]  Optional { SYMBOL: price }
 *                                                 for weight calculation.
 * @param {Function} [options.notify]             Injection point for tests.
 *                                                 Default: notifyTradeEvent.
 * @returns {{checked:number, alerted:Array, skipped:Array, pairs:Array}}
 */
async function runCorrelationDriftCheck({
  bars = 60,
  corrThreshold = CORR_THRESHOLD,
  driftThreshold = DRIFT_THRESHOLD,
  minWeightPct = MIN_WEIGHT_PCT,
  cooldownHours = ALERT_COOLDOWN_HOURS,
  quotes = {},
  notify = null,
} = {}) {
  ensureSchema();

  // Lazy require so tests can stub the notifications module via require.cache
  // BEFORE importing this one (same pattern as staging.js + gap-guard).
  const notifyFn = notify || require('../notifications/channels').notifyTradeEvent;

  const positions = getOpenPositions();
  const weighted  = computeWeights(positions, quotes);

  // Need at least 2 positions to form a pair. Still report how many we
  // looked at so the dashboard can show "1 position, nothing to compare".
  if (weighted.length < 2) {
    return { checked: weighted.length, pairsConsidered: 0, alerted: [], skipped: [], pairs: [] };
  }

  // Pre-fetch all closes once — O(N) DB hits, not O(N²).
  const closesMap = {};
  for (const p of weighted) {
    closesMap[p.symbol] = getSnapshotCloses(p.symbol, bars);
  }

  const pairs = [];      // every pair we looked at — for diagnostics
  const alerted = [];    // pairs that tripped the alert
  const skipped = [];    // pairs that fell out for weight/cooldown/data reasons

  for (let i = 0; i < weighted.length; i++) {
    for (let j = i + 1; j < weighted.length; j++) {
      const pi = weighted[i];
      const pj = weighted[j];
      const [a, b] = canonPair(pi.symbol, pj.symbol);
      const weightA = pi.symbol === a ? pi.weightPct : pj.weightPct;
      const weightB = pi.symbol === a ? pj.weightPct : pi.weightPct;

      const closesA = closesMap[a];
      const closesB = closesMap[b];
      const current = pairCorrelation(closesA, closesB);

      // Seed the baseline the FIRST time we observe this pair. From then on
      // it stays pinned so drift is measured relative to entry conditions,
      // not a trailing average that silently tracks the drift itself.
      let baseline = getBaseline(a, b);
      if (baseline == null && current != null) {
        setBaseline(a, b, current);
        baseline = current;
      }

      const pairInfo = {
        symbol_a: a,
        symbol_b: b,
        current: current != null ? +current.toFixed(3) : null,
        baseline: baseline != null ? +baseline.toFixed(3) : null,
        drift: (current != null && baseline != null) ? +(current - baseline).toFixed(3) : null,
        weight_a: +weightA.toFixed(2),
        weight_b: +weightB.toFixed(2),
      };
      pairs.push(pairInfo);

      // Skip reasons, in priority order — the dashboard shows them so the
      // user can tell WHY a pair didn't alert.
      if (current == null) {
        skipped.push({ ...pairInfo, reason: 'insufficient_price_data' });
        continue;
      }
      if (weightA < minWeightPct || weightB < minWeightPct) {
        skipped.push({ ...pairInfo, reason: 'below_min_weight' });
        continue;
      }
      if (current < corrThreshold) {
        // Not in lockstep yet — nothing to alert.
        continue;
      }
      // Drift gate: require meaningful change from baseline. If a pair was
      // entered at 0.82 correlation and is now 0.83, that's NOT drift.
      if (pairInfo.drift != null && pairInfo.drift < driftThreshold) {
        skipped.push({ ...pairInfo, reason: 'not_drifting_from_baseline' });
        continue;
      }
      // Cooldown: one alert per 24h per pair.
      const lastAlert = recentAlert(a, b, cooldownHours);
      if (lastAlert) {
        skipped.push({ ...pairInfo, reason: 'cooldown_active', lastAlert });
        continue;
      }

      // All gates cleared — fire the alert.
      recordAlert(pairInfo);
      try {
        await notifyFn({
          event: 'correlation_drift',
          symbol: `${a}/${b}`,
          details: {
            message:
              `⚠️ ${a} + ${b} have drifted to ${(pairInfo.current * 100).toFixed(0)}% correlation ` +
              `(was ${(pairInfo.baseline * 100).toFixed(0)}% at entry, drift +${(pairInfo.drift * 100).toFixed(0)}bp). ` +
              `Combined book weight: ${(pairInfo.weight_a + pairInfo.weight_b).toFixed(1)}%. ` +
              `Consider trimming one to restore diversification.`,
            correlation: pairInfo.current,
            baseline: pairInfo.baseline,
            drift: pairInfo.drift,
            weight_a: pairInfo.weight_a,
            weight_b: pairInfo.weight_b,
          },
        });
      } catch (e) {
        // Don't let a single notification failure block the rest of the
        // sweep — the alert is still logged in correlation_drift_alerts.
        console.error(`correlation_drift notify failed for ${a}/${b}: ${e.message}`);
      }
      alerted.push(pairInfo);
    }
  }

  return {
    checked: weighted.length,
    pairsConsidered: pairs.length,
    alerted,
    skipped,
    pairs,
  };
}

// ─── Maintenance helpers ───────────────────────────────────────────────────

// When a position is closed we should drop any baseline rows that referenced
// it — otherwise next time we open that symbol the old baseline resurrects
// from a totally different market regime. Called from portfolio reconcile.
function pruneClosedBaselines() {
  ensureSchema();
  db().prepare(`
    DELETE FROM correlation_baselines
    WHERE symbol_a NOT IN (SELECT DISTINCT symbol FROM trades WHERE exit_date IS NULL)
       OR symbol_b NOT IN (SELECT DISTINCT symbol FROM trades WHERE exit_date IS NULL)
  `).run();
}

module.exports = {
  runCorrelationDriftCheck,
  pruneClosedBaselines,
  // Exposed for tests and direct callers
  pairCorrelation,
  computeWeights,
  ensureSchema,
  canonPair,
  // Constants
  MIN_BARS,
  CORR_THRESHOLD,
  DRIFT_THRESHOLD,
  MIN_WEIGHT_PCT,
  ALERT_COOLDOWN_HOURS,
};
