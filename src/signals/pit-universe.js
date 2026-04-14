// ─── Point-in-Time Index Membership ────────────────────────────────────────
//
// This module is the read/write API for the `universe_membership` table,
// which holds historical constituent data for external indices (S&P 500,
// Russell 1000, Nasdaq 100, etc.).
//
// Why it exists: backtests that use today's universe for historical dates
// are silently biased toward stocks that survived. A 2018 backtest that
// includes NVDA (a 2019 addition) is cheating; one that excludes Valeant
// (a 2017 removal) is cheating the other direction. This table stores
// who was actually in each index on each trading day, so replay.js and
// the walk-forward engine can ask "who was in the S&P 500 on 2018-03-15?"
// and get the real answer.
//
// Data shape: sparse date ranges. One row per continuous membership stint.
// A symbol that was in the index for 2010-2015, dropped, and re-added
// 2019-present is two rows:
//   SP500, NFLX, 2010-12-20, 2015-06-30
//   SP500, NFLX, 2019-09-23, NULL
//
// Sources:
//   • Wikipedia "List of S&P 500 companies" (current + changes table)
//   • fja05680/sp500 GitHub dataset (historical CSVs)
//   • FTSE Russell reconstitution press releases (annual)
//   • Manual seed files (useful for tests and small fixtures)

const fs = require('fs');
const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Import ─────────────────────────────────────────────────────────────────
//
// Bulk-insert membership rows. Uses INSERT OR REPLACE so running the same
// importer twice is idempotent — the primary key (index_name, symbol,
// start_date) dedupes repeat stints.

/**
 * @param {Array<{indexName:string,symbol:string,startDate:string,endDate?:string|null,sector?:string|null,source?:string|null}>} rows
 * @returns {{inserted: number, skipped: number}}
 */
function importMembership(rows) {
  if (!Array.isArray(rows)) throw new Error('importMembership: rows must be an array');
  if (rows.length === 0) return { inserted: 0, skipped: 0 };

  const stmt = db().prepare(`
    INSERT OR REPLACE INTO universe_membership
      (index_name, symbol, start_date, end_date, sector, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;
  const txn = db().transaction((batch) => {
    for (const r of batch) {
      if (!r.indexName || !r.symbol || !r.startDate) {
        skipped++;
        continue;
      }
      stmt.run(
        String(r.indexName).toUpperCase(),
        String(r.symbol).toUpperCase(),
        r.startDate,
        r.endDate || null,
        r.sector || null,
        r.source || 'manual',
      );
      inserted++;
    }
  });
  txn(rows);
  return { inserted, skipped };
}

// ─── Seed file loader ──────────────────────────────────────────────────────
//
// Reads a JSON file of membership records and imports them. The file is
// either the "flat" shape (array of rows) or the "grouped" shape
// ({ indexName, source, rows: [...] }) — the grouped shape avoids
// repeating indexName on every row in static seed data.

function loadFromSeedFile(path) {
  if (!fs.existsSync(path)) throw new Error(`Seed file not found: ${path}`);
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const rows = _normalizeSeed(raw);
  return importMembership(rows);
}

function _normalizeSeed(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.rows)) {
    return raw.rows.map(r => ({
      indexName: r.indexName || raw.indexName,
      symbol:    r.symbol,
      startDate: r.startDate || r.start || r.added || r.added_date,
      endDate:   r.endDate   || r.end   || r.removed || r.removed_date || null,
      sector:    r.sector || null,
      source:    r.source || raw.source || 'seed',
    }));
  }
  throw new Error('Seed file must be an array or { rows: [...] } object');
}

// ─── Query ──────────────────────────────────────────────────────────────────
//
// "Who was in the index on date D?" — the core backtest-safety question.
// A row counts as a member on D when start_date <= D < end_date (end is
// exclusive so a same-day drop doesn't also appear as a current member).

/**
 * @param {string} date       ISO 'YYYY-MM-DD'
 * @param {string} indexName  e.g. 'SP500' (case-insensitive)
 * @returns {string[]}        Symbols (uppercase) that were members on `date`
 */
function getMembersOn(date, indexName = 'SP500') {
  if (!date) throw new Error('getMembersOn: date required');
  const rows = db().prepare(`
    SELECT DISTINCT symbol FROM universe_membership
    WHERE index_name = ?
      AND start_date <= ?
      AND (end_date IS NULL OR end_date > ?)
    ORDER BY symbol
  `).all(String(indexName).toUpperCase(), date, date);
  return rows.map(r => r.symbol);
}

/**
 * Get membership ROWS (with sector) for a given date — useful when the
 * caller needs sector metadata alongside symbols.
 */
function getMembershipOn(date, indexName = 'SP500') {
  if (!date) throw new Error('getMembershipOn: date required');
  return db().prepare(`
    SELECT symbol, sector, start_date, end_date, source
    FROM universe_membership
    WHERE index_name = ?
      AND start_date <= ?
      AND (end_date IS NULL OR end_date > ?)
    ORDER BY symbol
  `).all(String(indexName).toUpperCase(), date, date);
}

// ─── Metadata ───────────────────────────────────────────────────────────────

function getIndices() {
  return db().prepare(
    'SELECT index_name, COUNT(*) as stint_count FROM universe_membership GROUP BY index_name'
  ).all();
}

function getCoverage(indexName = 'SP500') {
  const row = db().prepare(`
    SELECT
      MIN(start_date)   AS earliest_start,
      MAX(COALESCE(end_date, '9999-12-31')) AS latest_known,
      COUNT(*)          AS total_stints,
      COUNT(DISTINCT symbol) AS distinct_symbols
    FROM universe_membership WHERE index_name = ?
  `).get(String(indexName).toUpperCase());
  return row || null;
}

/** Empty the table for a specific index — used by tests and re-imports. */
function clearIndex(indexName) {
  db().prepare('DELETE FROM universe_membership WHERE index_name = ?')
    .run(String(indexName).toUpperCase());
}

module.exports = {
  importMembership,
  loadFromSeedFile,
  getMembersOn,
  getMembershipOn,
  getIndices,
  getCoverage,
  clearIndex,
};
