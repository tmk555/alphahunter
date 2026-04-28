// ─── Replay Sweep — exhaustive per-strategy parameter sweep ─────────────
//
// Runs every meaningful (strategy × params × exit × regime) combination
// over a date range, ranks them by AFTER-TAX alpha vs SPY, and optionally
// runs walk-forward + Monte Carlo on the top-K survivors.
//
// The pre-tax replay engine already models slippage, commissions, gap
// filters, dividend accrual, cash drag, and next-day-entry execution. This
// orchestrator adds the missing piece — taxes — and exposes "does this
// thing actually beat SPY long-term hold once Uncle Sam takes his cut?".
//
// Why this matters: a 30% pre-tax return at 35% short-term cap gains nets
// 19.5%. A 20% SPY return at 18% long-term cap gains nets 16.4%. So the
// strategy that beat SPY by "+10 pts pre-tax" actually wins by ~3 pts
// after-tax. Most strategies fail this bar — better to know up front.
//
// Per-strategy grids are intentionally curated (not a naive cartesian)
// because each strategy only consumes a subset of parameters. Sweeping
// minRS for vcp_breakout (which uses minVCPContractions instead) just
// burns cycles on equivalent runs.

const { runReplay, runWalkForward, runMonteCarlo, BUILT_IN_STRATEGIES } = require('./replay');

// Per-strategy parameter grid. Each entry lists the discrete values to
// test for each lever the strategy actually consumes. Keep grids small
// per axis — total combo count is the cartesian product. The orchestrator
// also crosses each combo with exit-strategy × strictRegime, so an axis
// with 3 values multiplies the strategy's combo count by 18 (3 × 3 exits
// × 2 regime).
//
// Tuning philosophy: cover the meaningful range (tight / standard / loose)
// without exploding combo count. A 3-value axis gives meaningful coverage
// with minimal noise.
const STRATEGY_GRIDS = {
  rs_momentum: {
    minRS: [70, 80, 90],
    minMomentum: [50, 65],
    holdDays: [10, 20, 40],
    stopATR: [1.0, 1.5, 2.5],
    targetATR: [2.0, 3.0, 5.0],
  },
  vcp_breakout: {
    minRS: [70, 80],
    minVCPContractions: [2, 3],
    holdDays: [10, 20, 40],
    stopATR: [1.0, 1.5, 2.5],
    targetATR: [2.0, 3.0, 5.0],
  },
  sepa_trend: {
    minRS: [70, 80],
    minSEPA: [5, 6, 7],
    holdDays: [20, 40, 60],
    stopATR: [1.5, 2.5],
    targetATR: [3.0, 5.0],
  },
  rs_line_new_high: {
    minRS: [70, 80, 90],
    maxDistFromHigh: [0.05, 0.10, 0.15],
    holdDays: [20, 40],
    stopATR: [1.5, 2.5],
    targetATR: [3.0, 5.0],
  },
  conviction: {
    minRS: [60, 70, 80],
    minMomentum: [40, 50, 60],
    holdDays: [10, 20, 40],
    stopATR: [1.5, 2.5],
    targetATR: [3.0, 5.0],
  },
  short_breakdown: {
    maxRS: [15, 20, 25],
    maxSEPA: [1, 2],
    holdDays: [10, 20],
    stopATR: [1.0, 1.5],
  },
  emerging_leader: {
    minRS: [60, 65],
    maxRS: [79, 85],
    minAccel: [3, 5, 8],
    holdDays: [20, 30, 40],
    stopATR: [1.5, 2.5],
    targetATR: [3.0, 5.0],
  },
  deep_scan: {
    minRS: [70, 80],
    minSwingMomentum: [50, 65],
    holdDays: [20, 40],
    stopATR: [1.5, 2.5],
    targetATR: [3.0, 5.0],
  },
  factor_combo: {
    minRS: [80, 85, 90],
    holdDays: [20, 40],
    stopATR: [1.5, 2.5],
    targetATR: [3.0, 5.0],
    // Curated signal sets — each is a complete `signals` array. Skipping
    // the cross product over individual signal toggles to keep the combo
    // count manageable.
    _signalSet: [
      ['rs_strong', 'pattern'],
      ['rs_strong', 'vcp_forming'],
      ['rs_strong', 'rs_line_nh'],
      ['rs_strong', 'stage_2', 'pattern'],
      ['rs_strong', 'breadth_ok', 'pattern'],
    ],
  },
  regime_adaptive: {
    minRS: [70, 80],
    holdDays: [20, 40],
    stopATR: [1.5, 2.5],
    targetATR: [3.0, 5.0],
    bullStrategy: ['rs_momentum'],
    neutralStrategy: ['sepa_trend', 'conviction'],
  },
};

