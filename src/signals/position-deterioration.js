// ─── Position Deterioration Watcher ─────────────────────────────────────────
//
// Monitors open positions for thesis erosion signals that should trigger
// aggressive stop-tightening, BEFORE the price-based stop is hit. This closes
// the Minervini/O'Neil "rotation-aware exit" gap — pros don't wait for price
// to collapse, they tighten when leadership fades.
//
// Signals monitored (runs daily post-close):
//
//   1. INDUSTRY_ROTATION   — Position's industry ETF RS rank dropped ≥20
//                            points over the last 10 trading days. The
//                            industry that was leading is no longer leading;
//                            the stock's relative-performance tailwind is
//                            gone.
//   2. INDIVIDUAL_RS_DROP  — The stock's own RS rank dropped ≥20 points
//                            over 10 days. Institutional flow is leaving
//                            this specific name.
//   3. STAGE_DISTRIBUTION  — Stock transitioned from Stage 2 (uptrend) to
//                            Stage 3 (topping) or Stage 4 (downtrend).
//                            Weinstein's classic distribution signal.
//   4. REGIME_DOWNGRADE    — (Triggered externally by regime.js) — fires
//                            applyDeteriorationTighten('regime_change', ...)
//                            when BULL→CAUTION or CAUTION→BEAR transitions.
//
// Action when any signal fires:
//   - Set trade.trail_pct = 0.04 (half the default 8% trail — much tighter)
//   - If trailing already active, recompute stop at new trail% immediately
//     and PATCH broker stop legs via replaceStopsForSymbol
//   - Log the reason in trade.trail_tightened_reason for UI transparency
//   - Fire `trail_tightened` notification so the user sees it on their phone
//
// Idempotency: trade.trail_tightened_at is set. We skip re-tightening the
// same trade within 3 days unless a NEW signal fires with a different reason.

const { getDB } = require('../data/database');
const { notifyTradeEvent } = require('../notifications/channels');

function db() { return getDB(); }

const DEFAULT_RS_DROP = 20;
const DEFAULT_LOOKBACK_DAYS = 10;
const DEFAULT_TIGHT_TRAIL = 0.04;
const COOLDOWN_DAYS = 3;

// Map of stock sectors → their representative industry ETFs. This is
// coarse but sufficient for the rotation signal — a more granular
// industry-group mapping would require IBD-level data we don't have.
// The mapping covers the ~24 industry ETFs in our universe.
const SECTOR_TO_ETF = {
  'Technology':             ['XLK', 'SMH', 'IGV', 'HACK', 'SKYY'],
  'Financials':             ['XLF', 'KBE', 'KRE', 'IAI'],
  'Healthcare':             ['XLV', 'IBB', 'XBI', 'IHI'],
  'Energy':                 ['XLE', 'XOP', 'OIH', 'TAN'],
  'Industrials':            ['XLI', 'ITA', 'IYT', 'XHB'],
  'Consumer Discretionary': ['XLY', 'XRT'],
  'Consumer Staples':       ['XLP'],
  'Utilities':              ['XLU'],
  'Materials':              ['XLB', 'GDX', 'LIT'],
  'Real Estate':            ['XLRE', 'IYR'],
  'Communication':          ['XLC'],
};

// Fetch RS rank history for a symbol from rs_snapshots
function getRsHistory(symbol, type, days) {
  return db().prepare(`
    SELECT date, rs_rank, stage FROM rs_snapshots
    WHERE symbol = ? AND type = ? AND date >= date('now', '-${days + 5} days')
    ORDER BY date ASC
  `).all(symbol, type);
}

// Find the industry ETF most representative of a trade's sector. If the
// trade has a sector tag and that sector maps to multiple ETFs, we pick the
// one with the MOST RS drop (the most relevant negative signal). Returns null
// if we can't map the sector.
function detectIndustryRotation(trade, lookbackDays) {
  if (!trade.sector) return null;
  const etfs = SECTOR_TO_ETF[trade.sector];
  if (!etfs?.length) return null;

  let worstDrop = null;
  for (const etf of etfs) {
    const history = getRsHistory(etf, 'industry', lookbackDays);
    // Try sector type as fallback — some ETFs are tagged as 'sector' not 'industry'
    const rows = history.length >= 2 ? history : getRsHistory(etf, 'sector', lookbackDays);
    if (rows.length < 2) continue;
    const current = rows[rows.length - 1].rs_rank;
    const prior = rows[0].rs_rank;
    if (current == null || prior == null) continue;
    const drop = prior - current;
    if (worstDrop == null || drop > worstDrop.drop) {
      worstDrop = { etf, current, prior, drop };
    }
  }
  return worstDrop;
}

