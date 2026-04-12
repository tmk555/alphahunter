// ─── Tax-Aware Returns Engine ────────────────────────────────────────────────
// Tracks tax lots, detects wash sales, calculates after-tax returns.
// For US traders, the difference between short-term (37%) and long-term (20%)
// capital gains can be 17% of profits. After-tax alpha is what matters.
//
// Features:
//   1. Tax lot tracking (FIFO and specific identification)
//   2. Wash sale detection (30-day rule)
//   3. Short-term vs long-term classification
//   4. After-tax return calculation
//   5. Tax-loss harvesting opportunity scanner
//   6. Year-end tax impact estimation

const { getDB } = require('../data/database');

function db() { return getDB(); }

// ─── Tax Rate Configuration ─────────────────────────────────────────────────
const TAX_RATES = {
  shortTermRate: 0.37,     // Ordinary income (highest bracket)
  longTermRate: 0.20,      // Long-term capital gains
  netInvestmentIncome: 0.038, // NIIT surcharge for high earners
  stateRate: 0.05,         // Default state rate (varies)
};

function getTaxConfig() {
  try {
    const saved = db().prepare(`SELECT value FROM portfolio_state WHERE key = 'tax_config'`).get();
    if (saved) return { ...TAX_RATES, ...JSON.parse(saved.value) };
  } catch (_) {}
  return { ...TAX_RATES };
}

function updateTaxConfig(updates) {
  const config = { ...getTaxConfig(), ...updates };
  db().prepare(`
    INSERT OR REPLACE INTO portfolio_state (key, value, updated_at)
    VALUES ('tax_config', ?, datetime('now'))
  `).run(JSON.stringify(config));
  return config;
}

// ─── Tax Lot Management ─────────────────────────────────────────────────────
// Each purchase creates a tax lot. When selling, lots are matched FIFO
// or by specific identification. Wash sale rules apply.