const EXIT_VARIANTS = ['full_in_full_out', 'full_in_scale_out', 'pyramid_auto'];
const STRICT_REGIME_VARIANTS = [true, false];
// Trade-mode axis. `null` = strategy default (no MODE_OVERRIDES applied
// by the engine, so the sweep's own stop/target/hold/exit/regime axes
// are honored). 'swing' / 'position' = engine forces its preset
// (swing:  hold=10, stop=1.0, target=2.0, full-in/full-out;
//  position: hold=40, stop=2.5, target=7.0, pyramid + scale-out).
// When tradeMode is set, the per-combo expander below DROPS the redundant
// stop/target/hold/exit axes since the mode overrides win at the engine
// merge layer anyway. This way the user sees three distinct flavors per
// strategy:
//   - "Custom" — user/engine default lever combinations
//   - "Swing" — the canonical 10-day momentum preset
//   - "Position" — the 40-day pyramid+scale preset
// `null` is included alongside 'swing' and 'position' so all three
// flavors compete head-to-head in the same sweep.
const TRADE_MODE_VARIANTS = [null, 'swing', 'position'];

// Levers that get OVERRIDDEN by the engine's MODE_OVERRIDES when
// tradeMode is set. We strip these from a combo when running in swing
// or position mode so we don't sweep equivalent runs.
const MODE_OVERRIDDEN_KEYS = new Set(['holdDays', 'stopATR', 'targetATR']);

// Total combos is bounded by the engine's cartesian explosion (a single
// strategy with 5 axes of 3 values each = 243 combos; × 6 (3 exits × 2
// regime) = 1458). Cap the per-strategy combo count so a misconfigured
// grid can't explode unbounded.
const MAX_COMBOS_PER_STRATEGY = 800;
const HARD_CAP_TOTAL_COMBOS  = 5000;

// ─── Cartesian product helpers ──────────────────────────────────────────

function cartesianProduct(grid) {
  const keys = Object.keys(grid);
  if (!keys.length) return [{}];
  const values = keys.map(k => Array.isArray(grid[k]) ? grid[k] : [grid[k]]);
  const out = [];
  function recurse(idx, acc) {
    if (idx === keys.length) { out.push({ ...acc }); return; }
    for (const v of values[idx]) {
      acc[keys[idx]] = v;
      recurse(idx + 1, acc);
    }
  }
  recurse(0, {});
  return out;
}

function expandStrategyGrid(strategy) {
  const grid = STRATEGY_GRIDS[strategy];
  if (!grid) return [];
  // factor_combo's _signalSet is special — expand it by mapping to `signals`.
  if (grid._signalSet) {
    const { _signalSet, ...rest } = grid;
    const baseCombos = cartesianProduct(rest);
    const out = [];
    for (const sig of _signalSet) {
      for (const c of baseCombos) {
        out.push({ ...c, signals: sig });
      }
    }
    return out;
  }
  return cartesianProduct(grid);
}

// ─── Tax math ───────────────────────────────────────────────────────────
//
// Active trading short-term gains taxed at user's ordinary income rate
// (32-37% for most active traders + state). SPY buy-and-hold = long-term
// gains at 15-20% federal. Defaults to mid-bracket combined rates.
//
// Loss treatment (simplified): net annual loss is offset against gains
// up to total. We DON'T model the $3k/year ordinary-income offset cap or
// loss carryforwards — those are real but complicate a single-window
// backtest readout. For a strategy that posted a NET LOSS over the
// window, after-tax = pre-tax (no tax on losses). Strategy that posted a
// gain pays tax on the entire gain at the short-term rate.

const DEFAULT_SHORT_TERM_RATE = 0.35;   // 32% federal + ~3% state mid-bracket
const DEFAULT_LONG_TERM_RATE  = 0.18;   // 15% federal + ~3% state mid-bracket

function applyTax(returnPct, rate) {
  if (returnPct == null) return null;
  if (returnPct <= 0) return returnPct;          // losses untaxed in our model
  return +(returnPct * (1 - rate)).toFixed(2);
}

