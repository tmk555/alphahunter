#!/usr/bin/env node
// ─── fetch-sp500-history.js ────────────────────────────────────────────────
//
// Populates the `universe_membership` table with historical S&P 500
// constituents. Supports multiple sources because no single source is both
// complete and trustworthy:
//
//   • wikipedia — scrapes "List of S&P 500 companies" (current list +
//     "Selected changes to the list of S&P 500 components" table).
//     Cheap, free, but lossy before ~2000 and occasionally inconsistent.
//
//   • fja05680  — reads CSVs from the fja05680/sp500 GitHub dataset. Much
//     deeper history (back to the 1990s) but requires cloning or proxying
//     the raw files. Pass --path to point at a local checkout.
//
//   • seed      — loads a local JSON file in the pit-universe seed shape.
//     This is the path that actually works today and is what the test
//     fixture uses. Intended for bootstrapping, small indices, and unit
//     tests where we don't want network dependencies.
//
// USAGE
//   node scripts/fetch-sp500-history.js --source seed --path seeds/sp500.json
//   node scripts/fetch-sp500-history.js --source wikipedia --dry-run
//   node scripts/fetch-sp500-history.js --source fja05680 --path ../sp500-repo
//
// Always run with --dry-run first when pulling from an external source so
// you can eyeball the first few rows before committing.

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// Lazy-loaded so --help doesn't have to open the DB.
function pit() { return require('../src/signals/pit-universe'); }

// ─── Args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { source: null, path: null, indexName: 'SP500', dryRun: false, limit: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source')    out.source    = argv[++i];
    else if (a === '--path') out.path      = argv[++i];
    else if (a === '--index') out.indexName = argv[++i];
    else if (a === '--limit') out.limit    = parseInt(argv[++i], 10);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  return out;
}

function printHelp() {
  console.log(`fetch-sp500-history.js — populate universe_membership

  --source <name>   wikipedia | fja05680 | seed   (required)
  --path <file>     path for seed/fja05680 sources
  --index <name>    index name to write under (default: SP500)
  --limit <N>       import at most N rows (useful for --dry-run previews)
  --dry-run         print what would be imported; don't write to DB
  --help            show this message
`);
}

// ─── Source: seed file ─────────────────────────────────────────────────────
//
// The most reliable path. Reads a JSON file in the shape understood by
// pit-universe.loadFromSeedFile and returns the normalized rows for the
// caller to import (so --dry-run can preview before writing).

function loadFromSeed(filePath) {
  if (!filePath) throw new Error('--source seed requires --path');
  if (!fs.existsSync(filePath)) throw new Error(`seed file not found: ${filePath}`);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const indexName = raw.indexName || 'SP500';
  const source = raw.source || 'seed';
  const rows = Array.isArray(raw) ? raw : (raw.rows || []);
  return rows.map(r => ({
    indexName: r.indexName || indexName,
    symbol:    r.symbol,
    startDate: r.startDate || r.start || r.added || r.added_date,
    endDate:   r.endDate   || r.end   || r.removed || r.removed_date || null,
    sector:    r.sector || null,
    source:    r.source || source,
  }));
}

// ─── Source: Wikipedia ─────────────────────────────────────────────────────
//
// Scrapes "List of S&P 500 companies" — two tables off one page:
//   1. table#constituents → current members with Symbol, GICS Sector, and
//      "Date first added" columns. That gives us one open-ended stint per
//      current member.
//   2. The "Selected changes" table (found by header pattern, not ID, so
//      the scrape survives Wikipedia's periodic ID renames) → historical
//      Add/Remove events. We pair them per-symbol into closed stints.
//
// Parsing approach: hand-rolled regex. Wikipedia's HTML for this page is
// stable enough that a few patterns hold up month to month, and this
// avoids adding a cheerio/htmlparser2 dependency for a one-shot importer.
// If this breaks, diagnose what changed on the page BEFORE loosening a
// regex — a silently-permissive parser is worse than a clearly-broken one.
//
// Known limitation: a symbol whose ADD event predates the changes table's
// coverage shows up with an unpaired REMOVE. We don't know when they were
// added, so we fall back to UNBOUNDED_START (1957-03-04, S&P 500 inception)
// and label the row `source=wikipedia-synthesized-start`. Every consumer
// should treat that label as "start date is a floor, not ground truth."
// Concretely: a backtest that begins AFTER the synthetic start but BEFORE
// the real add date will incorrectly include the symbol. In practice this
// affects ~3-5 removed names per decade of backtest and is much better
// than silently dropping them (our previous behavior).

const WIKI_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';

