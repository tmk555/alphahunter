// ─── Pyramid Plans Engine ───────────────────────────────────────────────────
//
// True pyramiding entry. Breakout → pilot fires only at the pivot with volume
// confirmation. Pilot fill → arm add1 trigger at +0.5×ATR (or +2% floor) above
// pivot. Add1 fill → arm add2 trigger at +1.0×ATR (or +4% floor). Each tranche
// is submitted as an independent bracket with the shared stop and appropriate
// take-profit target.
//
// Why this differs from scale_in_scale_out:
//   - scale_in_scale_out fires all 3 brackets AT ONCE at the same pivot price
//   - pyramid_auto fires them STAGGERED, each gated by fill + price + volume
//
// Pivot detection:
//   - Uses VCP pivot first, then any detected chart pattern (cup/asc/power/HTF)
//   - If NO pattern detected → block. User can manually supply pivot to override.
//
// Gap-aware execution (Option C):
//   - If market opens < 3% above pivot → fire normally
//   - If 3-7% above pivot → fire pilot at 50% qty (size-reduce the chase)
//   - If > 7% above pivot → cancel plan (too extended, thesis broken)

const { getDB } = require('../data/database');
const { getBroker } = require('./index');
const { getMarketRegime } = require('../risk/regime');
const { preTradeCheck } = require('../risk/portfolio');
const { notifyTradeEvent } = require('../notifications/channels');
const { getVolumePace } = require('../signals/volume-pace');
const { calcVCP } = require('../signals/vcp');
const { detectPatterns } = require('../signals/patterns');
const { evaluateGate } = require('./vwap-gate');

function db() { return getDB(); }

// O'Neil's CANSLIM rule: breakout-day volume ≥ 50d avg × 1.40 (40% above).
// Pre-2026-04: 1.2 (looser — caught more breakouts but more fakeouts).
// Now: 1.4 to match the strict end-of-day rule. Note our pace is intraday-
// extrapolated (today_volume / linear-prorated-50d-avg) so a 1.4 reading
// at midday doesn't guarantee 1.4 at close — volume is U-shaped (heavy
// open, lull, heavy close) so midday 1.4 may end at 1.1-1.2. Low-confidence
// windows (first/last 30 min) auto-relax to 80% of this threshold in
// volume-pace.js to avoid noise rejections.
const DEFAULT_VOLUME_PACE_MIN = 1.4;
const GAP_WARN_PCT            = 0.03;  // 3% above pivot at open → reduce qty
const GAP_ABORT_PCT           = 0.07;  // 7% above pivot → cancel plan
// Gap-DOWN invalidation: if price drops more than 3% BELOW pivot before pilot
// fires, the pattern is broken and the plan should abort. Waiting for a
// retest and firing into a failed base is exactly the trap pros avoid.
const GAP_DOWN_INVALIDATE_PCT = 0.03;
const DEFAULT_EXPIRY_DAYS     = 5;     // Plans auto-expire if pilot never fires
// ── Marketable-limit cap (intraday slippage guard, Fix #1) ──
// Submitting a market order into a fast-moving breakout can slip several
// percent between submission and fill (see ANET 2026-04-22: $169.86 trigger →
// $175.67 avg fill, 3.4% slippage in 58s). We submit a LIMIT instead, capped
// to the max of (trigger × 1 + GAP_WARN_PCT) or (detected price × 1.005).
// Normal fires get the generous trigger-based ceiling (fills easily);
// gap-warn fires (already past 3% above pivot) get a tight +0.5% price-based
// ceiling — if the stock runs past that before the broker matches, we'd
// rather miss the entry than chase at +5%.
const INTRABAR_SLIPPAGE_CAP   = 0.005; // 0.5% above detected price (gap-warn case)
// ── Post-fill slippage cancellation (Fix #3) ──
// If the pilot fills more than this far above its own trigger, the adds
// (priced +0.5×ATR and +1.0×ATR above the same trigger) are now below the
// real cost basis — averaging DOWN into a chase. Cancel them instead.
const POST_FILL_SLIPPAGE_CANCEL_PCT = 0.02; // 2% slippage → cancel adds