// ─── Single combo evaluation ────────────────────────────────────────────

function buildParams(strategy, comboParams, exit, strictRegime, tradeMode) {
  const params = { ...comboParams, strictRegime };
  // Exit translation matches the UI's buildParamsForStrategy. Skipped
  // when a tradeMode preset is active — the engine's MODE_OVERRIDES
  // already set scaleOut/pyramidEntry for swing/position modes, and we
  // want the preset to win.
  if (tradeMode == null) {
    if (exit === 'full_in_scale_out') {
      params.scaleOut = true;
    } else if (exit === 'pyramid_auto') {
      params.scaleOut = true;
      params.pyramidEntry = true;
    }
  }
  return params;
}

function evaluateOneCombo({ strategy, comboParams, exit, strictRegime, tradeMode, startDate, endDate, maxPositions, initialCapital, execution, taxRates }) {
  const params = buildParams(strategy, comboParams, exit, strictRegime, tradeMode);
  let result;
  try {
    result = runReplay({
      strategy,
      tradeMode: tradeMode || undefined,
      params,
      startDate, endDate,
      maxPositions, initialCapital,
      execution,
      persistResult: false,
    });
  } catch (e) {
    return { strategy, exit, strictRegime, tradeMode, params: comboParams, error: e.message };
  }

  if (!result || result.error) {
    return { strategy, exit, strictRegime, tradeMode, params: comboParams, error: result?.error || 'unknown' };
  }

  const totalReturn   = result.performance?.totalReturn ?? 0;
  const spyReturn     = result.benchmark?.spyReturn ?? 0;
  const maxDrawdown   = result.performance?.maxDrawdown ?? 0;
  const sharpe        = result.performance?.sharpeRatio ?? 0;
  const profitFactor  = result.performance?.profitFactor ?? 0;
  const trades        = result.trades?.total ?? 0;
  const winRate       = result.trades?.winRate ?? 0;

  const stratNet  = applyTax(totalReturn, taxRates.short);
  const spyNet    = applyTax(spyReturn,   taxRates.long);
  const afterTaxAlpha = stratNet != null && spyNet != null
    ? +(stratNet - spyNet).toFixed(2) : null;
  const preTaxAlpha = result.performance?.alpha ?? null;

  return {
    strategy,
    strategyName: BUILT_IN_STRATEGIES[strategy]?.name || strategy,
    // Flavor label — what the user reads in the result table to know
    // whether this run used the engine's swing/position preset or a
    // custom param combo.
    flavor: tradeMode === 'swing' ? 'Swing' : tradeMode === 'position' ? 'Position' : 'Custom',
    tradeMode: tradeMode || null,
    exit,
    strictRegime,
    params: comboParams,
    paramsString: JSON.stringify(comboParams),
    totalReturn:    +totalReturn.toFixed(2),
    spyReturn:      +spyReturn.toFixed(2),
    preTaxAlpha:    preTaxAlpha != null ? +preTaxAlpha.toFixed(2) : null,
    stratNetAfterTax: stratNet,
    spyNetAfterTax:   spyNet,
    afterTaxAlpha,
    maxDrawdown:    +maxDrawdown.toFixed(2),
    sharpeRatio:    sharpe,
    profitFactor:   profitFactor,
    trades,
    winRate:        +winRate.toFixed(1),
  };
}

// ─── Sweep orchestrator ─────────────────────────────────────────────────

/**
 * Run an exhaustive sweep across the curated per-strategy grids.
 *
 * @param {object} opts
 * @param {string[]} [opts.strategies]       — defaults to all built-in strategies
 * @param {string} opts.startDate
 * @param {string} opts.endDate
 * @param {number} [opts.maxPositions=5]
 * @param {number} [opts.initialCapital=100000]
 * @param {object} [opts.execution={}]       — passed to runReplay (slippage, etc.)
 * @param {object} [opts.taxRates]           — { short, long } as decimals, e.g. {short:0.35, long:0.18}
 * @param {number} [opts.topK=10]            — how many top survivors to deep-dive
 * @param {boolean} [opts.runWalkForward=false]
 * @param {boolean} [opts.runMonteCarlo=false]
 * @param {function} [opts.onProgress]       — called as ({done, total, current, ...}) per combo
 *
 * @returns {object} { totalCombos, results[], topK[], topKDeepDive[], summary }
 */
