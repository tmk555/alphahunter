require('dotenv').config();
const { getDB } = require('./src/data/database');
const db = getDB();

// rs_snapshots date range + distinct-date count
const rs = db.prepare(`
  SELECT MIN(date) as first, MAX(date) as last,
         COUNT(DISTINCT date) as days,
         COUNT(DISTINCT symbol) as syms,
         COUNT(*) as total
  FROM rs_snapshots WHERE type='stock'
`).get();
console.log('rs_snapshots (type=stock):', rs);

// pattern_detections date range
const pd = db.prepare(`
  SELECT MIN(date) as first, MAX(date) as last,
         COUNT(DISTINCT date) as days, COUNT(*) as total
  FROM pattern_detections
`).get();
console.log('pattern_detections:', pd);

// rs_snapshots by year to see where density starts
const byYear = db.prepare(`
  SELECT substr(date,1,4) as yr, COUNT(DISTINCT date) as days, COUNT(DISTINCT symbol) as syms, COUNT(*) as rows
  FROM rs_snapshots WHERE type='stock' GROUP BY yr ORDER BY yr
`).all();
console.log('\nrs_snapshots by year:'); console.table(byYear);

// Check if there are pre-2019 rows that got orphaned (no rs_rank)
const pre2019 = db.prepare(`
  SELECT COUNT(*) as n,
         SUM(CASE WHEN rs_rank IS NULL THEN 1 ELSE 0 END) as null_rank,
         SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) as null_price
  FROM rs_snapshots WHERE type='stock' AND date < '2019-01-01'
`).get();
console.log('\nPre-2019 rows:', pre2019);

// What's the earliest date with substantial coverage (>=50 symbols)?
const firstDense = db.prepare(`
  SELECT date, COUNT(*) as syms
  FROM rs_snapshots WHERE type='stock'
  GROUP BY date HAVING syms >= 50
  ORDER BY date LIMIT 5
`).all();
console.log('\nFirst 5 dates with ≥50 symbols:'); console.table(firstDense);

process.exit(0);
