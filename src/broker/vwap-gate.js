// ─── Submission Gate (VWAP / gap / pivot-trigger / volume-pace) ────────────
//
// Holds staged orders in `pending_trigger` status until ALL configured gates
// pass; only then does the watcher flip `pending_trigger → staged` and call
// `submitStagedOrder`.
//
// Each gate is OPT-IN: only fields present in the gate JSON are evaluated.
// A gate JSON with just { triggerPrice: 280.98, volumePaceMin: 1.4 } skips
// VWAP and gap checks entirely — supports O'Neil-style breakout entries.
//
// File name kept as vwap-gate.js for backward compat with imports; it now
// handles the full suite of gates, not just VWAP.
//
// Schema of submission_gate JSON (all fields optional):
//   {
//     // ── Pivot-trigger gate (price-based, fast) ──
//     triggerPrice: 280.98,        // long: require live price >= this; short: <=
//
//     // ── Volume confirmation gate (CANSLIM-style) ──
//     volumePaceMin: 1.4,          // require live pace >= this (1.4 = O'Neil 40% rule)
//
//     // ── VWAP reclaim gate (intraday bars) ──
//     minutes: 39,                 // candle duration for VWAP reclaim
//     requireAboveVWAP: true,      // require Nth-min candle close > VWAP (long side)
//
//     // ── Gap bounds gate (uses today's open) ──
//     gapUpLimitPct: 0.02,         // reject if open gaps > +X% from staged entry
//     gapDownLimitPct: 0.02,       // reject if open gaps < −X% from staged entry
//
//     // ── Timing controls ──
//     earliestAfterOpenMin: 39,    // skip evaluation before this many minutes post-open
//     cancelOnFail: false,         // hard cancel on gate failure (vs leave pending)
//     expiresAt: '2026-04-23',     // auto-cancel if gates never pass by this date
//   }
//
// The watcher cron fires every 5 minutes during market hours. Order of
// evaluation: cheapest-first (trigger → volume → VWAP/gap) so the common
// "trigger not yet hit" case exits without an intraday-bar fetch.

