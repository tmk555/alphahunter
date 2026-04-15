// ─── 50 SMA Pullback Monitor (Phase 1.1) ───────────────────────────────────
//
// Real-time watcher for strong-RS stocks pulling back to their 50 SMA entry
// zone. This is the core alert for position trades: we want to enter when a
// leader takes a normal 5–10% pullback to its 50-day line, NOT when it runs
// 15% above it.
//
// Why this file exists:
//   The original `pullback_watch` job in `src/scheduler/jobs.js` did three
//   things wrong for live monitoring:
//     1. It used Yahoo's EOD `fiftyDayAverage` (quote.fiftyDayAverage via
//        rs_snapshots.vs_ma50), which is the PRIOR-DAY close-derived SMA and
//        goes stale intraday. Computing `ma50 = price / (1 + vs_ma50/100)`
//        reconstructs that stale value, not today's real SMA.
//     2. It fired a single binary alert (price ≤ 1.05 × ma50) — no sense of
//        "approaching" vs "in the zone" vs "kissing the line", so the trader
//        couldn't pre-stage an order before the bounce.
//     3. It had no idempotency — running the job twice would fire two alerts.
//
// What this module does:
//   - Recomputes SMA50 from OHLCV closes on every run (not Yahoo's cache).
//   - Tracks three explicit distance bands per symbol: approaching / in_zone /
//     kissing — see getPullbackState() for exact thresholds.
//   - Stores the last-fired state in a small `pullback_states` table so the
//     same state never fires twice. Only a STATE TRANSITION (e.g. approaching
//     → in_zone) produces a new notification.
//   - Gates candidates by real leadership filters: RS ≥ 70, above 200MA,
//     and at least one of (stage 2, VCP forming, SEPA ≥ 4). A pullback on a
//     weak stock is a downtrend — we want pullbacks on leaders only.
//
// Designed to be called on a 1-minute cron during RTH with live Alpaca/Yahoo
// quotes. The OHLCV history is cached (23h TTL), so the per-run cost is
// dominated by the 1-batch quote fetch — not history fetching.

const { getDB } = require('../data/database');
const { getQuotes, getHistoryFull } = require('../data/providers/manager');
const { notifyTradeEvent } = require('../notifications/channels');
const { calcATR } = require('./momentum');

function db() { return getDB(); }

// ─── State thresholds (intentional, documented) ────────────────────────────
//
// APPROACHING: within 5–8% of 50 SMA (upside). Gives the trader time to
//   pre-stage a bracket order before price actually reaches the zone.
// IN_ZONE:     within 3% of 50 SMA. This is the primary "fill me" alert —
//   classic O'Neil/Minervini 5% pullback entry range.
// KISSING:     at or just below the 50 SMA (within 0.3 ATR). This captures
//   intraday undercut-and-reclaim setups where price wicks below the line
//   then reverses — a secondary entry for aggressive traders.
//
// NOTE: Bands are mutually exclusive and evaluated in order from tightest to
// widest, so a single price produces a single state name. A stock sitting at
// MA50 * 1.025 is "in_zone", not "approaching", even though it's also <1.08.

const BANDS = {
  // price ≤ ma50 + 0.3*ATR → kissing (may be at/below the line)
  // price ≤ ma50 * 1.03    → in_zone
  // price ≤ ma50 * 1.08    → approaching
};

function getPullbackState({ price, ma50, atr }) {
  if (price == null || ma50 == null || ma50 <= 0) return null;

  // Kissing: at or near the line (including small undercut). ATR-based so
  // wide-range stocks get a proportional tolerance, not a fixed %.
  const kissingUpper = ma50 + 0.3 * (atr || ma50 * 0.01);
  if (price <= kissingUpper) return 'kissing';

  // In-zone: within 3% of MA50 — the canonical "pulled-in" alert.
  if (price <= ma50 * 1.03) return 'in_zone';

  // Approaching: 3–8% above. Early warning for pre-staging.
  if (price <= ma50 * 1.08) return 'approaching';

  return null;  // out of range, not a pullback candidate right now
}

