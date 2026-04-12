// ─── Quantitative Sector Rotation Engine ────────────────────────────────────
// Ranks sectors by RS and generates tilt recommendations.
// Integrates with conviction scoring to boost stocks in leading sectors
// and penalize stocks in lagging sectors.

const { getDB } = require('../data/database');

function db() { return getDB(); }

// Sector ETF → sector name mapping
const SECTOR_ETF_MAP = {
  XLK:  'Technology',
  XLC:  'Comm Services',
  XLY:  'Consumer Disc',
  XLI:  'Industrials',
  XLE:  'Energy',
  XLF:  'Financials',
  XLV:  'Healthcare',
  XLB:  'Materials',
  XLP:  'Cons Staples',
  XLU:  'Utilities',
  XLRE: 'Real Estate',
};

const SECTOR_TO_ETF = {};
for (const [etf, sector] of Object.entries(SECTOR_ETF_MAP)) {
  SECTOR_TO_ETF[sector] = etf;
}

// ─── Compute sector rotation model from latest RS scan data ─────────────────
// Uses sector ETF RS ranks from the most recent scan, plus momentum (1m, 3m)
// to produce weighted tilt recommendations.
//
// Model: composite = RS_rank × 0.5 + momentum_1m_rank × 0.3 + momentum_3m_rank × 0.2
// Top 3 sectors → overweight, bottom 3 → underweight, rest → market weight.

function computeRotation(sectorScanResults) {
  if (!sectorScanResults || !sectorScanResults.length) return null;

  // Build ranked list
  const sectors = sectorScanResults
    .filter(s => SECTOR_ETF_MAP[s.symbol])
    .map(s => ({
      etf:    s.symbol,
      sector: SECTOR_ETF_MAP[s.symbol],
      rsRank: s.rsRank || 0,
      chg1m:  s.chg1m || 0,
      chg3m:  s.chg3m || 0,
      stage:  s.stage || null,
      vsMA50: s.vsMA50 || 0,
    }));

  if (sectors.length < 5) return null;

  // Rank by 1m and 3m returns
  const sortedBy1m = [...sectors].sort((a, b) => b.chg1m - a.chg1m);
  const sortedBy3m = [...sectors].sort((a, b) => b.chg3m - a.chg3m);
  for (let i = 0; i < sortedBy1m.length; i++) {
    sortedBy1m[i]._rank1m = ((sortedBy1m.length - i) / sortedBy1m.length) * 99;
  }
  for (let i = 0; i < sortedBy3m.length; i++) {
    sortedBy3m[i]._rank3m = ((sortedBy3m.length - i) / sortedBy3m.length) * 99;
  }

  // Build rank lookup
  const rank1m = {}, rank3m = {};
  for (const s of sortedBy1m) rank1m[s.etf] = s._rank1m;
  for (const s of sortedBy3m) rank3m[s.etf] = s._rank3m;

  // Composite score
  for (const s of sectors) {
    s.compositeScore = +(
      s.rsRank * 0.50 +
      (rank1m[s.etf] || 50) * 0.30 +
      (rank3m[s.etf] || 50) * 0.20
    ).toFixed(1);
  }

  sectors.sort((a, b) => b.compositeScore - a.compositeScore);

  // Assign rank position
  for (let i = 0; i < sectors.length; i++) {
    sectors[i].rank = i + 1;
  }

  // Assign tilt
  const n = sectors.length;
  const overweightCount  = Math.max(2, Math.floor(n / 3));
  const underweightCount = Math.max(2, Math.floor(n / 3));

  for (let i = 0; i < sectors.length; i++) {
    if (i < overweightCount) {
      sectors[i].tilt = 'overweight';
      sectors[i].sizeBoost = 1.15; // +15% conviction boost for stocks in this sector
    } else if (i >= n - underweightCount) {
      sectors[i].tilt = 'underweight';
      sectors[i].sizeBoost = 0.85; // -15% conviction penalty
    } else {
      sectors[i].tilt = 'market_weight';
      sectors[i].sizeBoost = 1.0;
    }
  }

  return {
    asOf: new Date().toISOString().split('T')[0],
    sectors: sectors.map(s => ({
      etf:            s.etf,
      sector:         s.sector,
      rank:           s.rank,
      rsRank:         s.rsRank,
      chg1m:          s.chg1m,
      chg3m:          s.chg3m,
      compositeScore: s.compositeScore,
      tilt:           s.tilt,
      sizeBoost:      s.sizeBoost,
      stage:          s.stage,
      vsMA50:         s.vsMA50,
    })),
  };
}

// ─── Look up sector tilt for a given stock's sector ─────────────────────────
// Returns the sizeBoost multiplier (default 1.0 if no rotation data)

function getSectorTilt(sector, rotationModel) {
  if (!rotationModel?.sectors) return 1.0;
  const match = rotationModel.sectors.find(s => s.sector === sector);
  return match?.sizeBoost || 1.0;
}

// ─── Historical sector rotation from rs_snapshots ───────────────────────────
// Returns the last N days of sector ETF rankings for trend analysis.

function getSectorRotationHistory(days = 30) {
  const etfs = Object.keys(SECTOR_ETF_MAP);
  const placeholders = etfs.map(() => '?').join(',');

  const rows = db().prepare(`
    SELECT date, symbol, rs_rank, price, vs_ma50, vs_ma200
    FROM rs_snapshots
    WHERE type = 'stock' AND symbol IN (${placeholders})
      AND date >= date('now', '-${Math.min(days, 365)} days')
    ORDER BY date, rs_rank DESC
  `).all(...etfs);

  // Group by date
  const byDate = {};
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push({
      etf:    r.symbol,
      sector: SECTOR_ETF_MAP[r.symbol],
      rsRank: r.rs_rank,
      vsMA50: r.vs_ma50,
    });
  }

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sectors]) => ({ date, sectors }));
}

module.exports = {
  SECTOR_ETF_MAP, SECTOR_TO_ETF,
  computeRotation, getSectorTilt, getSectorRotationHistory,
};
