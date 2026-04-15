// ─── Morning Brief & Weekly Digest — Content Assembly ────────────────────────
// Pure content-assembly functions. Each returns { subject, html, text } so the
// scheduler job can deliver via Telegram (HTML) or Pushover/Slack (text).
//
// Morning Brief:  Regime, dist days, FTD, open positions, staged orders, top picks
// Weekly Digest:  Week P&L, trades, win rate, regime changes, RS movers

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${(+n).toFixed(1)}%`;
}

function fmtDollars(n) {
  if (n == null || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPrice(n) {
  if (n == null || isNaN(n)) return '—';
  return `$${(+n).toFixed(2)}`;
}

function marketDateET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function dayNameET() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
}

function fullDateET() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/New_York',
  });
}

// ─── Morning Brief ───────────────────────────────────────────────────────────

async function assembleMorningBrief() {
  const lines = [];
  const htmlLines = [];

  const dateStr = fullDateET();
  lines.push(`☀️ ALPHA HUNTER — MORNING BRIEF`);
  lines.push(dateStr);
  lines.push('');
  htmlLines.push(`☀️ <b>ALPHA HUNTER — MORNING BRIEF</b>`);
  htmlLines.push(`<i>${dateStr}</i>`);
  htmlLines.push('');

  // ── 1. Market Regime ────────────────────────────────────────────────────
  let regime = null;
  let cycle = null;
  try {
    const { getMarketRegime, autoDetectCycleState } = require('../risk/regime');
    regime = await getMarketRegime();
    cycle = await autoDetectCycleState();
  } catch (e) {
    regime = { regime: 'UNAVAILABLE', warning: e.message };
  }

  lines.push('📊 MARKET REGIME');
  htmlLines.push('📊 <b>MARKET REGIME</b>');

  if (cycle) {
    const modeEmoji = cycle.mode === 'CONFIRMED_UPTREND' || cycle.mode === 'FTD_CONFIRMED' ? '🟢'
      : cycle.mode === 'CORRECTION' ? '🔴'
      : cycle.mode === 'FTD_FAILED' ? '🟠'
      : cycle.mode === 'RALLY_ATTEMPT' ? '🟡'
      : '⚪';

    lines.push(`  Mode: ${cycle.mode} (${cycle.confidence}% confidence) ${modeEmoji}`);
    htmlLines.push(`  Mode: <b>${cycle.mode}</b> (${cycle.confidence}%) ${modeEmoji}`);
  }

  if (regime) {
    const spyLine = regime.spyPrice
      ? `  SPY: ${fmtPrice(regime.spyPrice)} | VIX: ${regime.vixLevel?.toFixed(1) || '—'}`
      : `  Regime: ${regime.regime}`;
    lines.push(spyLine);
    htmlLines.push(spyLine);

    if (regime.warning) {
      lines.push(`  ⚠️ ${regime.warning}`);
      htmlLines.push(`  ⚠️ <i>${regime.warning}</i>`);
    }
  }

  // SPY/QQQ MA status from cycle data
  if (cycle?.spy) {
    const spyStatus = [
      cycle.spy.above50 ? '50MA ✓' : '50MA ✗',
      cycle.spy.above200 ? '200MA ✓' : '200MA ✗',
    ].join(' | ');
    const qqqStatus = cycle.qqq ? [
      cycle.qqq.above50 ? '50MA ✓' : '50MA ✗',
      cycle.qqq.above200 ? '200MA ✓' : '200MA ✗',
    ].join(' | ') : '';

    lines.push(`  SPY: ${fmtPrice(cycle.spy.price)} (${spyStatus})`);
    htmlLines.push(`  SPY: <b>${fmtPrice(cycle.spy.price)}</b> (${spyStatus})`);
    if (cycle.qqq?.price) {
      lines.push(`  QQQ: ${fmtPrice(cycle.qqq.price)} (${qqqStatus})`);
      htmlLines.push(`  QQQ: <b>${fmtPrice(cycle.qqq.price)}</b> (${qqqStatus})`);
    }
    lines.push(`  VIX: ${cycle.vixLevel?.toFixed(1) || '—'}`);
    htmlLines.push(`  VIX: ${cycle.vixLevel?.toFixed(1) || '—'}`);
  }

  lines.push('');
  htmlLines.push('');

  // ── 2. Distribution Days / FTD ──────────────────────────────────────────
  if (cycle?.distributionDays || cycle?.ftd) {
    lines.push('📈 DISTRIBUTION / FTD');
    htmlLines.push('📈 <b>DISTRIBUTION / FTD</b>');

    const dd = cycle.distributionDays;
    if (dd) {
      lines.push(`  Dist days (25-session): ${dd.count} (SPY: ${dd.spy?.count || 0}, QQQ: ${dd.qqq?.count || 0})`);
      htmlLines.push(`  Dist days (25-session): <b>${dd.count}</b> (SPY: ${dd.spy?.count || 0}, QQQ: ${dd.qqq?.count || 0})`);
    }

    const ftd = cycle.ftd;
    if (ftd?.fired) {
      const status = ftd.confirmed ? '✅ Confirmed' : ftd.failed ? '❌ Failed' : '⏳ Pending';
      lines.push(`  FTD: ${status} on ${ftd.index} (${ftd.date})`);
      htmlLines.push(`  FTD: ${status} on <b>${ftd.index}</b> (${ftd.date})`);
    } else {
      lines.push('  FTD: Not fired');
      htmlLines.push('  FTD: Not fired');
    }

    lines.push('');
    htmlLines.push('');
  }

  // ── 3. Open Positions ───────────────────────────────────────────────────
  let openPositions = [];
  try {
    openPositions = db().prepare(
      'SELECT symbol, side, entry_price, shares, remaining_shares, stop_price, sector FROM trades WHERE exit_date IS NULL ORDER BY entry_date DESC'
    ).all();
  } catch (_) {}

  // Get current prices for P&L calculation
  let currentPrices = {};
  if (openPositions.length) {
    try {
      const { getQuotes } = require('../data/providers/manager');
      const symbols = openPositions.map(p => p.symbol);
      const quotes = await getQuotes(symbols);
      for (const q of quotes) {
        const s = q.symbol || q.ticker;
        const p = q.price || q.regularMarketPrice;
        if (s && p) currentPrices[s] = p;
      }
    } catch (_) {}
  }

  const { getPortfolioHeat, getConfig } = require('../risk/portfolio');
  const heat = getPortfolioHeat(openPositions);
  const portfolioConfig = getConfig();

  lines.push('🔥 PORTFOLIO HEAT');
  htmlLines.push('🔥 <b>PORTFOLIO HEAT</b>');
  lines.push(`  ${openPositions.length} open position${openPositions.length !== 1 ? 's' : ''} | Heat: ${heat.heatPct}% / ${heat.maxHeat}% max`);
  htmlLines.push(`  ${openPositions.length} position${openPositions.length !== 1 ? 's' : ''} | Heat: <b>${heat.heatPct}%</b> / ${heat.maxHeat}% max`);

  // Show each position with P&L
  for (const pos of openPositions.slice(0, 8)) {
    const shares = pos.remaining_shares || pos.shares || 0;
    const entry = pos.entry_price || 0;
    const current = currentPrices[pos.symbol] || entry;
    const pnl = (current - entry) * shares * (pos.side === 'short' ? -1 : 1);
    const pnlPct = entry > 0 ? ((current - entry) / entry) * 100 * (pos.side === 'short' ? -1 : 1) : 0;
    const emoji = pnl >= 0 ? '🟢' : '🔴';

    lines.push(`  ${emoji} ${pos.symbol}: ${fmtPct(pnlPct)} (${fmtDollars(pnl)})`);
    htmlLines.push(`  ${emoji} ${pos.symbol}: <b>${fmtPct(pnlPct)}</b> (${fmtDollars(pnl)})`);
  }
  if (openPositions.length > 8) {
    lines.push(`  ... and ${openPositions.length - 8} more`);
    htmlLines.push(`  <i>... and ${openPositions.length - 8} more</i>`);
  }
  if (!openPositions.length) {
    lines.push('  No open positions — fully in cash');
    htmlLines.push('  <i>No open positions — fully in cash</i>');
  }

  lines.push('');
  htmlLines.push('');

  // ── 4. Staged Orders ────────────────────────────────────────────────────
  let stagedOrders = [];
  try {
    stagedOrders = db().prepare(
      "SELECT symbol, side, qty, limit_price, stop_price, status FROM staged_orders WHERE status IN ('staged', 'submitted') ORDER BY created_at DESC"
    ).all();
  } catch (_) {}

  if (stagedOrders.length) {
    lines.push(`📋 STAGED ORDERS (${stagedOrders.length})`);
    htmlLines.push(`📋 <b>STAGED ORDERS</b> (${stagedOrders.length})`);

    for (const o of stagedOrders.slice(0, 5)) {
      const action = (o.side || 'buy').toUpperCase();
      const price = o.limit_price ? `@ ${fmtPrice(o.limit_price)}` : 'MKT';
      const stop = o.stop_price ? ` (stop ${fmtPrice(o.stop_price)})` : '';
      const badge = o.status === 'submitted' ? ' [LIVE]' : '';

      lines.push(`  ${action} ${o.symbol} ${o.qty} ${price}${stop}${badge}`);
      htmlLines.push(`  ${action} <b>${o.symbol}</b> ${o.qty} ${price}${stop}${badge}`);
    }
    if (stagedOrders.length > 5) {
      lines.push(`  ... and ${stagedOrders.length - 5} more`);
      htmlLines.push(`  <i>... and ${stagedOrders.length - 5} more</i>`);
    }
  } else {
    lines.push('📋 STAGED ORDERS: None');
    htmlLines.push('📋 <b>STAGED ORDERS:</b> None');
  }

  lines.push('');
  htmlLines.push('');

  // ── 5. Top Scan Picks ───────────────────────────────────────────────────
  let topPicks = [];
  try {
    // First try cached scan data
    const { cacheGet } = require('../data/cache');
    const cached = cacheGet('rs:full', 24 * 60 * 60 * 1000); // Accept up to 24h old
    if (cached?.length) {
      topPicks = cached
        .filter(s => s.stage === 2 && (s.rsRank || 0) >= 80)
        .sort((a, b) => (b.rsRank || 0) - (a.rsRank || 0))
        .slice(0, 5);
    }
  } catch (_) {}

  // Fallback to latest DB snapshots if cache is empty
  if (!topPicks.length) {
    try {
      const latestDate = db().prepare(
        "SELECT MAX(date) as date FROM rs_snapshots WHERE type = 'stock'"
      ).get()?.date;
      if (latestDate) {
        topPicks = db().prepare(`
          SELECT symbol as ticker, rs_rank as rsRank, stage, vcp_forming as vcpForming,
                 rs_line_new_high as rsLineNewHigh, vs_ma50 as vsMA50, swing_momentum as swingMomentum
          FROM rs_snapshots
          WHERE date = ? AND type = 'stock' AND stage = 2 AND rs_rank >= 80
          ORDER BY rs_rank DESC
          LIMIT 5
        `).all(latestDate);
      }
    } catch (_) {}
  }

  if (topPicks.length) {
    lines.push('🎯 TOP SCAN PICKS');
    htmlLines.push('🎯 <b>TOP SCAN PICKS</b>');

    for (let i = 0; i < topPicks.length; i++) {
      const s = topPicks[i];
      const tags = [];
      if (s.stage === 2) tags.push('Stage 2');
      if (s.vcpForming) tags.push('VCP');
      if (s.rsLineNewHigh) tags.push('RS new high');
      const vs50 = s.vsMA50 != null ? `${fmtPct(s.vsMA50)} vs MA50` : '';

      lines.push(`  ${i + 1}. ${s.ticker} — RS ${s.rsRank}${tags.length ? ', ' + tags.join(', ') : ''}${vs50 ? ', ' + vs50 : ''}`);
      htmlLines.push(`  ${i + 1}. <b>${s.ticker}</b> — RS ${s.rsRank}${tags.length ? ', ' + tags.join(', ') : ''}${vs50 ? ', ' + vs50 : ''}`);
    }
  } else {
    lines.push('🎯 TOP SCAN PICKS: No scan data available');
    htmlLines.push('🎯 <b>TOP SCAN PICKS:</b> <i>No scan data available</i>');
  }

  return {
    subject: `☀️ Morning Brief — ${dayNameET()} ${marketDateET()}`,
    text: lines.join('\n'),
    html: htmlLines.join('\n'),
    data: {
      regime: regime?.regime,
      cycleMode: cycle?.mode,
      distDays: cycle?.distributionDays?.count,
      openPositions: openPositions.length,
      heatPct: heat.heatPct,
      stagedOrders: stagedOrders.length,
      topPicks: topPicks.length,
    },
  };
}


// ─── Weekly Digest ───────────────────────────────────────────────────────────

async function assembleWeeklyDigest() {
  const lines = [];
  const htmlLines = [];

  // Week boundaries (Mon-Fri of the past week)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  // Go back to last Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7) - 7); // Previous week's Monday
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  // If called on Sunday, the "past week" is Mon-Fri just ended
  // If called on another day, adjust
  if (dayOfWeek === 0) {
    // Sunday: the week just ended (Mon-Fri)
    monday.setDate(now.getDate() - 6);
    friday.setDate(now.getDate() - 2);
  }

  const mondayStr = monday.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const fridayStr = friday.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const weekLabel = `${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })} – ${friday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}`;

  lines.push('📊 ALPHA HUNTER — WEEKLY DIGEST');
  lines.push(`Week of ${weekLabel}`);
  lines.push('');
  htmlLines.push('📊 <b>ALPHA HUNTER — WEEKLY DIGEST</b>');
  htmlLines.push(`<i>Week of ${weekLabel}</i>`);
  htmlLines.push('');

  // ── 1. Week Performance ─────────────────────────────────────────────────
  let weekPnl = 0;
  let weekPnlPct = null;
  let currentEquity = null;
  let spyWeekReturn = null;

  try {
    const { getEquitySnapshots, computePeriodReturn } = require('../risk/alpha-tracker');
    const snapshots = getEquitySnapshots();

    if (snapshots.length) {
      currentEquity = snapshots[snapshots.length - 1].equity;

      // Find the snapshot closest to Monday of last week
      const mondaySnap = snapshots.filter(s => s.date <= mondayStr).pop();
      const fridaySnap = snapshots.filter(s => s.date <= fridayStr).pop();

      if (mondaySnap && fridaySnap && mondaySnap.equity > 0) {
        weekPnl = fridaySnap.equity - mondaySnap.equity;
        weekPnlPct = ((fridaySnap.equity / mondaySnap.equity) - 1) * 100;

        // SPY return over same period
        if (mondaySnap.spy_close && fridaySnap.spy_close && mondaySnap.spy_close > 0) {
          spyWeekReturn = ((fridaySnap.spy_close / mondaySnap.spy_close) - 1) * 100;
        }
      } else {
        // Fallback to 5-day period return
        weekPnlPct = computePeriodReturn(snapshots, 5);
      }
    }
  } catch (_) {}

  lines.push('💰 WEEK PERFORMANCE');
  htmlLines.push('💰 <b>WEEK PERFORMANCE</b>');

  if (weekPnlPct != null) {
    const emoji = weekPnl >= 0 ? '📈' : '📉';
    lines.push(`  ${emoji} P&L: ${fmtDollars(weekPnl)} (${fmtPct(weekPnlPct)})`);
    htmlLines.push(`  ${emoji} P&L: <b>${fmtDollars(weekPnl)}</b> (${fmtPct(weekPnlPct)})`);

    if (currentEquity) {
      lines.push(`  Equity: ${fmtPrice(currentEquity)}`);
      htmlLines.push(`  Equity: ${fmtPrice(currentEquity)}`);
    }

    if (spyWeekReturn != null) {
      const alpha = weekPnlPct - spyWeekReturn;
      lines.push(`  SPY: ${fmtPct(spyWeekReturn)} | Alpha: ${fmtPct(alpha)}`);
      htmlLines.push(`  SPY: ${fmtPct(spyWeekReturn)} | Alpha: <b>${fmtPct(alpha)}</b>`);
    }
  } else {
    lines.push('  No equity snapshots for this week');
    htmlLines.push('  <i>No equity snapshots for this week</i>');
  }

  lines.push('');
  htmlLines.push('');

  // ── 2. Trades This Week ─────────────────────────────────────────────────
  let entries = [];
  let exits = [];

  try {
    entries = db().prepare(
      'SELECT symbol, side, entry_price, shares, entry_date FROM trades WHERE entry_date BETWEEN ? AND ? ORDER BY entry_date ASC'
    ).all(mondayStr, fridayStr);
  } catch (_) {}

  try {
    exits = db().prepare(
      'SELECT symbol, side, entry_price, exit_price, shares, exit_date, pnl_dollars, pnl_pct FROM trades WHERE exit_date BETWEEN ? AND ? ORDER BY exit_date ASC'
    ).all(mondayStr, fridayStr);
  } catch (_) {}

  lines.push(`📝 TRADES THIS WEEK (${entries.length} entries, ${exits.length} exits)`);
  htmlLines.push(`📝 <b>TRADES THIS WEEK</b> (${entries.length} entries, ${exits.length} exits)`);

  for (const t of entries.slice(0, 6)) {
    const day = new Date(t.entry_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
    lines.push(`  ✅ ${t.symbol} — ${(t.side || 'buy').toUpperCase()} ${t.shares} @ ${fmtPrice(t.entry_price)} (${day})`);
    htmlLines.push(`  ✅ <b>${t.symbol}</b> — ${(t.side || 'buy').toUpperCase()} ${t.shares} @ ${fmtPrice(t.entry_price)} (${day})`);
  }

  for (const t of exits.slice(0, 6)) {
    const day = new Date(t.exit_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
    const pnl = t.pnl_dollars != null ? ` → ${fmtPct(t.pnl_pct)} (${fmtDollars(t.pnl_dollars)})` : '';
    const emoji = (t.pnl_dollars || 0) >= 0 ? '💰' : '🔴';
    lines.push(`  ${emoji} ${t.symbol} — EXIT @ ${fmtPrice(t.exit_price)}${pnl} (${day})`);
    htmlLines.push(`  ${emoji} <b>${t.symbol}</b> — EXIT @ ${fmtPrice(t.exit_price)}${pnl} (${day})`);
  }

  if (!entries.length && !exits.length) {
    lines.push('  No trades this week');
    htmlLines.push('  <i>No trades this week</i>');
  }

  lines.push('');
  htmlLines.push('');

  // ── 3. Win Rate / Stats ─────────────────────────────────────────────────
  let closedTrades = [];
  try {
    closedTrades = db().prepare(
      'SELECT pnl_pct, pnl_dollars FROM trades WHERE exit_date IS NOT NULL ORDER BY exit_date DESC LIMIT 50'
    ).all();
  } catch (_) {}

  if (closedTrades.length) {
    const winners = closedTrades.filter(t => (t.pnl_dollars || 0) > 0);
    const losers = closedTrades.filter(t => (t.pnl_dollars || 0) < 0);
    const winRate = ((winners.length / closedTrades.length) * 100).toFixed(0);
    const avgWin = winners.length ? (winners.reduce((s, t) => s + (t.pnl_pct || 0), 0) / winners.length).toFixed(1) : '—';
    const avgLoss = losers.length ? (losers.reduce((s, t) => s + (t.pnl_pct || 0), 0) / losers.length).toFixed(1) : '—';

    lines.push('📊 TRADE STATS (last 50)');
    htmlLines.push('📊 <b>TRADE STATS</b> (last 50)');
    lines.push(`  Win rate: ${winRate}% (${winners.length}W / ${losers.length}L of ${closedTrades.length})`);
    htmlLines.push(`  Win rate: <b>${winRate}%</b> (${winners.length}W / ${losers.length}L of ${closedTrades.length})`);
    lines.push(`  Avg win: +${avgWin}% | Avg loss: ${avgLoss}%`);
    htmlLines.push(`  Avg win: +${avgWin}% | Avg loss: ${avgLoss}%`);
  }

  lines.push('');
  htmlLines.push('');

  // ── 4. Regime Changes This Week ─────────────────────────────────────────
  let regimeChanges = [];
  try {
    regimeChanges = db().prepare(`
      SELECT date, mode, confidence, ftd_date
      FROM regime_log
      WHERE date BETWEEN ? AND ?
      ORDER BY date ASC
    `).all(mondayStr, fridayStr);
  } catch (_) {}

  if (regimeChanges.length > 0) {
    lines.push('🌊 REGIME LOG');
    htmlLines.push('🌊 <b>REGIME LOG</b>');

    // Show transitions: compare consecutive entries
    for (let i = 0; i < regimeChanges.length; i++) {
      const r = regimeChanges[i];
      const day = new Date(r.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
      const ftdNote = r.ftd_date ? ` (FTD: ${r.ftd_date})` : '';
      lines.push(`  ${day}: ${r.mode} (${r.confidence}%)${ftdNote}`);
      htmlLines.push(`  ${day}: <b>${r.mode}</b> (${r.confidence}%)${ftdNote}`);
    }
  } else {
    lines.push('🌊 REGIME LOG: No regime entries this week');
    htmlLines.push('🌊 <b>REGIME LOG:</b> <i>No entries this week</i>');
  }

  lines.push('');
  htmlLines.push('');

  // ── 5. Top RS Movers (week-over-week) ───────────────────────────────────
  let rsMovers = [];
  try {
    // Get RS ranks from Monday and Friday snapshots
    const mondaySnaps = db().prepare(
      "SELECT symbol, rs_rank FROM rs_snapshots WHERE date = ? AND type = 'stock' AND rs_rank IS NOT NULL"
    ).all(mondayStr);

    const fridaySnaps = db().prepare(
      "SELECT symbol, rs_rank FROM rs_snapshots WHERE date = ? AND type = 'stock' AND rs_rank IS NOT NULL"
    ).all(fridayStr);

    if (mondaySnaps.length && fridaySnaps.length) {
      const mondayMap = {};
      for (const s of mondaySnaps) mondayMap[s.symbol] = s.rs_rank;

      const deltas = [];
      for (const s of fridaySnaps) {
        if (mondayMap[s.symbol] != null) {
          deltas.push({
            symbol: s.symbol,
            from: mondayMap[s.symbol],
            to: s.rs_rank,
            delta: s.rs_rank - mondayMap[s.symbol],
          });
        }
      }

      // Top 3 risers and top 3 fallers
      deltas.sort((a, b) => b.delta - a.delta);
      const risers = deltas.filter(d => d.delta > 3).slice(0, 3);
      const fallers = deltas.filter(d => d.delta < -3).sort((a, b) => a.delta - b.delta).slice(0, 3);
      rsMovers = [...risers, ...fallers];
    }
  } catch (_) {}

  if (rsMovers.length) {
    lines.push('🔥 RS MOVERS (week-over-week)');
    htmlLines.push('🔥 <b>RS MOVERS</b> (week-over-week)');

    for (const m of rsMovers) {
      const arrow = m.delta > 0 ? '↑' : '↓';
      const sign = m.delta > 0 ? '+' : '';
      lines.push(`  ${arrow} ${m.symbol}: ${m.from} → ${m.to} (${sign}${m.delta})`);
      htmlLines.push(`  ${arrow} <b>${m.symbol}</b>: ${m.from} → ${m.to} (${sign}${m.delta})`);
    }
  } else {
    lines.push('🔥 RS MOVERS: Insufficient snapshot data');
    htmlLines.push('🔥 <b>RS MOVERS:</b> <i>Insufficient snapshot data</i>');
  }

  return {
    subject: `📊 Weekly Digest — ${weekLabel}`,
    text: lines.join('\n'),
    html: htmlLines.join('\n'),
    data: {
      weekPnl,
      weekPnlPct,
      spyWeekReturn,
      entries: entries.length,
      exits: exits.length,
      regimeChanges: regimeChanges.length,
      rsMovers: rsMovers.length,
    },
  };
}

module.exports = { assembleMorningBrief, assembleWeeklyDigest };
