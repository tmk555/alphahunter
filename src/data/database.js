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

    -- Create indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_rs_snapshots_date ON rs_snapshots(date);
    CREATE INDEX IF NOT EXISTS idx_rs_snapshots_symbol ON rs_snapshots(symbol);
    CREATE INDEX IF NOT EXISTS idx_scan_results_date ON scan_results(date);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_open ON trades(exit_date) WHERE exit_date IS NULL;
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
  `);
}

// Migrate existing JSON data into SQLite on first run
function migrateFromJSON() {
  const store = require('./store');

  // Migrate RS history (stocks)
  const rsHistory = store.loadHistory(store.RS_HISTORY_FILE);
  const insertRS = db.prepare(
    `INSERT OR IGNORE INTO rs_snapshots (date, symbol, type, rs_rank) VALUES (?, ?, 'stock', ?)`
  );
  const txnRS = db.transaction(() => {
    for (const [date, snapshot] of Object.entries(rsHistory)) {
      for (const [symbol, rank] of Object.entries(snapshot)) {
        if (!symbol.startsWith('SEC_') && !symbol.startsWith('IND_')) {
          insertRS.run(date, symbol, rank);
        }
      }
    }
  });

  // Migrate sector RS history
  const secHistory = store.loadHistory(store.SEC_HISTORY_FILE);
  const insertSec = db.prepare(
    `INSERT OR IGNORE INTO rs_snapshots (date, symbol, type, rs_rank) VALUES (?, ?, 'sector', ?)`
  );
  const txnSec = db.transaction(() => {
    for (const [date, snapshot] of Object.entries(secHistory)) {
      for (const [key, rank] of Object.entries(snapshot)) {
        const symbol = key.replace('SEC_', '');
        insertSec.run(date, symbol, rank);
      }
    }
  });

  // Migrate industry RS history
  const indHistory = store.loadHistory(store.IND_HISTORY_FILE);
  const insertInd = db.prepare(
    `INSERT OR IGNORE INTO rs_snapshots (date, symbol, type, rs_rank) VALUES (?, ?, 'industry', ?)`
  );
  const txnInd = db.transaction(() => {
    for (const [date, snapshot] of Object.entries(indHistory)) {
      for (const [key, rank] of Object.entries(snapshot)) {
        const symbol = key.replace('IND_', '');
        insertInd.run(date, symbol, rank);
      }
    }
  });

  // Check if migration is needed
  const count = db.prepare('SELECT COUNT(*) as cnt FROM rs_snapshots').get();
  if (count.cnt === 0) {
    console.log('  Migrating RS history from JSON to SQLite...');
    txnRS();
    txnSec();
    txnInd();
    const newCount = db.prepare('SELECT COUNT(*) as cnt FROM rs_snapshots').get();
    console.log(`  ✓ Migrated ${newCount.cnt} RS snapshot records to SQLite`);
  }

  // Migrate watchlist
  const wlCount = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='watchlist_v2'").get();
  // Using trades table instead — watchlist stays as JSON for now (simple CRUD)
}

module.exports = { getDB, migrateFromJSON, DB_PATH };
