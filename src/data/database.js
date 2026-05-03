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
  // Cache: 200 MB (negative N = absolute KB). Fits most of rs_snapshots'
  // working set in RAM — that table is the hot path for replay sweeps which
  // re-scan it once per parameter combination. Pre-bump (10 MB) the sweep
  // was paging out roughly half its reads to disk on every combo.
  db.pragma('cache_size = -200000');
  db.pragma('temp_store = MEMORY');        // Temp tables in RAM
  // Memory-mapped I/O for the whole DB file. Lets the OS page cache serve
  // reads instead of going through SQLite's userspace cache. Especially
  // valuable for sequential scans (the replay sweep's dominant pattern).
  // 1 GB ceiling — well above current DB size, so the entire file is
  // effectively in OS cache after warm-up.
  db.pragma('mmap_size = 1073741824');
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

  // ─── Daily OHLCV bars cache (persistent, survives restart) ────────────────
  //
  // Pre-cache, every server restart wiped getHistoryFull's in-memory cache,
  // so the first scan after boot paid the full 1620-symbol provider sweep
  // (~7-8 min, Alpaca rate-limited). With this table, each symbol's bars
  // are persisted on first fetch and re-served from disk on every subsequent
  // call — including across restarts. Today's bar is updated daily by the
  // scheduler/scan path; older bars are immutable.
  //
  // Schema mirrors the in-memory bar shape (open/high/low/close/volume/date).
  // PK (symbol, date) lets us use INSERT OR REPLACE for idempotent upserts —
  // re-fetching a window that overlaps existing rows just refreshes them.
  //
  // Size estimate: 1620 symbols × 2500 days × ~80 bytes ≈ 320 MB on disk.
  // Acceptable for a single-user app; query patterns are
  //   SELECT ... WHERE symbol=? ORDER BY date — well-served by the PK.
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_bars (
      symbol TEXT NOT NULL,
      date   TEXT NOT NULL,
      open   REAL,
      high   REAL,
      low    REAL,
      close  REAL,
      volume INTEGER,
      PRIMARY KEY (symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_bars_symbol_date
      ON daily_bars (symbol, date);
  `);

  // ─── Insider transactions (Form 4) — per-event ───────────────────────────
  //
  // Captures all insider trades for the universe. SEC requires officers,
  // directors, and 10%+ owners to file Form 4 within 2 business days of
  // any transaction. We store at per-transaction granularity so:
  //   • The chart layer can render individual trade markers
  //   • The scanner can roll up 30-day aggregates per stock
  //   • The conviction score can detect cluster-buy events
  //
  // Transaction codes (from SEC Form 4 instructions):
  //   P = open-market or private purchase (THE buy signal)
  //   S = open-market or private sale (THE sell signal)
  //   A = grant/award (compensation — IGNORE for signal)
  //   M = exercise of derivative security (option exercise — IGNORE)
  //   F = payment of exercise price or tax via security (IGNORE)
  //   D = sale to issuer (10b5-1 plan typically)
  //   G = bona fide gift
  //   J = other (rare)
  //   V = transaction reported voluntarily (rare)
  //
  // We store all codes; signal generation filters to P/S only.
  db.exec(`
    CREATE TABLE IF NOT EXISTS insider_transactions (
      symbol           TEXT NOT NULL,
      filed_at         TEXT NOT NULL,        -- when Form 4 was filed (T+1 to T+2)
      trade_date       TEXT NOT NULL,        -- when the transaction actually happened
      insider_name     TEXT,
      insider_title    TEXT,                 -- 'CEO' / 'CFO' / 'Director' / '10% Owner'
      is_director      INTEGER DEFAULT 0,
      is_officer       INTEGER DEFAULT 0,
      is_ten_percent   INTEGER DEFAULT 0,
      transaction_code TEXT NOT NULL,        -- P, S, A, M, F, etc. (see comment above)
      shares           INTEGER,
      price_per_share  REAL,
      total_value      REAL,                 -- shares × price (signed: + for buys, - for sells)
      post_shares      INTEGER,              -- shares owned post-transaction
      accession_number TEXT NOT NULL,        -- SEC unique filing ID
      source_url       TEXT,
      PRIMARY KEY (accession_number, insider_name, trade_date, transaction_code, shares)
    );
    CREATE INDEX IF NOT EXISTS idx_insider_symbol_filed
      ON insider_transactions (symbol, filed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_insider_filed
      ON insider_transactions (filed_at DESC);
  `);

  // ─── Institutional holdings (13F) — per-quarter snapshot ──────────────────
  //
  // 13F-HR is filed quarterly by managers with >$100M AUM, due 45 days
  // after quarter-end. Each filing is a snapshot of holdings — we store
  // one row per (filer, symbol, quarter).
  //
  // Two tables:
  //   institutional_holdings   — granular per-filing rows
  //   institutional_aggregates — pre-computed per-stock-per-quarter rollups
  //                              (the table the scanner / UI actually reads)
  //
  // Aggregation runs after each batch import (cron job). Scanner reads
  // ONLY from aggregates so a stock-detail query doesn't fan out to
  // thousands of holdings rows.
  //
  // CUSIP→ticker mapping: 13F filings use CUSIPs not tickers. We maintain
  // a `cusip_ticker_map` table populated incrementally as we ingest.
  // First seed comes from SEC company-facts (which we already pull) +
  // a small bootstrap list. Many small-caps will lack mappings initially;
  // those holdings rows store the raw CUSIP and resolve later as the map
  // grows.
  db.exec(`
    CREATE TABLE IF NOT EXISTS institutional_holdings (
      filer_cik     TEXT NOT NULL,
      filer_name    TEXT,
      cusip         TEXT NOT NULL,
      symbol        TEXT,                  -- nullable until cusip_ticker_map resolves
      quarter       TEXT NOT NULL,         -- 'Q1-2026' format
      filed_at      TEXT NOT NULL,
      shares        INTEGER,
      market_value  REAL,
      PRIMARY KEY (filer_cik, cusip, quarter)
    );
    CREATE INDEX IF NOT EXISTS idx_inst_holdings_symbol_quarter
      ON institutional_holdings (symbol, quarter) WHERE symbol IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_inst_holdings_filer_quarter
      ON institutional_holdings (filer_cik, quarter);
    CREATE INDEX IF NOT EXISTS idx_inst_holdings_cusip
      ON institutional_holdings (cusip);

    CREATE TABLE IF NOT EXISTS institutional_aggregates (
      symbol            TEXT NOT NULL,
      quarter           TEXT NOT NULL,
      total_value       REAL,             -- sum of market_value across all filers
      num_holders       INTEGER,
      num_new_buyers    INTEGER,          -- filers who initiated a position this Q
      num_increased     INTEGER,
      num_reduced       INTEGER,
      num_sold_out      INTEGER,          -- filers who closed a prior position
      net_share_change  INTEGER,          -- aggregate share delta vs prior quarter
      top10_filers_json TEXT,             -- JSON array of top 10 by value
      smart_money_count INTEGER,          -- holders within our tracked-filer whitelist
      PRIMARY KEY (symbol, quarter)
    );
    CREATE INDEX IF NOT EXISTS idx_inst_agg_symbol
      ON institutional_aggregates (symbol);

    -- CUSIP → ticker lookup. Seeded incrementally; primary source is the
    -- SEC company-facts endpoint (returns issuer CUSIP alongside ticker).
    CREATE TABLE IF NOT EXISTS cusip_ticker_map (
      cusip   TEXT PRIMARY KEY,
      ticker  TEXT NOT NULL,
      cik     TEXT,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cusip_ticker ON cusip_ticker_map (ticker);
  `);

  // ─── Position trail state — live MA-trail translation ────────────────────
  //
  // Per open position, tracks the staged-trail state computed daily after
  // market close. The strategy uses MA close-below for exits; this table
  // is what makes that strategy work in PRODUCTION (not just backtest).
  //
  // Stage progression mirrors src/signals/replay.js evaluateExit's
  // staged_position logic:
  //   birth        — first 5% gain OR first 10 days
  //   adolescence  — gain ≥5% OR days ≥10  → trail 13EMA close-below
  //   intermediate — gain ≥12% OR days ≥25 → trail 26EMA close-below
  //   mature       — gain ≥20% OR days ≥45 → trail 50SMA close-below
  //
  // Once mature, never downgrade — max_gain_pct sticks so a temporary
  // pullback doesn't loosen the trail.
  //
  // Updated by 'eod_trail_update' cron at 4:15 PM ET weekdays.
  // Read by Daily Plan tab to surface exit signals + suggested stop updates.
  db.exec(`
    CREATE TABLE IF NOT EXISTS position_trail_state (
      symbol             TEXT NOT NULL,
      trade_id           INTEGER,                     -- FK to trades.id when applicable
      entry_date         TEXT NOT NULL,
      entry_price        REAL NOT NULL,
      current_stage      TEXT,                        -- 'birth' | 'adolescence' | 'intermediate' | 'mature'
      max_gain_pct       REAL DEFAULT 0,              -- ratchet — only goes up
      ema13              REAL,                        -- last computed values (post-EOD)
      ema26              REAL,
      sma50              REAL,
      suggested_stop     REAL,                        -- the trail MA for the current stage
      exit_signal        INTEGER DEFAULT 0,           -- 1 = today's close broke trail, exit tomorrow
      exit_reason        TEXT,                        -- e.g. 'closed below 26EMA at $172'
      updated_at         TEXT,
      PRIMARY KEY (symbol, entry_date)
    );
    CREATE INDEX IF NOT EXISTS idx_trail_state_exit ON position_trail_state (exit_signal) WHERE exit_signal = 1;
  `);

  // ─── Daily decisions — the action loop ──────────────────────────────────
  //
  // Per-day decisions on tier-1 watchlist names. Closes the "scan vs decide
  // vs act" loop: every Tier-1 name MUST be decided each trading day, with
  // the decision recorded for later adherence/forecasting analysis.
  //
  // Decisions:
  //   'pending'    — in the daily plan but not decided yet
  //   'submit'     — user committed to the trade today (bracket auto-stages)
  //   'wait'       — defer to tomorrow (carries to next day's plan)
  //   'skip'       — explicit no, with reason
  //   'auto_skip'  — 10:30 AM ET cutoff hit before user decided. Counts
  //                  against adherence rate (forces the commitment habit)
  //
  // Adherence = decisions made BY THE USER (submit + wait + skip) ÷ total.
  // Auto-skips fail the adherence ratio — that's the design.
  //
  // The pivot_price + conviction_at_decision snapshots the state at the
  // moment of decision so post-hoc review can compare "did the price
  // actually break the pivot I committed to?" vs current market.
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_decisions (
      date                   TEXT NOT NULL,           -- 'YYYY-MM-DD' (ET)
      symbol                 TEXT NOT NULL,
      decision               TEXT NOT NULL DEFAULT 'pending',
      conviction_at_decision INTEGER,                 -- score when decision was made
      price_at_decision      REAL,                    -- last quote at decision time
      pivot_price            REAL,                    -- entry trigger from staged setup
      decided_at             TEXT,                    -- ISO timestamp of decision
      thesis                 TEXT,                    -- 1-line reasoning (from watchlist)
      skip_reason            TEXT,                    -- when decision='skip' or 'auto_skip'
      tier                   INTEGER DEFAULT 1,        -- usually 1 (tier-1 only) but allowed
      PRIMARY KEY (date, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_decisions_date ON daily_decisions (date DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_decisions_symbol ON daily_decisions (symbol, date DESC);
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

  // ─── Partial UNIQUE index on trades.alpaca_order_id ────────────────────
  // Prevents future duplicate trade rows with the same broker order_id (the
  // DELL ghost-loop bug of 2026-04). NULL-tolerant so manual journal entries
  // without a broker linkage still work.
  //
  // Wrapped in try/catch because a DB with pre-existing duplicates fails the
  // CREATE. In that case we log a clear warning pointing the user at the
  // dedup script — the server still boots and functions; the index just
  // isn't enforced until cleanup runs.
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_alpaca_order_id_unique
        ON trades(alpaca_order_id) WHERE alpaca_order_id IS NOT NULL;
    `);
  } catch (e) {
    console.warn(
      `⚠ Could not create UNIQUE index on trades.alpaca_order_id: ${e.message}\n` +
      `  Likely cause: existing duplicate rows. Run:\n` +
      `    node scripts/dedup-trade-rows.js\n` +
      `  Then restart the server to enable the constraint.`
    );
  }

  // Migration: breadth columns
  safeAddColumn('breadth_snapshots', 'mcclellan_osc', 'REAL');
  safeAddColumn('breadth_snapshots', 'summation_index', 'REAL');
  // stock_count = how many rs_snapshots rows fed this breadth row. Used by
  // breadth-warning.js to detect sample-size jumps that would otherwise
  // produce false-alarm deltas. Pre-fix (2026-04-30): the universe grew
  // from 360 → 656 → 1620 over a single day as SP1500 was merged, and
  // delta10d compared today's 656-stock composite against a 14-day-ago
  // 371-stock composite — apples to oranges, triggered CRITICAL warning
  // when the underlying breadth had actually improved by 3 points.
  // With this column, the warning module can suppress deltas when the
  // sample size shifted >20% between the two endpoints.
  safeAddColumn('breadth_snapshots', 'stock_count', 'INTEGER');

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

  // ATR-based chandelier trail. Replaces the flat trail_pct path:
  //   entry_atr      — ATR in DOLLARS captured at trade-creation time from
  //                    rs_snapshots.atr_pct × entry_price. Stays fixed for
  //                    the life of the trade; the multiplier is what
  //                    tightens, not the ATR itself.
  //   trail_atr_mult — Multiplier applied to entry_atr to produce the trail
  //                    distance. Strategy-driven default (2.5 for swing,
  //                    3.0 for position) sourced from
  //                    strategies.exit_rules.trail_atr_mult; tightened to
  //                    1.5 / 1.0 by deterioration & regime-downgrade rules
  //                    instead of flipping trail_pct.
  // Legacy fallback: when entry_atr is NULL (rows that pre-date this
  // capture, or symbols without an rs_snapshot at entry time), the trail
  // consumers fall back to the old trail_pct × current_price path.
  safeAddColumn('trades', 'entry_atr', 'REAL');
  safeAddColumn('trades', 'trail_atr_mult', 'REAL');

  // Pending-close tracking: when the user submits a LIMIT sell via the
  // Exit button, the position ISN'T closed yet — the limit may or may not
  // fill. These columns record the pending broker order id so fills-sync
  // can reconcile the close when it fills, and so the UI can show
  // "pending close" instead of pretending the trade is already closed.
  // See src/routes/broker.js `/broker/close-position`.
  safeAddColumn('trades', 'pending_close_order_id',    'TEXT');
  safeAddColumn('trades', 'pending_close_submitted_at', 'TEXT');

  // Idempotency key for the fills-sync sells loop. Without this, the same
  // filled sell order in the 7-day window kept being re-applied to whatever
  // orphan-reconciled row existed — producing dozens of ghost "closed" rows
  // per real sell (DELL had 6 before this was added). Populated by
  // src/broker/fills-sync.js when it closes a trade via auto_sync.
  safeAddColumn('trades', 'exit_order_id', 'TEXT');

  // Immutable original stop. Populated at entry-sync time and NEVER modified
  // by the scale-out engine — risk.scaling.applyScalingAction moves
  // `stop_price` to breakeven / trailing levels as T1/T2 hit, which
  // previously destroyed the denominator of the R-multiple calc
  // (risk = entry - stop became 0 → every scale-out winner recorded as 0.0R).
  // Read path: fills-sync.js r_multiple = (exit - entry) / (entry - COALESCE(initial_stop_price, stop_price)).
  safeAddColumn('trades', 'initial_stop_price', 'REAL');

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
  // Price proximity to 52-week extremes — used for the NYSE-style new-highs
  // / new-lows breadth count in src/signals/breadth.js. Pre-fix the count
  // used s.rs_line_new_high (RS line outperformance vs SPY) which is a
  // different signal than literal price at a fresh 52-week high — left
  // GOOGL invisible to the count even when its price tagged $385 with the
  // 52w high at $385.83. dist_from_high = (52w_high - price) / 52w_high
  // (decimal, so 0 = at the high). Stocks with value < 0.005 (within 0.5%)
  // count as "new high"; same logic mirrored for dist_from_low.
  safeAddColumn('rs_snapshots', 'dist_from_high', 'REAL');
  safeAddColumn('rs_snapshots', 'dist_from_low',  'REAL');
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

  // ─── Stop-Move Audit Trail ──────────────────────────────────────────────
  //
  // Every broker-side stop adjustment is recorded here BEFORE the UI sees it.
  // Previously `replaceStopsForSymbol` failures were caught and logged only
  // to stderr — the user had no way to know the trailing stop never made it
  // to the broker. This table makes the failure mode visible.
  //
  // status: 'success' when every listed stop leg was patched.
  //         'partial' when some legs patched, others failed.
  //         'no_op'   when isConfigured=false, or broker returned 0 stop legs.
  //         'error'   when the whole call threw (network, auth, etc.).
  //
  // The diagnostic route /api/broker/stops/:symbol reads this + live broker
  // state so the user can confirm DB desired stop == broker live stop.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stop_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
      symbol TEXT NOT NULL,
      trade_id INTEGER,
      old_stop REAL,
      new_stop REAL,
      trigger_price REAL,
      reason TEXT,
      level TEXT,
      legs_targeted INTEGER DEFAULT 0,
      legs_patched INTEGER DEFAULT 0,
      status TEXT NOT NULL,
      error_message TEXT,
      broker_response JSON
    );
    CREATE INDEX IF NOT EXISTS idx_stop_moves_symbol ON stop_moves(symbol, attempted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stop_moves_status ON stop_moves(status, attempted_at DESC);

    CREATE TABLE IF NOT EXISTS paper_trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol        TEXT NOT NULL,
      theme_tag     TEXT,
      status        TEXT NOT NULL DEFAULT 'open',
      entry_date    TEXT NOT NULL,
      entry_price   REAL NOT NULL,
      stop_price    REAL NOT NULL,
      target1_price REAL,
      target2_price REAL,
      shares        INTEGER NOT NULL,
      exit_date     TEXT,
      exit_price    REAL,
      exit_reason   TEXT,
      pnl_pct       REAL,
      r_multiple    REAL,
      max_favorable REAL,
      max_adverse   REAL,
      source        TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status, entry_date DESC);
    CREATE INDEX IF NOT EXISTS idx_paper_trades_theme  ON paper_trades(theme_tag, entry_date DESC);
    CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades(symbol);
  `);

  // ─── 39-min VWAP submission gate ──────────────────────────────────────────
  // Staged orders opt-in to a VWAP-reclaim + gap-bounds gate. The gate watcher
  // cron reads `submission_gate` JSON and only flips a row from pending_trigger
  // → staged (ready to submit) when the first 39-minute candle closes above
  // VWAP and the overnight gap is inside configured bounds.
  safeAddColumn('staged_orders', 'submission_gate', 'JSON');

  // ─── VWAP gate for pyramid pilot fires ────────────────────────────────────
  // Same primitive as staged_orders.submission_gate but evaluated in the
  // pyramid watcher at pilot-fire time. Pilot-only (adds are confirmation-
  // driven and don't need a regime check). When non-null, the pilot stays
  // armed until the 39-min candle has closed above VWAP. Soft fail: a failed
  // tick just delays — the pilot retries on the next tick and fires as soon
  // as the gate passes.
  safeAddColumn('pyramid_plans', 'vwap_gate', 'JSON');
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