async function fetchFromWikipedia() {
  const res = await fetch(WIKI_URL, {
    headers: { 'User-Agent': 'alphahunter-pit-seed/1.0' },
  });
  if (!res.ok) throw new Error(`Wikipedia fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const current = parseConstituentsTable(html);
  const changes = parseChangesTable(html);
  console.error(`  wikipedia: parsed ${current.length} current constituents`);
  console.error(`  wikipedia: parsed ${changes.length} historical change events`);

  return buildStintsFromWiki(current, changes);
}

// ─── HTML helpers ──────────────────────────────────────────────────────────

function stripTags(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#160;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\[\w+\]/g, '')   // citations like [1], [a]
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRows(tableHtml) {
  const rows = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(tableHtml)) !== null) rows.push(m[1]);
  return rows;
}

function extractCells(rowHtml) {
  const cells = [];
  const re = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) cells.push(stripTags(m[2]));
  return cells;
}

function findConstituentsTable(html) {
  const idx = html.indexOf('id="constituents"');
  if (idx < 0) throw new Error('Wikipedia: table#constituents not found');
  const start = html.lastIndexOf('<table', idx);
  const end   = html.indexOf('</table>', idx);
  if (start < 0 || end < 0) throw new Error('Wikipedia: constituents table boundaries not found');
  return html.slice(start, end);
}

// The changes table has no reliable ID, so we find it by header signature.
// It's the first table on the page containing "Added" and "Removed" <th>s.
function findChangesTable(html) {
  const re = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const table = m[0];
    if (/<th[^>]*>[\s\S]*?Added[\s\S]*?<\/th>/i.test(table)
     && /<th[^>]*>[\s\S]*?Removed[\s\S]*?<\/th>/i.test(table)) {
      return table;
    }
  }
  throw new Error('Wikipedia: changes table not found');
}

// ─── Column parsers ────────────────────────────────────────────────────────

function parseConstituentsTable(html) {
  const table = findConstituentsTable(html);
  const rows  = extractRows(table);
  const out   = [];
  // Column layout (as of 2024/2025):
  //   0 Symbol | 1 Security | 2 GICS Sector | 3 GICS Sub-Industry
  //   4 HQ Location | 5 Date first added | 6 CIK | 7 Founded
  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 6) continue;
    const symbol = cells[0];
    // Header row has "Symbol" as text; ticker rows start with an uppercase letter.
    if (!/^[A-Z][A-Z0-9.\-]*$/.test(symbol)) continue;
    out.push({
      symbol,
      sector:     cells[2] || null,
      firstAdded: cells[5] || null,
    });
  }
  return out;
}

function parseChangesTable(html) {
  const table = findChangesTable(html);
  const rows  = extractRows(table);
  const out   = [];
  // Column layout:
  //   0 Date | 1 Added Ticker | 2 Added Security
  //   3 Removed Ticker | 4 Removed Security | 5 Reason
  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 5) continue;
    const date = cells[0];
    if (!/\d{4}/.test(date)) continue; // header/filler row
    out.push({
      date,
      addedTicker:   cells[1] || null,
      removedTicker: cells[3] || null,
    });
  }
  return out;
}

// ─── Date normalization ────────────────────────────────────────────────────
//
// Wikipedia dates come in several flavors:
//   "1957-03-04"              → passthrough
//   "March 4, 1957"           → 1957-03-04
//   "Mar 4, 1957"             → 1957-03-04
//   "March 4, 1957[1][2]"     → (citations already stripped by stripTags)

const MONTHS = {
  january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
  july:'07', august:'08', september:'09', october:'10', november:'11', december:'12',
  jan:'01', feb:'02', mar:'03', apr:'04', jun:'06', jul:'07',
  aug:'08', sep:'09', sept:'09', oct:'10', nov:'11', dec:'12',
};

function normalizeDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${m[2].padStart(2, '0')}`;
  }
  const yr = t.match(/^(\d{4})$/);
  if (yr) return `${yr[1]}-01-01`;
  return null;
}

// ─── Stint builder ─────────────────────────────────────────────────────────
//
// Turns (current members, change events) into a list of {symbol, start, end}
// stints. Algorithm:
//
//   1. Build a per-symbol event list from the changes table: every "Added"
//      is an ADD event, every "Removed" is a REMOVE event.
//   2. For current members with no events, push a synthetic ADD at their
//      "first added" date — they've been in continuously.
//   3. Sort each symbol's events oldest-first and walk them, pairing each
//      ADD with the next REMOVE to form closed stints. A trailing ADD with
//      no matching REMOVE becomes an open stint (endDate=null) iff the
//      symbol is in the current list.
//   4. Unpaired REMOVEs (no prior ADD in the table) are dropped — see the
//      "known limitation" note above.

const UNBOUNDED_START = '1957-03-04'; // S&P 500 inception; used as a floor
                                       // for stints whose ADD predates the
                                       // changes table.

