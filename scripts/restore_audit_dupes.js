#!/usr/bin/env node
/**
 * One-shot restore: re-inserts the rows that zombie_dupe_cleanup_*.json
 * captured before they were deleted. Run with the audit file path:
 *   node scripts/restore_audit_dupes.js data/audit_logs/<file>.json
 *
 * Background: Phase-1 of the dupe-cleanup deleted what was labelled
 * "strict dupes" but were actually PARTIAL FILLS of larger staged orders
 * (DELL 27sh = 9+9+9, TER 15sh = 5+5+5, MKSI 14sh × 3 partials). Each
 * "dupe" represented real shares the user owned, so removing them
 * silently shaved P&L from the journal. This restore puts them back.
 *
 * The audit file format is the multi-section JSON dumped by sqlite3 with
 * `.mode json` — alternating header rows ([{"section": "..."}]) and
 * data rows (the actual records). We parse each non-section block and
 * INSERT into the matching table, preserving primary keys (so all FK
 * references re-attach correctly).
 */

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const auditPath = process.argv[2];
if (!auditPath) { console.error('Usage: node restore_audit_dupes.js <audit.json>'); process.exit(1); }

const dbPath = path.join(__dirname, '..', 'data', 'alphahunter.db');
const db = new Database(dbPath);

const text = fs.readFileSync(auditPath, 'utf8');
// Format: sqlite3 `.mode json` emits ONE multi-line JSON array per section,
// with section markers (also single-element JSON arrays) between them.
// Section markers look like:  [{"section":"--- trades ---"}]
// We accumulate lines into the current buffer and flush whenever we hit a
// section marker (a parseable single-line array containing `section`).
const lines = text.split('\n').filter(Boolean);

let currentTable = null;
let buffer = '';
const restoreCounts = {};

const insertRow = (table, row) => {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  return stmt.run(cols.map(c => row[c]));
};

const flushBuffer = () => {
  if (!buffer || !currentTable) { buffer = ''; return; }
  let parsed;
  try { parsed = JSON.parse(buffer); }
  catch (e) { console.error(`parse fail for ${currentTable}: ${e.message}`); buffer = ''; return; }
  if (!Array.isArray(parsed)) { buffer = ''; return; }
  for (const obj of parsed) {
    const result = insertRow(currentTable, obj);
    restoreCounts[currentTable] = (restoreCounts[currentTable] || 0) + (result.changes || 0);
  }
  buffer = '';
};

for (const line of lines) {
  // Section marker = single-line array containing `section`.
  let isSectionMarker = false;
  if (line.startsWith('[{') && line.endsWith('}]')) {
    try {
      const arr = JSON.parse(line);
      if (Array.isArray(arr) && arr[0]?.section) {
        isSectionMarker = true;
        flushBuffer();
        const m = arr[0].section.match(/---\s*(\w+)\s*---/);
        currentTable = m ? m[1] : null;
      }
    } catch (_) { /* not a marker — fall through */ }
  }
  if (!isSectionMarker) buffer += line + '\n';
}
flushBuffer();

console.log('Restored row counts:', restoreCounts);
db.close();
