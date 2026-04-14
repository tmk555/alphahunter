// ─── /api/options/* routes — Options chain, hedging, order execution ────────
const express = require('express');
const router  = express.Router();

const options = require('../broker/options');

module.exports = function(db) {

  // ─── Options Chain ─────────────────────────────────────────────────────────
  // GET /api/options/chain/:symbol?expiration=2025-05-16
  router.get('/options/chain/:symbol', async (req, res) => {
    try {
      const { symbol } = req.params;
      const { expiration } = req.query;
      const chain = await options.getOptionsChain(symbol, expiration || null);
      res.json(chain);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Options Positions ─────────────────────────────────────────────────────
  // GET /api/options/positions
  router.get('/options/positions', async (req, res) => {
    try {
      const result = await options.getOptionsPositions();
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Submit Options Order ──────────────────────────────────────────────────
  // POST /api/options/order
  // body: { symbol, qty, side, type, timeInForce, limitPrice }
  router.post('/options/order', async (req, res) => {
    try {
      const { symbol, qty, side, type, timeInForce, limitPrice } = req.body;
      if (!symbol || !qty || !side) {
        return res.status(400).json({ error: 'symbol, qty, and side are required' });
      }
      const confirmation = await options.submitOptionsOrder({
        symbol, qty: +qty, side, type, timeInForce, limitPrice: limitPrice ? +limitPrice : undefined,
      });
      res.json({ ok: true, order: confirmation, live: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Protective Put ────────────────────────────────────────────────────────
  // POST /api/options/hedge/protective-put
  // body: { symbol, shares, hedgeRatio, execute }
  router.post('/options/hedge/protective-put', async (req, res) => {
    try {
      const { symbol, shares, hedgeRatio, execute } = req.body;
      if (!symbol) {
        return res.status(400).json({ error: 'symbol is required' });
      }

      // Get current stock price
      const chain = await options.getOptionsChain(symbol);
      const stockPrice = chain.stockPrice || inferPriceFromChain(chain);
      if (!stockPrice) {
        return res.status(400).json({ error: `Could not determine price for ${symbol}` });
      }

      // Calculate portfolio value from positions or use provided shares
      const portfolioValue = await getPortfolioValue(db, symbol, shares, stockPrice);

      const plan = options.buildProtectivePut(
        symbol, stockPrice, portfolioValue, hedgeRatio || 0.10
      );

      // Optionally execute the trade
      if (execute) {
        try {
          const order = await options.submitOptionsOrder(plan.order);
          return res.json({ plan, executed: true, order, live: true });
        } catch (orderErr) {
          return res.json({ plan, executed: false, orderError: orderErr.message, live: false });
        }
      }

      res.json({ plan, executed: false, live: chain.live || false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Collar ────────────────────────────────────────────────────────────────
  // POST /api/options/hedge/collar
  // body: { symbol, shares, execute }
  router.post('/options/hedge/collar', async (req, res) => {
    try {
      const { symbol, shares, execute } = req.body;
      if (!symbol) {
        return res.status(400).json({ error: 'symbol is required' });
      }

      const chain = await options.getOptionsChain(symbol);
      const stockPrice = chain.stockPrice || inferPriceFromChain(chain);
      if (!stockPrice) {
        return res.status(400).json({ error: `Could not determine price for ${symbol}` });
      }

      const actualShares = shares || await getShareCount(db, symbol);
      if (!actualShares || actualShares < 100) {
        return res.status(400).json({
          error: 'Collar requires at least 100 shares. Provide shares count or hold the position.',
        });
      }

      const plan = options.buildCollar(symbol, stockPrice, actualShares);

      if (execute) {
        const results = { put: null, call: null, errors: [] };
        try {
          results.put = await options.submitOptionsOrder(plan.put.order);
        } catch (e) { results.errors.push({ leg: 'put', error: e.message }); }
        try {
          results.call = await options.submitOptionsOrder(plan.call.order);
        } catch (e) { results.errors.push({ leg: 'call', error: e.message }); }

        return res.json({
          plan,
          executed: results.errors.length === 0,
          orders: results,
          live: true,
        });
      }

      res.json({ plan, executed: false, live: chain.live || false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── VIX Hedge ─────────────────────────────────────────────────────────────
  // POST /api/options/hedge/vix
  // body: { hedgeRatio, vixLevel, portfolioValue }
  router.post('/options/hedge/vix', async (req, res) => {
    try {
      const { hedgeRatio, vixLevel, portfolioValue } = req.body;

      // Try to get current VIX level and portfolio value
      let vix = vixLevel;
      if (!vix) {
        try {
          const vixChain = await options.getOptionsChain('VIX');
          vix = vixChain.stockPrice || 18;
        } catch (_) { vix = 18; }
      }

      let portValue = portfolioValue;
      if (!portValue) {
        portValue = await getTotalPortfolioValue(db);
      }

      const plan = options.buildVIXHedge(vix, portValue, hedgeRatio || 0.003);
      res.json({ plan, live: false }); // VIX hedges are always planned, never auto-executed
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Full Portfolio Hedge Recommendation ───────────────────────────────────
  // GET /api/options/portfolio-hedge
  // Integrates with the hedge framework to provide executable options plans.
  router.get('/options/portfolio-hedge', async (req, res) => {
    try {
      const hedgeFramework = require('../risk/hedge-framework');
      const { getPortfolioHeat } = require('../risk/portfolio');

      // Gather portfolio data
      const openPositions = db.prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();
      const heat = getPortfolioHeat(openPositions);

      // Get market conditions
      let vixLevel = 20;
      let spyPrice = 540;
      try {
        const { getMarketRegime } = require('../risk/regime');
        const regime = await getMarketRegime();
        vixLevel = regime.vixLevel || 20;
      } catch (_) { /* use defaults */ }

      try {
        const spyChain = await options.getOptionsChain('SPY');
        spyPrice = spyChain.stockPrice || 540;
      } catch (_) { /* use default */ }

      // Calculate hedge ratio
      const portfolioValue = heat.totalExposure || await getTotalPortfolioValue(db);
      const hedgeCalc = hedgeFramework.calculateHedgeRatio({
        portfolioBeta: heat.avgBeta || 1.0,
        breadthScore: 50, // could integrate breadth engine here
        vixLevel,
        drawdownPct: heat.drawdownPct || 0,
        maxDrawdownTarget: 10,
        portfolioValue,
        currentHedgeValue: 0,
      });

      // Build executable options for each recommendation type
      const executableHedges = [];

      // 1. SPY protective put for broad portfolio hedge
      if (portfolioValue > 0) {
        const spyPut = options.buildProtectivePut(
          'SPY', spyPrice, portfolioValue, hedgeCalc.recommendedHedgeRatio * 0.5
        );
        executableHedges.push({
          type: 'PROTECTIVE_PUT',
          instrument: 'SPY',
          priority: 1,
          ...spyPut,
        });
      }

      // 2. Collars for concentrated positions (>10% of portfolio)
      for (const pos of openPositions) {
        const posValue = (pos.shares || 0) * (pos.current_price || pos.entry_price || 0);
        if (portfolioValue > 0 && posValue / portfolioValue > 0.10 && (pos.shares || 0) >= 100) {
          const collar = options.buildCollar(
            pos.symbol,
            pos.current_price || pos.entry_price,
            pos.shares
          );
          executableHedges.push({
            type: 'COLLAR',
            instrument: pos.symbol,
            priority: 2,
            positionPct: +((posValue / portfolioValue) * 100).toFixed(1),
            ...collar,
          });
        }
      }

      // 3. VIX tail hedge
      const vixHedge = options.buildVIXHedge(
        vixLevel, portfolioValue, 0.003
      );
      executableHedges.push({
        type: 'VIX_CALL_SPREAD',
        instrument: 'VIX',
        priority: 3,
        ...vixHedge,
      });

      // Framework recommendations (non-executable analysis)
      const frameworkRec = hedgeFramework.recommendHedgeInstruments({
        portfolioValue,
        portfolioBeta: heat.avgBeta || 1.0,
        hedgeRatio: hedgeCalc.recommendedHedgeRatio,
        vixLevel,
        spyPrice,
        timeHorizon: 30,
      });

      res.json({
        hedgeRatio: hedgeCalc,
        executableHedges,
        frameworkAnalysis: frameworkRec,
        portfolio: {
          value: portfolioValue,
          positionCount: openPositions.length,
          beta: heat.avgBeta || 1.0,
        },
        marketConditions: { vixLevel, spyPrice },
        live: false, // plans are always estimates until executed
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function inferPriceFromChain(chain) {
  // Infer stock price from ATM options (where call and put prices are closest)
  if (!chain.calls || chain.calls.length === 0) return null;

  // The ATM strike is where the call price equals the put price
  // Approximate: use the strike closest to the midpoint of all strikes
  const strikes = chain.calls.map(c => c.strike);
  const mid = (strikes[0] + strikes[strikes.length - 1]) / 2;

  // Find the call with the smallest bid-ask spread near the midpoint
  let best = chain.calls[0];
  let bestDiff = Infinity;
  for (const c of chain.calls) {
    const diff = Math.abs(c.strike - mid);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }

  // ATM call price roughly equals: intrinsic + time value
  // For ATM options, intrinsic is ~0, so price is all time value
  // The underlying is approximately at the strike of the ATM option
  return best.strike;
}

async function getPortfolioValue(db, symbol, shares, stockPrice) {
  if (shares) return shares * stockPrice;

  // Try to get from trades table
  try {
    const trade = db.prepare(
      'SELECT shares, entry_price FROM trades WHERE symbol = ? AND exit_date IS NULL ORDER BY entry_date DESC LIMIT 1'
    ).get(symbol);
    if (trade && trade.shares) return trade.shares * stockPrice;
  } catch (_) { /* fall through */ }

  return await getTotalPortfolioValue(db);
}

async function getShareCount(db, symbol) {
  try {
    const trade = db.prepare(
      'SELECT shares FROM trades WHERE symbol = ? AND exit_date IS NULL ORDER BY entry_date DESC LIMIT 1'
    ).get(symbol);
    return trade ? trade.shares : 0;
  } catch (_) { return 0; }
}

async function getTotalPortfolioValue(db) {
  try {
    const alpaca = require('../broker/alpaca');
    const account = await alpaca.getAccount();
    return +account.portfolio_value || +account.equity || 100000;
  } catch (_) {
    // Fallback: sum of open trade values
    try {
      const trades = db.prepare('SELECT shares, entry_price FROM trades WHERE exit_date IS NULL').all();
      const total = trades.reduce((sum, t) => sum + (t.shares || 0) * (t.entry_price || 0), 0);
      return total || 100000;
    } catch (__) { return 100000; }
  }
}
