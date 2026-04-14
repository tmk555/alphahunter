#!/usr/bin/env node
// ─── fetch-fred.js ─────────────────────────────────────────────────────────
//
// Pulls historical observations from FRED (Federal Reserve Economic Data)
// via the public CSV endpoint and writes them into the `macro_series` table.
//
// The endpoint (`https://fred.stlouisfed.org/graph/fredgraph.csv?id=X`) is
// unauthenticated — no API key, no token, no rate-limited developer account.
// It's slower than the JSON API but it's bulletproof: one HTTP GET per
// series, plain CSV back, works from anywhere.
//
// USAGE
//   node scripts/fetch-fred.js                       # fetch the default set
//   node scripts/fetch-fred.js --dry-run             # preview without writing
//   node scripts/fetch-fred.js --series DGS10,UNRATE # pick specific series
//   node scripts/fetch-fred.js --list                # show stored series
//
// The default set is the nine series most useful for US equity position
// traders: yield curve (DGS10, DGS2, T10Y2Y), rates (FEDFUNDS, DFF),
// inflation (CPIAUCSL), growth (UNRATE, INDPRO), credit (BAMLH0A0HYM2),
// volatility (VIXCLS). Add more via --series; FRED has tens of thousands
// of series if you know the ID.

const fetch = require('node-fetch');

function macro() { return require('../src/signals/macro-fred'); }

// ─── Default series set ────────────────────────────────────────────────────
//
// Each entry has the FRED series ID, a short human label, and the
// frequency — "D" (daily), "W" (weekly), "M" (monthly). Frequency matters
// for deciding how much data to expect: a daily series 1980-present has
// ~11000 observations, a monthly one has ~540.
const DEFAULT_SERIES = [
  { id: 'DGS10',        label: '10-Year Treasury yield',       freq: 'D' },
  { id: 'DGS2',         label: '2-Year Treasury yield',        freq: 'D' },
  { id: 'T10Y2Y',       label: '10Y-2Y yield spread',          freq: 'D' },
  { id: 'FEDFUNDS',     label: 'Effective Fed funds rate',     freq: 'M' },
  { id: 'DFF',          label: 'Daily Fed funds rate',         freq: 'D' },
  { id: 'CPIAUCSL',     label: 'CPI (all urban consumers)',    freq: 'M' },
  { id: 'UNRATE',       label: 'Unemployment rate',            freq: 'M' },
  { id: 'INDPRO',       label: 'Industrial production index',  freq: 'M' },
  { id: 'BAMLH0A0HYM2', label: 'BofA US High Yield OAS',       freq: 'D' },
  { id: 'VIXCLS',       label: 'VIX close',                    freq: 'D' },
];

// ─── Args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    series: null,   // comma-separated list or null for default
    dryRun: false,
    list:   false,
    help:   false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--series')   out.series = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--list')    out.list   = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`Unknown arg: ${a}`); out.help = true; }
  }
  return out;
}

function printHelp() {
  console.log(`fetch-fred.js — populate macro_series from FRED CSV endpoint

  --series <ids>   Comma-separated FRED series IDs (e.g. "DGS10,UNRATE")
                   Omit to fetch the default set:
                   ${DEFAULT_SERIES.map(s => s.id).join(', ')}
  --dry-run        Parse & preview; don't write to DB
  --list           Show series currently in the DB and exit
  --help           This message
`);
}

// ─── FRED fetch ─────────────────────────────────────────────────────────────

function fredCsvUrl(seriesId) {
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
}

async function fetchOneSeries(seriesId) {
  const url = fredCsvUrl(seriesId);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'alphahunter-fred/1.0' },
  });
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  // Minimum sanity check — FRED returns an HTML error page on bad IDs
  // with a 200 status, so we inspect content too.
  if (!/^date,/i.test(text) && !/^observation_date,/i.test(text)) {
    throw new Error(`FRED ${seriesId}: unexpected response (not a CSV)`);
  }
  return macro().parseFredCsv(text, seriesId);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  if (args.list) {
    const series = macro().getAvailableSeries();
    if (series.length === 0) {
      console.log('No macro series in DB yet. Run without --list to fetch the default set.');
    } else {
      console.log(`Series in DB (${series.length}):`);
      for (const s of series) {
        console.log(`  ${s.series_id.padEnd(16)} ${s.observations.toString().padStart(6)} obs  ${s.earliest} → ${s.latest}`);
      }
    }
    return;
  }

  // Resolve which series to fetch
  const targets = args.series
    ? args.series.split(',').map(s => ({ id: s.trim().toUpperCase(), label: '(custom)', freq: '?' }))
    : DEFAULT_SERIES;

  console.log(`Fetching ${targets.length} series from FRED...`);
  console.log(args.dryRun ? '(dry-run: nothing will be written)\n' : '');

  let totalInserted = 0;
  let totalSkipped  = 0;
  const failures    = [];

  for (const t of targets) {
    process.stdout.write(`  ${t.id.padEnd(16)} ${t.label.padEnd(32)} `);
    try {
      const rows = await fetchOneSeries(t.id);
      const nonNull = rows.filter(r => r.value != null).length;
      const first = rows.find(r => r.value != null);
      const last  = [...rows].reverse().find(r => r.value != null);
      process.stdout.write(`${rows.length.toString().padStart(6)} rows (${nonNull} non-null)`);
      if (first && last) {
        process.stdout.write(`  ${first.date} → ${last.date}`);
      }
      process.stdout.write('\n');

      if (!args.dryRun) {
        const result = macro().importSeries(rows);
        totalInserted += result.inserted;
        totalSkipped  += result.skipped;
      }
    } catch (e) {
      process.stdout.write(`FAILED: ${e.message}\n`);
      failures.push({ id: t.id, error: e.message });
    }
  }

  console.log('');
  if (args.dryRun) {
    console.log('--dry-run: not writing to DB.');
  } else {
    console.log(`Imported ${totalInserted} rows (${totalSkipped} skipped).`);
    console.log('\nNow in DB:');
    for (const s of macro().getAvailableSeries()) {
      console.log(`  ${s.series_id.padEnd(16)} ${s.observations.toString().padStart(6)} obs  ${s.earliest} → ${s.latest}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} series failed:`);
    for (const f of failures) console.log(`  ${f.id}: ${f.error}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, fredCsvUrl, fetchOneSeries, DEFAULT_SERIES };
