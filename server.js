// ─── Alpha Hunter v7 — Professional Trading Platform ─────────────────────────
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');

const { FULL_UNIVERSE, SECTOR_ETFS: UNI_SECTOR_ETFS, INDUSTRY_ETFS, INDUSTRY_STOCKS } = require('./universe');

// ─── Initialize ──────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
// Disable caching for index.html so code changes load immediately on refresh
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// ─── Universe (file + DB: DB additions survive restarts) ─────────────────────
const SECTOR_MAP = FULL_UNIVERSE;
const UNIVERSE   = Object.keys(SECTOR_MAP);

const SECTOR_ETFS = [
  {t:'XLK',n:'Technology',color:'#00d4ff'},{t:'XLE',n:'Energy',color:'#ff8c00'},
  {t:'XLC',n:'Comm Services',color:'#c44dff'},{t:'XLI',n:'Industrials',color:'#f0a500'},
  {t:'XLF',n:'Financials',color:'#ffd700'},{t:'XLY',n:'Consumer Disc',color:'#80d8ff'},
  {t:'XLB',n:'Materials',color:'#b9f6ca'},{t:'XLV',n:'Healthcare',color:'#00e676'},
  {t:'XLP',n:'Cons Staples',color:'#b39ddb'},{t:'XLU',n:'Utilities',color:'#80cbc4'},
  {t:'XLRE',n:'Real Estate',color:'#ffab91'},
];

// ─── Database ────────────────────────────────────────────────────────────────
const { getDB, migrateFromJSON } = require('./src/data/database');
const db = getDB();
migrateFromJSON();

// Merge DB-managed universe additions (stocks added via UI)
try {
  const dbAdded = db.prepare("SELECT symbol, sector FROM universe_mgmt WHERE status = 'active'").all();
  let dbCount = 0;
  for (const { symbol, sector } of dbAdded) {
    if (!SECTOR_MAP[symbol]) {
      SECTOR_MAP[symbol] = sector;
      UNIVERSE.push(symbol);
      dbCount++;
    }
  }
  if (dbCount) console.log(`   Universe: +${dbCount} stocks from DB (total ${UNIVERSE.length})`);
} catch(_) { /* universe_mgmt table may not exist on first run */ }

// ─── Scanner (needs universe context) ────────────────────────────────────────
const { runRSScan } = require('./src/scanner');
const runScan = () => runRSScan(UNIVERSE, SECTOR_MAP);

// ─── Routes ──────────────────────────────────────────────────────────────────
const scanRoutes          = require('./src/routes/scan')(UNIVERSE, SECTOR_MAP);
const sectorRoutes        = require('./src/routes/sectors')(SECTOR_ETFS, INDUSTRY_ETFS, INDUSTRY_STOCKS, UNIVERSE, SECTOR_MAP);
const macroRoutes         = require('./src/routes/macro');
const swinglabRoutes      = require('./src/routes/swinglab')(runScan, anthropic);
const watchlistRoutes     = require('./src/routes/watchlist');
const picksRoutes         = require('./src/routes/picks')(runScan, SECTOR_ETFS);
const fundamentalsRoutes  = require('./src/routes/fundamentals');
const claudeRoutes        = require('./src/routes/claude')(anthropic);
const historyRoutes       = require('./src/routes/history');
const healthRoutes        = require('./src/routes/health')(UNIVERSE, SECTOR_MAP, anthropic);
const portfolioRoutes     = require('./src/routes/portfolio')(db);
const brokerRoutes        = require('./src/routes/broker')(db);
const stagingRoutes       = require('./src/routes/staging')(db, runScan);
const alertRoutes         = require('./src/routes/alerts')(db);
const schedulerRoutes     = require('./src/routes/scheduler');
const notificationRoutes  = require('./src/routes/notifications');
const providerRoutes      = require('./src/routes/providers');
const replayRoutes        = require('./src/routes/replay');
const hedgeRoutes         = require('./src/routes/hedge')(runScan);
const edgeRoutes          = require('./src/routes/edge')(db, runScan, UNIVERSE, SECTOR_MAP);
const revisionRoutes      = require('./src/routes/revisions')(db, runScan);
const chartRoutes         = require('./src/routes/chart')();
const optionsRoutes       = require('./src/routes/options')(db);
const strategiesRoutes    = require('./src/routes/strategies')(db);

