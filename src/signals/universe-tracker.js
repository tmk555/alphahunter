// ─── Point-in-Time Universe Tracking ─────────────────────────────────────────
// Eliminates survivorship bias in backtesting by tracking when stocks enter
// and leave the trading universe. Freezes snapshots on removal so historical
// data is preserved for accurate replay.
const { getDB } = require('../data/database');

function db() { return getDB(); }

function marketDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── Sync Universe ──────────────────────────────────────────────────────────
// Compare current universe against universe_mgmt table.
// Add new symbols, mark removed symbols, freeze their snapshots.

function syncUniverse(currentUniverse, sectorMap) {
  const date = marketDate();
  const currentSet = new Set(Array.isArray(currentUniverse) ? currentUniverse : Object.keys(currentUniverse));

  // Get all tracked symbols
  const tracked = db().prepare('SELECT symbol, sector, removed_date FROM universe_mgmt').all();
  const trackedMap = {};
  for (const t of tracked) trackedMap[t.symbol] = t;

  const added = [];
  const removed = [];
  const reactivated = [];
  let unchanged = 0;

  const txn = db().transaction(() => {
    // 1. Add new symbols not yet tracked
    const insertStmt = db().prepare(
      `INSERT OR IGNORE INTO universe_mgmt (symbol, sector, added_date, source)
       VALUES (?, ?, ?, 'auto_sync')`
    );
    for (const symbol of currentSet) {
      const sector = typeof sectorMap === 'object' ? (sectorMap[symbol] || 'Unknown') : 'Unknown';
      if (!trackedMap[symbol]) {
        insertStmt.run(symbol, sector, date);
        added.push({ symbol, sector, date });
      } else if (trackedMap[symbol].removed_date) {
        // Re-activate previously removed symbol
        db().prepare(
          `UPDATE universe_mgmt SET removed_date = NULL, reason = NULL, source = 'auto_reactivated'
           WHERE symbol = ?`
        ).run(symbol);
        reactivated.push({ symbol, sector: trackedMap[symbol].sector, date });
      } else {
        unchanged++;
      }
    }

    // 2. Mark removed symbols (in tracking but not in current universe)
    for (const t of tracked) {
      if (!currentSet.has(t.symbol) && !t.removed_date) {
        db().prepare(
          `UPDATE universe_mgmt SET removed_date = ?, reason = 'auto_removed', source = 'auto_sync'
           WHERE symbol = ?`
        ).run(date, t.symbol);

        // Freeze snapshot for the removed symbol
        try {
          freezeSnapshot(t.symbol, 'auto_removed');
        } catch (_) {}

        removed.push({ symbol: t.symbol, sector: t.sector, date, reason: 'auto_removed' });
      }
    }
  });

  txn();

  return {
    date,
    added: added.length,
    removed: removed.length,
    reactivated: reactivated.length,
    unchanged,
    total: currentSet.size,
    additions: added,
    removals: removed,
    reactivations: reactivated,
  };
}

// ─── Freeze Snapshot ────────────────────────────────────────────────────────
// Copy latest rs_snapshot and scan_result for a symbol into frozen storage.

function freezeSnapshot(symbol, reason = 'manual') {
  const date = marketDate();

  // Get latest RS snapshot
  const snapshot = db().prepare(`
    SELECT * FROM rs_snapshots
    WHERE symbol = ? AND type = 'stock'
    ORDER BY date DESC LIMIT 1
  `).get(symbol);

  // Get latest scan result
  const scanResult = db().prepare(`
    SELECT data, conviction_score FROM scan_results
    WHERE symbol = ?
    ORDER BY date DESC LIMIT 1
  `).get(symbol);

  db().prepare(`
    INSERT INTO universe_frozen_snapshots (symbol, frozen_date, removal_reason, last_rs_rank, last_price, last_scan_data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    symbol,
    date,
    reason,
    snapshot?.rs_rank || null,
    snapshot?.price || null,
    scanResult?.data || null,
  );

  return {
    symbol,
    frozen_date: date,
    removal_reason: reason,
    last_rs_rank: snapshot?.rs_rank,
    last_price: snapshot?.price,
  };
}

// ─── Get Active Universe for a Date ─────────────────────────────────────────
// Returns the list of symbols that were in the universe on a given date.
// This is the key function for survivorship-bias-free backtesting.

function getActiveUniverseForDate(date) {
  // Primary: use universe_mgmt with date range filtering
  const mgmtCount = db().prepare('SELECT COUNT(*) as cnt FROM universe_mgmt').get().cnt;

  if (mgmtCount > 0) {
    const active = db().prepare(`
      SELECT symbol FROM universe_mgmt
      WHERE added_date <= ?
        AND (removed_date IS NULL OR removed_date > ?)
    `).all(date, date).map(r => r.symbol);

    if (active.length > 0) return active;
  }

  // Fallback: use rs_snapshots to infer which symbols existed on that date
  const fallback = db().prepare(`
    SELECT DISTINCT symbol FROM rs_snapshots
    WHERE date = ? AND type = 'stock' AND price > 0
  `).all(date).map(r => r.symbol);

  return fallback;
}

// ─── Get Universe Changes ───────────────────────────────────────────────────

function getUniverseChanges(startDate, endDate) {
  const params = [];
  let addQuery = 'SELECT symbol, sector, added_date as date FROM universe_mgmt WHERE added_date IS NOT NULL';
  let removeQuery = 'SELECT symbol, sector, removed_date as date, reason FROM universe_mgmt WHERE removed_date IS NOT NULL';

  if (startDate) {
    addQuery += ' AND added_date >= ?';
    removeQuery += ' AND removed_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    addQuery += ' AND added_date <= ?';
    removeQuery += ' AND removed_date <= ?';
    params.push(endDate);
  }

  addQuery += ' ORDER BY added_date DESC';
  removeQuery += ' ORDER BY removed_date DESC';

  const additions = startDate || endDate
    ? db().prepare(addQuery).all(...params)
    : db().prepare(addQuery).all();
  const removals = startDate || endDate
    ? db().prepare(removeQuery).all(...params)
    : db().prepare(removeQuery).all();

  return { additions, removals };
}

// ─── Get Frozen Snapshots ───────────────────────────────────────────────────

function getFrozenSnapshots(limit = 50) {
  return db().prepare(
    'SELECT * FROM universe_frozen_snapshots ORDER BY frozen_date DESC LIMIT ?'
  ).all(limit);
}

// ─── Restore Symbol ─────────────────────────────────────────────────────────

function restoreSymbol(symbol) {
  db().prepare(
    `UPDATE universe_mgmt SET removed_date = NULL, reason = NULL, source = 'manual_restore'
     WHERE symbol = ?`
  ).run(symbol);
  return { symbol, restored: true, date: marketDate() };
}

// ─── Universe Size Over Time ────────────────────────────────────────────────

function getUniverseSizeOverTime(startDate, endDate) {
  // Use rs_snapshots as the most reliable source of daily active counts
  let query = `
    SELECT date, COUNT(DISTINCT symbol) as active_count
    FROM rs_snapshots
    WHERE type = 'stock' AND price > 0
  `;
  const params = [];

  if (startDate) { query += ' AND date >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND date <= ?'; params.push(endDate); }
  query += ' GROUP BY date ORDER BY date ASC';

  return db().prepare(query).all(...params);
}

module.exports = {
  syncUniverse,
  freezeSnapshot,
  getActiveUniverseForDate,
  getUniverseChanges,
  getFrozenSnapshots,
  restoreSymbol,
  getUniverseSizeOverTime,
};
