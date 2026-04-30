#!/usr/bin/env node
// ─── fetch-sp400-sp600.js ──────────────────────────────────────────────────
//
// Pulls the current S&P 400 (mid-cap) and S&P 600 (small-cap) constituents
// from Wikipedia and writes them to universe_membership with index_name
// SP400 / SP600. Together with the SP500 entries already there, this gives
// us the S&P 1500 — the canonical "broad market" universe most pros use
// for breadth signals when full NYSE A/D isn't available.
//
// The S&P 500 fetcher (fetch-sp500-history.js) was hardcoded to one URL;
// this script handles both new indices in a single pass with shared
// table parsing so we don't fork the whole importer for two indices.
//
// USAGE
//   node scripts/fetch-sp400-sp600.js [--dry-run]
//
// Wikipedia is a current-snapshot source — we only get TODAY's members,
// not historical add/remove events. That's fine for the universe-merge
// use case (point-in-time scanning) since `start_date` is set to today
// and `end_date` is NULL (active).

const fs = require('fs');

function pit() { return require('../src/signals/pit-universe'); }

const PAGES = [
  {
    indexName: 'SP400',
    url: 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies',
  },
  {
    indexName: 'SP600',
    url: 'https://en.wikipedia.org/wiki/List_of_S%26P_600_companies',
  },
];

// ─── Fetch + parse one page ────────────────────────────────────────────────
//
// Both pages use the same #constituents table layout as the SP500 page:
//   columns: Symbol | Security | GICS Sector | GICS Sub-Industry | ... | (Date added)
// We hand-roll a simple regex parse — same approach as fetch-sp500-history's
// `loadFromWikipedia` so behavior matches when a row has odd whitespace.

async function fetchHTML(url) {
  const fetch = global.fetch || require('node-fetch');
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
  });
  if (!r.ok) throw new Error(`Wikipedia returned ${r.status} for ${url}`);
  return r.text();
}

// Extract the #constituents table HTML, then split into rows.
function extractRows(html) {
  // Pull just the constituents table to avoid matching change-history rows.
  const tableM = html.match(/<table[^>]+id="constituents"[\s\S]*?<\/table>/i);
  if (!tableM) throw new Error('constituents table not found on page');
  const table = tableM[0];

  const rows = [];
  // Each <tr> after the header. Skip the header row (first match).
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m, isHeader = true;
  while ((m = rowRe.exec(table)) !== null) {
    if (isHeader) { isHeader = false; continue; }
    rows.push(m[1]);
  }
  return rows;
}

// Parse one row: extract symbol (col 0) and sector (col 2).
// Wikipedia ticker cells link out, so we strip <a> wrappers.
function parseRow(rowHtml) {
  const cells = [];
  const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
  let m;
  while ((m = cellRe.exec(rowHtml)) !== null) {
    cells.push(m[1]);
  }
  if (cells.length < 3) return null;

  const stripTags = (s) => s.replace(/<[^>]+>/g, '').trim();
  const symbol = stripTags(cells[0]).replace(/ /g, ' ').trim();
  const sector = stripTags(cells[2]).replace(/ /g, ' ').trim();

  if (!symbol || !/^[A-Z][A-Z0-9.\-]{0,5}$/i.test(symbol)) return null;
  return { symbol: symbol.toUpperCase(), sector };
}

// Map Wikipedia GICS sector names to our internal sector tags so the
// merged universe has consistent sector-filter behavior across SP500 +
// SP400 + SP600. Matches the mapping used by the SP500 importer.
function mapSector(gics) {
  if (!gics) return 'Unknown';
  const s = gics.toLowerCase();
  if (s.includes('information technology'))     return 'Technology';
  if (s.includes('communication services'))     return 'Comm Services';
  if (s.includes('consumer discretionary'))     return 'Consumer Disc';
  if (s.includes('consumer staples'))           return 'Cons Staples';
  if (s.includes('financ'))                     return 'Financials';
  if (s.includes('health'))                     return 'Healthcare';
  if (s.includes('industrial'))                 return 'Industrials';
  if (s.includes('material'))                   return 'Materials';
  if (s.includes('energy'))                     return 'Energy';
  if (s.includes('utilit'))                     return 'Utilities';
  if (s.includes('real estate'))                return 'Real Estate';
  return 'Unknown';
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const today = new Date().toISOString().slice(0, 10);

  let allRows = [];
  for (const { indexName, url } of PAGES) {
    process.stderr.write(`Fetching ${indexName} from Wikipedia... `);
    const html = await fetchHTML(url);
    const rawRows = extractRows(html);
    const parsed = rawRows.map(parseRow).filter(Boolean);
    process.stderr.write(`${parsed.length} constituents\n`);

    for (const r of parsed) {
      allRows.push({
        indexName,
        symbol: r.symbol,
        startDate: today,         // current snapshot — no historical event data
        endDate: null,            // active member
        sector: mapSector(r.sector),
        source: 'wikipedia',
      });
    }
  }

  if (dryRun) {
    console.log(`Would write ${allRows.length} rows to universe_membership.`);
    console.log('\nSample (first 10):');
    for (const r of allRows.slice(0, 10)) console.log(' ', r);
    console.log('\nBy index:');
    const byIdx = {};
    for (const r of allRows) byIdx[r.indexName] = (byIdx[r.indexName] || 0) + 1;
    console.log(' ', byIdx);
    process.exit(0);
  }

  const { importMembership } = pit();
  const { inserted, skipped } = importMembership(allRows);
  console.log(`Imported ${inserted} rows into universe_membership; ${skipped} skipped (missing required field).`);
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
