// ─── SQLite Database Setup ───────────────────────────────────────────────────
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'alphahunter.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null;

function getDB() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');        // Write-Ahead Logging for concurrency
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');      // Safe with WAL, fewer fsync calls
  db.pragma('cache_size = 10000');         // ~40MB cache for faster reads
  db.pragma('temp_store = MEMORY');        // Temp tables in RAM
  initSchema();
  return db;
}

function safeAddColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function initSchema() {
  db.exec(`
    -- Daily RS snapshots (replaces rs-history JSON files)
    CREATE TABLE IF NOT EXISTS rs_snapshots (
      date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('stock','sector','industry')),
      rs_rank INTEGER,
      raw_rs REAL,
      swing_momentum INTEGER,
      sepa_score INTEGER,
      stage INTEGER,
      price REAL,
      vs_ma50 REAL,
      vs_ma200 REAL,
      volume_ratio REAL,
      vcp_forming BOOLEAN DEFAULT 0,
      rs_line_new_high BOOLEAN DEFAULT 0,
      PRIMARY KEY (date, symbol, type)
    );

    -- Full scan results for backtesting
    CREATE TABLE IF NOT EXISTS scan_results (
      date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      data JSON NOT NULL,
      conviction_score REAL,
      PRIMARY KEY (date, symbol)
    );

    -- Trade journal
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'long',
      sector TEXT,
      entry_date TEXT NOT NULL,
      entry_price REAL NOT NULL,
      entry_rs INTEGER,
      entry_sepa INTEGER,
      entry_regime TEXT,
      stop_price REAL,
      target1 REAL,
      target2 REAL,
      exit_date TEXT,
      exit_price REAL,
      exit_reason TEXT,
      pnl_dollars REAL,
      pnl_percent REAL,
      r_multiple REAL,
      shares INTEGER,
      wave TEXT,
      notes TEXT,
      alpaca_order_id TEXT,
      needs_review INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Market regime log
    CREATE TABLE IF NOT EXISTS regime_log (
      date TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      confidence INTEGER,
      spy_price REAL,
      vix_level REAL,
      dist_days INTEGER,
      breadth_pct REAL,
      ftd_date TEXT,
      rally_day INTEGER,
      notes TEXT
    );

    -- Universe management
    CREATE TABLE IF NOT EXISTS universe_mgmt (
      symbol TEXT PRIMARY KEY,
      sector TEXT NOT NULL,
      added_date TEXT DEFAULT (date('now')),
      removed_date TEXT,
      reason TEXT,
      source TEXT DEFAULT 'manual'
    );

    -- Alerts log
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      symbol TEXT,
      message TEXT NOT NULL,
      data JSON,
      acknowledged BOOLEAN DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Staged bracket orders (ready for one-click submission to broker)
    CREATE TABLE IF NOT EXISTS staged_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'buy',
      order_type TEXT NOT NULL DEFAULT 'limit',
      qty INTEGER NOT NULL,
      entry_price REAL NOT NULL,
      stop_price REAL NOT NULL,
      target1_price REAL,
      target2_price REAL,
      time_in_force TEXT DEFAULT 'gtc',
      source TEXT,
      conviction_score REAL,
      risk_check JSON,
      status TEXT DEFAULT 'staged',
      alpaca_order_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      submitted_at TEXT,
      filled_at TEXT,
      notes TEXT
    );

    -- Price alert subscriptions
    CREATE TABLE IF NOT EXISTS alert_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      trigger_price REAL NOT NULL,
      direction TEXT NOT NULL,
      trade_id INTEGER,
      webhook_url TEXT,
      message TEXT,
      active BOOLEAN DEFAULT 1,
      triggered_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trade_id) REFERENCES trades(id)
    );

    -- Scheduled jobs (Tier 5 — Job Scheduler)
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      job_type TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      config JSON DEFAULT '{}',
      enabled BOOLEAN DEFAULT 1,
      last_run_at TEXT,
      last_run_status TEXT,
      last_run_duration_ms INTEGER,
      last_error TEXT,
      run_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Job execution history
    CREATE TABLE IF NOT EXISTS job_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      job_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      duration_ms INTEGER,
      result JSON,
      error TEXT,
      FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id)
    );

    -- Notification channels (Tier 5 Alerting)
    CREATE TABLE IF NOT EXISTS notification_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('slack','telegram','webhook')),
      config JSON DEFAULT '{}',
      filters JSON DEFAULT '{}',
      enabled BOOLEAN DEFAULT 1,
      priority INTEGER DEFAULT 10,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Notification delivery log
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      payload JSON,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Provider health log (Tier 1 multi-provider)
    CREATE TABLE IF NOT EXISTS provider_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      event TEXT NOT NULL,
      details JSON,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Signal replay results (Tier 4 backtest)
    CREATE TABLE IF NOT EXISTS replay_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      params JSON NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      initial_capital REAL NOT NULL,
      final_equity REAL,
      total_return REAL,
      total_trades INTEGER,
      win_rate REAL,
      profit_factor REAL,
      max_drawdown REAL,
      sharpe_ratio REAL,
      result JSON,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Monte Carlo simulation results
    CREATE TABLE IF NOT EXISTS mc_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      replay_id INTEGER NOT NULL,
      strategy TEXT,
      method TEXT NOT NULL,
      iterations INTEGER,
      trade_count INTEGER,
      baseline_return REAL,
      baseline_drawdown REAL,
      median_return REAL,
      median_drawdown REAL,
      profitable_pct REAL,
      result JSON,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (replay_id) REFERENCES replay_results(id)
    );

    -- Walk-Forward optimization results
    CREATE TABLE IF NOT EXISTS wf_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      train_days INTEGER,
      test_days INTEGER,
      optimize_metric TEXT,
      oos_return REAL,
      oos_max_dd REAL,
      oos_sharpe REAL,
      oos_trades INTEGER,
      oos_win_rate REAL,
      alpha REAL,
      windows_tested INTEGER,
      result JSON,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Create indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_rs_snapshots_date ON rs_snapshots(date);
    CREATE INDEX IF NOT EXISTS idx_rs_snapshots_symbol ON rs_snapshots(symbol);
    CREATE INDEX IF NOT EXISTS idx_rs_snapshots_date_type ON rs_snapshots(date, type);
    CREATE INDEX IF NOT EXISTS idx_scan_results_date ON scan_results(date);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_open ON trades(exit_date) WHERE exit_date IS NULL;
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
    CREATE INDEX IF NOT EXISTS idx_staged_status ON staged_orders(status);
    CREATE INDEX IF NOT EXISTS idx_alert_subs_active ON alert_subscriptions(active) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled ON scheduled_jobs(enabled) WHERE enabled = 1;
    CREATE INDEX IF NOT EXISTS idx_job_history_job ON job_history(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_history_started ON job_history(started_at);
    CREATE INDEX IF NOT EXISTS idx_notification_log_channel ON notification_log(channel);
    CREATE INDEX IF NOT EXISTS idx_notification_log_created ON notification_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_provider_log_provider ON provider_log(provider);
    CREATE INDEX IF NOT EXISTS idx_replay_results_strategy ON replay_results(strategy);
  `);

  // Portfolio state (peak equity, config — survives server restarts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrations for existing databases
  safeAddColumn('trades', 'alpaca_order_id', 'TEXT');
  safeAddColumn('trades', 'needs_review', 'INTEGER DEFAULT 0');
  safeAddColumn('rs_snapshots', 'atr_pct', 'REAL');

  // Multi-timeframe RS + accumulation profile (institutional-edge signals)
  safeAddColumn('rs_snapshots', 'rs_rank_weekly', 'INTEGER');
  safeAddColumn('rs_snapshots', 'rs_rank_monthly', 'INTEGER');
  safeAddColumn('rs_snapshots', 'rs_tf_alignment', 'INTEGER');
  safeAddColumn('rs_snapshots', 'up_down_ratio_50', 'REAL');
  safeAddColumn('rs_snapshots', 'accumulation_50', 'TEXT');

  // Exit strategy on staged orders (full_size = all-in/all-out, scale_in_out = dynamic partials)
  safeAddColumn('staged_orders', 'exit_strategy', "TEXT DEFAULT 'full_size'");

  // Replay strategy tag — links live trades to replay engine strategy for active management
  safeAddColumn('staged_orders', 'strategy', 'TEXT');
  safeAddColumn('trades', 'strategy', 'TEXT');

  // Tier 3: partial profit-taking state
  safeAddColumn('trades', 'initial_shares', 'INTEGER');
  safeAddColumn('trades', 'remaining_shares', 'INTEGER');
  safeAddColumn('trades', 'realized_pnl_dollars', 'REAL DEFAULT 0');
  safeAddColumn('trades', 'partial_exits', 'JSON');
  safeAddColumn('trades', 'trailing_stop_active', 'INTEGER DEFAULT 0');
  safeAddColumn('trades', 'beta', 'REAL');

  // Tier 5: performance attribution
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance_attribution (
      date TEXT NOT NULL,
      bucket TEXT NOT NULL,
      bucket_value TEXT NOT NULL,
      pnl REAL DEFAULT 0,
      trade_count INTEGER DEFAULT 0,
      win_count INTEGER DEFAULT 0,
      avg_r REAL,
      PRIMARY KEY (date, bucket, bucket_value)
    );
  `);

  // ─── Gap 1: Edge Validation — survivorship-bias-free backtesting ──────────
  // universe_mgmt already exists above; these support execution cost tracking
  // in backtests and signal decay analysis results.

  // ─── Gap 2a: Market Breadth Internals ─────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS breadth_snapshots (
      date TEXT PRIMARY KEY,
      pct_above_50ma REAL,
      pct_above_200ma REAL,
      new_highs INTEGER,
      new_lows INTEGER,
      ad_ratio REAL,
      vol_thrust_pct REAL,
      stage2_pct REAL,
      stage4_pct REAL,
      composite_score INTEGER,
      regime TEXT,
      mcclellan_osc REAL,
      summation_index REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ─── Gap 2c: Hedge Tracking ───────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS hedge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      action_type TEXT NOT NULL,
      instrument TEXT NOT NULL,
      notional REAL,
      cost REAL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ─── Gap 3a: Execution Quality Tracking ───────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      intended_price REAL,
      fill_price REAL,
      shares INTEGER,
      order_type TEXT,
      slippage REAL,
      slippage_pct REAL,
      fill_quality REAL,
      timing_delay_days INTEGER,
      participation_rate REAL,
      implementation_shortfall REAL,
      implementation_shortfall_pct REAL,
      signal_date TEXT,
      order_date TEXT,
      fill_date TEXT,
      day_high REAL,
      day_low REAL,
      day_volume INTEGER,
      avg_daily_volume INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trade_id) REFERENCES trades(id)
    );
  `);

  // ─── Gap 3b: Tax Lot Tracking ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS tax_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER,
      symbol TEXT NOT NULL,
      shares INTEGER NOT NULL,
      remaining_shares INTEGER NOT NULL,
      cost_basis REAL NOT NULL,
      adjusted_basis REAL NOT NULL,
      acquired_date TEXT NOT NULL,
      disposed_date TEXT,
      sale_price REAL,
      realized_gain REAL,
      holding_period TEXT DEFAULT 'pending',
      wash_sale_adjustment REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trade_id) REFERENCES trades(id)
    );
  `);

  // ─── Gap 3d: Decision Quality Log ─────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_log (
      trade_id INTEGER PRIMARY KEY,
      process_score INTEGER,
      entry_score INTEGER,
      regime_score INTEGER,
      sizing_score INTEGER,
      exit_score INTEGER,
      risk_score INTEGER,
      grade TEXT,
      outcome_alignment TEXT,
      notes JSON,
      was_system_signal BOOLEAN,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trade_id) REFERENCES trades(id)
    );
  `);

  // Indexes for new tables
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_breadth_date ON breadth_snapshots(date);
    CREATE INDEX IF NOT EXISTS idx_execution_trade ON execution_log(trade_id);
    CREATE INDEX IF NOT EXISTS idx_execution_symbol ON execution_log(symbol);
    CREATE INDEX IF NOT EXISTS idx_execution_fill_date ON execution_log(fill_date);
    CREATE INDEX IF NOT EXISTS idx_tax_lots_symbol ON tax_lots(symbol);
    CREATE INDEX IF NOT EXISTS idx_tax_lots_open ON tax_lots(remaining_shares) WHERE remaining_shares > 0;
    CREATE INDEX IF NOT EXISTS idx_tax_lots_disposed ON tax_lots(disposed_date);
    CREATE INDEX IF NOT EXISTS idx_decision_grade ON decision_log(grade);
    CREATE INDEX IF NOT EXISTS idx_hedge_date ON hedge_log(date);
  `);

  // Migration: add columns to trades for decision quality context
  safeAddColumn('trades', 'was_system_signal', 'INTEGER DEFAULT 1');
  safeAddColumn('trades', 'regime_at_entry', 'TEXT');
  safeAddColumn('trades', 'heat_at_entry', 'REAL');

  // Migration: breadth columns
  safeAddColumn('breadth_snapshots', 'mcclellan_osc', 'REAL');
  safeAddColumn('breadth_snapshots', 'summation_index', 'REAL');

  // ─── Phase 1: Equity Snapshots & Alpha Metrics ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS equity_snapshots (
      date TEXT PRIMARY KEY,
      equity REAL NOT NULL,
      cash_flow REAL DEFAULT 0,
      spy_close REAL,
      open_positions INTEGER,
      total_heat_pct REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_equity_date ON equity_snapshots(date);

    CREATE TABLE IF NOT EXISTS alpha_metrics (
      date TEXT PRIMARY KEY,
      twr REAL,
      rolling_sharpe_30 REAL,
      rolling_sharpe_90 REAL,
      rolling_sortino_30 REAL,
      rolling_sortino_90 REAL,
      spy_relative_alpha REAL,
      cumulative_alpha REAL,
      max_drawdown_pct REAL,
      drawdown_duration_days INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alpha_date ON alpha_metrics(date);
  `);

  // ─── Phase 1: Universe Frozen Snapshots (survivorship bias fix) ─────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS universe_frozen_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      frozen_date TEXT NOT NULL,
      removal_reason TEXT,
      last_rs_rank INTEGER,
      last_price REAL,
      last_scan_data JSON,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_frozen_symbol ON universe_frozen_snapshots(symbol);
    CREATE INDEX IF NOT EXISTS idx_frozen_date ON universe_frozen_snapshots(frozen_date);
  `);

  // ─── Phase 2: Conditional Entries (watchlist-to-execution automation) ────
  db.exec(`
    CREATE TABLE IF NOT EXISTS conditional_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      condition_type TEXT NOT NULL DEFAULT 'pullback',
      trigger_price REAL NOT NULL,
      entry_price REAL NOT NULL,
      stop_price REAL NOT NULL,
      target1_price REAL,
      target2_price REAL,
      qty INTEGER NOT NULL,
      side TEXT DEFAULT 'buy',
      time_in_force TEXT DEFAULT 'gtc',
      source TEXT DEFAULT 'manual',
      conviction_score REAL,
      expiry_date TEXT,
      status TEXT DEFAULT 'pending',
      triggered_at TEXT,
      staged_order_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (staged_order_id) REFERENCES staged_orders(id)
    );
    CREATE INDEX IF NOT EXISTS idx_conditional_status ON conditional_entries(status);
    CREATE INDEX IF NOT EXISTS idx_conditional_symbol ON conditional_entries(symbol);
  `);

  // ─── Phase 2: Scale-In Plans (3-tranche entry workflow) ─────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS scale_in_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      total_shares INTEGER NOT NULL,
      tranche1_qty INTEGER NOT NULL,
      tranche1_price REAL,
      tranche1_filled_at TEXT,
      tranche2_qty INTEGER NOT NULL,
      tranche2_trigger TEXT NOT NULL DEFAULT 'confirmation',
      tranche2_trigger_price REAL,
      tranche2_filled_at TEXT,
      tranche3_qty INTEGER NOT NULL,
      tranche3_trigger TEXT NOT NULL DEFAULT 'breakout',
      tranche3_trigger_price REAL,
      tranche3_filled_at TEXT,
      current_tranche INTEGER DEFAULT 1,
      stop_price REAL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trade_id) REFERENCES trades(id)
    );
    CREATE INDEX IF NOT EXISTS idx_scale_in_active ON scale_in_plans(status);
    CREATE INDEX IF NOT EXISTS idx_scale_in_trade ON scale_in_plans(trade_id);
  `);

  // Phase 2 migration: link trades to scale-in plans
  safeAddColumn('trades', 'scale_in_plan_id', 'INTEGER');
}