function detectIndividualRsDrop(trade, lookbackDays) {
  const rows = getRsHistory(trade.symbol, 'stock', lookbackDays);
  if (rows.length < 2) return null;
  const current = rows[rows.length - 1].rs_rank;
  const prior = rows[0].rs_rank;
  if (current == null || prior == null) return null;
  return { current, prior, drop: prior - current };
}

function detectStageDistribution(trade) {
  const rows = getRsHistory(trade.symbol, 'stock', 15);
  if (rows.length < 2) return null;
  const current = rows[rows.length - 1].stage;
  const prior = rows[0].stage;
  if (current == null || prior == null) return null;
  // Transition from Stage 2 (uptrend) to Stage 3 (topping) or Stage 4 (decline)
  if (prior === 2 && (current === 3 || current === 4)) {
    return { current, prior, transition: `Stage ${prior} → Stage ${current}` };
  }
  return null;
}

// Main scan: evaluate every open position and return the list of
// deterioration signals + the adjustments they trigger.
function scanOpenPositions({ rsDropThreshold = DEFAULT_RS_DROP, lookbackDays = DEFAULT_LOOKBACK_DAYS, tightTrailPct = DEFAULT_TIGHT_TRAIL } = {}) {
  const openTrades = db().prepare(`
    SELECT * FROM trades WHERE exit_date IS NULL
  `).all();

  const alerts = [];
  for (const trade of openTrades) {
    // Cooldown: skip if tightened in the last 3 days (unless user manually
    // untightened by editing trail_pct back up)
    if (trade.trail_tightened_at && trade.trail_pct <= tightTrailPct + 0.001) {
      const last = new Date(trade.trail_tightened_at);
      const daysSince = (Date.now() - last.getTime()) / 86400000;
      if (daysSince < COOLDOWN_DAYS) continue;
    }

    const signals = [];
    const rotation = detectIndustryRotation(trade, lookbackDays);
    if (rotation && rotation.drop >= rsDropThreshold) {
      signals.push({
        type: 'industry_rotation',
        detail: `${rotation.etf} RS ${rotation.prior} → ${rotation.current} (drop ${rotation.drop} pts in ${lookbackDays}d)`,
      });
    }

    const rsDrop = detectIndividualRsDrop(trade, lookbackDays);
    if (rsDrop && rsDrop.drop >= rsDropThreshold) {
      signals.push({
        type: 'individual_rs_drop',
        detail: `${trade.symbol} RS ${rsDrop.prior} → ${rsDrop.current} (drop ${rsDrop.drop} pts in ${lookbackDays}d)`,
      });
    }

    const stage = detectStageDistribution(trade);
    if (stage) {
      signals.push({
        type: 'stage_distribution',
        detail: stage.transition,
      });
    }

    if (signals.length > 0) {
      alerts.push({ trade, signals, newTrailPct: tightTrailPct });
    }
  }
  return alerts;
}