// ─── Pivot detection ────────────────────────────────────────────────────────
//
// Returns { pivot, patternName, stop, confidence } or null if nothing found.
// Tries patterns in order: VCP (tightest, most reliable), then chart patterns
// by their confidence score.
//
// Prefers pre-computed pattern data on `stock` (from the scanner, which
// persists fresh detections every scan). Only falls back to a fresh run when
// the stock object lacks it — keeps this cheap and keeps detection rules
// identical to what the client's PYR filter sees.
function detectPivotForPyramid(stock, closes, highs, lows) {
  // 1) VCP — use the sharp final-contraction pivot if forming.
  //    Prefer scanner-computed (matches what the UI's VCP chip shows);
  //    recompute only if missing.
  try {
    let vcp = (stock && stock.vcpForming != null) ? stock : null;
    if (!vcp && closes && closes.length >= 30) {
      vcp = calcVCP(closes);
    }
    if (vcp?.vcpForming && vcp.vcpPivot) {
      return {
        pivot: vcp.vcpPivot,
        stop:  vcp.vcpStop || null,
        patternName: 'VCP',
        confidence: Math.min(100, 60 + (vcp.contractions || 0) * 10),
      };
    }
  } catch (_) {}

  // 2) Chart patterns (cup & handle, ascending base, power play, high tight flag).
  //    patData.bestPattern is a STRING key into patData.patterns — the actual
  //    pattern object (with pivotPrice/stopPrice/confidence/type) lives under
  //    patData.patterns[bestPattern]. Old code dereferenced the string
  //    directly as if it were the object, so the chart-pattern branch was
  //    effectively dead code — only VCP ever matched server-side.
  try {
    let patData = stock?.patternData || null;
    if ((!patData || !patData.bestPattern) && closes && closes.length >= 30) {
      const bars = closes.map((c, i) => ({
        close: c,
        high:  highs?.[i] ?? c,
        low:   lows?.[i]  ?? c,
        volume: 0,
      }));
      // Quick SMAs so power-play detection has its MA inputs. Other patterns
      // don't need them but passing null would skip power-play entirely.
      const sma = (n) => {
        const out = [];
        let sum = 0;
        for (let i = 0; i < closes.length; i++) {
          sum += closes[i];
          if (i >= n) sum -= closes[i - n];
          out.push(i >= n - 1 ? sum / n : null);
        }
        return out;
      };
      const ma50 = sma(50), ma150 = sma(150), ma200 = sma(200);
      patData = detectPatterns(bars, closes, ma50, ma150, ma200);
    }
    const bestName = patData?.bestPattern;
    const best = bestName ? patData.patterns?.[bestName] : null;
    if (best?.pivotPrice) {
      return {
        pivot: +best.pivotPrice.toFixed(2),
        stop:  best.stopPrice ? +best.stopPrice.toFixed(2) : null,
        patternName: bestName,
        confidence: best.confidence || 70,
      };
    }
  } catch (_) {}

  return null;
}

// ─── Trigger spacing (ATR-aware) ────────────────────────────────────────────
//
// add1 = max(pivot × 1.02, pivot + 0.5 × ATR)    — at least +2% OR 0.5 ATR
// add2 = max(pivot × 1.04, pivot + 1.0 × ATR)    — at least +4% OR 1.0 ATR
//
// Floors keep add triggers meaningful on low-vol stocks; ATR-based spacing
// gives high-vol stocks (ATR > 4%) realistic breathing room.
function computeAddTriggers(pivot, atr = null) {
  const add1 = Math.max(pivot * 1.02, pivot + 0.5 * (atr || pivot * 0.02));
  const add2 = Math.max(pivot * 1.04, pivot + 1.0 * (atr || pivot * 0.02));
  return {
    add1: +add1.toFixed(2),
    add2: +add2.toFixed(2),
  };
}

// ─── Plan creation ──────────────────────────────────────────────────────────
//
// Inputs:
//   symbol, totalQty, pivot (optional — auto-detected if null), stop (optional),
//   target1, target2, atr, stock data (closes/highs/lows for pivot detection)
//
// Pipeline:
//   1. If pivot not supplied, detect from VCP / chart patterns. Block if none.
//   2. Compute add1/add2 triggers.
//   3. Split qty into 3 tranches (respect small-qty edge cases).
//   4. Insert pyramid_plan row with status='armed_pilot'.

