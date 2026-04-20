require('dotenv').config();
const { getDB } = require('./src/data/database');
const db = getDB();

// 1) pattern_detections coverage for 2024
const pc = db.prepare(`
  SELECT pattern_type, COUNT(*) as n,
         COUNT(DISTINCT symbol) as syms,
         COUNT(DISTINCT date) as days,
         MIN(date) as first, MAX(date) as last
  FROM pattern_detections
  WHERE date >= '2024-01-01' AND date <= '2024-12-31'
  GROUP BY pattern_type
`).all();
console.log('2024 pattern_detections by type:'); console.table(pc);

// 2) How many stocks on, say, 2024-06-03 have rs_rank >= 80 AND a pattern?
const sample = db.prepare(`
  SELECT COUNT(DISTINCT r.symbol) AS rs_strong_and_pattern
  FROM rs_snapshots r
  JOIN pattern_detections p ON p.symbol = r.symbol AND p.date = r.date
  WHERE r.type='stock' AND r.date='2024-06-03' AND r.rs_rank >= 80
`).get();
console.log('2024-06-03 RS≥80 stocks that also had ANY pattern detected:', sample);

// 3) Sanity: distinct dates in rs_snapshots vs pattern_detections
const rsDates = db.prepare(`SELECT COUNT(DISTINCT date) n FROM rs_snapshots WHERE date LIKE '2024-%'`).get().n;
const pdDates = db.prepare(`SELECT COUNT(DISTINCT date) n FROM pattern_detections WHERE date LIKE '2024-%'`).get().n;
console.log(`Dates in 2024 — rs_snapshots: ${rsDates}, pattern_detections: ${pdDates}`);

// 4) How many rs_snapshots rows have rs_rank in 2024?
const rsCov = db.prepare(`
  SELECT COUNT(*) as total,
         SUM(CASE WHEN rs_rank IS NOT NULL THEN 1 ELSE 0 END) as with_rank,
         SUM(CASE WHEN rs_rank >= 80 THEN 1 ELSE 0 END) as rs80plus
  FROM rs_snapshots WHERE type='stock' AND date LIKE '2024-%'
`).get();
console.log('2024 rs_snapshots coverage:', rsCov);

process.exit(0);
