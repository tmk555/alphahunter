// ─── Data persistence (SQLite for RS history, JSON for simple CRUD) ──────────
const fs   = require('fs');
const path = require('path');
const { getDB } = require('./database');

const DATA_DIR         = path.join(__dirname, '..', '..', 'data');
const WATCHLIST_FILE   = path.join(DATA_DIR, 'watchlist.json');
const CYCLE_STATE_FILE = path.join(DATA_DIR, 'cycle-state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Type constants used as keys for loadHistory/saveHistory
const RS_HISTORY   = 'stock';
const SEC_HISTORY  = 'sector';
const IND_HISTORY  = 'industry';

// Load RS history from SQLite — returns { date: { symbol: rank, ... }, ... }
function loadHistory(type) {
  const db = getDB();
  const rows = db.prepare(
    `SELECT date, symbol, rs_rank FROM rs_snapshots WHERE type = ? ORDER BY date`
  ).all(type);
  const h = {};
  for (const r of rows) {
    if (!h[r.date]) h[r.date] = {};
    // Add prefix for sector/industry to match existing code expectations
    const key = type === 'sector' ? 'SEC_' + r.symbol
              : type === 'industry' ? 'IND_' + r.symbol
              : r.symbol;
    h[r.date][key] = r.rs_rank;
  }
  return h;
}

// Save RS snapshot to SQLite — scores is { symbol: rank, ... }
// Upsert rs_rank only; never clobber columns written by the richer backfill path
// (price, stage, vcp_forming, rs_line_new_high, pattern_type, atr_pct, etc.).
function saveHistory(type, scores, dateStr) {
  const db = getDB();
  const upsert = db.prepare(`
    INSERT INTO rs_snapshots (date, symbol, type, rs_rank)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date, symbol, type) DO UPDATE SET rs_rank = excluded.rs_rank
  `);
  const txn = db.transaction(() => {
    for (const [key, rank] of Object.entries(scores)) {
      // Strip prefix for storage
      const symbol = key.replace(/^SEC_/, '').replace(/^IND_/, '');
      upsert.run(dateStr, symbol, type, rank);
    }
  });
  txn();

  // Note: pruning handled by rs_history_cleanup scheduler job (default keepDays: 365)
  // Removed aggressive 95-day prune that was destroying replay/backtest data
}

function loadWatchlist() {
  try {
    return fs.existsSync(WATCHLIST_FILE)
      ? JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'))
      : [];
  } catch(_) { return []; }
}

function saveWatchlist(wl) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(wl, null, 2));
}

function loadCycleState() {
  try {
    return fs.existsSync(CYCLE_STATE_FILE)
      ? JSON.parse(fs.readFileSync(CYCLE_STATE_FILE, 'utf8'))
      : null;
  } catch(_) { return null; }
}

function saveCycleState(state) {
  fs.writeFileSync(CYCLE_STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = {
  DATA_DIR,
  RS_HISTORY, SEC_HISTORY, IND_HISTORY,
  WATCHLIST_FILE, CYCLE_STATE_FILE,
  loadHistory, saveHistory,
  loadWatchlist, saveWatchlist,
  loadCycleState, saveCycleState,
};