function createTaxLot(params) {
  const {
    tradeId,
    symbol,
    shares,
    costBasis,        // per share
    acquiredDate,
    adjustedBasis,    // if wash sale adds disallowed loss
  } = params;

  db().prepare(`
    INSERT INTO tax_lots
    (trade_id, symbol, shares, remaining_shares, cost_basis, adjusted_basis,
     acquired_date, holding_period, wash_sale_adjustment)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    tradeId, symbol, shares, shares, costBasis,
    adjustedBasis || costBasis, acquiredDate, 0
  );

  return { created: true, symbol, shares, costBasis, acquiredDate };
}

// Sell shares using FIFO (or specific lot ID)
function sellTaxLots(params) {
  const {
    symbol,
    shares,
    salePrice,
    saleDate,
    method = 'fifo',   // fifo | specific | tax_optimal
    specificLotId,      // for specific identification
  } = params;

  let lots;
  if (method === 'specific' && specificLotId) {
    lots = db().prepare(`
      SELECT * FROM tax_lots WHERE id = ? AND remaining_shares > 0
    `).all(specificLotId);
  } else if (method === 'tax_optimal') {
    // Sell highest-basis lots first (minimize taxable gain)
    lots = db().prepare(`
      SELECT * FROM tax_lots WHERE symbol = ? AND remaining_shares > 0
      ORDER BY adjusted_basis DESC
    `).all(symbol);
  } else {
    // FIFO: sell oldest lots first
    lots = db().prepare(`
      SELECT * FROM tax_lots WHERE symbol = ? AND remaining_shares > 0
      ORDER BY acquired_date ASC
    `).all(symbol);
  }

  let remainingToSell = shares;
  const dispositions = [];
  let totalGain = 0, shortTermGain = 0, longTermGain = 0;

  for (const lot of lots) {
    if (remainingToSell <= 0) break;

    const sellFromLot = Math.min(remainingToSell, lot.remaining_shares);
    const gain = (salePrice - lot.adjusted_basis) * sellFromLot;

    // Determine holding period
    const acquiredMs = new Date(lot.acquired_date).getTime();
    const soldMs = new Date(saleDate).getTime();
    const holdingDays = Math.round((soldMs - acquiredMs) / (1000 * 60 * 60 * 24));
    const isLongTerm = holdingDays > 365;

    if (isLongTerm) longTermGain += gain;
    else shortTermGain += gain;
    totalGain += gain;

    // Check for wash sale
    const washSale = checkWashSale(symbol, saleDate, gain < 0);

    dispositions.push({
      lotId: lot.id,
      shares: sellFromLot,
      costBasis: lot.adjusted_basis,
      salePrice,
      gain: +gain.toFixed(2),
      gainPct: +((gain / (lot.adjusted_basis * sellFromLot)) * 100).toFixed(2),
      holdingDays,
      isLongTerm,
      washSale: washSale.isWashSale,
      washSaleDisallowed: washSale.disallowedLoss,
    });

    // Update lot
    const newRemaining = lot.remaining_shares - sellFromLot;
    if (newRemaining === 0) {
      db().prepare(`
        UPDATE tax_lots SET remaining_shares = 0, disposed_date = ?,
        sale_price = ?, realized_gain = ?, holding_period = ?
        WHERE id = ?
      `).run(saleDate, salePrice, gain, isLongTerm ? 'long_term' : 'short_term', lot.id);
    } else {
      db().prepare(`
        UPDATE tax_lots SET remaining_shares = ? WHERE id = ?
      `).run(newRemaining, lot.id);
    }

    remainingToSell -= sellFromLot;
  }

  const config = getTaxConfig();
  const totalEffectiveRate = (isLT) => isLT
    ? config.longTermRate + config.netInvestmentIncome + config.stateRate
    : config.shortTermRate + config.netInvestmentIncome + config.stateRate;

  const shortTermTax = shortTermGain * totalEffectiveRate(false);
  const longTermTax = longTermGain * totalEffectiveRate(true);
  const totalTax = shortTermTax + longTermTax;
  const afterTaxGain = totalGain - Math.max(0, totalTax);

  return {
    dispositions,
    summary: {
      sharesSold: shares - remainingToSell,
      unsold: remainingToSell,
      totalGain: +totalGain.toFixed(2),
      shortTermGain: +shortTermGain.toFixed(2),
      longTermGain: +longTermGain.toFixed(2),
      estimatedTax: +Math.max(0, totalTax).toFixed(2),
      afterTaxGain: +afterTaxGain.toFixed(2),
      effectiveTaxRate: totalGain !== 0 ? +(Math.max(0, totalTax) / Math.abs(totalGain) * 100).toFixed(1) : 0,
      taxSavings: shortTermGain > 0 ? +((shortTermGain * (config.shortTermRate - config.longTermRate))).toFixed(2) : 0,
      taxSavingsNote: 'Amount saved if all short-term gains were long-term instead',
    },
  };
}

// ─── Wash Sale Detection ────────────────────────────────────────────────────
// IRS Rule: if you sell at a loss and buy the same (or substantially identical)
// security within 30 days before or after, the loss is disallowed.

function checkWashSale(symbol, saleDate, isLoss) {
  if (!isLoss) return { isWashSale: false, disallowedLoss: 0 };

  const saleMs = new Date(saleDate).getTime();
  const windowStart = new Date(saleMs - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const windowEnd = new Date(saleMs + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Check for purchases of the same symbol within the wash sale window
  const recentPurchases = db().prepare(`
    SELECT * FROM tax_lots
    WHERE symbol = ? AND acquired_date >= ? AND acquired_date <= ? AND acquired_date != ?
  `).all(symbol, windowStart, windowEnd, saleDate);

  // Also check trades table for open orders
  const recentTrades = db().prepare(`
    SELECT * FROM trades
    WHERE symbol = ? AND side = 'long' AND entry_date >= ? AND entry_date <= ? AND entry_date != ?
  `).all(symbol, windowStart, windowEnd, saleDate);

  const isWashSale = recentPurchases.length > 0 || recentTrades.length > 0;

  return {
    isWashSale,
    disallowedLoss: 0, // calculated when the specific sale amount is known
    triggeringPurchases: recentPurchases.map(p => ({
      date: p.acquired_date,
      shares: p.shares,
      costBasis: p.cost_basis,
    })),
    windowStart,
    windowEnd,
    message: isWashSale
      ? `WASH SALE: ${symbol} purchased within 30 days of loss sale — loss will be disallowed and added to new lot basis`
      : null,
  };
}

// ─── Tax-Loss Harvesting Scanner ────────────────────────────────────────────
// Finds positions with unrealized losses that could be harvested to offset gains.

function scanTaxLossHarvesting(openPositions, currentPrices) {
  const config = getTaxConfig();
  const opportunities = [];

  // Get realized gains YTD for context
  const ytdGains = getYTDTaxSummary();

  for (const pos of openPositions) {
    const currentPrice = currentPrices[pos.symbol] || pos.currentPrice;
    if (!currentPrice) continue;

    // Get tax lots for this position
    const lots = db().prepare(`
      SELECT * FROM tax_lots WHERE symbol = ? AND remaining_shares > 0
      ORDER BY acquired_date ASC
    `).all(pos.symbol);

    let unrealizedLoss = 0, unrealizedGain = 0;
    const lotDetails = [];

    for (const lot of lots) {
      const gain = (currentPrice - lot.adjusted_basis) * lot.remaining_shares;
      const holdingDays = Math.round(
        (Date.now() - new Date(lot.acquired_date).getTime()) / (1000 * 60 * 60 * 24)
      );

      if (gain < 0) {
        unrealizedLoss += gain;
        lotDetails.push({
          lotId: lot.id,
          shares: lot.remaining_shares,
          costBasis: lot.adjusted_basis,
          unrealizedLoss: +gain.toFixed(2),
          holdingDays,
          isLongTerm: holdingDays > 365,
        });
      } else {
        unrealizedGain += gain;
      }
    }

    if (unrealizedLoss < -100) { // minimum $100 loss to be worth harvesting
      // Check for wash sale risk
      const washRisk = checkWashSale(pos.symbol, new Date().toISOString().split('T')[0], true);

      // Tax savings estimate
      const shortTermSavings = Math.abs(unrealizedLoss) *
        (config.shortTermRate + config.netInvestmentIncome + config.stateRate);
      const longTermSavings = Math.abs(unrealizedLoss) *
        (config.longTermRate + config.netInvestmentIncome + config.stateRate);

      opportunities.push({
        symbol: pos.symbol,
        currentPrice,
        unrealizedLoss: +unrealizedLoss.toFixed(2),
        unrealizedGain: +unrealizedGain.toFixed(2),
        netUnrealized: +(unrealizedLoss + unrealizedGain).toFixed(2),
        lots: lotDetails,
        estimatedTaxSavings: {
          shortTerm: +shortTermSavings.toFixed(2),
          longTerm: +longTermSavings.toFixed(2),
        },
        washSaleRisk: washRisk.isWashSale,
        washSaleWarning: washRisk.message,
        recommendation: washRisk.isWashSale
          ? 'WAIT — wash sale window active. Harvest after 31 days or buy substitute ETF.'
          : unrealizedLoss < -500
            ? 'HARVEST — sell to realize loss, consider buying sector ETF as substitute'
            : 'MONITOR — loss is small, may not be worth the transaction cost',
      });
    }
  }

  // Sort by largest potential savings
  opportunities.sort((a, b) => a.unrealizedLoss - b.unrealizedLoss);

  const totalHarvestable = opportunities.reduce((s, o) => s + o.unrealizedLoss, 0);
  const totalTaxSavings = opportunities.reduce((s, o) => s + o.estimatedTaxSavings.shortTerm, 0);

  return {
    opportunities,
    summary: {
      totalHarvestable: +totalHarvestable.toFixed(2),
      totalEstimatedSavings: +totalTaxSavings.toFixed(2),
      ytdRealizedGains: ytdGains?.totalGain || 0,
      netTaxPosition: +((ytdGains?.totalGain || 0) + totalHarvestable).toFixed(2),
      opportunityCount: opportunities.length,
    },
    ytdGains,
  };
}

// ─── Year-to-Date Tax Summary ───────────────────────────────────────────────
function getYTDTaxSummary() {
  const yearStart = new Date().getFullYear() + '-01-01';
  const lots = db().prepare(`
    SELECT * FROM tax_lots WHERE disposed_date >= ? AND remaining_shares = 0
  `).all(yearStart);

  let shortTermGain = 0, longTermGain = 0, totalGain = 0;
  let shortTermCount = 0, longTermCount = 0;
  let washSaleAdjustments = 0;

  for (const lot of lots) {
    const gain = lot.realized_gain || 0;
    totalGain += gain;
    if (lot.holding_period === 'long_term') {
      longTermGain += gain;
      longTermCount++;
    } else {
      shortTermGain += gain;
      shortTermCount++;
    }
    washSaleAdjustments += lot.wash_sale_adjustment || 0;
  }

  const config = getTaxConfig();
  const shortTermTax = Math.max(0, shortTermGain) *
    (config.shortTermRate + config.netInvestmentIncome + config.stateRate);
  const longTermTax = Math.max(0, longTermGain) *
    (config.longTermRate + config.netInvestmentIncome + config.stateRate);

  // $3,000 annual loss deduction limit
  const netLoss = Math.min(0, totalGain);
  const deductibleLoss = Math.max(-3000, netLoss);
  const carryforwardLoss = netLoss - deductibleLoss;

  return {
    year: new Date().getFullYear(),
    shortTermGain: +shortTermGain.toFixed(2),
    longTermGain: +longTermGain.toFixed(2),
    totalGain: +totalGain.toFixed(2),
    shortTermTrades: shortTermCount,
    longTermTrades: longTermCount,
    estimatedTax: +Math.max(0, shortTermTax + longTermTax).toFixed(2),
    afterTaxGain: +(totalGain - Math.max(0, shortTermTax + longTermTax)).toFixed(2),
    effectiveTaxRate: totalGain > 0
      ? +(((shortTermTax + longTermTax) / totalGain) * 100).toFixed(1)
      : 0,
    washSaleAdjustments: +washSaleAdjustments.toFixed(2),
    lossDeduction: +deductibleLoss.toFixed(2),
    lossCarryforward: +carryforwardLoss.toFixed(2),
    taxRates: config,
  };
}

// ─── After-Tax Performance ──────────────────────────────────────────────────
// Compare pre-tax and after-tax returns to see the true cost of short holding periods.

function afterTaxPerformance(startDate, endDate) {
  const config = getTaxConfig();

  const trades = db().prepare(`
    SELECT * FROM trades WHERE exit_date >= ? AND exit_date <= ? AND exit_date IS NOT NULL
    ORDER BY exit_date
  `).all(startDate, endDate);

  let preTaxPnl = 0, afterTaxPnl = 0;
  let shortTermPnl = 0, longTermPnl = 0;
  const monthly = {};

  for (const trade of trades) {
    const pnl = trade.pnl_dollars || 0;
    preTaxPnl += pnl;

    // Determine holding period from entry/exit dates
    const entryMs = new Date(trade.entry_date).getTime();
    const exitMs = new Date(trade.exit_date).getTime();
    const holdingDays = Math.round((exitMs - entryMs) / (1000 * 60 * 60 * 24));
    const isLongTerm = holdingDays > 365;

    const taxRate = isLongTerm
      ? config.longTermRate + config.stateRate
      : config.shortTermRate + config.stateRate;

    const tax = pnl > 0 ? pnl * taxRate : 0; // only positive gains are taxed
    const afterTax = pnl - tax;
    afterTaxPnl += afterTax;

    if (isLongTerm) longTermPnl += pnl;
    else shortTermPnl += pnl;

    // Monthly aggregation
    const month = trade.exit_date.substring(0, 7);
    if (!monthly[month]) monthly[month] = { preTax: 0, afterTax: 0, count: 0 };
    monthly[month].preTax += pnl;
    monthly[month].afterTax += afterTax;
    monthly[month].count++;
  }

  const taxDrag = preTaxPnl > 0 ? +((preTaxPnl - afterTaxPnl) / preTaxPnl * 100).toFixed(1) : 0;

  return {
    period: { start: startDate, end: endDate },
    tradeCount: trades.length,
    preTaxPnl: +preTaxPnl.toFixed(2),
    afterTaxPnl: +afterTaxPnl.toFixed(2),
    taxPaid: +(preTaxPnl - afterTaxPnl).toFixed(2),
    taxDragPct: taxDrag,
    shortTermPnl: +shortTermPnl.toFixed(2),
    longTermPnl: +longTermPnl.toFixed(2),
    avgHoldingDays: trades.length > 0
      ? +(trades.reduce((s, t) => {
          const days = Math.round((new Date(t.exit_date) - new Date(t.entry_date)) / 86400000);
          return s + days;
        }, 0) / trades.length).toFixed(0)
      : 0,
    monthly: Object.entries(monthly).map(([month, data]) => ({
      month, ...data,
      preTax: +data.preTax.toFixed(2),
      afterTax: +data.afterTax.toFixed(2),
    })),
    insight: taxDrag > 30
      ? 'Tax drag >30% — consider longer holding periods to qualify for long-term rates'
      : taxDrag > 15
        ? 'Moderate tax drag — some gains taxed at short-term rates'
        : 'Tax-efficient — most gains at favorable rates',
  };
}

module.exports = {
  getTaxConfig,
  updateTaxConfig,
  createTaxLot,
  sellTaxLots,
  checkWashSale,
  scanTaxLossHarvesting,
  getYTDTaxSummary,
  afterTaxPerformance,
};
