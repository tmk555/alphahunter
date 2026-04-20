// ─── SQLite Database Setup ───────────────────────────────────────────────────
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// ALPHAHUNTER_DB lets tests and ephemeral runs point at an isolated DB file
// (or ':memory:') without polluting the canonical alphahunter.db.
const DB_PATH  = process.env.ALPHAHUNTER_DB || path.join(DATA_DIR, 'alphahunter.db');

if (DB_PATH !== ':memory:' && !fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
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

  // Multi-tranche bracket bookkeeping: JSON array of
  // [{label, orderId, qty, tp, stopOrderId}] rows, one per tranche.
  // Set on submission when the exit strategy splits qty across N brackets;
  // NULL for single-bracket submissions. Monitor and reconciler read this
  // to find every child stop leg when moving stops to breakeven.
  safeAddColumn('staged_orders', 'tranches_json', 'JSON');

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

  // ─── Point-in-Time Index Membership ────────────────────────────────────────
  //
  // `universe_mgmt` is a single-row-per-symbol admin table — it can't hold
  // a re-addition (e.g. Netflix dropped from S&P 500 then re-added years
  // later). This table is the authoritative historical membership record
  // for external indices (S&P 500, Russell 1000, Nasdaq 100, etc.).
  //
  // Schema is sparse ranges: one row per continuous membership stint.
  // A symbol that was in the index 2010-2015 and re-added 2019 to present
  // gets two rows. `end_date IS NULL` means "currently a member".
  //
  // Primary key is (index_name, symbol, start_date) so multiple stints per
  // symbol are allowed without clobbering each other.
  db.exec(`
    CREATE TABLE IF NOT EXISTS universe_membership (
      index_name  TEXT NOT NULL,    -- 'SP500', 'RUSSELL1000', 'NDX', etc.
      symbol      TEXT NOT NULL,
      start_date  TEXT NOT NULL,    -- ISO date 'YYYY-MM-DD', inclusive
      end_date    TEXT,             -- ISO date, exclusive; NULL if still a member
      sector      TEXT,             -- Sector as-of start_date (best-effort)
      source      TEXT,             -- 'wikipedia', 'fja05680', 'manual', etc.
      PRIMARY KEY (index_name, symbol, start_date)
    );
    CREATE INDEX IF NOT EXISTS idx_universe_membership_date
      ON universe_membership (index_name, start_date, end_date);
  `);

  // ─── FRED Macro Series (point-in-time historical economic data) ──────────
  //
  // Stores observations for FRED series like DGS10 (10yr yield), CPIAUCSL
  // (CPI), UNRATE (unemployment), BAMLH0A0HYM2 (high-yield spread). The
  // existing src/signals/macro.js uses ETF PROXIES (TLT/SHY for yield curve,
  // HYG/LQD for credit spreads) because FRED requires no auth but the
  // proxies are easier to fetch live; those are fine for real-time regime
  // detection but useless for backtests — ETFs have their own price action
  // and pre-2007 coverage is missing. This table holds the real historical
  // numbers so replay.js and walk-forward can ask "what was the 10Y/2Y
  // spread on 2018-03-15?" and get a ground-truth answer.
  //
  // Schema note: monthly series (UNRATE, CPIAUCSL) only have observations
  // on specific dates (usually the 1st). The query layer in
  // src/signals/macro-fred.js does forward-fill so callers can ask for any
  // trading day and get the most recent observation on-or-before that date.
  db.exec(`
    CREATE TABLE IF NOT EXISTS macro_series (
      series_id TEXT NOT NULL,  -- FRED series ID, e.g. 'DGS10', 'CPIAUCSL'
      date      TEXT NOT NULL,  -- ISO 'YYYY-MM-DD'
      value     REAL,           -- may be NULL for reported-missing observations
      PRIMARY KEY (series_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_macro_series_date
      ON macro_series (series_id, date);
  `);

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

  // ─── v8: Earnings Estimate Revisions ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_estimates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      quarter TEXT NOT NULL,
      eps_estimate REAL,
      eps_actual REAL,
      rev_estimate REAL,
      rev_actual REAL,
      eps_current_year REAL,
      eps_next_year REAL,
      rev_current_year REAL,
      num_analysts INTEGER,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(symbol, quarter, fetched_at)
    );
    CREATE INDEX IF NOT EXISTS idx_earnings_est_symbol ON earnings_estimates(symbol);
    CREATE INDEX IF NOT EXISTS idx_earnings_est_quarter ON earnings_estimates(quarter);

    CREATE TABLE IF NOT EXISTS revision_scores (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      revision_score REAL,
      direction TEXT,
      eps_current_yr_chg REAL,
      eps_next_yr_chg REAL,
      rev_chg REAL,
      acceleration REAL,
      tier TEXT,
      PRIMARY KEY (symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_revision_scores_date ON revision_scores(date);
  `);

  // Migrations: add columns needed by earningsRevisions engine
  safeAddColumn('earnings_estimates', 'eps_current_qtr', 'REAL');
  safeAddColumn('earnings_estimates', 'eps_next_qtr', 'REAL');
  safeAddColumn('earnings_estimates', 'rev_current_qtr', 'REAL');
  safeAddColumn('earnings_estimates', 'eps_growth_current_year', 'REAL');
  safeAddColumn('earnings_estimates', 'eps_growth_next_year', 'REAL');
  safeAddColumn('earnings_estimates', 'created_at', "TEXT DEFAULT (datetime('now'))");

  // ─── v8: Options Positions & Hedge Log (extended) ─────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS options_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      underlying TEXT NOT NULL,
      option_type TEXT NOT NULL CHECK(option_type IN ('call','put')),
      strike REAL NOT NULL,
      expiration TEXT NOT NULL,
      qty INTEGER NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('long','short')),
      entry_price REAL,
      current_price REAL,
      strategy_type TEXT,
      linked_trade_id INTEGER,
      status TEXT DEFAULT 'open',
      alpaca_order_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT,
      pnl REAL,
      FOREIGN KEY (linked_trade_id) REFERENCES trades(id)
    );
    CREATE INDEX IF NOT EXISTS idx_options_pos_underlying ON options_positions(underlying);
    CREATE INDEX IF NOT EXISTS idx_options_pos_status ON options_positions(status);
  `);

  // ─── v8: Pattern Detection Cache ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_detections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      pattern_type TEXT NOT NULL,
      confidence INTEGER,
      pivot_price REAL,
      stop_price REAL,
      details JSON,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(symbol, date, pattern_type)
    );
    CREATE INDEX IF NOT EXISTS idx_pattern_symbol ON pattern_detections(symbol);
    CREATE INDEX IF NOT EXISTS idx_pattern_date ON pattern_detections(date);
    CREATE INDEX IF NOT EXISTS idx_pattern_type ON pattern_detections(pattern_type);
  `);

  // ─── v8: Macro Regime Snapshots ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS macro_snapshots (
      date TEXT PRIMARY KEY,
      yield_curve_score REAL,
      credit_spread_score REAL,
      dollar_score REAL,
      commodity_score REAL,
      ism_proxy_score REAL,
      intermarket_score REAL,
      composite_score REAL,
      macro_regime TEXT,
      macro_size_multiplier REAL,
      details JSON,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_macro_date ON macro_snapshots(date);
  `);

  // ─── v8: Institutional Flow Tracking ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS institutional_flow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      flow_score INTEGER,
      net_flow TEXT,
      accum_days_20 INTEGER,
      dist_days_20 INTEGER,
      power_days INTEGER,
      dark_pool_score INTEGER,
      details JSON,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_inst_flow_symbol ON institutional_flow(symbol);
    CREATE INDEX IF NOT EXISTS idx_inst_flow_date ON institutional_flow(date);
  `);

  // ─── PEAD (Post-Earnings Announcement Drift) snapshots ───────────────────
  // Stores per-(symbol, date) output of calcEarningsDrift so the replay
  // engine and deep_scan backtests can re-read historical PEAD scores
  // without replaying bar math. Backfill path uses detectEarningsReaction
  // (biggest 3%+ gap in last 30 bars) since historical `daysToEarnings`
  // isn't captured — `known_earnings` is therefore always 0 for backfilled
  // rows and 1 only when the live scanner had a real earnings timestamp.
  db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_drift_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      score INTEGER,
      gap_pct REAL,
      days_since_reaction INTEGER,
      drift_pct REAL,
      held_gains INTEGER,
      known_earnings INTEGER,
      strong INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_ed_snap_symbol ON earnings_drift_snapshots(symbol);
    CREATE INDEX IF NOT EXISTS idx_ed_snap_date ON earnings_drift_snapshots(date);
  `);

  // ─── v8: Multi-Strategy Framework ─────────────────────────────────────────
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

  // Seed default strategies if empty
  const stratCount = db.prepare('SELECT COUNT(*) as cnt FROM strategies').get();
  if (stratCount.cnt === 0) {
    const seed = db.prepare('INSERT OR IGNORE INTO strategies (id, name, type, allocation_pct, max_positions, max_heat_pct, holding_period_min, holding_period_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    seed.run('momentum_swing', 'RS Momentum Swing', 'momentum', 40, 8, 4, 2, 20);
    seed.run('vcp_breakout', 'VCP / Pattern Breakout', 'breakout', 25, 5, 2.5, 5, 40);
    seed.run('sector_rotation', 'Sector ETF Rotation', 'rotation', 20, 4, 2, 20, 90);
    seed.run('mean_reversion', 'Oversold Mean Reversion', 'mean_reversion', 15, 4, 1.5, 1, 10);
  }

  // ─── Deep Scan Results Cache ─────────────────────────────────────────────
  // Persists deep scan results so they survive page refresh and server restarts.
  // The user stages orders from deep scan — if results vanish on refresh, the
  // context for why an order was staged is lost.
  db.exec(`
    CREATE TABLE IF NOT EXISTS deep_scan_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      results JSON NOT NULL,
      regime JSON,
      scanned_count INTEGER,
      total_input INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deep_scan_mode ON deep_scan_cache(mode);
    CREATE INDEX IF NOT EXISTS idx_deep_scan_created ON deep_scan_cache(created_at);
  `);

  // v8 migration: add new columns to existing tables
  safeAddColumn('trades', 'pattern_type', 'TEXT');
  safeAddColumn('trades', 'revision_score', 'REAL');
  safeAddColumn('trades', 'institutional_score', 'REAL');
  safeAddColumn('trades', 'macro_regime_at_entry', 'TEXT');
  // Capture the exit strategy (full_in_scale_out, etc.) from the staged order
  // so the journal knows how the position was managed. Used by /api/trades/sync
  // to mirror staged_orders.exit_strategy into the trade record.
  safeAddColumn('trades', 'exit_strategy', "TEXT DEFAULT 'full_in_scale_out'");
  // Per-trade trailing stop percentage — defaults to 0.08 (8%) but the
  // rotation_watch job flips it to 0.04 (4%) when the stock's industry
  // ETF RS rank rotates down sharply (Minervini's rotation-aware exit).
  safeAddColumn('trades', 'trail_pct', 'REAL DEFAULT 0.08');
  // Timestamp of last rotation-tighten so we can show it in UI and avoid
  // re-tightening the same trade every cron tick.
  safeAddColumn('trades', 'trail_tightened_at', 'TEXT');
  safeAddColumn('trades', 'trail_tightened_reason', 'TEXT');

  // ─── Pyramid Plans ────────────────────────────────────────────────────────
  // True pyramiding entry — pilot fires at pivot, tranche 2 fires only after
  // pilot is filled AND price advances to confirmation trigger, tranche 3
  // fires after tranche 2. Each tranche has optional volume-pace gate so we
  // don't chase thin-volume fakeouts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pyramid_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'buy',
      status TEXT NOT NULL DEFAULT 'armed_pilot',
        -- armed_pilot | pilot_filled | add1_filled | add2_filled | complete | failed | cancelled
      total_qty INTEGER NOT NULL,
      stop_price REAL NOT NULL,
      target1_price REAL,
      target2_price REAL,
      tranches_json JSON NOT NULL,
        -- [{label:'pilot',     qty, trigger, volumePaceMin, status, orderId, filledAt},
        --  {label:'add1',      qty, trigger, volumePaceMin, status, orderId, filledAt},
        --  {label:'add2',      qty, trigger, volumePaceMin, status, orderId, filledAt}]
      source TEXT DEFAULT 'manual',
      conviction_score INTEGER,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pyramid_plans_status ON pyramid_plans(status);
    CREATE INDEX IF NOT EXISTS idx_pyramid_plans_symbol ON pyramid_plans(symbol);
  `);
  safeAddColumn('rs_snapshots', 'pattern_type', 'TEXT');
  safeAddColumn('rs_snapshots', 'pattern_confidence', 'INTEGER');
  safeAddColumn('rs_snapshots', 'revision_score', 'REAL');
  safeAddColumn('rs_snapshots', 'institutional_score', 'INTEGER');
  safeAddColumn('scan_results', 'pattern_data', 'JSON');
  safeAddColumn('scan_results', 'revision_data', 'JSON');
  safeAddColumn('scan_results', 'institutional_data', 'JSON');

  // ─── Layer 1: Edge Telemetry ─────────────────────────────────────────────
  //
  // One row per emitted signal (LLM brief, staged order, pullback alert, etc.).
  // A signal is the thing the app TELLS THE TRADER TO CONSIDER. Outcomes are
  // filled by the nightly closer using forward OHLCV bars.
  //
  // Why a separate table from `trades`: many signals are never traded, and
  // even those that are traded fill/exit at different prices than the signal's
  // reference entry. We need the raw emission→outcome mapping to answer "does
  // confidence:high actually outperform confidence:low?" independently of
  // execution quality (which execution_log already tracks).
  //
  // horizon_days is the intended holding window. The closer records 5/10/20d
  // forward returns regardless, and additionally computes MFE/MAE (max
  // favorable / max adverse excursion) within the horizon for path analysis.
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      emission_date TEXT NOT NULL,
      source TEXT NOT NULL,
      symbol TEXT NOT NULL,
      strategy TEXT,
      setup_type TEXT,
      side TEXT DEFAULT 'long',
      verdict TEXT,
      confidence TEXT,
      confidence_prob REAL,
      conviction_score REAL,
      entry_price REAL,
      stop_price REAL,
      target1_price REAL,
      target2_price REAL,
      rs_rank INTEGER,
      swing_momentum INTEGER,
      sepa_score INTEGER,
      stage INTEGER,
      regime TEXT,
      atr_pct REAL,
      horizon_days INTEGER DEFAULT 20,
      meta JSON,
      status TEXT NOT NULL DEFAULT 'open',
      closed_at TEXT,
      close_price_5d REAL,
      close_price_10d REAL,
      close_price_20d REAL,
      ret_5d REAL,
      ret_10d REAL,
      ret_20d REAL,
      max_favorable REAL,
      max_adverse REAL,
      hit_stop INTEGER DEFAULT 0,
      hit_target1 INTEGER DEFAULT 0,
      hit_target2 INTEGER DEFAULT 0,
      realized_r REAL,
      outcome_label TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sigout_source_date ON signal_outcomes(source, emission_date);
    CREATE INDEX IF NOT EXISTS idx_sigout_symbol_date ON signal_outcomes(symbol, emission_date);
    CREATE INDEX IF NOT EXISTS idx_sigout_status ON signal_outcomes(status);
    CREATE INDEX IF NOT EXISTS idx_sigout_strategy ON signal_outcomes(strategy);
  `);
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
