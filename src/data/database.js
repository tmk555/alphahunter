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
  db.pragma('journal_mode = WAL');  // Write-Ahead Logging for concurrency
  db.pragma('foreign_keys = ON');
  initSchema();
  return db;
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
      time_in_force TEXT DEFAULT 'day',
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

    -- Create indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_rs_snapshots_date ON rs_snapshots(date);
    CREATE INDEX IF NOT EXISTS idx_rs_snapshots_symbol ON rs_snapshots(symbol);
    CREATE INDEX IF NOT EXISTS idx_scan_results_date ON scan_results(date);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_open ON trades(exit_date) WHERE exit_date IS NULL;
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
    CREATE INDEX IF NOT EXISTS idx_staged_status ON staged_orders(status);
    CREATE INDEX IF NOT EXISTS idx_alert_subs_active ON alert_subscriptions(active) WHERE active = 1;
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