const { getDB } = require('../data/database');
const { getIntradayBars, getQuotes } = require('../data/providers/manager');
const { calculateVWAP, aggregateToTimeframe } = require('../signals/intraday');
const { getVolumePace } = require('../signals/volume-pace');
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
// with pass/fail + reasons. Each check is opt-in: only fields present in the
// gateCfg JSON are enforced. Cheap checks (price/volume) run before
// expensive ones (intraday bars + VWAP) so the common "not yet triggered"
// case exits without bar fetches.
async function evaluateGate(row, gateCfg) {
  const verdict = {
    symbol: row.symbol,
    stagedId: row.id,
    gateConfig: gateCfg,
    pass: false,
    reasons: [],
    data: {},
  };
  const isShort = row.side === 'sell';

  // Track which gate fields are configured so the verdict reasons can show
  // "all_gates_passed (trigger,volume)" instead of just "all_gates_passed".
  const activeGates = [];

  // ── Gate 1: pivot trigger price ─────────────────────────────────────────
  // Cheap: one quote call. For longs require live price ≥ trigger; for
  // shorts require ≤ trigger. Skipped entirely if triggerPrice not set.
  if (gateCfg.triggerPrice != null) {
    activeGates.push('trigger');
    try {
      const quotes = await getQuotes([row.symbol]);
      const px = quotes?.[0]?.regularMarketPrice;
      if (px == null) {
        verdict.reasons.push('trigger_quote_unavailable');
        return verdict;
      }
      verdict.data.livePrice = px;
      verdict.data.triggerPrice = gateCfg.triggerPrice;
      const triggered = isShort ? px <= gateCfg.triggerPrice : px >= gateCfg.triggerPrice;
      if (!triggered) {
        verdict.reasons.push(
          isShort
            ? `above_trigger:price=${px}>trigger=${gateCfg.triggerPrice}`
            : `below_trigger:price=${px}<trigger=${gateCfg.triggerPrice}`
        );
        return verdict;
      }
    } catch (e) {
      verdict.reasons.push(`trigger_quote_failed:${e.message}`);
      return verdict;
    }
  }

  // ── Gate 2: volume pace (CANSLIM-style confirmation) ────────────────────
  // Compares today's volume-to-now against the linearly-prorated 50-day
  // average. Skipped if volumePaceMin not set. We accept low-confidence
  // windows (first/last 30 min of session) at 80% of the threshold —
  // mirrors passesVolumePace's leniency.
  if (gateCfg.volumePaceMin != null) {
    activeGates.push('volume');
    try {
      const pace = await getVolumePace(row.symbol);
      verdict.data.volumePace = pace;
      if (!pace || pace.pace == null) {
        // No data ≠ block. If we can't measure, allow (matches
        // passesVolumePace fallback=true philosophy).
        verdict.data.volumePaceFallback = pace?.reason || 'no_data';
      } else {
        const effectiveMin = pace.confidence === 'low'
          ? gateCfg.volumePaceMin * 0.8
          : gateCfg.volumePaceMin;
        if (pace.pace < effectiveMin) {
          verdict.reasons.push(
            `volume_light:pace=${pace.pace}<${effectiveMin.toFixed(2)}` +
            (pace.confidence === 'low' ? ' (low-confidence window)' : '')
          );
          return verdict;
        }
      }
    } catch (e) {
      verdict.reasons.push(`volume_pace_failed:${e.message}`);
      return verdict;
    }
  }

  // ── Gate 3 & 4: VWAP reclaim + gap bounds (intraday bars) ──────────────
  // These share the same intraday-bar fetch, so we pull bars once and
  // evaluate both. Skipped together if neither requireAboveVWAP nor gap
  // limits are set.
  const wantsVWAP = gateCfg.requireAboveVWAP != null;
  const wantsGap  = gateCfg.gapUpLimitPct != null || gateCfg.gapDownLimitPct != null;
  if (wantsVWAP || wantsGap) {
    if (wantsVWAP) activeGates.push('vwap');
    if (wantsGap)  activeGates.push('gap');

    const minutes = gateCfg.minutes ?? 39;
    const earliestAfterOpenMin = gateCfg.earliestAfterOpenMin ?? minutes;

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

    // Earliest-after-open: don't evaluate before the first N-min candle
    // could have closed.
    const minutesElapsed = _marketMinutesSinceOpen(bars);
    verdict.data.minutesSinceOpen = +minutesElapsed.toFixed(1);
    if (minutesElapsed < earliestAfterOpenMin) {
      verdict.reasons.push(`too_early:${minutesElapsed.toFixed(1)}min<${earliestAfterOpenMin}min`);
      return verdict;
    }

    // Aggregate to the configured candle duration
    const aggBars = aggregateToTimeframe(bars, minutes);
    if (!aggBars.length) {
      verdict.reasons.push('aggregation_empty');
      return verdict;
    }
    const firstCandle = aggBars[0];
    verdict.data.firstCandle = {
      open:  firstCandle.open,
      high:  firstCandle.high,
      low:   firstCandle.low,
      close: firstCandle.close,
      volume: firstCandle.volume,
    };

    if (wantsVWAP) {
      const requireAboveVWAP = gateCfg.requireAboveVWAP;
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
    }

    if (wantsGap) {
      const gapUpLimit   = gateCfg.gapUpLimitPct   ?? Infinity;
      const gapDownLimit = gateCfg.gapDownLimitPct ?? Infinity;
      const entry = row.entry_price;
      if (entry && firstCandle.open) {
        const upperBand = entry * (1 + gapUpLimit);
        const lowerBand = entry * (1 - gapDownLimit);
        verdict.data.gapPct = +((firstCandle.open / entry - 1) * 100).toFixed(2);
        if (!isShort) {
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
    }
  }

  // No gates configured at all? Treat as pass — caller should have
  // disarmed instead of leaving an empty gate, but don't lock the row.
  verdict.pass = true;
  verdict.reasons.push(activeGates.length
    ? `all_gates_passed:${activeGates.join(',')}`
    : 'no_gates_configured');
  verdict.data.activeGates = activeGates;
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
      // Build a gate-aware notification message. For trigger-only gates the
      // VWAP-flavored message would be misleading, so we describe what
      // actually fired.
      const gateLabels = verdict.data.activeGates || [];
      const firePrice = verdict.data.livePrice
        ?? verdict.data.firstCandle?.close
        ?? row.entry_price;
      const msgParts = [];
      if (gateLabels.includes('trigger')) msgParts.push(`price $${verdict.data.livePrice} ≥ trigger $${verdict.data.triggerPrice}`);
      if (gateLabels.includes('volume') && verdict.data.volumePace?.pace) msgParts.push(`vol pace ${verdict.data.volumePace.pace}× (${verdict.data.volumePace.label})`);
      if (gateLabels.includes('vwap'))    msgParts.push(`above VWAP $${verdict.data.vwap}`);
      if (gateLabels.includes('gap'))     msgParts.push(`gap ${verdict.data.gapPct ?? 0}% in bounds`);
      const message = msgParts.length
        ? `${row.symbol} entry triggered — ${msgParts.join(', ')} — order submitted`
        : `${row.symbol} gate passed — order submitted`;
      notifyTradeEvent({
        event: 'entry_triggered',
        symbol: row.symbol,
        details: { price: firePrice, gates: gateLabels, message },
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
