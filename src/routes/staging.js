// ─── /api/staging/* routes ──────────────────────────────────────────────────
// Order staging: create, review, and one-click submit bracket orders
const express = require('express');
const router  = express.Router();

const { stageOrder, stageFromSetup, getStagedOrders, getStagedOrder,
        submitStagedOrder, syncOrderStatus, cancelStagedOrder,
        modifyStagedEntryPrice } = require('../broker/staging');
const { notifyTradeEvent } = require('../notifications/channels');
const { computeTradeSetup } = require('../signals/candidates');
const { calculatePositionSize } = require('../risk/position-sizer');
const { calcConviction, evaluateConvictionOverride } = require('../signals/conviction');
const { getRSTrend } = require('../signals/rs');
const { loadHistory, RS_HISTORY } = require('../data/store');
const { getConfig } = require('../risk/portfolio');
const { getMarketRegime } = require('../risk/regime');

module.exports = function(db, runScan) {
  // ─── List staged orders ─────────────────────────────────────────────────────
  router.get('/staging', (req, res) => {
    try {
      const { status, symbol } = req.query;
      const orders = getStagedOrders({ status, symbol });
      res.json({ orders, count: orders.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Get single staged order ────────────────────────────────────────────────
  router.get('/staging/:id', (req, res) => {
    try {
      const order = getStagedOrder(+req.params.id);
      if (!order) return res.status(404).json({ error: 'Staged order not found' });
      res.json(order);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Stage order manually ──────────────────────────────────────────────────
  router.post('/staging', (req, res) => {
    try {
      const { symbol, entry_price, stop_price, target1_price, target2_price,
              qty, side, time_in_force, notes } = req.body;
      if (!symbol || !entry_price || !stop_price || !qty) {
        return res.status(400).json({ error: 'symbol, entry_price, stop_price, and qty required' });
      }
      const staged = stageOrder({
        symbol, entry_price, stop_price, target1_price, target2_price,
        qty, side, time_in_force, source: 'manual', notes,
      });
      res.json(staged);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Stage from trade setup (auto-calculate everything) ───────────────────
  router.post('/staging/from-setup', async (req, res) => {
    try {
      const { ticker, mode = 'swing', exitStrategy = 'full_in_scale_out', strategy,
              entryPrice: userEntryPrice, stopPrice: userStopPrice } = req.body;
      if (!ticker) return res.status(400).json({ error: 'ticker required' });

      // Run scanner to get fresh stock data
      const scanResults = await runScan();
      const stock = scanResults.find(s => s.ticker === ticker.toUpperCase());
      if (!stock) return res.status(404).json({ error: `${ticker} not found in scan results` });

      // If user supplied an entry price override, clone stock with the custom price
      // so computeTradeSetup bases stops/targets off the override.
      const effectiveStock = userEntryPrice != null
        ? { ...stock, price: parseFloat(userEntryPrice) }
        : stock;

      // Compute trade setup (uses effectiveStock.price for all level calculations)
      const setup = computeTradeSetup(effectiveStock, mode);

      const config = getConfig();
      const regime = await getMarketRegime();

      // ── Custom stop override ──
      // If user supplied a stop price, replace the computed stop with their value.
      // This recalculates R:R + position size so total $ risk stays at the
      // configured riskPerTrade (shares adjust: tighter stop = more shares,
      // wider stop = fewer shares). Lets the trader tighten on A+ VCP setups
      // or widen on pullback-to-50MA entries where noise is expected.
      const entryPrice = effectiveStock.price;
      let stopPrice;
      if (userStopPrice != null) {
        const overrideStop = parseFloat(userStopPrice);
        // Sanity: for longs, stop must be below entry. Reject otherwise.
        if (!(overrideStop > 0)) {
          return res.status(400).json({ error: 'stopPrice must be > 0' });
        }
        if (overrideStop >= entryPrice) {
          return res.status(400).json({ error: `Stop ($${overrideStop}) must be below entry ($${entryPrice}) for a long` });
        }
        stopPrice = overrideStop;
        const stopPct = +((entryPrice - stopPrice) / entryPrice * 100).toFixed(1);
        const t1 = parseFloat(setup.target1.replace(/[^0-9.]/g, ''));
        const rr = stopPrice < entryPrice ? +((t1 - entryPrice) / (entryPrice - stopPrice)).toFixed(2) : 0;
        setup.stopLevel = `$${stopPrice} (custom — ${stopPct}% below entry)`;
        setup.riskReward = `${rr}:1`;
        setup.stopPct = stopPct;
        setup.customStop = true;
      } else {
        stopPrice = parseFloat(setup.stopLevel.replace(/[^0-9.]/g, ''));
      }

      // Evaluate conviction override for weak regimes
      let convictionOverride = null;
      try {
        const history = loadHistory(RS_HISTORY);
        const trend = getRSTrend(stock.ticker, history);
        const { convictionScore } = calcConviction(stock, trend, null);
        convictionOverride = evaluateConvictionOverride(stock, convictionScore, regime);
      } catch (_) { /* non-critical */ }

      const sizing = calculatePositionSize({
        accountSize: config.accountSize,
        riskPerTrade: config.riskPerTrade,
        entryPrice,
        stopPrice,
        regimeMultiplier: regime.sizeMultiplier,
        convictionOverride,
        maxPositionPct: config.maxPositionPct,
        beta: stock.beta,
        atrPct: stock.atrPct,
        candidateSymbol: stock.ticker,
        side: 'buy',
        orderType: 'limit',
      });

      // Stage the bracket order
      const staged = stageFromSetup(stock, setup, sizing, mode === 'swing' ? 'swing' : 'position', exitStrategy, strategy);

      res.json({
        staged,
        setup,
        sizing: {
          shares: sizing.shares,
          dollarRisk: sizing.dollarRisk,
          positionValue: sizing.positionValue,
          portfolioPct: sizing.portfolioPct,
          regimeMultiplier: regime.sizeMultiplier,
          effectiveRegimeMult: sizing.effectiveRegimeMult,
          convictionOverride: sizing.convictionOverride,
          betaMultiplier: sizing.betaMultiplier,
          volMultiplier: sizing.volMultiplier,
          totalMultiplier: sizing.totalMultiplier,
          beta: sizing.beta,
          atrPct: sizing.atrPct,
          // Phase 2.9 — slippage prediction surfaced for the UI
          slippagePrediction: sizing.slippagePrediction || null,
          intendedEntry: sizing.intendedEntry || entryPrice,
          effectiveEntry: sizing.effectiveEntry || entryPrice,
        },
        exitStrategy,
        stock: {
          ticker: stock.ticker,
          price: stock.price,
          rsRank: stock.rsRank,
          sepaScore: stock.sepaScore,
          convictionScore: stock.convictionScore,
        },
        entryPriceOverride: userEntryPrice != null ? parseFloat(userEntryPrice) : null,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Submit staged order (one-click) ───────────────────────────────────────
  // Body may include { allowWashSale: true } to override the wash-sale blocker.
  router.post('/staging/:id/submit', async (req, res) => {
    try {
      const overrides = {};
      if (req.body?.allowWashSale) overrides.allowWashSale = true;
      const result = await submitStagedOrder(+req.params.id, overrides);
      res.json(result);
    } catch (e) {
      // Forward the structured riskCheck so the frontend can render per-gate details
      // instead of a flat "Pre-trade check failed: Rule1, Rule2" string.
      res.status(400).json({
        error: e.message,
        riskCheck: e.riskCheck || null,
      });
    }
  });

  // ─── Cancel staged order ──────────────────────────────────────────────────
  router.post('/staging/:id/cancel', async (req, res) => {
    try {
      const result = await cancelStagedOrder(+req.params.id);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Arm submission gate on a staged order ───────────────────────────────
  // Flips status 'staged' → 'pending_trigger' and writes the gate config JSON.
  // The vwap_gate_check cron walks pending_trigger rows every 5 minutes,
  // evaluates each configured gate, and promotes the row back to 'staged'
  // (then submits it) once ALL configured gates pass.
  //
  // Each gate is opt-in. Body fields control which gates apply:
  //
  // Body: {
  //   triggerPrice?: 280.98,    // pivot trigger — long: price≥this; short: ≤
  //   volumePaceMin?: 1.4,      // CANSLIM-style volume confirmation
  //   minutes?: 39,             // candle duration for VWAP reclaim (default 39)
  //   gapUpLimitPct?: 0.02,      // reject gap up > this (default 2%)
  //   gapDownLimitPct?: 0.02,    // reject gap down > this (default 2%)
  //   requireAboveVWAP?: true,   // long side default
  //   earliestAfterOpenMin?: 39, // min minutes post-open before evaluating
  //   cancelOnFail?: false,      // if true, fail → cancel; else leaves pending
  //   expiresAt?: 'YYYY-MM-DD',  // optional auto-cancel date
  // }
  router.post('/staging/:id/arm-gate', (req, res) => {
    try {
      const id = +req.params.id;
      const existing = getStagedOrder(id);
      if (!existing) return res.status(404).json({ error: 'Staged order not found' });
      if (existing.status !== 'staged' && existing.status !== 'pending_trigger') {
        return res.status(400).json({ error: `Cannot arm gate: order is ${existing.status}, must be staged or pending_trigger` });
      }

      const body = req.body || {};
      // Build gate JSON with only the fields the caller specified — leaving
      // a gate unset means "don't enforce it." This lets a breakout gate
      // (triggerPrice + volumePaceMin only) skip VWAP/gap entirely instead
      // of inheriting defaults that would block the fire.
      const gate = {};
      if (body.triggerPrice != null)       gate.triggerPrice       = +body.triggerPrice;
      if (body.volumePaceMin != null)      gate.volumePaceMin      = +body.volumePaceMin;
      if (body.requireAboveVWAP != null)   gate.requireAboveVWAP   = !!body.requireAboveVWAP;
      if (body.gapUpLimitPct != null)      gate.gapUpLimitPct      = +body.gapUpLimitPct;
      if (body.gapDownLimitPct != null)    gate.gapDownLimitPct    = +body.gapDownLimitPct;
      if (body.minutes != null)            gate.minutes            = +body.minutes;
      if (body.earliestAfterOpenMin != null) gate.earliestAfterOpenMin = +body.earliestAfterOpenMin;
      if (body.cancelOnFail)               gate.cancelOnFail       = true;
      if (body.expiresAt)                  gate.expiresAt          = body.expiresAt;

      // Sanity: at least one gate must be configured, else this is a no-op
      // that just leaves the row stuck in pending_trigger forever.
      const hasAnyGate = gate.triggerPrice != null
        || gate.volumePaceMin != null
        || gate.requireAboveVWAP != null
        || gate.gapUpLimitPct != null
        || gate.gapDownLimitPct != null;
      if (!hasAnyGate) {
        return res.status(400).json({
          error: 'arm-gate requires at least one of: triggerPrice, volumePaceMin, requireAboveVWAP, gapUpLimitPct, gapDownLimitPct',
        });
      }

      db.prepare(
        "UPDATE staged_orders SET status = 'pending_trigger', submission_gate = ? WHERE id = ?"
      ).run(JSON.stringify(gate), id);

      // Phone notification — user wants to know when an entry is armed so
      // they can monitor / cancel without having to refresh the UI.
      const gateLabels = [];
      if (gate.triggerPrice != null)     gateLabels.push(`trigger $${gate.triggerPrice}`);
      if (gate.volumePaceMin != null)    gateLabels.push(`vol ≥${gate.volumePaceMin}×`);
      if (gate.requireAboveVWAP != null) gateLabels.push(`VWAP reclaim`);
      if (gate.gapUpLimitPct != null || gate.gapDownLimitPct != null) gateLabels.push('gap bounds');
      notifyTradeEvent({
        event: 'entry_armed',
        symbol: existing.symbol,
        details: {
          message: `${existing.symbol} entry armed — waiting for: ${gateLabels.join(' + ')}`,
          trigger_price: gate.triggerPrice,
          volume_pace_min: gate.volumePaceMin,
          gates: gateLabels,
        },
      }).catch(() => {});

      res.json({ id, gate, status: 'pending_trigger' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Disarm gate — revert to plain staged ────────────────────────────────
  router.post('/staging/:id/disarm-gate', (req, res) => {
    try {
      const id = +req.params.id;
      const existing = getStagedOrder(id);
      if (!existing) return res.status(404).json({ error: 'Staged order not found' });
      if (existing.status !== 'pending_trigger') {
        return res.status(400).json({ error: `Cannot disarm: order is ${existing.status}` });
      }
      db.prepare(
        "UPDATE staged_orders SET status = 'staged', submission_gate = NULL WHERE id = ?"
      ).run(id);
      res.json({ id, status: 'staged' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Preview gate evaluation without submitting ──────────────────────────
  router.get('/staging/:id/gate-status', async (req, res) => {
    try {
      const id = +req.params.id;
      const row = getStagedOrder(id);
      if (!row) return res.status(404).json({ error: 'Staged order not found' });
      if (!row.submission_gate) return res.json({ id, hasGate: false });

      const { evaluateGate } = require('../broker/vwap-gate');
      let gateCfg;
      try { gateCfg = JSON.parse(row.submission_gate); }
      catch (_) { return res.status(500).json({ error: 'Invalid submission_gate JSON on row' }); }

      const verdict = await evaluateGate(row, gateCfg);
      res.json({ id, hasGate: true, status: row.status, gateConfig: gateCfg, verdict });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Modify entry price on staged or submitted order ──────────────────────
  // Body: { newEntryPrice: number }
  // For submitted multi-tranche brackets, patches all tranche parents at Alpaca.
  router.post('/staging/:id/modify-entry', async (req, res) => {
    try {
      const newEntryPrice = +req.body?.newEntryPrice;
      if (!(newEntryPrice > 0)) {
        return res.status(400).json({ error: 'newEntryPrice must be a positive number' });
      }
      const result = await modifyStagedEntryPrice(+req.params.id, newEntryPrice);
      res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ─── Sync order status from Alpaca ────────────────────────────────────────
  router.get('/staging/:id/status', async (req, res) => {
    try {
      const result = await syncOrderStatus(+req.params.id);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Phase 2: Conditional Entries ──────────────────────────────────────────

  router.post('/staging/conditional', (req, res) => {
    try {
      const { createConditionalEntry } = require('../broker/auto-stage');
      const { symbol, conditionType = 'pullback', triggerPrice, entryPrice, stopPrice,
              target1Price, target2Price, qty, side = 'buy', source = 'manual',
              convictionScore, expiryDate } = req.body;
      if (!symbol || !triggerPrice || !entryPrice || !stopPrice || !qty) {
        return res.status(400).json({ error: 'symbol, triggerPrice, entryPrice, stopPrice, qty required' });
      }
      const entry = createConditionalEntry({
        symbol, conditionType, triggerPrice, entryPrice, stopPrice,
        target1Price, target2Price, qty, side, source, convictionScore, expiryDate,
      });
      res.json(entry);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/staging/conditional', (req, res) => {
    try {
      const { getConditionalEntries } = require('../broker/auto-stage');
      const status = req.query.status || null;
      const entries = getConditionalEntries(status);
      res.json({ entries, count: entries.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/staging/conditional/:id', (req, res) => {
    try {
      const { cancelConditionalEntry } = require('../broker/auto-stage');
      cancelConditionalEntry(+req.params.id);
      res.json({ cancelled: true, id: +req.params.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Phase 2: Auto-Stage from Trade Briefs ─────────────────────────────────

  router.post('/staging/from-brief', (req, res) => {
    try {
      const { autoStageFromTradeBriefs } = require('../broker/auto-stage');
      const briefs = req.body.briefs || [req.body];
      const result = autoStageFromTradeBriefs(briefs);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Phase 2: Auto-Stage from Watchlist ─────────────────────────────────────

  router.post('/staging/auto-stage', async (req, res) => {
    try {
      const { autoStageFromWatchlist } = require('../broker/auto-stage');
      const { cacheGet, TTL_QUOTE } = require('../data/cache');
      const scanData = cacheGet('rs:full', TTL_QUOTE);
      if (!scanData?.length) return res.status(400).json({ error: 'No scan data available — run RS scan first' });

      // Get watchlist symbols
      let watchlistSymbols = req.body.symbols || [];
      if (!watchlistSymbols.length) {
        try {
          const fs = require('fs');
          const path = require('path');
          const wlPath = path.join(__dirname, '..', '..', 'data', 'watchlist.json');
          if (fs.existsSync(wlPath)) {
            const wl = JSON.parse(fs.readFileSync(wlPath, 'utf8'));
            watchlistSymbols = Array.isArray(wl) ? wl.map(w => w.symbol || w) : [];
          }
        } catch (_) {}
      }

      if (!watchlistSymbols.length) return res.status(400).json({ error: 'No watchlist symbols — pass symbols in body or add to watchlist.json' });

      const regime = await getMarketRegime();
      const config = getConfig();
      const result = autoStageFromWatchlist(watchlistSymbols, scanData, {
        accountSize: config.accountSize,
        riskPerTrade: config.riskPerTrade,
        regimeMultiplier: regime.sizeMultiplier,
      });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Phase 2: Stage with Scale-In Plan ─────────────────────────────────────

  router.post('/staging/from-setup-scaled', async (req, res) => {
    try {
      const { symbol, entry_price, stop_price, target1_price, target2_price,
              total_qty, side = 'buy', source = 'scaled' } = req.body;
      if (!symbol || !entry_price || !stop_price || !total_qty) {
        return res.status(400).json({ error: 'symbol, entry_price, stop_price, total_qty required' });
      }

      // Stage pilot tranche (1/3)
      const pilotQty = Math.max(1, Math.ceil(total_qty / 3));
      const staged = stageOrder({
        symbol, side, order_type: 'limit', qty: pilotQty,
        entry_price, stop_price, target1_price, target2_price,
        source: `${source}_pilot`, notes: `Pilot tranche (1/3 of ${total_qty}). Scale-in plan pending.`,
      });

      res.json({
        staged,
        scaleInNote: `Pilot ${pilotQty}/${total_qty} shares staged. Create scale-in plan after trade entry.`,
        totalShares: total_qty,
        tranches: {
          pilot: pilotQty,
          confirmation: Math.ceil((total_qty - pilotQty) / 2),
          breakout: total_qty - pilotQty - Math.ceil((total_qty - pilotQty) / 2),
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