// ─── 50 SMA from OHLCV closes (not Yahoo's cached quote value) ─────────────

function computeMA50(closes) {
  if (!closes || closes.length < 50) return null;
  const slice = closes.slice(-50);
  const sum = slice.reduce((a, b) => a + b, 0);
  return +(sum / 50).toFixed(4);
}

// ─── Candidate gate (leaders only) ─────────────────────────────────────────
//
// Pullback-entry logic only makes sense on real leaders. On a weak stock a
// pullback is just a downtrend; we're not trying to bottom-fish.

function isLeadershipCandidate(snap) {
  if (!snap) return false;
  if ((snap.rs_rank || 0) < 70) return false;
  if ((snap.vs_ma200 || 0) <= 0) return false;
  const qualifyingStructure =
    snap.stage === 2 ||
    !!snap.vcp_forming ||
    (snap.sepa_score || 0) >= 4;
  return qualifyingStructure;
}

// ─── State tracking table (idempotency) ───────────────────────────────────
//
// Schema: one row per (symbol) holding the most recent emitted state and
// the ma50/atr snapshot at fire time. Re-firing the same state is a no-op.

function ensurePullbackStatesTable() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS pullback_states (
      symbol TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      ma50 REAL,
      atr REAL,
      price_at_fire REAL,
      fired_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function readLastState(symbol) {
  try {
    return db().prepare('SELECT * FROM pullback_states WHERE symbol = ?').get(symbol) || null;
  } catch (_) {
    return null;
  }
}

function writeLastState({ symbol, state, ma50, atr, priceAtFire }) {
  db().prepare(`
    INSERT INTO pullback_states (symbol, state, ma50, atr, price_at_fire, fired_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(symbol) DO UPDATE SET
      state = excluded.state,
      ma50 = excluded.ma50,
      atr = excluded.atr,
      price_at_fire = excluded.price_at_fire,
      fired_at = excluded.fired_at,
      updated_at = excluded.updated_at
  `).run(symbol, state, ma50, atr, priceAtFire);
}

function clearLastState(symbol) {
  try {
    db().prepare('DELETE FROM pullback_states WHERE symbol = ?').run(symbol);
  } catch (_) {}
}

// ─── Leadership snapshot loader (from latest rs_snapshots row) ─────────────

function loadLatestLeadershipSnapshots() {
  const latestDate = db().prepare(
    "SELECT MAX(date) as date FROM rs_snapshots WHERE type = 'stock'"
  ).get()?.date;
  if (!latestDate) return { date: null, snapshots: [] };

  const snapshots = db().prepare(`
    SELECT symbol, price, rs_rank, sepa_score, stage, vs_ma50, vs_ma200,
           volume_ratio, vcp_forming, atr_pct
    FROM rs_snapshots
    WHERE date = ? AND type = 'stock' AND price > 0
  `).all(latestDate);

  return { date: latestDate, snapshots };
}

// ─── Main scan entry point ─────────────────────────────────────────────────
//
// options.currentPrices: optional map { SYMBOL: price } — skips the batch
//   quote fetch if the caller already has fresh prices (e.g. from the stream).
// options.dryRun: if true, returns the planned transitions without firing
//   notifyTradeEvent or persisting state. Used for unit tests and /api peek.

async function runPullbackScan(options = {}) {
  ensurePullbackStatesTable();

  const { date, snapshots } = loadLatestLeadershipSnapshots();
  if (!snapshots.length) {
    return { date: null, scanned: 0, fired: [], cleared: [], reason: 'no snapshots' };
  }

  const candidates = snapshots.filter(isLeadershipCandidate);
  if (!candidates.length) {
    return { date, scanned: 0, fired: [], cleared: [], reason: 'no leaders qualify' };
  }

  // Fetch live prices if the caller didn't supply them.
  const symbols = candidates.map(c => c.symbol);
  let currentPrices = options.currentPrices || {};

  const missing = symbols.filter(s => currentPrices[s] == null);
  if (missing.length > 0) {
    try {
      // Batch in chunks of 20 to stay friendly with upstream rate limits.
      for (let i = 0; i < missing.length; i += 20) {
        const chunk = missing.slice(i, i + 20);
        const quotes = await getQuotes(chunk);
        for (const q of quotes) {
          if (q?.regularMarketPrice) currentPrices[q.symbol] = q.regularMarketPrice;
        }
      }
    } catch (e) {
      console.error(`  Pullback scan: batch quote fetch failed: ${e.message}`);
    }
  }

  const fired = [];
  const cleared = [];
  const unchanged = [];
  const errors = [];

  for (const snap of candidates) {
    const symbol = snap.symbol;
    const livePrice = currentPrices[symbol];
    if (livePrice == null) continue;

    // Recompute MA50 from OHLCV (23h cache keeps this cheap).
    let bars = null;
    try {
      bars = await getHistoryFull(symbol);
    } catch (e) {
      errors.push({ symbol, error: `history fetch failed: ${e.message}` });
      continue;
    }
    if (!bars || bars.length < 50) continue;

    const closes = bars.map(b => b.close);
    const ma50 = computeMA50(closes);
    const atr = calcATR(bars) || 0;
    if (ma50 == null) continue;

    const newState = getPullbackState({ price: livePrice, ma50, atr });
    const last = readLastState(symbol);
    const lastState = last?.state || null;

    // Out-of-range transition: if we previously had a state but price ran
    // back above 1.08 × ma50, clear the sticky state so the next pullback
    // gets a fresh sequence of alerts.
    if (newState == null) {
      if (lastState) {
        clearLastState(symbol);
        cleared.push({ symbol, previousState: lastState, livePrice, ma50 });
      }
      continue;
    }

    // Idempotency: same state as last fire → skip.
    if (newState === lastState) {
      unchanged.push({ symbol, state: newState, livePrice, ma50 });
      continue;
    }

    // State transition — fire the alert and persist the new state.
    if (!options.dryRun) {
      writeLastState({ symbol, state: newState, ma50, atr, priceAtFire: livePrice });

      const distPct = +(((livePrice - ma50) / ma50) * 100).toFixed(2);
      const label =
        newState === 'approaching' ? 'APPROACHING 50MA'
        : newState === 'in_zone'    ? 'IN PULLBACK ZONE'
        : 'KISSING 50MA (undercut)';

      notifyTradeEvent({
        event: 'pullback_entry',
        symbol,
        details: {
          price: +livePrice.toFixed(2),
          state: newState,
          ma50: +ma50.toFixed(2),
          atr: +atr.toFixed(2),
          distPct,
          rsRank: snap.rs_rank,
          sepaScore: snap.sepa_score,
          stage: snap.stage,
          vcpForming: !!snap.vcp_forming,
          reason: `${label}: ${symbol} @ $${livePrice.toFixed(2)} (MA50 $${ma50.toFixed(2)}, ${distPct >= 0 ? '+' : ''}${distPct}%)`,
          message: `${label}: ${symbol} @ $${livePrice.toFixed(2)} (MA50 $${ma50.toFixed(2)}, ${distPct >= 0 ? '+' : ''}${distPct}%) — RS ${snap.rs_rank}, SEPA ${snap.sepa_score || 0}/8`,
        },
      }).catch(e => console.error(`  Pullback notify error for ${symbol}: ${e.message}`));
    }

    fired.push({
      symbol,
      state: newState,
      previousState: lastState,
      livePrice: +livePrice.toFixed(2),
      ma50: +ma50.toFixed(2),
      atr: +atr.toFixed(2),
      rsRank: snap.rs_rank,
      sepaScore: snap.sepa_score,
    });
  }

  return {
    date,
    scanned: candidates.length,
    fired,
    cleared,
    unchanged: unchanged.length,
    errors,
  };
}

module.exports = {
  runPullbackScan,
  // exported for unit tests + /api inspection:
  getPullbackState,
  computeMA50,
  isLeadershipCandidate,
  ensurePullbackStatesTable,
  readLastState,
  writeLastState,
  clearLastState,
};
