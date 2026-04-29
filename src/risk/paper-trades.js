// ─── Paper Trades — discretionary watchlist + paper P&L tracking ──────────
//
// Why this exists: the auto-sweep proved a pure systematic screener can't
// reliably beat SPY after tax over a decade. The traders who actually do
// outperform (Minervini-style) layer JUDGMENT on top of systematic
// candidates — they take ~1 in 5 algorithmic VCP/stage-2 candidates,
// concentrate, pyramid into winners. That judgment piece can't be
// backtested without a forward-tracked sample. This module enables it:
// stage paper positions from the scanner, let the daily cron auto-close
// on stop/target, accumulate win-rate + expectancy + per-theme stats over
// 60-90 days. Then the user knows whether the hybrid approach actually
// has an edge BEFORE committing capital.
//
// Distinct from `trades` (broker-mirrored): this table never touches
// Alpaca, never enters portfolio_state, never affects heat/exposure.

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Stage a new paper position ────────────────────────────────────────────
function stagePaperTrade({
  symbol, themeTag = null, entryPrice, stopPrice,
  target1Price = null, target2Price = null,
  shares = 1, source = null, notes = null, entryDate = null,
}) {
  if (!symbol) throw new Error('symbol required');
  if (!(entryPrice > 0)) throw new Error('entryPrice must be > 0');
  if (!(stopPrice > 0)) throw new Error('stopPrice must be > 0');
  if (stopPrice >= entryPrice) {
    throw new Error('stopPrice must be below entryPrice for a long paper trade');
  }
  if (!(shares > 0)) throw new Error('shares must be > 0');
  const date = entryDate || new Date().toISOString().slice(0, 10);
  const result = db().prepare(`
    INSERT INTO paper_trades
      (symbol, theme_tag, entry_date, entry_price, stop_price,
       target1_price, target2_price, shares, source, notes,
       max_favorable, max_adverse)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol.toUpperCase(), themeTag, date, entryPrice, stopPrice,
    target1Price, target2Price, shares, source, notes,
    entryPrice, entryPrice  // initial high-water and low-water = entry
  );
  return getPaperTrade(result.lastInsertRowid);
}

function getPaperTrade(id) {
  return db().prepare('SELECT * FROM paper_trades WHERE id = ?').get(id);
}

function listPaperTrades({ status = null, themeTag = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status)    { where.push('status = ?');    args.push(status); }
  if (themeTag)  { where.push('theme_tag = ?'); args.push(themeTag); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(Math.min(limit, 1000));
  return db().prepare(
    `SELECT * FROM paper_trades ${whereSql} ORDER BY entry_date DESC, id DESC LIMIT ?`
  ).all(...args);
}

// ─── Manual close (user clicks "CLOSE" in UI) ──────────────────────────────
function closePaperTrade(id, exitPrice, exitReason = 'manual', exitDate = null) {
  const row = getPaperTrade(id);
  if (!row) throw new Error(`Paper trade ${id} not found`);
  if (row.status !== 'open') throw new Error(`Trade ${id} already ${row.status}`);
  if (!(exitPrice > 0)) throw new Error('exitPrice must be > 0');
  const date = exitDate || new Date().toISOString().slice(0, 10);
  const pnlPct = +((exitPrice / row.entry_price - 1) * 100).toFixed(2);
  const risk   = row.entry_price - row.stop_price;
  const rMult  = risk > 0 ? +((exitPrice - row.entry_price) / risk).toFixed(2) : null;
  db().prepare(`
    UPDATE paper_trades
       SET status = 'closed', exit_date = ?, exit_price = ?, exit_reason = ?,
           pnl_pct = ?, r_multiple = ?
     WHERE id = ?
  `).run(date, exitPrice, exitReason, pnlPct, rMult, id);
  return getPaperTrade(id);
}

// ─── Cancel before any move (user changed mind) ────────────────────────────
function cancelPaperTrade(id, reason = 'cancelled') {
  const row = getPaperTrade(id);
  if (!row) throw new Error(`Paper trade ${id} not found`);
  if (row.status !== 'open') return row;
  db().prepare(`
    UPDATE paper_trades SET status = 'cancelled', exit_reason = ? WHERE id = ?
  `).run(reason, id);
  return getPaperTrade(id);
}

// ─── Auto-close on price move (cron handler) ──────────────────────────────
//
// For each open paper trade, fetch current price and check:
//   • price ≤ stop_price       → close at stop_price, reason='stop'
//   • price ≥ target2_price    → close at target2_price, reason='target2'
//   • price ≥ target1_price    → leave OPEN (hybrid scale-out is manual)
//                                but tag max_favorable so we know T1 hit
//   • track max_favorable / max_adverse for "left on table" + "drawdown
//     during hold" diagnostics that distinguish discipline from luck
//
// The check uses live quotes from the provider manager; failures are
// logged and the trade is left open (no false-close on a bad fetch).
async function autoCloseOnQuotes() {
  const open = listPaperTrades({ status: 'open' });
  if (!open.length) return { checked: 0, closed: 0, updated: 0 };
  const symbols = [...new Set(open.map(t => t.symbol))];
  const { getQuotes } = require('../data/providers/manager');
  let quotes = [];
  try { quotes = await getQuotes(symbols); }
  catch (e) { return { checked: 0, closed: 0, updated: 0, error: `getQuotes failed: ${e.message}` }; }
  const priceBySymbol = {};
  for (const q of (quotes || [])) {
    if (q?.symbol && q?.regularMarketPrice != null) priceBySymbol[q.symbol] = q.regularMarketPrice;
  }
  let closed = 0, updated = 0;
  const closures = [];
  for (const t of open) {
    const px = priceBySymbol[t.symbol];
    if (px == null) continue;
    // Update high-water / low-water marks first (tracks "left on table"
    // and "max drawdown during hold" — both feed the discipline stats).
    const newHigh = Math.max(t.max_favorable || px, px);
    const newLow  = Math.min(t.max_adverse  || px, px);
    if (newHigh !== t.max_favorable || newLow !== t.max_adverse) {
      db().prepare(
        'UPDATE paper_trades SET max_favorable = ?, max_adverse = ? WHERE id = ?'
      ).run(newHigh, newLow, t.id);
      updated++;
    }
    // Stop hit (use the LOW-water mark — captures intraday wicks the
    // current price doesn't see; in real trading a wick at the stop would
    // have triggered the broker's GTC stop order even if price recovered).
    if (newLow <= t.stop_price) {
      closePaperTrade(t.id, t.stop_price, 'stop');
      closures.push({ id: t.id, symbol: t.symbol, reason: 'stop', exitPrice: t.stop_price });
      closed++;
      continue;
    }
    // Target2 hit (full close — T1 stays open as a manual scale-out
    // decision the user makes, since hybrid Minervini-style is about
    // judging whether to ride the runner or scale out)
    if (t.target2_price && newHigh >= t.target2_price) {
      closePaperTrade(t.id, t.target2_price, 'target2');
      closures.push({ id: t.id, symbol: t.symbol, reason: 'target2', exitPrice: t.target2_price });
      closed++;
    }
  }
  return { checked: open.length, closed, updated, closures };
}

// ─── Stats ─────────────────────────────────────────────────────────────────
//
// Win rate + average R + expectancy. These three numbers are what
// distinguishes a real edge from noise. After 30+ trades:
//   • Win rate ≥ 50% AND avg R ≥ 1.5 → strong edge
//   • Win rate ~40% AND avg R ≥ 2.0  → trend-follower edge
//   • Expectancy > +0.5R           → worth deploying real capital
//   • Expectancy ~0 or negative     → no edge, capital better elsewhere
//
// Per-theme breakdown helps the user see if "AI plays" works while
// "Defense plays" doesn't — drives where to concentrate next.
function getPaperStats({ since = null, themeTag = null } = {}) {
  const where = ["status = 'closed'"];
  const args = [];
  if (since)    { where.push('exit_date >= ?');  args.push(since); }
  if (themeTag) { where.push('theme_tag = ?');   args.push(themeTag); }
  const closed = db().prepare(
    `SELECT * FROM paper_trades WHERE ${where.join(' AND ')} ORDER BY exit_date`
  ).all(...args);
  if (!closed.length) {
    return { count: 0, wins: 0, losses: 0, winRate: null, avgR: null, expectancy: null,
             totalPnlPct: 0, themes: {} };
  }
  const wins = closed.filter(t => t.r_multiple > 0);
  const losses = closed.filter(t => t.r_multiple <= 0);
  const avgWinR  = wins.length ? wins.reduce((s, t) => s + t.r_multiple, 0) / wins.length : 0;
  const avgLossR = losses.length ? losses.reduce((s, t) => s + t.r_multiple, 0) / losses.length : 0;
  const winRate  = +(wins.length / closed.length).toFixed(3);
  // Expectancy (Van Tharp): winRate × avgWinR + (1 - winRate) × avgLossR
  const expectancy = +(winRate * avgWinR + (1 - winRate) * avgLossR).toFixed(2);
  const totalPnlPct = +closed.reduce((s, t) => s + (t.pnl_pct || 0), 0).toFixed(2);
  // Per-theme breakdown.
  const themes = {};
  for (const t of closed) {
    const tag = t.theme_tag || '(untagged)';
    if (!themes[tag]) themes[tag] = { count: 0, wins: 0, totalR: 0 };
    themes[tag].count++;
    if (t.r_multiple > 0) themes[tag].wins++;
    themes[tag].totalR += t.r_multiple || 0;
  }
  for (const tag of Object.keys(themes)) {
    const th = themes[tag];
    th.winRate = +(th.wins / th.count).toFixed(3);
    th.avgR    = +(th.totalR / th.count).toFixed(2);
  }
  return {
    count: closed.length,
    wins: wins.length, losses: losses.length,
    winRate, avgWinR: +avgWinR.toFixed(2), avgLossR: +avgLossR.toFixed(2),
    expectancy, totalPnlPct, themes,
  };
}

module.exports = {
  stagePaperTrade, getPaperTrade, listPaperTrades,
  closePaperTrade, cancelPaperTrade,
  autoCloseOnQuotes, getPaperStats,
};
