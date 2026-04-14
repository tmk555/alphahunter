// ─── Earnings Estimate Revision Tracking Engine ──────────────────────────────
// Tracks analyst earnings estimate revisions — the single most predictive
// fundamental signal for momentum stocks. Rising estimates = bullish.
// Falling estimates = bearish. Acceleration in revisions = strongest signal.

const { cacheGet, cacheSet } = require('../data/cache');

const TTL_REVISIONS = 4 * 60 * 60 * 1000; // 4 hours — estimates don't change intraday

// ─── 1. Fetch Estimate Revisions ────────────────────────────────────────────
// Pulls consensus estimates from Yahoo Finance (primary) with FMP fallback.
// Returns normalized estimate snapshot for comparison over time.

async function fetchEstimateRevisions(symbol) {
  const cacheKey = `rev:${symbol}`;
  const cached = cacheGet(cacheKey, TTL_REVISIONS);
  if (cached) return cached;

  let result = null;

  // Try Yahoo Finance first — earningsTrend module has estimate details
  try {
    const { getYahooCrumb } = require('../data/providers/yahoo');
    const fetch = require('node-fetch');
    const { crumb, cookie } = await getYahooCrumb();

    const modules = 'earningsTrend,financialData';
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    });

    if (r.status === 401 || r.status === 403) {
      const { resetAuth } = require('../data/providers/yahoo');
      resetAuth();
      throw new Error(`Yahoo auth expired (${r.status})`);
    }

    const data = await r.json();
    const summary = data?.quoteSummary?.result?.[0];
    if (summary) {
      result = parseYahooEstimates(symbol, summary);
    }
  } catch (e) {
    console.warn(`  Revisions: Yahoo failed for ${symbol}: ${e.message}`);
  }

  // Try FMP fallback if Yahoo didn't return data
  if (!result) {
    try {
      const fs = require('fs');
      const path = require('path');
      const fmpPath = path.join(__dirname, '..', 'data', 'providers', 'fmp.js');
      if (fs.existsSync(fmpPath)) {
        const fmp = require('../data/providers/fmp');
        if (fmp.isConfigured && fmp.isConfigured()) {
          result = await fetchFMPEstimates(symbol);
        }
      }
    } catch (e) {
      console.warn(`  Revisions: FMP failed for ${symbol}: ${e.message}`);
    }
  }

  if (result) {
    cacheSet(cacheKey, result);
  }
  return result;
}

// Parse Yahoo earningsTrend + financialData into normalized estimates
function parseYahooEstimates(symbol, summary) {
  const trend = summary.earningsTrend?.trend || [];
  const fd = summary.financialData || {};

  // earningsTrend.trend is an array of periods:
  // [0] = current quarter, [1] = next quarter, [2] = current year, [3] = next year
  const currentQtr = trend.find(t => t.period === '0q');
  const nextQtr = trend.find(t => t.period === '+1q');
  const currentYear = trend.find(t => t.period === '0y');
  const nextYear = trend.find(t => t.period === '+1y');

  const epsCurrentQtr = rawVal(currentQtr?.earningsEstimate?.avg);
  const epsNextQtr = rawVal(nextQtr?.earningsEstimate?.avg);
  const epsCurrentYear = rawVal(currentYear?.earningsEstimate?.avg);
  const epsNextYear = rawVal(nextYear?.earningsEstimate?.avg);
  const revCurrentQtr = rawVal(currentQtr?.revenueEstimate?.avg);
  const revCurrentYear = rawVal(currentYear?.revenueEstimate?.avg);

  // If no estimate data at all, this stock has no analyst coverage
  if (epsCurrentQtr == null && epsCurrentYear == null && epsNextYear == null) {
    return null;
  }

  return {
    symbol,
    epsCurrentQtr,
    epsNextQtr,
    epsCurrentYear,
    epsNextYear,
    revCurrentQtr,
    revCurrentYear,
    // Growth rates from earningsTrend
    epsGrowthCurrentQtr: rawVal(currentQtr?.earningsEstimate?.growth),
    epsGrowthCurrentYear: rawVal(currentYear?.earningsEstimate?.growth),
    epsGrowthNextYear: rawVal(nextYear?.earningsEstimate?.growth),
    revGrowthCurrentQtr: rawVal(currentQtr?.revenueEstimate?.growth),
    revGrowthCurrentYear: rawVal(currentYear?.revenueEstimate?.growth),
    // Number of analysts
    numAnalysts: rawVal(currentQtr?.earningsEstimate?.numberOfAnalysts)
      || rawVal(currentYear?.earningsEstimate?.numberOfAnalysts),
    fetchedAt: new Date().toISOString(),
  };
}

