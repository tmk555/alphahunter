// ─── Performance Attribution Engine ─────────────────────────────────────────
// Decomposes trade returns into: market (beta), sector, and stock-specific alpha.
// Uses SPY prices from rs_snapshots for point-in-time accuracy.

const { getDB } = require('../data/database');

function db() { return getDB(); }

// SPY price on or before a date (nearest available)
function getSPYPrice(date) {
  const row = db().prepare(`
    SELECT price FROM rs_snapshots
    WHERE symbol = 'SPY' AND type = 'stock' AND date <= ? AND price > 0
    ORDER BY date DESC LIMIT 1
  `).get(date);
  return row?.price || null;
}

// ─── Per-trade decomposition ────────────────────────────────────────────────
// For each closed trade:
//   marketComponent  = beta × SPY return over the holding period
//   stockAlpha       = total trade return − marketComponent
//   (sector attribution is aggregated from individual trade alphas grouped by sector)

function attributePerformance(options = {}) {
  const { startDate, endDate } = options;

  let query = 'SELECT * FROM trades WHERE exit_date IS NOT NULL AND pnl_dollars IS NOT NULL';
  const params = [];
  if (startDate) { query += ' AND exit_date >= ?'; params.push(startDate); }
  if (endDate)   { query += ' AND exit_date <= ?'; params.push(endDate); }
  query += ' ORDER BY entry_date';

  const trades = db().prepare(query).all(...params);
  if (!trades.length) return { totalTrades: 0, attribution: null };

  const attributed = [];
  let totalPnl = 0, totalMarket = 0, totalAlpha = 0;
  const bySector = {}, byRegime = {}, byStrategy = {};

  for (const t of trades) {
    const spyEntry = getSPYPrice(t.entry_date);
    const spyExit  = getSPYPrice(t.exit_date);

    const tradeReturn = t.pnl_percent || 0;
    const tradePnl    = t.pnl_dollars || 0;
    const posSize     = (t.shares || 0) * t.entry_price;
    const beta        = t.beta || 1.0;
    const sector      = t.sector || 'Unknown';
    const isShort     = t.side === 'short';

    // SPY return over the trade's holding period
    let spyReturn = 0;
    if (spyEntry && spyExit && spyEntry > 0) {
      spyReturn = ((spyExit / spyEntry) - 1) * 100;
    }

    // Market component: return from beta exposure alone
    const marketComponent = isShort ? -(beta * spyReturn) : (beta * spyReturn);
    const marketPnl = posSize * (marketComponent / 100);

    // Stock alpha: everything beyond what beta explains
    const stockAlpha    = tradeReturn - marketComponent;
    const stockAlphaPnl = tradePnl - marketPnl;

    totalPnl    += tradePnl;
    totalMarket += marketPnl;
    totalAlpha  += stockAlphaPnl;

    const holdDays = Math.round((new Date(t.exit_date) - new Date(t.entry_date)) / 86400000);

    // ─── aggregate into buckets ─────────────────────────────────────────
    for (const [map, key] of [
      [bySector,   sector],
      [byRegime,   t.entry_regime || 'Unknown'],
      [byStrategy, t.strategy || 'manual'],
    ]) {
      if (!map[key]) map[key] = { trades: 0, wins: 0, pnl: 0, mktPnl: 0, alphaPnl: 0, totalR: 0, betaSum: 0 };
      const b = map[key];
      b.trades++;
      if (tradePnl > 0) b.wins++;
      b.pnl      += tradePnl;
      b.mktPnl   += marketPnl;
      b.alphaPnl += stockAlphaPnl;
      b.totalR   += (t.r_multiple || 0);
      b.betaSum  += beta;
    }

    attributed.push({
      id: t.id, symbol: t.symbol, sector, side: t.side || 'long',
      entryDate: t.entry_date, exitDate: t.exit_date, holdDays,
      totalReturn:    +tradeReturn.toFixed(2),
      marketComponent: +marketComponent.toFixed(2),
      stockAlpha:     +stockAlpha.toFixed(2),
      totalPnl:       +tradePnl.toFixed(2),
      marketPnl:      +marketPnl.toFixed(2),
      stockAlphaPnl:  +stockAlphaPnl.toFixed(2),
      beta,
      spyReturn: +spyReturn.toFixed(2),
      entryRegime: t.entry_regime || 'Unknown',
      exitReason: t.exit_reason || null,
      rMultiple: t.r_multiple || 0,
      strategy: t.strategy || null,
    });
  }

  // ─── finalize bucket stats ────────────────────────────────────────────────
  function finalize(map) {
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = {
        trades:       v.trades,
        winRate:      +((v.wins / v.trades) * 100).toFixed(1),
        totalPnl:     +v.pnl.toFixed(2),
        marketPnl:    +v.mktPnl.toFixed(2),
        stockAlphaPnl: +v.alphaPnl.toFixed(2),
        avgR:         +(v.totalR / v.trades).toFixed(2),
        avgBeta:      +(v.betaSum / v.trades).toFixed(2),
      };
    }
    return out;
  }

  // ─── monthly P&L curve ────────────────────────────────────────────────────
  const monthly = {};
  for (const t of attributed) {
    const m = t.exitDate.slice(0, 7); // YYYY-MM
    if (!monthly[m]) monthly[m] = { pnl: 0, mkt: 0, alpha: 0, trades: 0, wins: 0 };
    monthly[m].pnl    += t.totalPnl;
    monthly[m].mkt    += t.marketPnl;
    monthly[m].alpha  += t.stockAlphaPnl;
    monthly[m].trades++;
    if (t.totalPnl > 0) monthly[m].wins++;
  }
  const monthlyBreakdown = Object.entries(monthly)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month,
      pnl:     +v.pnl.toFixed(2),
      market:  +v.mkt.toFixed(2),
      alpha:   +v.alpha.toFixed(2),
      trades:  v.trades,
      winRate: +((v.wins / v.trades) * 100).toFixed(1),
    }));

  return {
    totalTrades: trades.length,
    summary: {
      totalPnl:       +totalPnl.toFixed(2),
      marketComponent: +totalMarket.toFixed(2),
      stockAlpha:     +totalAlpha.toFixed(2),
      marketPct: totalPnl !== 0 ? +((totalMarket / Math.abs(totalPnl)) * 100).toFixed(1) : 0,
      alphaPct:  totalPnl !== 0 ? +((totalAlpha  / Math.abs(totalPnl)) * 100).toFixed(1) : 0,
    },
    bySector:   finalize(bySector),
    byRegime:   finalize(byRegime),
    byStrategy: finalize(byStrategy),
    monthlyBreakdown,
    trades: attributed,
  };
}

module.exports = { attributePerformance };