// Apply the tightening: flip trail_pct, patch broker stops, notify user.
async function applyDeteriorationTighten(alerts) {
  if (!alerts?.length) return { tightened: 0, brokerPatched: 0, brokerFailed: 0 };

  const updateStmt = db().prepare(`
    UPDATE trades SET trail_pct = ?, trail_tightened_at = datetime('now'),
      trail_tightened_reason = ?
    WHERE id = ?
  `);

  let tightened = 0, brokerPatched = 0, brokerFailed = 0;
  const { getBroker } = require('../broker');
  let broker = null;
  try { broker = getBroker(); } catch (_) { broker = null; }

  for (const alert of alerts) {
    const { trade, signals, newTrailPct } = alert;
    const reason = signals.map(s => s.detail).join(' | ');

    updateStmt.run(newTrailPct, reason, trade.id);
    tightened++;

    // Recompute the new stop RIGHT NOW and patch the broker leg so the
    // alert the user gets ("trail tightened on TER") actually corresponds
    // to a real broker stop change. Pre-fix this branch was gated on
    // `trade.trailing_stop_active` — most rows had that flag 0, so the
    // journal got tightened and the user's phone buzzed but the broker
    // stop never moved. Net effect: positions sat at -4% to -7% with
    // STOP VIOLATED in the journal while Alpaca's actual stop was still
    // at the original wide level. Removing the gate fixes that. Even if
    // the position has no broker stop yet (manual entry, reconciled
    // orphan), the periodic syncJournalStopsToBroker job will create one
    // — but on tight-trigger we still attempt the patch path so the user
    // sees a same-tick action.
    if (broker && trade.remaining_shares > 0) {
      try {
        // Fetch current price for a stop recompute
        const { getQuotes } = require('../data/providers/manager');
        const quotes = await getQuotes([trade.symbol]);
        const price = quotes[0]?.regularMarketPrice;
        if (price) {
          const isShort = trade.side === 'short';
          const newStop = isShort
            ? +(price * (1 + newTrailPct)).toFixed(2)
            : +(price * (1 - newTrailPct)).toFixed(2);
          const currentStop = trade.stop_price;
          // Only tighten — never loosen
          const shouldUpdate = isShort ? newStop < currentStop : newStop > currentStop;
          if (shouldUpdate) {
            db().prepare('UPDATE trades SET stop_price = ? WHERE id = ?').run(newStop, trade.id);
            try {
              const patched = await broker.replaceStopsForSymbol({ symbol: trade.symbol, newStopPrice: newStop });
              if (patched?.length) brokerPatched++;
            } catch (e) {
              brokerFailed++;
              console.error(`  deterioration: broker patch failed for ${trade.symbol}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        console.warn(`  deterioration: price fetch failed for ${trade.symbol}: ${e.message}`);
      }
    }

    // Phone notification so the user knows their thesis eroded
    notifyTradeEvent({
      event: 'trail_tightened',
      symbol: trade.symbol,
      details: {
        shares: trade.remaining_shares ?? trade.shares,
        price: trade.stop_price,
        message: `Trail tightened to ${(newTrailPct*100).toFixed(0)}% — ${reason}`,
      },
    }).catch(e => console.error(`  notify trail_tightened ${trade.symbol}: ${e.message}`));
  }

  return { tightened, brokerPatched, brokerFailed };
}

// Combined entry point for the rotation_watch cron job.
async function runPositionDeteriorationScan(config = {}) {
  const alerts = scanOpenPositions(config);
  const result = await applyDeteriorationTighten(alerts);
  return {
    scanned: alerts.length,
    ...result,
    alerts: alerts.map(a => ({
      symbol: a.trade.symbol,
      signals: a.signals,
      newTrailPct: a.newTrailPct,
    })),
  };
}

// Called directly by regime.js when BULL→CAUTION or CAUTION→BEAR detected.
// Tightens ALL open positions regardless of individual signals — the whole
// market turned against us, not just this one stock.
async function tightenOnRegimeDowngrade({ fromRegime, toRegime, tightTrailPct = 0.04 }) {
  const openTrades = db().prepare('SELECT * FROM trades WHERE exit_date IS NULL').all();
  if (!openTrades.length) return { tightened: 0 };

  const reason = `Regime downgrade ${fromRegime} → ${toRegime}`;
  const alerts = openTrades
    .filter(t => (t.trail_pct ?? 0.08) > tightTrailPct) // skip ones already tight
    .map(trade => ({ trade, signals: [{ type: 'regime_downgrade', detail: reason }], newTrailPct: tightTrailPct }));

  return applyDeteriorationTighten(alerts);
}

module.exports = {
  runPositionDeteriorationScan,
  scanOpenPositions,
  applyDeteriorationTighten,
  tightenOnRegimeDowngrade,
  SECTOR_TO_ETF,
};
