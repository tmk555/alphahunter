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
function saveHistory(type, scores, dateStr) {
  const db = getDB();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO rs_snapshots (date, symbol, type, rs_rank) VALUES (?, ?, ?, ?)`
  );
  const txn = db.transaction(() => {
    for (const [key, rank] of Object.entries(scores)) {
      // Strip prefix for storage
      const symbol = key.replace(/^SEC_/, '').replace(/^IND_/, '');
      insert.run(dateStr, symbol, type, rank);
    }
  });
  txn();

  // Prune old data (keep 95 days)
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 95);
  const cut = cutoff.toISOString().split('T')[0];
  db.prepare(`DELETE FROM rs_snapshots WHERE type = ? AND date < ?`).run(type, cut);
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