function createPyramidPlan({
  symbol, totalQty, pivot: pivotOverride, stopPrice: stopOverride,
  target1_price: t1Override, target2_price: t2Override, atr: atrInput,
  closes, highs, lows,
  stock = null,          // optional: scanner result row (carries vcpForming/patternData)
  source = 'manual', convictionScore = null,
  volumePaceMin = DEFAULT_VOLUME_PACE_MIN,
  notes = null,
  expiryDays = DEFAULT_EXPIRY_DAYS,
  // Opt-in VWAP gate on pilot fire. Pass a gate config (same shape as
  // staged_orders.submission_gate) or leave null for default pyramid behavior.
  // Example: { minutes: 39, requireAboveVWAP: true, earliestAfterOpenMin: 39,
  //            gapUpLimitPct: 0.02, gapDownLimitPct: 0.02 }
  vwapGate = null,
}) {
  // Use ATR from input or estimate 2% of pivot as fallback
  const atr = atrInput || null;
  if (!symbol || !(totalQty > 0)) throw new Error('symbol and totalQty required');

  // ── Resolve pivot ──
  let pivot = pivotOverride;
  let pivotSource = pivotOverride ? 'manual' : null;
  let patternName = null;
  if (!pivot) {
    // Pass the real stock object if provided so detectPivotForPyramid can
    // use scanner-cached vcpForming/patternData instead of re-running.
    const detected = detectPivotForPyramid(stock || { ticker: symbol }, closes, highs, lows);
    if (!detected) {
      throw new Error('No pattern detected — pyramid mode requires a defined pivot. Provide manual pivot or use full_in_scale_out.');
    }
    pivot = detected.pivot;
    patternName = detected.patternName;
    pivotSource = detected.patternName;
    if (!stopOverride && detected.stop) stopOverride = detected.stop;
  }
  pivot = +(+pivot).toFixed(2);

  // ── Stop fallback ──
  // Preference order: user override → pattern-structural stop → 2.5×ATR below
  // pivot (matches stopATR 2.5 in MODE_OVERRIDES.position) → 5% floor.
  const stop = stopOverride != null
    ? +(+stopOverride).toFixed(2)
    : atr
      ? +Math.min(pivot * 0.95, pivot - 2.5 * atr).toFixed(2)
      : +(pivot * 0.95).toFixed(2);

  if (stop >= pivot) {
    throw new Error(`Stop ($${stop}) must be below pivot ($${pivot})`);
  }

  // ── Add triggers ──
  const { add1, add2 } = computeAddTriggers(pivot, atr);

  // ── Exit targets — aligned with MODE_OVERRIDES.position in replay.js ──
  // Each tranche exits at a progressively higher target:
  //   Pilot  exits at target1 = pivot + 3.5 × ATR   (or 3.5% floor) — ~3.5R
  //   Add1   exits at target2 = pivot + 7.0 × ATR   (or 7%   floor) — ~7R
  //   Add2   exits at runner  = pivot + 10.0 × ATR  (deliberately far —
  //                             trailing stop takes the runner via scaling.js)
  // Numbers match src/signals/replay.js MODE_OVERRIDES.position
  // (target1ATR 3.5, target2ATR 7.0) so the backtest, the preview dialog,
  // and the live plan all agree. If you change these, update both files.
  const effectiveAtr = atr || pivot * 0.02;
  const target1 = t1Override || +Math.max(pivot * 1.035, pivot + 3.5  * effectiveAtr).toFixed(2);
  const target2 = t2Override || +Math.max(pivot * 1.07,  pivot + 7.0  * effectiveAtr).toFixed(2);
  const runnerTarget       = +Math.max(pivot * 1.10,  pivot + 10.0 * effectiveAtr).toFixed(2);

  // ── Split qty into 3 tranches. Runner gets remainder so rounding never
  //    loses shares. For qty < 3 we fall back to a single pilot (degenerate).
  let pilotQty, add1Qty, add2Qty;
  if (totalQty < 3) {
    pilotQty = totalQty; add1Qty = 0; add2Qty = 0;
  } else {
    const third = Math.floor(totalQty / 3);
    pilotQty = third;
    add1Qty  = third;
    add2Qty  = totalQty - (2 * third);
  }

  const tranches = [
    { label:'pilot', qty: pilotQty, trigger: pivot, volumePaceMin,
      tp: target1, status:'armed', orderId:null, filledAt:null },
    add1Qty > 0 ? { label:'add1', qty: add1Qty, trigger: add1, volumePaceMin,
      tp: target2, status:'waiting_pilot_fill',
      orderId:null, filledAt:null } : null,
    add2Qty > 0 ? { label:'add2', qty: add2Qty, trigger: add2, volumePaceMin,
      tp: runnerTarget, status:'waiting_add1_fill',  // runner — TP far; trail stop handles real exit
      orderId:null, filledAt:null } : null,
  ].filter(Boolean);

  const expires_at = new Date(Date.now() + expiryDays * 86400000).toISOString();

  const vwapGateJson = vwapGate && typeof vwapGate === 'object'
    ? JSON.stringify(vwapGate)
    : null;

  const result = db().prepare(`
    INSERT INTO pyramid_plans
      (symbol, side, status, total_qty, stop_price, target1_price, target2_price,
       tranches_json, source, conviction_score, expires_at, notes, vwap_gate)
    VALUES (?, 'buy', 'armed_pilot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol.toUpperCase(), totalQty, stop, target1, target2,
    JSON.stringify(tranches), source, convictionScore, expires_at,
    notes || (patternName ? `Pivot from ${patternName} detector` : 'Manual pivot'),
    vwapGateJson,
  );

  return {
    id: result.lastInsertRowid,
    symbol: symbol.toUpperCase(),
    status: 'armed_pilot',
    totalQty, stop_price: stop,
    target1_price: target1, target2_price: target2, runnerTarget,
    tranches, pivotSource, patternName,
  };
}

// ─── Plan list/get ──────────────────────────────────────────────────────────

function getPyramidPlans({ status, symbol } = {}) {
  let sql = 'SELECT * FROM pyramid_plans WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (symbol) { sql += ' AND symbol = ?'; params.push(symbol.toUpperCase()); }
  sql += ' ORDER BY created_at DESC';
  return db().prepare(sql).all(...params).map(parsePlan);
}

function getPyramidPlan(id) {
  const row = db().prepare('SELECT * FROM pyramid_plans WHERE id = ?').get(id);
  return row ? parsePlan(row) : null;
}

function parsePlan(row) {
  if (!row) return null;
  let tranches = [];
  try { tranches = JSON.parse(row.tranches_json || '[]'); } catch (_) {}
  let vwapGate = null;
  if (row.vwap_gate) {
    try { vwapGate = JSON.parse(row.vwap_gate); } catch (_) {}
  }
  return { ...row, tranches, vwapGate };
}

// ─── The live checker — runs every ~30s during market hours ────────────────
//
// For each plan in an actionable status, checks whether the next tranche's
// trigger is hit and volume pace meets the gate. If so, submits that tranche
// as a bracket order, updates plan state to "awaiting fill", and notifies.

async function checkPyramidPlans({ currentPrices } = {}) {
  const activeStatuses = ['armed_pilot', 'pilot_filled', 'add1_filled'];
  const plans = db().prepare(
    `SELECT * FROM pyramid_plans WHERE status IN (${activeStatuses.map(() => '?').join(',')})`
  ).all(...activeStatuses).map(parsePlan);

  if (!plans.length) return { checked: 0, fired: [], cancelled: [] };

  const fired = [];
  const cancelled = [];

  // Resolve live prices — caller can inject them (stream path) else fetch.
  let priceMap = currentPrices || {};
  const need = plans.map(p => p.symbol).filter(s => priceMap[s] == null);
  if (need.length) {
    try {
      const { getQuotes } = require('../data/providers/manager');
      const quotes = await getQuotes([...new Set(need)]);
      for (const q of quotes) {
        if (q?.regularMarketPrice) priceMap[q.symbol] = q.regularMarketPrice;
      }
    } catch (e) {
      console.warn(`  pyramid: quote fetch failed: ${e.message}`);
    }
  }

  for (const plan of plans) {
    try {
      // Expiry check — plan stale for >5d without pilot firing
      if (plan.expires_at && new Date(plan.expires_at) < new Date()) {
        db().prepare("UPDATE pyramid_plans SET status = 'expired', updated_at = datetime('now') WHERE id = ?").run(plan.id);
        cancelled.push({ id: plan.id, symbol: plan.symbol, reason: 'expired' });
        notifyTradeEvent({ event:'pyramid_expired', symbol: plan.symbol, details:{ message:`Pyramid plan #${plan.id} expired — pilot never fired` } }).catch(()=>{});
        continue;
      }

      const price = priceMap[plan.symbol];
      if (price == null) continue;

      const pilotTrigger = plan.tranches[0]?.trigger;

      // ── Gap-DOWN invalidation (before pilot fires) ──
      // If price has dropped substantially below the pivot, the pattern is
      // dead. Abort rather than wait for a retest — firing into a failed
      // base is the #1 whipsaw trap. Two separate triggers:
      //   (a) price <= stop_price      → thesis fully broken (would stop out instantly)
      //   (b) price <= pivot × 0.97    → base broken (3% breach = structural failure)
      if (plan.status === 'armed_pilot' && pilotTrigger) {
        const invalidation = Math.max(plan.stop_price, pilotTrigger * (1 - GAP_DOWN_INVALIDATE_PCT));
        if (price <= invalidation) {
          const breachPct = ((pilotTrigger - price) / pilotTrigger * 100).toFixed(1);
          const reason = price <= plan.stop_price
            ? `price $${price.toFixed(2)} ≤ stop $${plan.stop_price} — thesis broken before pilot fired`
            : `price $${price.toFixed(2)} is ${breachPct}% below pivot $${pilotTrigger} — base invalidated`;
          db().prepare("UPDATE pyramid_plans SET status = 'cancelled', updated_at = datetime('now'), notes = COALESCE(notes,'') || ' [gap-down abort: ' || ? || ']' WHERE id = ?")
            .run(reason, plan.id);
          cancelled.push({ id: plan.id, symbol: plan.symbol, reason });
          notifyTradeEvent({ event:'pyramid_gap_abort', symbol: plan.symbol,
            details:{ price, message:`Pyramid #${plan.id} cancelled — ${reason}` }
          }).catch(()=>{});
          continue;
        }
      }

      // ── Stop-out invalidation (after pilot fires) ──
      // If pilot is filled and price hits the shared stop, the broker will
      // close the pilot position via its bracket leg. At that moment, any
      // still-armed add1/add2 must be cancelled — they'd fire into a
      // position that no longer exists, or worse, into a bounce of a
      // failed setup. We detect this by price <= stop_price + a tiny
      // buffer to catch the transition before the broker stop fills.
      if (plan.status !== 'armed_pilot' && price <= plan.stop_price) {
        db().prepare("UPDATE pyramid_plans SET status = 'failed', updated_at = datetime('now'), notes = COALESCE(notes,'') || ' [pilot stopped out at $' || ? || ']' WHERE id = ?")
          .run(price.toFixed(2), plan.id);
        cancelled.push({ id: plan.id, symbol: plan.symbol, reason: `pilot stopped out at $${price.toFixed(2)} — remaining tranches cancelled` });
        notifyTradeEvent({ event:'pyramid_stopped', symbol: plan.symbol,
          details:{ price, message:`🛑 Pyramid #${plan.id} failed — pilot stopped at $${price.toFixed(2)}. Remaining tranches cancelled.` }
        }).catch(()=>{});
        continue;
      }

      // Determine which tranche is active
      const trancheIdx = plan.status === 'armed_pilot' ? 0
                      : plan.status === 'pilot_filled' ? 1
                      : plan.status === 'add1_filled'  ? 2
                      : -1;
      if (trancheIdx < 0 || trancheIdx >= plan.tranches.length) continue;
      const tranche = plan.tranches[trancheIdx];
      // Guard against re-submission: once a tranche is 'submitted' we wait for
      // the broker fill handler to advance state. Without this, every scheduler
      // tick re-fires the same tranche, stacking duplicate bracket orders.
      //
      // HISTORICAL BUG (MKSI, 2026-04-20, 13 submissions in 31 min): this
      // guard originally only skipped `filled`/`submitted`. When the cron
      // poller flipped a cancelled broker order to `tranche.status='cancelled'`
      // (monitor.js ~613), the next tick saw a not-filled-not-submitted
      // tranche and re-fired the same bracket. TIF=day kept expiring, poller
      // kept marking cancelled, checker kept re-firing — infinite minute loop.
      // Fix: cancelled/rejected/expired tranches are TERMINAL. If the active
      // tranche hits a terminal state, the poller also flips plan.status so
      // the whole plan exits this loop for good (see monitor.js).
      if (!tranche) continue;
      const TRANCHE_TERMINAL = ['filled', 'submitted', 'cancelled', 'canceled', 'rejected', 'expired'];
      if (TRANCHE_TERMINAL.includes(tranche.status)) continue;

      // Has trigger been reached?
      if (price < tranche.trigger) continue;

      // ── Gap guard (Option C) ──
      // Only applies to pilot. For add1/add2, being "above trigger" is expected.
      let qty = tranche.qty;
      if (trancheIdx === 0) {
        const gapPct = (price - tranche.trigger) / tranche.trigger;
        if (gapPct > GAP_ABORT_PCT) {
          db().prepare("UPDATE pyramid_plans SET status = 'cancelled', updated_at = datetime('now'), notes = COALESCE(notes,'') || ' [gap abort: +' || ? || '%]' WHERE id = ?")
            .run((gapPct*100).toFixed(1), plan.id);
          cancelled.push({ id: plan.id, symbol: plan.symbol, reason: `gap too wide (+${(gapPct*100).toFixed(1)}%)` });
          notifyTradeEvent({ event:'pyramid_gap_abort', symbol: plan.symbol,
            details:{ message:`Pyramid #${plan.id} cancelled — gap +${(gapPct*100).toFixed(1)}% above pivot exceeds ${(GAP_ABORT_PCT*100)}% limit` }
          }).catch(()=>{});
          continue;
        }
        if (gapPct > GAP_WARN_PCT) {
          qty = Math.max(1, Math.floor(tranche.qty * 0.5));
          console.log(`  pyramid ${plan.symbol}: gap +${(gapPct*100).toFixed(1)}% — reducing pilot qty to ${qty} (from ${tranche.qty})`);
        }
      }

      // ── Volume pace gate ──
      const pace = await getVolumePace(plan.symbol);
      if (pace?.pace != null && pace.pace < (tranche.volumePaceMin || DEFAULT_VOLUME_PACE_MIN)) {
        // Don't fire yet — but don't cancel. Try again next tick.
        console.log(`  pyramid ${plan.symbol} ${tranche.label}: trigger hit but vol pace ${pace.pace} < ${tranche.volumePaceMin} — waiting`);
        continue;
      }

      // ── VWAP 39-min gate (pilot only, opt-in via plan.vwap_gate) ──
      // Same primitive as the staged-order submission gate, applied here at
      // pilot-fire time. Pilot-only because adds are already confirmation-
      // driven (pilot filled → structure proven). When the gate fails, we
      // SOFT-fail: leave pilot armed, try again next tick. This means:
      //   • Pre-09:30 + 39 min  → 'too_early', pilot waits
      //   • 39-min close < VWAP → pilot waits; once the gate rejects, it
      //                            keeps rejecting for the rest of the day
      //                            (the first 39-min candle doesn't change)
      //   • 39-min close ≥ VWAP + trigger crossed → fires this tick
      if (trancheIdx === 0 && plan.vwapGate) {
        let verdict;
        try {
          verdict = await evaluateGate(
            {
              symbol:      plan.symbol,
              id:          plan.id,
              side:        'buy',
              entry_price: tranche.trigger,
            },
            plan.vwapGate,
          );
        } catch (e) {
          console.warn(`  pyramid ${plan.symbol}: VWAP gate threw — ${e.message}, skipping tick`);
          continue;
        }
        if (!verdict.pass) {
          console.log(`  pyramid ${plan.symbol} pilot: VWAP gate blocks fire — ${verdict.reasons.join(', ')}`);
          continue;
        }
      }

      // ── Fire the tranche as a bracket order ──
      const broker = getBroker();
      const regime = await getMarketRegime();
      const openPositions = db().prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();

      // Pre-trade check — risk + heat
      const riskCheck = preTradeCheck({
        symbol: plan.symbol, entryPrice: price, stopPrice: plan.stop_price, shares: qty,
      }, openPositions, regime);
      if (!riskCheck.approved) {
        console.warn(`  pyramid ${plan.symbol} ${tranche.label}: risk check failed, skipping tick — ${riskCheck.checks.filter(c=>!c.pass).map(c=>c.rule).join(', ')}`);
        continue;
      }

      const tpPrice = tranche.tp || plan.target2_price || plan.target1_price || +(price * 1.10).toFixed(2);

      // ── Marketable-limit entry (Fix #1) ──
      // Historically this was a market order ("past the pivot — use market
      // for certain fill"). That exposes us to unbounded intraday slippage
      // in fast breakouts. We now submit a LIMIT with a hard ceiling:
      //   max(trigger × (1 + GAP_WARN_PCT), price × (1 + INTRABAR_SLIPPAGE_CAP))
      // The first term gives normal fires a generous ceiling that'll fill
      // at the NBBO; the second term covers the gap-warn case where
      // current price is already past the trigger-based cap.
      const triggerCap   = tranche.trigger * (1 + GAP_WARN_PCT);
      const detectedCap  = price * (1 + INTRABAR_SLIPPAGE_CAP);
      const entryLimit   = +Math.max(triggerCap, detectedCap).toFixed(2);

      const submission = await broker.submitBracketOrder({
        symbol:               plan.symbol,
        qty,
        side:                 'buy',
        entryType:            'limit',
        entryLimitPrice:      entryLimit,
        stopPrice:            plan.stop_price,
        takeProfitLimitPrice: tpPrice,
        timeInForce:          'day',
        clientOrderId:        `pyramid-${plan.id}-${tranche.label}-${Date.now()}`,
      });

      tranche.orderId = submission?.id;
      tranche.status = 'submitted';
      tranche.submittedAt = new Date().toISOString();
      tranche.actualQty = qty;
      tranche.entryLimit = entryLimit;  // record ceiling for post-hoc analysis

      db().prepare(`
        UPDATE pyramid_plans SET tranches_json = ?, updated_at = datetime('now') WHERE id = ?
      `).run(JSON.stringify(plan.tranches), plan.id);

      fired.push({ id: plan.id, symbol: plan.symbol, label: tranche.label, qty, price });

      notifyTradeEvent({
        event: 'pyramid_tranche_fired',
        symbol: plan.symbol,
        details: {
          shares: qty,
          price,
          message: `🔺 Pyramid ${tranche.label.toUpperCase()} fired: ${qty} sh @ ~$${price.toFixed(2)} (limit ≤ $${entryLimit}, plan #${plan.id})`,
        },
      }).catch(e => console.error(`  pyramid notify error: ${e.message}`));

    } catch (err) {
      console.error(`  pyramid plan #${plan.id} error: ${err.message}`);
    }
  }

  return { checked: plans.length, fired, cancelled };
}