function buildStintsFromWiki(current, changes) {
  const events = new Map(); // symbol -> [{type, date}]
  const pushEvent = (symbol, type, rawDate) => {
    if (!symbol) return;
    const d = normalizeDate(rawDate);
    if (!d) return;
    if (!events.has(symbol)) events.set(symbol, []);
    events.get(symbol).push({ type, date: d });
  };

  for (const ch of changes) {
    if (ch.addedTicker)   pushEvent(ch.addedTicker,   'add',    ch.date);
    if (ch.removedTicker) pushEvent(ch.removedTicker, 'remove', ch.date);
  }

  const currentSet  = new Set(current.map(m => m.symbol));
  const sectorOf    = Object.fromEntries(current.map(m => [m.symbol, m.sector]));
  const firstAddOf  = Object.fromEntries(current.map(m => [m.symbol, m.firstAdded]));

  // Current members who don't show up in the changes table → synthetic ADD
  // at their Wikipedia "first added" date. No events means "been in since".
  for (const m of current) {
    if (!events.has(m.symbol)) pushEvent(m.symbol, 'add', m.firstAdded);
  }

  const rows = [];
  for (const [symbol, evs] of events.entries()) {
    evs.sort((a, b) => a.date.localeCompare(b.date));
    let openStart = null;
    let openSource = 'wikipedia';
    for (const ev of evs) {
      if (ev.type === 'add') {
        // Double-add without an intervening remove: skip the duplicate.
        if (openStart === null) { openStart = ev.date; openSource = 'wikipedia'; }
      } else if (ev.type === 'remove') {
        if (openStart === null) {
          // Unpaired remove → the symbol was in the index before the
          // changes table's coverage begins. Emit with a synthesized
          // start so the stint is visible to consumers, labelled so they
          // can filter it out if they need ground-truth starts only.
          rows.push({
            symbol,
            startDate: UNBOUNDED_START,
            endDate:   ev.date,
            sector:    sectorOf[symbol] || null,
            source:    'wikipedia-synthesized-start',
          });
          continue;
        }
        rows.push({
          symbol,
          startDate: openStart,
          endDate:   ev.date,
          sector:    sectorOf[symbol] || null,
          source:    openSource,
        });
        openStart = null;
      }
    }

    // Trailing open stint: only emit for current members. A non-current
    // symbol with an open stint means the table's last event was an ADD
    // without a REMOVE we can find — most likely scrape noise.
    if (openStart !== null && currentSet.has(symbol)) {
      rows.push({
        symbol,
        startDate: openStart,
        endDate:   null,
        sector:    sectorOf[symbol] || null,
        source:    openSource,
      });
    } else if (openStart === null && currentSet.has(symbol)
               && !rows.some(r => r.symbol === symbol && r.endDate === null)) {
      // Current member whose events ended on a REMOVE — inconsistent.
      // Fall back to the "first added" column so they don't disappear.
      const d = normalizeDate(firstAddOf[symbol]);
      if (d) {
        rows.push({
          symbol,
          startDate: d,
          endDate:   null,
          sector:    sectorOf[symbol] || null,
          source:    'wikipedia-firstadded',
        });
      }
    }
  }
  return rows;
}

// ─── Source: fja05680/sp500 ────────────────────────────────────────────────
//
// TODO(day 3-4 follow-up): read CSVs from a local checkout of
// https://github.com/fja05680/sp500
//
// Plan:
//   1. The repo has S&P_500_Historical_Components_&_Changes(...).csv with
//      one row per (date, component list) — we want the delta between
//      consecutive rows, which gives us add/remove events.
//   2. Walk dates ascending, maintain a running set; diffing the current
//      set against the previous one emits (symbol, start_date) for new
//      entries and closes (symbol, end_date) for departures.
//   3. Still-open stints at the final date get endDate = null.

function fetchFromFja05680() {
  throw new Error('fja05680 source not yet implemented — see TODO in scripts/fetch-sp500-history.js');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (!args.source) { printHelp(); process.exit(1); }

  let rows;
  switch (args.source) {
    case 'seed':      rows = loadFromSeed(args.path); break;
    case 'wikipedia': rows = await fetchFromWikipedia(); break;
    case 'fja05680':  rows = fetchFromFja05680(); break;
    default:
      console.error(`Unknown --source: ${args.source}`);
      process.exit(1);
  }

  // Force every row onto the caller-specified index, so a SP500 seed can be
  // reused to populate a "TEST500" index in a test run.
  rows = rows.map(r => ({ ...r, indexName: args.indexName }));

  if (args.limit) rows = rows.slice(0, args.limit);

  console.log(`Source: ${args.source}  rows: ${rows.length}  index: ${args.indexName}`);
  console.log('First 5:');
  rows.slice(0, 5).forEach(r => {
    console.log(`  ${r.symbol.padEnd(6)} ${r.startDate} → ${r.endDate || 'NOW'}  ${r.sector || ''}`);
  });

  if (args.dryRun) {
    console.log('\n--dry-run: not writing to DB.');
    return;
  }

  const result = pit().importMembership(rows);
  console.log(`\nImported: ${result.inserted} rows (${result.skipped} skipped)`);
  const cov = pit().getCoverage(args.indexName);
  if (cov) {
    console.log(`Coverage (${args.indexName}): ${cov.total_stints} stints, ${cov.distinct_symbols} symbols, earliest ${cov.earliest_start}`);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, loadFromSeed,
  fetchFromWikipedia, parseConstituentsTable, parseChangesTable,
  buildStintsFromWiki, normalizeDate,
};