async function runSweep(opts = {}) {
  const {
    strategies = Object.keys(STRATEGY_GRIDS),
    startDate, endDate,
    maxPositions = 5,
    initialCapital = 100_000,
    execution = {},
    taxRates = { short: DEFAULT_SHORT_TERM_RATE, long: DEFAULT_LONG_TERM_RATE },
    topK = 10,
    runWalkForward: doWF = false,
    runMonteCarlo: doMC = false,
    mcIterations = 1000,
    randomSamples = 0,
    slippageSweep = false,
    onProgress,
  } = opts;
  if (!startDate || !endDate) throw new Error('startDate and endDate required');

  // Build the full list of (strategy, combo, exit, regime, tradeMode) tuples.
  // When tradeMode is 'swing' or 'position' the engine's MODE_OVERRIDES
  // force the stop/target/hold values AND the exit pattern (position mode
  // = pyramid+scale; swing mode = full→full), so we strip those axes from
  // the combo to avoid sweeping equivalent runs. Net effect: each strategy
  // produces three flavors — Custom, Swing-preset, Position-preset.
  // short_breakdown is excluded from the position variant since the
  // position preset assumes long bias.
  const queue = [];
  for (const strategy of strategies) {
    if (!STRATEGY_GRIDS[strategy]) continue;
    const stratDef = BUILT_IN_STRATEGIES[strategy];
    const isShort = stratDef?.side === 'short';
    let combos = expandStrategyGrid(strategy);
    if (combos.length > MAX_COMBOS_PER_STRATEGY) {
      combos = combos.slice(0, MAX_COMBOS_PER_STRATEGY);
    }
    for (const combo of combos) {
      for (const tradeMode of TRADE_MODE_VARIANTS) {
        // Position preset is long-only; skip for short strategies.
        if (tradeMode === 'position' && isShort) continue;

        if (tradeMode == null) {
          // Custom flavor: full sweep over exit + strop/target/hold (already
          // baked into combo) + regime.
          for (const exit of EXIT_VARIANTS) {
            for (const sr of STRICT_REGIME_VARIANTS) {
              queue.push({ strategy, comboParams: combo, exit, strictRegime: sr, tradeMode: null });
            }
          }
        } else {
          // Mode-locked flavor: drop axes the engine will override anyway,
          // skip exit sweep (mode owns the exit), keep filter params + regime.
          const trimmed = { ...combo };
          for (const k of MODE_OVERRIDDEN_KEYS) delete trimmed[k];
          for (const sr of STRICT_REGIME_VARIANTS) {
            queue.push({
              strategy, comboParams: trimmed,
              // exit field carried for reporting only; engine ignores it
              // when tradeMode is set (MODE_OVERRIDES wins).
              exit: tradeMode === 'swing' ? 'full_in_full_out' : 'pyramid_auto',
              strictRegime: sr,
              tradeMode,
            });
          }
        }
      }
    }
    if (queue.length >= HARD_CAP_TOTAL_COMBOS) break;
  }

  // Random parameter sampling — adds N entries with parameters drawn
  // uniformly from each strategy's axis ranges. Catches interpolated
  // regions the discrete grid would miss (e.g. minRS=83 between 80 and
  // 85). Each random sample uses Custom flavor and full exit/regime
  // sweep would explode the count, so use one default exit + sweep regime.
  if (randomSamples > 0) {
    for (let s = 0; s < randomSamples; s++) {
      const strat = strategies[Math.floor(Math.random() * strategies.length)];
      const grid = STRATEGY_GRIDS[strat];
      if (!grid) continue;
      const sample = {};
      for (const [k, vals] of Object.entries(grid)) {
        if (k === '_signalSet' || !Array.isArray(vals)) continue;
        sample[k] = vals[Math.floor(Math.random() * vals.length)];
      }
      // Special-case factor_combo signal sets
      if (grid._signalSet) sample.signals = grid._signalSet[Math.floor(Math.random() * grid._signalSet.length)];
      for (const sr of STRICT_REGIME_VARIANTS) {
        queue.push({ strategy: strat, comboParams: sample, exit: 'pyramid_auto', strictRegime: sr, tradeMode: null, _isRandom: true });
      }
    }
  }

  // Slippage axis — re-runs each combo with 3 entry-slippage levels
  // (5/10/20 bps) so the user sees how brittle a strategy is to
  // execution costs. Triples combo count — opt-in via slippageSweep.
  let executionVariants = [{ ...execution }];
  if (slippageSweep) {
    executionVariants = [5, 10, 20].map(bps => ({ ...execution, entrySlippageBps: bps, exitSlippageBps: Math.max(2, Math.round(bps / 2)) }));
    // Multiply the queue: each combo × 3 slippage levels
    const expanded = [];
    for (const q of queue) {
      for (let i = 0; i < executionVariants.length; i++) {
        expanded.push({ ...q, _slippageBps: executionVariants[i].entrySlippageBps, _executionVariant: executionVariants[i] });
      }
    }
    queue.length = 0; queue.push(...expanded);
  }

  if (queue.length > HARD_CAP_TOTAL_COMBOS) queue.length = HARD_CAP_TOTAL_COMBOS;

  const total = queue.length;
  const results = [];
  let outperforming = 0;

  for (let i = 0; i < total; i++) {
    const q = queue[i];
    const r = evaluateOneCombo({
      ...q,
      startDate, endDate, maxPositions, initialCapital,
      // Slippage-axis combos carry their own execution variant; otherwise
      // use the global execution opts.
      execution: q._executionVariant || execution,
      taxRates,
    });
    // Decorate with axis-tag metadata so the UI can show what made each
    // combo distinct.
    if (q._slippageBps != null) r.slippageBps = q._slippageBps;
    if (q._isRandom) r.fromRandomSample = true;
    results.push(r);
    if (r.afterTaxAlpha != null && r.afterTaxAlpha > 0) outperforming++;
    if (onProgress && (i % 5 === 0 || i === total - 1)) {
      const flavor = q.tradeMode || 'custom';
      onProgress({
        done: i + 1,
        total,
        outperforming,
        current: `${q.strategy} · ${flavor} · ${q.strictRegime ? 'strict' : 'lenient'}`,
      });
    }
    // Yield to the event loop every 5 combos. node-cron's missed-tick
    // threshold is ~1 second; with replays running ~50-100ms each, a
    // 5-combo batch is ~250-500ms — comfortably under the threshold.
    // Yielding every combo (1×) was 5× slower because every setImmediate
    // gives ALL queued macrotasks a turn (including unrelated incoming
    // requests). Yielding every 10× let cron miss a tick. Five is the
    // sweet spot: cron stays on schedule AND the sweep stays fast.
    if (i % 5 === 4) await new Promise(r => setImmediate(r));
  }

  // Sort by after-tax alpha (primary) then pre-tax alpha (tiebreaker)
  const valid = results.filter(r => !r.error && r.afterTaxAlpha != null);
  valid.sort((a, b) => (b.afterTaxAlpha - a.afterTaxAlpha) || ((b.preTaxAlpha || 0) - (a.preTaxAlpha || 0)));

  const top = valid.slice(0, topK);

  // Optional: WF + MC on top-K survivors. Each WF can take multiple
  // minutes, so this only runs when the caller asked for it.
  const topKDeepDive = [];
  if ((doWF || doMC) && top.length) {
    for (let i = 0; i < top.length; i++) {
      const t = top[i];
      const params = buildParams(t.strategy, t.params, t.exit, t.strictRegime, t.tradeMode);
      const dive = { rank: i + 1, strategy: t.strategy, flavor: t.flavor, tradeMode: t.tradeMode, params: t.params, exit: t.exit, strictRegime: t.strictRegime };
      onProgress?.({ done: total, total, phase: 'deepDive', current: `WF/MC for #${i+1} ${t.strategy}` });

      if (doWF) {
        try {
          // Build a 2-axis grid around the chosen params for WF — pick
          // the two most-influential levers per strategy.
          const wfGrid = {};
          if (t.params.minRS !== undefined) wfGrid.minRS = [Math.max(50, t.params.minRS - 5), t.params.minRS, Math.min(99, t.params.minRS + 5)];
          if (t.params.holdDays !== undefined) wfGrid.holdDays = [t.params.holdDays - 5, t.params.holdDays, t.params.holdDays + 10].filter(v => v > 0);
          if (Object.keys(wfGrid).length < 2) {
            // Fallback: sweep stop/target if minRS/holdDays absent.
            wfGrid.stopATR = [t.params.stopATR || 1.5, (t.params.stopATR || 1.5) + 0.5];
            wfGrid.targetATR = [t.params.targetATR || 3.0, (t.params.targetATR || 3.0) + 1.0];
          }
          // Auto-size WF train/test from the actual date range so a
          // 6-month sweep doesn't waste WF on a single window. Aim for
          // 60% train / 40% test split with at least 3 windows.
          const spanDays = Math.max(1, Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000));
          const tradingDays = Math.max(1, Math.round(spanDays * 252 / 365));
          const wfTrainDays = Math.max(40, Math.min(180, Math.round(tradingDays * 0.6)));
          const wfTestDays  = Math.max(20, Math.min(90,  Math.round(tradingDays * 0.2)));
          const wf = runWalkForward({
            strategy: t.strategy,
            tradeMode: t.tradeMode || undefined,
            startDate, endDate,
            trainDays: wfTrainDays, testDays: wfTestDays,
            paramGrid: wfGrid, optimizeMetric: 'sharpeRatio',
            maxPositions, initialCapital, execution,
          });
          dive.walkForward = {
            oosReturn: wf.outOfSample?.totalReturn,
            oosMaxDD:  wf.outOfSample?.maxDrawdown,
            oosSharpe: wf.outOfSample?.sharpeRatio,
            oosAlpha:  wf.outOfSample?.alpha,
            oosTrades: wf.outOfSample?.tradeCount,
            paramStability: wf.parameterStability?.[0]?.share ?? null,
            windowsTested:  wf.config?.windowsTested,
          };
        } catch (e) { dive.walkForwardError = e.message; }
      }

      if (doMC) {
        try {
          // MC needs a trade list. Re-run the replay (we discarded it)
          // and feed its tradeLog to the MC engine.
          const re = runReplay({
            strategy: t.strategy,
            tradeMode: t.tradeMode || undefined,
            params, startDate, endDate,
            maxPositions, initialCapital, execution,
            persistResult: false,
          });
          if (re.tradeLog?.length >= 5) {
            const mc = runMonteCarlo({
              trades: re.tradeLog,
              iterations: mcIterations,
              method: 'permutation',
              positionFraction: 0.10,
              initialCapital,
            });
            dive.monteCarlo = {
              p5MaxDD:   mc.maxDrawdown?.p5,
              p50MaxDD:  mc.maxDrawdown?.p50,
              p95MaxDD:  mc.maxDrawdown?.p95,
              profitablePct: mc.profitableScenariosPct,
              losingStreakP95: mc.losingStreak?.p95,
            };
          } else {
            dive.monteCarloSkipped = `Only ${re.tradeLog?.length || 0} trades — MC needs ≥5`;
          }
        } catch (e) { dive.monteCarloError = e.message; }
      }

      topKDeepDive.push(dive);
      // Yield BEFORE the next deep-dive iteration too. WF runs combos ×
      // windows of synchronous replays internally; without a yield here
      // the deep-dive phase can lock the event loop for minutes per
      // top-K entry — far worse than the main sweep. Engine-level
      // yielding inside runWalkForward would be an even better fix; for
      // now this at least gives node-cron a tick between dives.
      await new Promise(r => setImmediate(r));
    }
  }

  // Headline summary — quick read for the UI.
  // Per-flavor breakdown (Custom / Swing / Position) so the user can see
  // whether the swing preset, the position preset, or fully custom param
  // combos won — directly answering "swing vs position trading?".
  const flavorBuckets = { Custom: [], Swing: [], Position: [] };
  for (const r of valid) (flavorBuckets[r.flavor] || flavorBuckets.Custom).push(r);
  const flavorStats = {};
  for (const [name, rows] of Object.entries(flavorBuckets)) {
    if (!rows.length) { flavorStats[name] = { count: 0 }; continue; }
    const sorted = rows.slice().sort((a, b) => b.afterTaxAlpha - a.afterTaxAlpha);
    flavorStats[name] = {
      count: rows.length,
      outperformingAfterTax: rows.filter(r => (r.afterTaxAlpha || 0) > 0).length,
      bestAfterTaxAlpha: sorted[0]?.afterTaxAlpha ?? null,
      bestRow: sorted[0] || null,
      medianAfterTaxAlpha: rows.length ? rows.slice().sort((a,b)=>a.afterTaxAlpha-b.afterTaxAlpha)[Math.floor(rows.length/2)].afterTaxAlpha : null,
    };
  }

  // Best-per-strategy mini-table — one row per strategy showing its best
  // configuration. Direct answer to "what's each strategy's ceiling on
  // this window?" instead of the top-25 being dominated by 5 variants of
  // a single winning strategy.
  const bestByStrategy = {};
  for (const r of valid) {
    const cur = bestByStrategy[r.strategy];
    if (!cur || r.afterTaxAlpha > cur.afterTaxAlpha) bestByStrategy[r.strategy] = r;
  }
  const bestByStrategyList = Object.values(bestByStrategy)
    .sort((a, b) => b.afterTaxAlpha - a.afterTaxAlpha);

  const summary = {
    totalCombos: total,
    successful: valid.length,
    erroredCombos: results.length - valid.length,
    outperformingPreTax:  valid.filter(r => (r.preTaxAlpha || 0) > 0).length,
    outperformingAfterTax: valid.filter(r => (r.afterTaxAlpha || 0) > 0).length,
    bestPreTaxAlpha:  valid.length ? Math.max(...valid.map(r => r.preTaxAlpha || -Infinity)) : null,
    bestAfterTaxAlpha: valid.length ? valid[0].afterTaxAlpha : null,
    bestEntry: valid[0] || null,
    flavorStats,
    bestByStrategy: bestByStrategyList,
    taxRates,
    slippageSweep,
    randomSamples,
    deepDive: doWF || doMC ? { topK: top.length, ranWF: doWF, ranMC: doMC, mcIterations: doMC ? mcIterations : null } : null,
  };

  return {
    totalCombos: total,
    results: valid,        // sorted desc by afterTaxAlpha
    erroredCombos: results.filter(r => r.error),
    topK: top,
    topKDeepDive,
    summary,
    config: {
      startDate, endDate,
      strategies, maxPositions, initialCapital,
      taxRates, topK,
      runWalkForward: doWF, runMonteCarlo: doMC,
    },
  };
}