// ─── Fill handler — called from broker monitor when a tranche's parent fills ─
//
// Tranche lifecycle: submitted → (broker fill) → filled → arms next tranche.
// We advance plan state and flip the next tranche to 'armed'.
//
// `fillInfo` is optional and carries the broker's actual execution data:
//   { avgFillPrice, filledQty }
// When provided, we:
//   1. Persist avgFillPrice + actualQty on the tranche (so the UI can show
//      the real cost basis, not just the trigger).
//   2. Run the post-fill slippage guard (Fix #3): if the pilot filled more
//      than POST_FILL_SLIPPAGE_CANCEL_PCT above its trigger, cancel the
//      remaining armed/waiting adds rather than averaging down into them.

async function handleTrancheFill(orderId, fillInfo = null) {
  const row = db().prepare(
    "SELECT * FROM pyramid_plans WHERE tranches_json LIKE ? AND status NOT IN ('complete','cancelled','expired','failed')"
  ).get(`%"${orderId}"%`);
  if (!row) return null;

  const plan = parsePlan(row);
  let advanced = false;
  let newStatus = plan.status;
  let filledIdx = -1;
  let filledTranche = null;
  let slippageCancel = null;

  for (let i = 0; i < plan.tranches.length; i++) {
    const t = plan.tranches[i];
    if (t.orderId === orderId && t.status === 'submitted') {
      t.status = 'filled';
      t.filledAt = new Date().toISOString();

      // Record actual fill data when the poller passed it through.
      if (fillInfo?.avgFillPrice != null && Number.isFinite(fillInfo.avgFillPrice)) {
        t.fillPrice = +Number(fillInfo.avgFillPrice).toFixed(2);
      }
      if (fillInfo?.filledQty != null && Number.isFinite(fillInfo.filledQty)) {
        t.actualQty = Number(fillInfo.filledQty);
      }

      // Fallback: if the poller didn't carry fill data (race with
      // fills-sync, or the broker response was partial), look up the
      // trades row by alpaca_order_id. trades.entry_price is the avg
      // fill as recorded by fills-sync when the parent order settles.
      if (t.fillPrice == null) {
        try {
          const trow = db().prepare(
            'SELECT entry_price, shares FROM trades WHERE alpaca_order_id = ? LIMIT 1'
          ).get(orderId);
          if (trow?.entry_price) t.fillPrice = +Number(trow.entry_price).toFixed(2);
          if (trow?.shares && t.actualQty == null) t.actualQty = Number(trow.shares);
        } catch (_) { /* best-effort */ }
      }

      filledIdx = i;
      filledTranche = t;

      // Advance plan status + arm next tranche (will be overridden below if
      // the slippage guard cancels the remaining adds).
      if (i === 0) {
        newStatus = 'pilot_filled';
        if (plan.tranches[1]) plan.tranches[1].status = 'armed';
      } else if (i === 1) {
        newStatus = 'add1_filled';
        if (plan.tranches[2]) plan.tranches[2].status = 'armed';
      } else if (i === 2) {
        newStatus = 'complete';
      }
      advanced = true;
      break;
    }
  }

  if (!advanced) return null;

  // ── Post-fill slippage guard (Fix #3) ──
  // Only meaningful when we actually have a fill price AND there are
  // downstream tranches still in play (add1 for pilot fill, add2 for
  // add1 fill). If slippage exceeds the cancel threshold, flip the
  // remaining tranches to 'cancelled' and mark the plan 'complete' so
  // the watcher stops firing new adds. We don't need to touch the
  // broker here — the adds never got submitted, they're plan-side only.
  if (filledTranche && filledTranche.fillPrice && filledTranche.trigger && filledIdx < 2) {
    const slippagePct = (filledTranche.fillPrice - filledTranche.trigger) / filledTranche.trigger;
    if (slippagePct > POST_FILL_SLIPPAGE_CANCEL_PCT) {
      const cancelledLabels = [];
      for (let j = filledIdx + 1; j < plan.tranches.length; j++) {
        const next = plan.tranches[j];
        if (next && next.status !== 'filled' && next.status !== 'cancelled') {
          next.status = 'cancelled';
          next.cancelReason = `pilot_slippage_${(slippagePct * 100).toFixed(1)}pct`;
          cancelledLabels.push(next.label);
        }
      }
      if (cancelledLabels.length) {
        newStatus = 'complete'; // No further tranches will fire; treat plan as done.
        slippageCancel = {
          slippagePct,
          fillPrice: filledTranche.fillPrice,
          trigger: filledTranche.trigger,
          cancelled: cancelledLabels,
        };
      }
    }
  }

  db().prepare(`
    UPDATE pyramid_plans SET status = ?, tranches_json = ?, updated_at = datetime('now') WHERE id = ?
  `).run(newStatus, JSON.stringify(plan.tranches), plan.id);

  // Fill notification — includes real avg fill price when we have it.
  const priceLabel = filledTranche?.fillPrice
    ? `avg $${filledTranche.fillPrice} (trigger $${filledTranche.trigger})`
    : `trigger $${filledTranche?.trigger ?? '?'}`;
  notifyTradeEvent({
    event: 'pyramid_tranche_filled',
    symbol: plan.symbol,
    details: {
      price: filledTranche?.fillPrice,
      message: `✅ Pyramid ${filledTranche?.label?.toUpperCase() || 'tranche'} filled — ${priceLabel}, plan #${plan.id} → ${newStatus}`,
    },
  }).catch(() => {});

  // Slippage cancel alert — separate phone ping so you know adds were killed.
  if (slippageCancel) {
    notifyTradeEvent({
      event: 'pyramid_slippage_cancel',
      symbol: plan.symbol,
      details: {
        price: slippageCancel.fillPrice,
        message: `⚠️ Pyramid #${plan.id} ${filledTranche.label.toUpperCase()} slipped +${(slippageCancel.slippagePct * 100).toFixed(1)}% (trigger $${slippageCancel.trigger} → fill $${slippageCancel.fillPrice}). Cancelled remaining tranches: ${slippageCancel.cancelled.join(', ')}.`,
      },
    }).catch(() => {});
  }

  return { planId: plan.id, newStatus, slippageCancel };
}