app.use('/api', scanRoutes);
app.use('/api', sectorRoutes);
app.use('/api', macroRoutes);
app.use('/api', swinglabRoutes);
app.use('/api', watchlistRoutes);
app.use('/api', picksRoutes);
app.use('/api', fundamentalsRoutes);
app.use('/api', claudeRoutes);
app.use('/api', historyRoutes);
app.use('/api', healthRoutes);
app.use('/api', portfolioRoutes);
app.use('/api', brokerRoutes);
app.use('/api', stagingRoutes);
app.use('/api', alertRoutes);
app.use('/api', schedulerRoutes);
app.use('/api', notificationRoutes);
app.use('/api', providerRoutes);
app.use('/api', replayRoutes);
app.use('/api', hedgeRoutes);
app.use('/api', edgeRoutes);
app.use('/api', revisionRoutes);
app.use('/api', chartRoutes);
app.use('/api', optionsRoutes);
app.use('/api', strategiesRoutes);

// ─── SPA fallback ────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Broker Monitor ─────────────────────────────────────────────────────────
const { startStopMonitor } = require('./src/broker/monitor');
const alpacaConfig = require('./src/broker/alpaca').getConfig();

// ─── Job Scheduler (Tier 5) ─────────────────────────────────────────────────
const { startScheduler } = require('./src/scheduler/engine');
const { setRunScan }     = require('./src/scheduler/jobs');

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const counts = Object.entries(SECTOR_MAP).reduce((a,[,s])=>{a[s]=(a[s]||0)+1;return a},{});
  // Check provider availability
  const { getProviderHealth } = require('./src/data/providers/manager');
  const providerStatus = getProviderHealth();
  const availableProviders = providerStatus.filter(p => p.configured).map(p => p.name);

  console.log(`\n🎯 Alpha Hunter v8  →  http://localhost:${PORT}`);
  console.log(`   Universe: ${UNIVERSE.length} stocks`);
  console.log(`   RS model: REAL IBD (12-month daily closes)`);
  console.log(`   Database: SQLite (WAL mode)`);
  console.log(`   Data: ${availableProviders.join(' → ') || 'Yahoo Finance'} (cascading fallback)`);
  console.log(`   Risk Engine: Position sizing + Portfolio heat + Drawdown circuit breaker`);
  console.log(`   Market Cycle: O'Neil distribution days + FTD detection`);
  console.log(`   Notifications: Slack / Telegram / Webhook delivery channels`);
  console.log(`   Replay: Signal backtest engine (5 built-in strategies)`);
  console.log(`   Edge: Survivorship tracking + execution cost model + signal decay`);
  console.log(`   Breadth: McClellan osc + A/D + %above MA + VIX term structure`);
  console.log(`   Risk: Correlation matrix + factor decomposition + VaR + hedge framework`);
  console.log(`   Tax: Lot tracking + wash sales + after-tax returns + TLH scanner`);
  console.log(`   Quality: Decision scoring + process trend + system vs discretionary`);
  console.log(`   Charts: TradingView Lightweight Charts + signal overlays`);
  console.log(`   Patterns: Cup & Handle + Ascending Base + Power Play + High Tight Flag`);
  console.log(`   Revisions: Earnings estimate revision tracking + conviction integration`);
  console.log(`   Options: Alpaca options chain + protective puts + collars + VIX hedges`);
  console.log(`   Macro: Yield curve + credit spreads + dollar + commodities + ISM proxy`);
  console.log(`   Institutional: Unusual volume + dark pool proxy + accumulation scoring`);
  console.log(`   Strategies: Multi-strategy framework (momentum/VCP/rotation/reversion)`);
  console.log(`   Claude: ${anthropic?'✓ sonnet-4-6 / haiku-4-5':'⚠ Set ANTHROPIC_API_KEY'}`);
  console.log(`   Broker: ${alpacaConfig.configured ? '✓ Alpaca' + (alpacaConfig.base.includes('paper') ? ' (paper)' : ' (LIVE)') : '⚠ Set ALPACA_API_KEY'}`);
  console.log(`   Sectors: ${JSON.stringify(counts)}\n`);

  // Start stop monitor (works with or without Alpaca — uses Yahoo for prices)
  startStopMonitor();

  // Start job scheduler (Tier 5)
  setRunScan(runScan);
  startScheduler();
});
