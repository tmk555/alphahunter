// ─── VWAP + Gap Submission Gate ──────────────────────────────────────────────
//
// Holds staged orders in `pending_trigger` status until:
//   1. The first N-minute candle (default 39) has closed above VWAP
//   2. The overnight gap is inside the configured bounds (same logic as
//      gap_guard, reused for consistency)
//   3. The current time is after the earliest-after-open threshold
//
// Only when ALL three pass does the gate flip `pending_trigger → staged` and
// call `submitStagedOrder` — the order then goes through normal broker
// submission + pre-trade risk checks.
//
// The gate is OPT-IN per staged order: a row is governed only when its
// `submission_gate` JSON column is non-null. Rows without a gate behave
// exactly as before. This keeps the feature zero-risk to existing flows.
//
// Schema of submission_gate JSON:
//   {
//     minutes: 39,               // candle duration for VWAP reclaim
//     gapUpLimitPct: 0.02,       // reject gaps above this
//     gapDownLimitPct: 0.02,     // reject gaps below this
//     requireAboveVWAP: true,    // long side default
//     earliestAfterOpenMin: 39,  // don't check before this many minutes post-open
//     cancelOnFail: false,       // if true, gate failure cancels; else leaves pending for re-try
//     expiresAt: '2026-04-23',   // optional — cancel if gate hasn't passed by this date
//   }
//
// The watcher cron fires every 5 minutes during market hours. On each tick it
// walks all pending_trigger rows, pulls today's 1-min bars, aggregates to the
// configured candle duration, computes VWAP, and evaluates the gate.

const { getDB } = require('../data/database');
const { getIntradayBars, getQuotes } = require('../data/providers/manager');
const { calculateVWAP, aggregateToTimeframe } = require('../signals/intraday');
const { notifyTradeEvent } = require('../notifications/channels');

function db() { return getDB(); }