// ─── Coverage preview (cheap — no engine calls) ──────────────────────────
// Returns the combo count + breakdown the UI shows BEFORE the user clicks
// START so they know what they're committing to ("1,350 combos · ~9 min").
//
// estimatedSec = combos × avgPerComboMs / 1000. avgPerComboMs is a rough
// constant calibrated from real sweeps (~50ms on a fresh server). The UI
// rounds up to the nearest minute and displays it as a hint.
const AVG_MS_PER_COMBO = 80;       // includes yield overhead

function previewSweep(opts = {}) {
  const {
    strategies = Object.keys(STRATEGY_GRIDS),
    slippageSweep = false,
    randomSamples = 0,
  } = opts;
  const perStrategyCounts = {};
  let total = 0;
  for (const strategy of strategies) {
    if (!STRATEGY_GRIDS[strategy]) continue;
    const stratDef = BUILT_IN_STRATEGIES[strategy];
    const isShort = stratDef?.side === 'short';
    let combos = expandStrategyGrid(strategy);
    if (combos.length > MAX_COMBOS_PER_STRATEGY) combos = combos.slice(0, MAX_COMBOS_PER_STRATEGY);
    let stratTotal = 0;
    for (const combo of combos) {
      // Custom flavor: 3 exits × 2 regime
      stratTotal += EXIT_VARIANTS.length * STRICT_REGIME_VARIANTS.length;
      // Swing: 2 regime
      stratTotal += STRICT_REGIME_VARIANTS.length;
      // Position: 2 regime, but only for long strategies
      if (!isShort) stratTotal += STRICT_REGIME_VARIANTS.length;
    }
    perStrategyCounts[strategy] = stratTotal;
    total += stratTotal;
  }
  if (slippageSweep) total *= 3;       // 3 slippage levels per combo
  if (randomSamples > 0) total += randomSamples * STRICT_REGIME_VARIANTS.length;  // random samples × regime
  if (total > HARD_CAP_TOTAL_COMBOS) total = HARD_CAP_TOTAL_COMBOS;
  return {
    totalCombos: total,
    perStrategyCounts,
    strategies,
    slippageSweep,
    randomSamples,
    estimatedSec: Math.round(total * AVG_MS_PER_COMBO / 1000),
  };
}

module.exports = {
  runSweep,
  previewSweep,
  STRATEGY_GRIDS,
  EXIT_VARIANTS,
  STRICT_REGIME_VARIANTS,
  DEFAULT_SHORT_TERM_RATE,
  DEFAULT_LONG_TERM_RATE,
  // exposed for tests
  expandStrategyGrid,
  applyTax,
};
