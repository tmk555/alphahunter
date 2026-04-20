// Smoke-test: run factor_combo over a recent year with pattern_type:cupHandle
require('dotenv').config();
const { runReplay } = require('./src/signals/replay');

(async () => {
  const t0 = Date.now();
  const res = await runReplay({
    strategy: 'factor_combo',
    startDate: '2024-01-01',
    endDate:   '2024-12-31',
    maxPositions: 10,
    initialCapital: 100000,
    params: { signals: ['rs_strong', 'pattern_type:cupHandle|ascendingBase|powerPlay|highTightFlag'], minRS: 80 },
  });
  console.log(`Elapsed: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Strategy: ${res.strategy} (${res.strategyKey})`);
  console.log(`Trading days: ${res.period?.tradingDays}`);
  console.log(`Trades summary:`, res.trades);
  console.log('Performance:', res.performance);
  const tradeLog = res.tradeLog || [];
  console.log(`Trade log length: ${tradeLog.length}`);
  if (tradeLog.length) {
    console.log('First 3 trades:');
    for (const t of tradeLog.slice(0,3)) console.log(' ', t.symbol, t.entryDate, '→', t.exitDate, `P/L ${t.pnlPct?.toFixed?.(2) ?? '-'}%`);
  }
  process.exit(0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
