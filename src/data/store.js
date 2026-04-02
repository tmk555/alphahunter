// ─── JSON file persistence (to be replaced with SQLite in Phase 2) ────────────
const fs   = require('fs');
const path = require('path');

const DATA_DIR         = path.join(__dirname, '..', '..', 'data');
const RS_HISTORY_FILE  = path.join(DATA_DIR, 'rs-history.json');
const SEC_HISTORY_FILE = path.join(DATA_DIR, 'rs-history-sectors.json');
const IND_HISTORY_FILE = path.join(DATA_DIR, 'rs-history-industries.json');
const WATCHLIST_FILE   = path.join(DATA_DIR, 'watchlist.json');
const CYCLE_STATE_FILE = path.join(DATA_DIR, 'cycle-state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadHistory(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(_) { return {}; }
}

function saveHistory(file, scores, dateStr) {
  const h = loadHistory(file);
  h[dateStr] = scores;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 95);
  const cut = cutoff.toISOString().split('T')[0];
  for (const d of Object.keys(h)) { if (d < cut) delete h[d]; }
  try { fs.writeFileSync(file, JSON.stringify(h)); } catch(_) {}
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
  RS_HISTORY_FILE, SEC_HISTORY_FILE, IND_HISTORY_FILE,
  WATCHLIST_FILE, CYCLE_STATE_FILE,
  loadHistory, saveHistory,
  loadWatchlist, saveWatchlist,
  loadCycleState, saveCycleState,
};