// One-time migration from legacy JSON files into SQLite
function migrateFromJSON() {
  const fs   = require('fs');
  const path = require('path');
  const DATA_DIR = path.join(__dirname, '..', '..', 'data');

  const count = db.prepare('SELECT COUNT(*) as cnt FROM rs_snapshots').get();
  if (count.cnt > 0) return; // Already have data

  const files = [
    { file: 'rs-history.json',            type: 'stock',    prefix: '' },
    { file: 'rs-history-sectors.json',     type: 'sector',   prefix: 'SEC_' },
    { file: 'rs-history-industries.json',  type: 'industry', prefix: 'IND_' },
  ];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO rs_snapshots (date, symbol, type, rs_rank) VALUES (?, ?, ?, ?)`
  );

  let total = 0;
  const txn = db.transaction(() => {
    for (const { file, type, prefix } of files) {
      const fp = path.join(DATA_DIR, file);
      if (!fs.existsSync(fp)) continue;
      try {
        const history = JSON.parse(fs.readFileSync(fp, 'utf8'));
        for (const [date, snapshot] of Object.entries(history)) {
          for (const [key, rank] of Object.entries(snapshot)) {
            const symbol = prefix ? key.replace(prefix, '') : key;
            if (!prefix && (key.startsWith('SEC_') || key.startsWith('IND_'))) continue;
            insert.run(date, symbol, type, rank);
            total++;
          }
        }
      } catch(_) {}
    }
  });

  console.log('  Migrating RS history from JSON to SQLite...');
  txn();
  console.log(`  ✓ Migrated ${total} RS snapshot records to SQLite`);
}

module.exports = { getDB, migrateFromJSON, DB_PATH };
