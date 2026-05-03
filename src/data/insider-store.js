// ─── Insider transactions store ────────────────────────────────────────
//
// Persistence + rollup helpers for Form 4 data. Sits between the SEC
// EDGAR adapter (which fetches raw transactions) and the scanner / UI
// layers (which want pre-computed metrics).
//
// Two responsibilities:
//   1. saveInsiderTransactions(rows) — idempotent INSERT OR IGNORE
//      (composite PK absorbs duplicates from re-fetches)
//   2. getInsiderActivity(symbol, lookbackDays) — rolling rollup the
//      scanner / Levels card consumes (cluster-buy detection, net
//      30-day flow, top recent transactions)

const { getDB } = require('./database');

let _insertStmt = null;
function _getInsertStmt() {
  if (_insertStmt) return _insertStmt;
  _insertStmt = getDB().prepare(`
    INSERT OR IGNORE INTO insider_transactions
      (symbol, filed_at, trade_date, insider_name, insider_title,
       is_director, is_officer, is_ten_percent,
       transaction_code, shares, price_per_share, total_value, post_shares,
       accession_number, source_url)
    VALUES
      (@symbol, @filedAt, @tradeDate, @insiderName, @insiderTitle,
       @isDirector, @isOfficer, @isTenPercent,
       @transactionCode, @shares, @pricePerShare, @totalValue, @postShares,
       @accessionNumber, @sourceUrl)
  `);
  return _insertStmt;
}

// Persist an array of transaction rows (the shape returned by
// secEdgar.getInsiderTransactions). Returns count inserted.
function saveInsiderTransactions(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const stmt = _getInsertStmt();
  const insertMany = getDB().transaction((batch) => {
    let n = 0;
    for (const r of batch) {
      try { stmt.run(r); n++; } catch (_) { /* PK collision = already stored */ }
    }
    return n;
  });
  return insertMany(rows);
}

// Rollup metrics for a single symbol over a lookback window.
// Cluster-buy detection follows the empirical literature: 3+ distinct
// insiders each transacting >$500K in a 30-day window historically signals
// 6-12 month outperformance vs market (Cohen, Malloy, Pomorski 2012).
//
// Returns null if no data; otherwise:
//   {
//     buys30d, sells30d, netDollar, distinctBuyers, distinctSellers,
//     clusterBuy: boolean,
//     clusterSell: boolean,
//     topRecent: [...up to 5 most-recent rows...]
//   }
function getInsiderActivity(symbol, { lookbackDays = 30, clusterMinDollar = 500_000, clusterMinDistinct = 3 } = {}) {
  const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString().slice(0, 10);
  const db = getDB();

  const rows = db.prepare(`
    SELECT trade_date, filed_at, insider_name, insider_title,
           is_director, is_officer, is_ten_percent,
           transaction_code, shares, price_per_share, total_value, source_url
    FROM insider_transactions
    WHERE symbol = ? AND trade_date >= ?
    ORDER BY trade_date DESC, filed_at DESC
  `).all(symbol, since);

  if (!rows.length) return null;

  const buys  = rows.filter(r => r.transaction_code === 'P');
  const sells = rows.filter(r => r.transaction_code === 'S');

  // Cluster detection: count distinct insiders whose individual
  // 30-day buy total exceeds the threshold. Not "any 3 insiders" —
  // it must be 3 who EACH bought meaningfully, not 3 who each bought
  // 100 shares.
  const buyByInsider = new Map();
  for (const b of buys) {
    const k = b.insider_name || 'unknown';
    buyByInsider.set(k, (buyByInsider.get(k) || 0) + (b.total_value || 0));
  }
  const distinctBuyersOverThreshold = [...buyByInsider.values()]
    .filter(v => v >= clusterMinDollar).length;

  const sellByInsider = new Map();
  for (const s of sells) {
    const k = s.insider_name || 'unknown';
    // total_value is signed (sells negative); use absolute for threshold
    sellByInsider.set(k, (sellByInsider.get(k) || 0) + Math.abs(s.total_value || 0));
  }
  const distinctSellersOverThreshold = [...sellByInsider.values()]
    .filter(v => v >= clusterMinDollar).length;

  const sumBuy  = buys.reduce((a, r) => a + (r.total_value || 0), 0);
  const sumSell = sells.reduce((a, r) => a + (r.total_value || 0), 0);  // already negative
  const netDollar = sumBuy + sumSell;  // net (negative = net selling)

  return {
    buys30d:  buys.length,
    sells30d: sells.length,
    netDollar,
    distinctBuyers:  buyByInsider.size,
    distinctSellers: sellByInsider.size,
    clusterBuy:  distinctBuyersOverThreshold >= clusterMinDistinct,
    clusterSell: distinctSellersOverThreshold >= clusterMinDistinct,
    // Top recent transactions for tooltip / detail display. Mix of buys
    // and sells, newest first.
    topRecent: rows.slice(0, 5).map(r => ({
      tradeDate: r.trade_date,
      filedAt:   r.filed_at,
      insider:   r.insider_name,
      title:     r.insider_title,
      code:      r.transaction_code,
      shares:    r.shares,
      price:     r.price_per_share,
      value:     r.total_value,
      url:       r.source_url,
    })),
  };
}

// Last filing date we have for a symbol — used by the daily cron to
// decide what's new. Returns null if no rows.
function getLastInsiderFilingDate(symbol) {
  try {
    const r = getDB().prepare(
      `SELECT MAX(filed_at) AS last FROM insider_transactions WHERE symbol = ?`
    ).get(symbol);
    return r?.last || null;
  } catch (_) { return null; }
}

// Diagnostic: aggregate counts across the table for the diagnostics tab.
function getInsiderTableStats() {
  try {
    const total  = getDB().prepare(`SELECT COUNT(*) AS n FROM insider_transactions`).get();
    const byCode = getDB().prepare(`
      SELECT transaction_code, COUNT(*) AS n FROM insider_transactions
      GROUP BY transaction_code ORDER BY n DESC
    `).all();
    const lastFiled = getDB().prepare(`SELECT MAX(filed_at) AS last FROM insider_transactions`).get();
    const symbols = getDB().prepare(`SELECT COUNT(DISTINCT symbol) AS n FROM insider_transactions`).get();
    return {
      totalRows: total.n,
      distinctSymbols: symbols.n,
      lastFiledAt: lastFiled.last,
      byCode,
    };
  } catch (_) { return null; }
}

module.exports = {
  saveInsiderTransactions,
  getInsiderActivity,
  getLastInsiderFilingDate,
  getInsiderTableStats,
};
