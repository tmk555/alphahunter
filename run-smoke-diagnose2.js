require('dotenv').config();
const { getDB } = require('./src/data/database');
const db = getDB();

// Check if universe_history / universe-tracker has data
try {
  const { getActiveUniverseForDate } = require('./src/signals/universe-tracker');
  const active = getActiveUniverseForDate('2024-06-03', 'SP500');
  console.log(`SP500 active universe on 2024-06-03: ${active?.length ?? 'null'}`);
  if (active?.length) console.log('Sample:', active.slice(0, 10));
} catch (e) {
  console.log('universe-tracker error:', e.message);
}

// What symbols are in rs_snapshots on 2024-06-03?
const rsSymbols = db.prepare(`
  SELECT COUNT(DISTINCT symbol) as n FROM rs_snapshots
  WHERE type='stock' AND date='2024-06-03'
`).get().n;
console.log('Symbols in rs_snapshots on 2024-06-03:', rsSymbols);

// Simulate the entry filter for factor_combo rs_strong on 2024-06-03
const rsStrong2024 = db.prepare(`
  SELECT symbol, rs_rank FROM rs_snapshots
  WHERE type='stock' AND date='2024-06-03' AND rs_rank >= 80
  ORDER BY rs_rank DESC LIMIT 15
`).all();
console.log(`\nTop 15 RS≥80 on 2024-06-03:`); console.table(rsStrong2024);

// universe_history table exists?
try {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%universe%'`).all();
  console.log('\nUniverse tables:', tables);
  for (const t of tables) {
    const n = db.prepare(`SELECT COUNT(*) as n FROM ${t.name}`).get().n;
    console.log(`  ${t.name}: ${n} rows`);
  }
} catch (e) { console.log('universe table scan err:', e.message); }

process.exit(0);