// FMP fallback — analyst estimates endpoint
async function fetchFMPEstimates(symbol) {
  const fetch = require('node-fetch');
  const API_KEY = process.env.FMP_API_KEY;
  if (!API_KEY) return null;

  const url = `https://financialmodelingprep.com/api/v3/analyst-estimates/${encodeURIComponent(symbol)}?limit=2&apikey=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) return null;

  const data = await r.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const current = data[0];
  const next = data.length > 1 ? data[1] : null;

  return {
    symbol,
    epsCurrentQtr: null, // FMP doesn't split quarterly in this endpoint
    epsNextQtr: null,
    epsCurrentYear: current.estimatedEpsAvg || null,
    epsNextYear: next?.estimatedEpsAvg || null,
    revCurrentQtr: null,
    revCurrentYear: current.estimatedRevenueAvg || null,
    epsGrowthCurrentQtr: null,
    epsGrowthCurrentYear: null,
    epsGrowthNextYear: null,
    revGrowthCurrentQtr: null,
    revGrowthCurrentYear: null,
    numAnalysts: current.numberAnalystEstimatedEps || null,
    fetchedAt: new Date().toISOString(),
  };
}

// Extract raw numeric value from Yahoo's nested format
function rawVal(field) {
  if (field == null) return null;
  if (typeof field === 'object' && 'raw' in field) return field.raw;
  if (typeof field === 'number') return field;
  return null;
}

// ─── 2. Score Revisions ─────────────────────────────────────────────────────
// Compares current estimates vs prior snapshot. Scores 0-100 based on
// magnitude and breadth of revisions across EPS and revenue.

function scoreRevisions(current, prior) {
  if (!current || !prior) return null;

  // Compute % change for each estimate field
  const epsCurrentYrChg = pctChange(current.epsCurrentYear, prior.epsCurrentYear);
  const epsNextYrChg = pctChange(current.epsNextYear, prior.epsNextYear);
  const revChg = pctChange(current.revCurrentYear, prior.revCurrentYear);
  const epsCurrentQtrChg = pctChange(current.epsCurrentQtr, prior.epsCurrentQtr);

  // EPS acceleration: is current year growth rate accelerating vs prior?
  // Compare the growth rate itself — if analysts are raising growth expectations
  let acceleration = 0;
  if (current.epsGrowthCurrentYear != null && prior.epsGrowthCurrentYear != null) {
    acceleration = (current.epsGrowthCurrentYear - prior.epsGrowthCurrentYear) * 100;
  } else if (epsCurrentYrChg != null && epsNextYrChg != null) {
    // Fallback: use differential between current and next year revision
    acceleration = epsCurrentYrChg - (epsNextYrChg || 0);
  }

  // Breadth: how many fields were revised upward?
  const fields = [epsCurrentYrChg, epsNextYrChg, revChg, epsCurrentQtrChg];
  const revisedUp = fields.filter(v => v != null && v > 0.5).length;
  const revisedDown = fields.filter(v => v != null && v < -0.5).length;
  const breadth = fields.filter(v => v != null).length > 0
    ? (revisedUp / fields.filter(v => v != null).length) * 100
    : 50;

  // Weighted score (0-100)
  let rawScore = 50; // neutral baseline

  // EPS current year revision: weight 30%
  if (epsCurrentYrChg != null) {
    rawScore += clamp(epsCurrentYrChg * 3, -15, 15); // 30% weight
  }

  // EPS next year revision: weight 25%
  if (epsNextYrChg != null) {
    rawScore += clamp(epsNextYrChg * 2.5, -12.5, 12.5); // 25% weight
  }

  // Revenue current year revision: weight 20%
  if (revChg != null) {
    rawScore += clamp(revChg * 2, -10, 10); // 20% weight
  }

  // EPS acceleration: weight 15%
  rawScore += clamp(acceleration * 0.15, -7.5, 7.5);

  // Breadth of revisions: weight 10%
  rawScore += ((breadth - 50) / 50) * 5; // -5 to +5

  const revisionScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Direction tier
  let direction, tier;
  if (revisionScore >= 70) {
    direction = 'up';
    tier = 'strong_upgrade';
  } else if (revisionScore >= 50) {
    direction = 'up';
    tier = 'upgrade';
  } else if (revisionScore >= 30) {
    direction = 'flat';
    tier = 'neutral';
  } else {
    direction = 'down';
    tier = 'downgrade';
  }

  return {
    revisionScore,
    direction,
    epsCurrentYrChg: round2(epsCurrentYrChg),
    epsNextYrChg: round2(epsNextYrChg),
    revChg: round2(revChg),
    acceleration: round2(acceleration),
    breadth: Math.round(breadth),
    tier,
  };
}

// ─── 3. Conviction Integration ──────────────────────────────────────────────
// Returns a conviction adjustment based on revision tier + stock RS strength.
// Designed to plug into the existing calcConviction pipeline.

function calcRevisionSignal(stock, revisionData) {
  if (!revisionData || revisionData.revisionScore == null) {
    return { adjustment: 0, reasons: [] };
  }

  const rs = stock.rsRank || 0;
  const tier = revisionData.tier;
  const score = revisionData.revisionScore;
  let adjustment = 0;
  const reasons = [];

  switch (tier) {
    case 'strong_upgrade':
      if (rs >= 80) {
        adjustment = 12;
        reasons.push(`Strong estimate upgrades (${score}) + RS ${rs} — institutional momentum`);
      } else if (rs >= 60) {
        adjustment = 8;
        reasons.push(`Strong estimate upgrades (${score}) — RS ${rs} needs confirmation`);
      } else {
        adjustment = 5;
        reasons.push(`Strong estimate upgrades (${score}) — RS lagging (${rs})`);
      }
      break;

    case 'upgrade':
      if (rs >= 70) {
        adjustment = 8;
        reasons.push(`Estimate upgrades (${score}) + RS ${rs} — analysts confirming trend`);
      } else {
        adjustment = 4;
        reasons.push(`Estimate upgrades (${score}) — watch for RS follow-through`);
      }
      break;

    case 'neutral':
      adjustment = 0;
      // No reason added for neutral — not actionable
      break;

    case 'downgrade':
      if (rs <= 40) {
        adjustment = -15;
        reasons.push(`Estimate cuts (${score}) + weak RS ${rs} — avoid`);
      } else if (rs <= 60) {
        adjustment = -8;
        reasons.push(`Estimate cuts (${score}) — fundamental deterioration`);
      } else {
        // High RS but falling estimates — divergence, mild warning
        adjustment = -4;
        reasons.push(`Estimate cuts (${score}) despite strong RS ${rs} — watch for reversal`);
      }
      break;
  }

  // Acceleration bonus/penalty
  if (revisionData.acceleration != null) {
    if (revisionData.acceleration > 5) {
      adjustment += 2;
      reasons.push(`Accelerating revisions (+${revisionData.acceleration}%)`);
    } else if (revisionData.acceleration < -5) {
      adjustment -= 2;
      reasons.push(`Decelerating revisions (${revisionData.acceleration}%)`);
    }
  }

  // Clamp to spec range
  adjustment = clamp(adjustment, -15, 12);

  return { adjustment, reasons };
}

// ─── 4. Persist to SQLite ───────────────────────────────────────────────────
// Upserts estimate snapshots keyed by (symbol, quarter).

function storeRevisions(db, symbol, data) {
  if (!db || !data) return;

  const quarter = currentQuarter();
  const now = new Date().toISOString();

  try {
    // The earnings_estimates table has UNIQUE(symbol, quarter, fetched_at).
    // We want at most one row per (symbol, quarter) per day — delete any
    // existing row for today's date before inserting the fresh snapshot.
    const today = now.split('T')[0];
    db.prepare(`
      DELETE FROM earnings_estimates
      WHERE symbol = ? AND quarter = ? AND fetched_at LIKE ?
    `).run(symbol, quarter, `${today}%`);

    db.prepare(`
      INSERT INTO earnings_estimates (
        symbol, quarter, eps_current_qtr, eps_next_qtr,
        eps_current_year, eps_next_year,
        rev_current_qtr, rev_current_year,
        eps_growth_current_year, eps_growth_next_year,
        num_analysts, fetched_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      symbol, quarter,
      data.epsCurrentQtr, data.epsNextQtr,
      data.epsCurrentYear, data.epsNextYear,
      data.revCurrentQtr, data.revCurrentYear,
      data.epsGrowthCurrentYear, data.epsGrowthNextYear,
      data.numAnalysts, data.fetchedAt, now
    );
  } catch (e) {
    console.warn(`  Revisions: store failed for ${symbol}: ${e.message}`);
  }
}