// US Eastern "now" — node-cron runs in server TZ but gate timing is market-TZ.
// We compute market-open offset from bar timestamps rather than relying on
// the server clock, so this works regardless of host timezone.
function _marketMinutesSinceOpen(bars) {
  if (!bars?.length) return 0;
  // bars arrive sorted oldest→newest. First bar at or after 09:30 ET is the
  // open; the latest bar's `time` gives elapsed minutes.
  const first = bars[0];
  const last = bars[bars.length - 1];
  // Prefer explicit timestamps if the provider normalized them
  const startMs = first.timestamp ? new Date(first.timestamp).getTime()
                                  : Date.parse(`${first.date}T${first.time || '09:30:00'}-04:00`);
  const endMs = last.timestamp ? new Date(last.timestamp).getTime()
                                : Date.parse(`${last.date}T${last.time || '09:30:00'}-04:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, (endMs - startMs) / 60000);
}

// Evaluate the gate for a single staged_orders row. Returns a verdict object
// with pass/fail + reasons. Pure function aside from the bar fetch; testable.
async function evaluateGate(row, gateCfg) {
  const verdict = {
    symbol: row.symbol,
    stagedId: row.id,
    gateConfig: gateCfg,
    pass: false,
    reasons: [],
    data: {},
  };

  const minutes = gateCfg.minutes ?? 39;
  const requireAboveVWAP = gateCfg.requireAboveVWAP ?? (row.side === 'buy' || !row.side);
  const earliestAfterOpenMin = gateCfg.earliestAfterOpenMin ?? minutes;

  // 1. Fetch today's 1-minute bars
  let bars;
  try {
    bars = await getIntradayBars(row.symbol, 'minute', 1);
  } catch (e) {
    verdict.reasons.push(`bar_fetch_failed:${e.message}`);
    return verdict;
  }
  if (!bars?.length) {
    verdict.reasons.push('no_intraday_bars');
    return verdict;
  }

  // 2. Earliest-after-open gate — don't evaluate before the first N-min candle
  //    could have closed. This prevents premature fires on the very first
  //    1-min bar after the open.
  const minutesElapsed = _marketMinutesSinceOpen(bars);
  verdict.data.minutesSinceOpen = +minutesElapsed.toFixed(1);
  if (minutesElapsed < earliestAfterOpenMin) {
    verdict.reasons.push(`too_early:${minutesElapsed.toFixed(1)}min<${earliestAfterOpenMin}min`);
    return verdict;
  }

  // 3. Aggregate to the configured candle duration
  const aggBars = aggregateToTimeframe(bars, minutes);
  if (!aggBars.length) {
    verdict.reasons.push('aggregation_empty');
    return verdict;
  }
  const firstCandle = aggBars[0];       // First N-min candle of the day
  verdict.data.firstCandle = {
    open:  firstCandle.open,
    high:  firstCandle.high,
    low:   firstCandle.low,
    close: firstCandle.close,
    volume: firstCandle.volume,
  };

  // 4. VWAP reclaim check — first candle's close must be above VWAP at that
  //    moment. We compute VWAP from the 1-min bars up through the candle's
  //    end so the reference is "VWAP as of close of bar 39".
  const barsThroughFirstCandle = bars.slice(0, Math.min(bars.length, minutes));
  const vwapSnap = calculateVWAP(barsThroughFirstCandle);
  if (!vwapSnap) {
    verdict.reasons.push('vwap_compute_failed');
    return verdict;
  }
  verdict.data.vwap = vwapSnap.vwap;
  verdict.data.vwapCloseDelta = +(firstCandle.close - vwapSnap.vwap).toFixed(2);

  if (requireAboveVWAP && firstCandle.close <= vwapSnap.vwap) {
    verdict.reasons.push(`below_vwap:close=${firstCandle.close}<=vwap=${vwapSnap.vwap}`);
    return verdict;
  }
  if (!requireAboveVWAP && firstCandle.close >= vwapSnap.vwap) {
    verdict.reasons.push(`above_vwap:close=${firstCandle.close}>=vwap=${vwapSnap.vwap}`);
    return verdict;
  }

  // 5. Gap bounds — rejected if the open gaps beyond user-configured limits
  //    vs the staged entry price. Mirrors checkPreOpenGaps but runs at fire
  //    time so pre-open quote gaps don't slip through.
  const gapUpLimit   = gateCfg.gapUpLimitPct   ?? 0.02;
  const gapDownLimit = gateCfg.gapDownLimitPct ?? 0.02;
  const entry = row.entry_price;
  if (entry && firstCandle.open) {
    const upperBand = entry * (1 + gapUpLimit);
    const lowerBand = entry * (1 - gapDownLimit);
    verdict.data.gapPct = +((firstCandle.open / entry - 1) * 100).toFixed(2);
    if (row.side === 'buy' || !row.side) {
      if (firstCandle.open > upperBand) {
        verdict.reasons.push(`gap_up:open=${firstCandle.open}>${upperBand.toFixed(2)}`);
        return verdict;
      }
    } else {
      if (firstCandle.open < lowerBand) {
        verdict.reasons.push(`gap_down:open=${firstCandle.open}<${lowerBand.toFixed(2)}`);
        return verdict;
      }
    }
  }

  verdict.pass = true;
  verdict.reasons.push('all_gates_passed');
  return verdict;
}

// Walk every pending_trigger row with a non-null submission_gate and try to
// advance it. Calls submitStagedOrder (lazy-required to avoid circular dep)
// on pass; fires an adjustment_failed event on hard fail (gap/expiry).
async function runVwapGateTick() {
  const rows = db().prepare(
    "SELECT * FROM staged_orders WHERE status = 'pending_trigger' AND submission_gate IS NOT NULL"
  ).all();
  if (!rows.length) return { checked: 0, passed: [], failed: [], skipped: [] };

  const { submitStagedOrder, cancelStagedOrder } = require('./staging');
  const passed = [], failed = [], skipped = [];

  for (const row of rows) {
    let gateCfg;
    try { gateCfg = JSON.parse(row.submission_gate); }
    catch (_) { skipped.push({ id: row.id, symbol: row.symbol, reason: 'invalid_gate_json' }); continue; }

    // Expiry: if gate hasn't passed by expiresAt, cancel the staged row.
    if (gateCfg.expiresAt) {
      const today = new Date().toISOString().slice(0, 10);
      if (today > gateCfg.expiresAt) {
        try {
          await cancelStagedOrder(row.id, { suppressNotify: true });
          notifyTradeEvent({
            event: 'gap_cancel',
            symbol: row.symbol,
            details: { message: `VWAP gate expired — pending since ${row.created_at}, gate never passed` },
          }).catch(() => {});
          failed.push({ id: row.id, symbol: row.symbol, reason: 'expired' });
        } catch (e) {
          skipped.push({ id: row.id, symbol: row.symbol, reason: `expiry_cancel_failed:${e.message}` });
        }
        continue;
      }
    }

    let verdict;
    try { verdict = await evaluateGate(row, gateCfg); }
    catch (e) { skipped.push({ id: row.id, symbol: row.symbol, reason: `evaluate_threw:${e.message}` }); continue; }

    if (!verdict.pass) {
      // Soft fail — leave pending for re-try next tick, unless cancelOnFail.
      if (gateCfg.cancelOnFail) {
        try {
          await cancelStagedOrder(row.id, { suppressNotify: true });
          notifyTradeEvent({
            event: 'gap_cancel',
            symbol: row.symbol,
            details: { message: `VWAP gate failed (cancelOnFail=true): ${verdict.reasons.join(', ')}` },
          }).catch(() => {});
          failed.push({ id: row.id, symbol: row.symbol, reason: verdict.reasons.join(',') });
        } catch (e) {
          skipped.push({ id: row.id, symbol: row.symbol, reason: `fail_cancel_failed:${e.message}` });
        }
      } else {
        skipped.push({ id: row.id, symbol: row.symbol, reason: verdict.reasons.join(',') });
      }
      continue;
    }

    // Pass — promote to 'staged' and submit. submitStagedOrder runs the
    // pre-trade risk check as a second gate (regime, heat, position count).
    try {
      db().prepare("UPDATE staged_orders SET status = 'staged' WHERE id = ?").run(row.id);
      await submitStagedOrder(row.id);
      notifyTradeEvent({
        event: 'vwap_gate_passed',
        symbol: row.symbol,
        details: {
          price: verdict.data.firstCandle?.close,
          message: `VWAP gate passed (${gateCfg.minutes || 39}-min close $${verdict.data.firstCandle?.close} > VWAP $${verdict.data.vwap}) — order submitted`,
        },
      }).catch(() => {});
      passed.push({ id: row.id, symbol: row.symbol, verdict });
    } catch (e) {
      // Roll back the status change if submit failed (so the next tick retries)
      try { db().prepare("UPDATE staged_orders SET status = 'pending_trigger' WHERE id = ?").run(row.id); }
      catch (_) {}
      skipped.push({ id: row.id, symbol: row.symbol, reason: `submit_threw:${e.message}` });
      console.error(`  VWAP gate: submit failed for ${row.symbol} #${row.id}: ${e.message}`);
    }
  }

  return { checked: rows.length, passed, failed, skipped };
}

module.exports = { evaluateGate, runVwapGateTick };