// ─── Cancel a plan ──────────────────────────────────────────────────────────

async function cancelPyramidPlan(id) {
  const plan = getPyramidPlan(id);
  if (!plan) throw new Error(`Pyramid plan #${id} not found`);
  if (['complete','cancelled','expired','failed'].includes(plan.status)) {
    return plan;  // already terminal
  }

  // Cancel any submitted-but-unfilled tranches at the broker
  try {
    const broker = getBroker();
    for (const t of plan.tranches) {
      if (t.status === 'submitted' && t.orderId) {
        try { await broker.cancelOrder(t.orderId); }
        catch (e) { console.error(`  pyramid cancel order ${t.orderId}: ${e.message}`); }
      }
    }
  } catch (_) { /* broker unavailable */ }

  db().prepare(
    "UPDATE pyramid_plans SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?"
  ).run(id);

  notifyTradeEvent({ event:'pyramid_cancelled', symbol: plan.symbol,
    details:{ message:`Pyramid plan #${id} cancelled by user` } }).catch(()=>{});

  return getPyramidPlan(id);
}

// ─── Modify pilot trigger on an armed (not-yet-fired) pyramid plan ──────────
// Only allowed while status === 'armed_pilot' (no tranche submitted yet).
// Shifts add1/add2 triggers by the same delta so the ATR-scaled offsets
// stay intact — a user who wanted pilot at 170 with adds at +0.5/+1.0 ATR
// still wants those same offsets when they bump pilot to 172.
function modifyPyramidPilotTrigger(id, newPilotPrice) {
  const plan = getPyramidPlan(id);
  if (!plan) throw new Error(`Pyramid plan #${id} not found`);
  if (plan.status !== 'armed_pilot') {
    throw new Error(`Pilot trigger can only be modified while armed (current status: ${plan.status})`);
  }
  const np = +newPilotPrice;
  if (!(np > 0)) throw new Error('newPilotPrice must be a positive number');
  if (plan.stop_price && np <= plan.stop_price) {
    throw new Error(`New pilot $${np} must be above stop $${plan.stop_price}`);
  }

  const oldPilot = plan.tranches[0]?.trigger;
  if (!(oldPilot > 0)) throw new Error('Existing pilot trigger missing on plan');
  const delta = np - oldPilot;

  const newTranches = plan.tranches.map((t, i) => {
    if (i === 0) return { ...t, trigger: +np.toFixed(2) };
    // Only shift triggers for not-yet-active tranches (waiting on earlier fill).
    // Once a plan is armed_pilot the adds are always in waiting_* state so this
    // is a no-op check — defensive though in case the guard above changes.
    if (t.status && t.status.startsWith('waiting_')) {
      return { ...t, trigger: +(t.trigger + delta).toFixed(2) };
    }
    return t;
  });

  db().prepare(
    "UPDATE pyramid_plans SET tranches_json = ?, updated_at = datetime('now'), " +
    "notes = COALESCE(notes,'') || ' [pilot modified: $' || ? || ' → $' || ? || ']' " +
    "WHERE id = ?"
  ).run(JSON.stringify(newTranches), oldPilot, np.toFixed(2), id);

  return getPyramidPlan(id);
}

module.exports = {
  createPyramidPlan,
  getPyramidPlans,
  getPyramidPlan,
  checkPyramidPlans,
  handleTrancheFill,
  cancelPyramidPlan,
  modifyPyramidPilotTrigger,
  detectPivotForPyramid,
  computeAddTriggers,
};
