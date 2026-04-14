// ─── /api/strategies/* routes ────────────────────────────────────────────────
// Multi-strategy allocation, performance tracking, risk analysis
const express = require('express');
const router  = express.Router();

const {
  getStrategies,
  getStrategyPerformance,
  getStrategyAllocation,
  validateTradeForStrategy,
  rebalanceStrategies,
  assignStrategy,
  getCorrelatedRisk,
  DEFAULT_STRATEGIES,
} = require('../risk/strategy-manager');

const { getConfig } = require('../risk/portfolio');

// ─── DB Initialization ─────────────────────────────────────────────────────
function initStrategiesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      allocation_pct REAL NOT NULL DEFAULT 25,
      max_positions INTEGER DEFAULT 5,
      max_heat_pct REAL DEFAULT 3,
      holding_period_min INTEGER DEFAULT 1,
      holding_period_max INTEGER DEFAULT 60,
      entry_rules JSON DEFAULT '{}',
      exit_rules JSON DEFAULT '{}',
      enabled BOOLEAN DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed defaults if empty
  const count = db.prepare('SELECT COUNT(*) as cnt FROM strategies').get();
  if (count.cnt === 0) {
    const insert = db.prepare(`
      INSERT INTO strategies
        (id, name, type, allocation_pct, max_positions, max_heat_pct,
         holding_period_min, holding_period_max, entry_rules, exit_rules, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = db.transaction(() => {
      for (const s of DEFAULT_STRATEGIES) {
        insert.run(
          s.id, s.name, s.type, s.allocation_pct, s.max_positions, s.max_heat_pct,
          s.holding_period_min, s.holding_period_max, s.entry_rules, s.exit_rules, s.enabled
        );
      }
    });
    txn();
  }
}

module.exports = function(db) {
  // Initialize table on first load
  initStrategiesTable(db);

  // ─── GET /api/strategies — List all strategies with allocation ────────────
  router.get('/strategies', (req, res) => {
    try {
      const config = getConfig();
      const accountSize = config.accountSize;
      const allocation = getStrategyAllocation(db, accountSize);
      res.json(allocation);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── GET /api/strategies/allocation — Current allocation state ────────────
  // NOTE: Literal paths MUST be registered before parameterized :id routes
  router.get('/strategies/allocation', (req, res) => {
    try {
      const config = getConfig();
      const accountSize = +(req.query.accountSize || config.accountSize);
      const allocation = getStrategyAllocation(db, accountSize);
      res.json(allocation);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── GET /api/strategies/rebalance — Rebalancing recommendations ──────────
  router.get('/strategies/rebalance', (req, res) => {
    try {
      const config = getConfig();
      const accountSize = +(req.query.accountSize || config.accountSize);
      const result = rebalanceStrategies(db, accountSize);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── GET /api/strategies/risk — Cross-strategy risk analysis ──────────────
  router.get('/strategies/risk', (req, res) => {
    try {
      const config = getConfig();
      const accountSize = +(req.query.accountSize || config.accountSize);
      const risk = getCorrelatedRisk(db, accountSize);
      res.json(risk);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── POST /api/strategies/backfill — Auto-assign strategy to untagged trades
  router.post('/strategies/backfill', (req, res) => {
    try {
      const untagged = db.prepare(
        `SELECT t.id, t.symbol, t.entry_rs, t.entry_sepa
         FROM trades t WHERE t.strategy IS NULL`
      ).all();

      if (untagged.length === 0) {
        return res.json({ ok: true, updated: 0, message: 'All trades already have strategies assigned' });
      }

      let updated = 0;
      const updateStmt = db.prepare('UPDATE trades SET strategy = ? WHERE id = ?');

      for (const trade of untagged) {
        // Look up scan data for richer classification
        let scanData = {};
        try {
          const scanRow = db.prepare(
            `SELECT data FROM scan_results WHERE symbol = ? ORDER BY date DESC LIMIT 1`
          ).get(trade.symbol);
          if (scanRow) scanData = JSON.parse(scanRow.data);
        } catch (_) {}

        const assigned = assignStrategy({
          symbol: trade.symbol,
          rsRank: trade.entry_rs || scanData.rsRank || 0,
          swingMomentum: scanData.swingMomentum || 0,
          vcpForming: scanData.vcpForming || false,
          patternDetected: scanData.bestPattern || false,
        });

        updateStmt.run(assigned.strategy, trade.id);
        console.log(`  Strategy backfill: ${trade.symbol} → ${assigned.strategy} (${assigned.confidence}%: ${assigned.reasons.join(', ')})`);
        updated++;
      }

      res.json({ ok: true, updated, total: untagged.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── POST /api/strategies/validate — Pre-trade validation ─────────────────
  // NOTE: Must be before POST /strategies/:id to avoid "validate" matching as :id
  router.post('/strategies/validate', (req, res) => {
    try {
      const { strategyId, symbol, entry, stop, shares, holdingPeriod } = req.body;

      if (!strategyId) {
        return res.status(400).json({ error: 'strategyId required' });
      }
      if (!entry || !stop || !shares) {
        return res.status(400).json({ error: 'entry, stop, and shares required' });
      }

      const config = getConfig();
      const trade = { symbol, entry, stop, shares, holdingPeriod };
      const result = validateTradeForStrategy(db, strategyId, trade, config.accountSize);

      // Also include auto-assignment suggestion
      const assignment = assignStrategy({
        symbol,
        rs_rank: req.body.rsRank || req.body.rs_rank,
        swing_momentum: req.body.swingMomentum || req.body.swing_momentum,
        vcp_forming: req.body.vcpForming || req.body.vcp_forming,
        holdingPeriod,
      });

      res.json({
        ...result,
        suggestedStrategy: assignment,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── GET /api/strategies/:id/performance — Strategy P&L ──────────────────
  // NOTE: Parameterized routes come AFTER all literal paths
  router.get('/strategies/:id/performance', (req, res) => {
    try {
      const { id } = req.params;
      const { start, end } = req.query;

      // Validate strategy exists
      const strategies = getStrategies(db);
      if (!strategies.find(s => s.id === id)) {
        return res.status(404).json({ error: `Strategy "${id}" not found` });
      }

      const performance = getStrategyPerformance(db, id, start || null, end || null);
      res.json(performance);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── POST /api/strategies/:id — Update strategy config ───────────────────
  router.post('/strategies/:id', (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Verify strategy exists
      const existing = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
      if (!existing) {
        return res.status(404).json({ error: `Strategy "${id}" not found` });
      }

      // Build dynamic UPDATE statement from provided fields
      const allowedFields = [
        'name', 'type', 'allocation_pct', 'max_positions', 'max_heat_pct',
        'holding_period_min', 'holding_period_max', 'entry_rules', 'exit_rules', 'enabled',
      ];

      // Map camelCase to snake_case
      const fieldMap = {
        allocationPct: 'allocation_pct',
        maxPositions: 'max_positions',
        maxHeatPct: 'max_heat_pct',
        holdingPeriodMin: 'holding_period_min',
        holdingPeriodMax: 'holding_period_max',
        entryRules: 'entry_rules',
        exitRules: 'exit_rules',
      };

      const setClauses = [];
      const values = [];

      for (const [key, value] of Object.entries(updates)) {
        const dbField = fieldMap[key] || key;
        if (!allowedFields.includes(dbField)) continue;

        // Serialize objects to JSON for rules columns
        const dbValue = (dbField === 'entry_rules' || dbField === 'exit_rules') && typeof value === 'object'
          ? JSON.stringify(value)
          : value;

        setClauses.push(`${dbField} = ?`);
        values.push(dbValue);
      }

      if (setClauses.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      // Validate total allocation does not exceed 100%
      if (updates.allocation_pct != null || updates.allocationPct != null) {
        const newPct = updates.allocation_pct ?? updates.allocationPct;
        const otherTotal = db.prepare(
          'SELECT COALESCE(SUM(allocation_pct), 0) as total FROM strategies WHERE id != ? AND enabled = 1'
        ).get(id).total;
        if (otherTotal + newPct > 100) {
          return res.status(400).json({
            error: `Total allocation would be ${(otherTotal + newPct).toFixed(1)}% (max 100%). Other strategies use ${otherTotal.toFixed(1)}%.`,
          });
        }
      }

      setClauses.push("updated_at = datetime('now')");
      values.push(id);

      db.prepare(`UPDATE strategies SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

      const updated = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
      res.json({
        message: `Strategy "${id}" updated`,
        strategy: updated,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