// Load the most recent prior snapshot for comparison
function loadPriorRevisions(db, symbol) {
  if (!db) return null;
  const quarter = currentQuarter();
  const today = new Date().toISOString().split('T')[0];
  try {
    // Get the most recent prior snapshot — either from a previous quarter
    // or an older fetch from the same quarter (but not today's fetch)
    const row = db.prepare(`
      SELECT * FROM earnings_estimates
      WHERE symbol = ? AND (quarter < ? OR (quarter = ? AND fetched_at < ?))
      ORDER BY fetched_at DESC LIMIT 1
    `).get(symbol, quarter, quarter, `${today}%`);

    if (!row) return null;
    return {
      symbol: row.symbol,
      epsCurrentQtr: row.eps_current_qtr,
      epsNextQtr: row.eps_next_qtr,
      epsCurrentYear: row.eps_current_year,
      epsNextYear: row.eps_next_year,
      revCurrentQtr: row.rev_current_qtr,
      revCurrentYear: row.rev_current_year,
      epsGrowthCurrentYear: row.eps_growth_current_year,
      epsGrowthNextYear: row.eps_growth_next_year,
      numAnalysts: row.num_analysts,
      fetchedAt: row.fetched_at,
    };
  } catch (e) {
    console.warn(`  Revisions: load prior failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ─── 5. Batch Fetch ─────────────────────────────────────────────────────────
// Fetches revisions for multiple symbols with rate limiting.

async function batchFetchRevisions(symbols, batchSize = 5) {
  const { pLimit } = require('../data/providers/manager');
  const results = new Map();

  const tasks = symbols.map(symbol => async () => {
    try {
      const data = await fetchEstimateRevisions(symbol);
      if (data) results.set(symbol, data);
    } catch (e) {
      console.warn(`  Revisions: batch fetch failed for ${symbol}: ${e.message}`);
    }
  });

  await pLimit(tasks, batchSize);
  return results;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pctChange(current, prior) {
  if (current == null || prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function round2(val) {
  if (val == null) return null;
  return +val.toFixed(2);
}

function currentQuarter() {
  const now = new Date();
  const q = Math.ceil((now.getMonth() + 1) / 3);
  return `${now.getFullYear()}Q${q}`;
}

module.exports = {
  fetchEstimateRevisions,
  scoreRevisions,
  calcRevisionSignal,
  storeRevisions,
  loadPriorRevisions,
  batchFetchRevisions,
};
