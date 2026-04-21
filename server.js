// ─── Alpha Hunter v7 — Professional Trading Platform ─────────────────────────
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');

const { FULL_UNIVERSE, SECTOR_ETFS: UNI_SECTOR_ETFS, INDUSTRY_ETFS, INDUSTRY_STOCKS } = require('./universe');
const { authRoutes, authGuard, cookieParser, isEnabled: authEnabled } = require('./src/auth');

// ─── Initialize ──────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser);

// ─── Authentication ─────────────────────────────────────────────────────────
// PIN auth routes must be registered before the guard
app.use('/api', authRoutes());
// Login page must be served without auth
app.get('/login.html', (_, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
// Guard all other routes (skips if APP_PIN not set in .env)
app.use(authGuard);

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
const tradeSetupsRoutes   = require('./src/routes/tradeSetups')(runScan, anthropic, SECTOR_ETFS);
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
const telemetryRoutes     = require('./src/routes/telemetry');
const pyramidPlansRoutes  = require('./src/routes/pyramidPlans')(runScan);

app.use('/api', scanRoutes);
app.use('/api', sectorRoutes);
app.use('/api', macroRoutes);
app.use('/api', tradeSetupsRoutes);
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
app.use('/api', telemetryRoutes);
app.use('/api', pyramidPlansRoutes);

// ─── SPA fallback ────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Broker Monitor ─────────────────────────────────────────────────────────
const { startStopMonitor } = require('./src/broker/monitor');
const alpacaConfig = require('./src/broker/alpaca').getConfig();

// ─── Job Scheduler (Tier 5) ─────────────────────────────────────────────────
const { startScheduler }                = require('./src/scheduler/engine');
const { setRunScan, setSectorEtfs, seedDefaultJobs } = require('./src/scheduler/jobs');

// ─── TLS — optional HTTPS listener ──────────────────────────────────────────
// Runs in parallel with the plain HTTP listener so the app is reachable on
// both protocols. We look for mkcert-generated certs in ./certs/ first, then
// fall back to the repo root (legacy location). Absence is silent — HTTP
// still serves normally, so CI and preview tools keep working.
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const certCandidates = [
  { cert: path.join(__dirname, 'certs', 'localhost.pem'),     key: path.join(__dirname, 'certs', 'localhost-key.pem') },
  { cert: path.join(__dirname, 'localhost.pem'),              key: path.join(__dirname, 'localhost-key.pem') },
];
let httpsServer = null;
for (const { cert, key } of certCandidates) {
  if (fs.existsSync(cert) && fs.existsSync(key)) {
    try {
      httpsServer = https.createServer({
        cert: fs.readFileSync(cert),
        key:  fs.readFileSync(key),
      }, app);
      break;
    } catch (e) {
      console.warn(`   TLS: cert load failed (${cert}) — ${e.message}`);
    }
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const counts = Object.entries(SECTOR_MAP).reduce((a,[,s])=>{a[s]=(a[s]||0)+1;return a},{});
  // Check provider availability
  const { getProviderHealth } = require('./src/data/providers/manager');
  const providerStatus = getProviderHealth();
  const availableProviders = providerStatus.filter(p => p.configured).map(p => p.name);

  console.log(`\n🎯 Alpha Hunter v8  →  http://localhost:${PORT}`);
  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, () => {
      console.log(`                     →  https://localhost:${HTTPS_PORT} (mkcert)`);
    });
  } else {
    console.log(`   TLS: no certs found — HTTPS disabled (run mkcert to enable)`);
  }
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
  console.log(`   Edge Telemetry: signal_outcomes logger + nightly closer + calibration`);
  console.log(`   Auth: ${authEnabled() ? '✓ PIN protected' : '⚠ No PIN set (open access)'}`);
  console.log(`   Claude: ${anthropic?'✓ sonnet-4-6 / haiku-4-5':'⚠ Set ANTHROPIC_API_KEY'}`);
  console.log(`   Broker: ${alpacaConfig.configured ? '✓ Alpaca' + (alpacaConfig.base.includes('paper') ? ' (paper)' : ' (LIVE)') : '⚠ Set ALPACA_API_KEY'}`);
  console.log(`   Sectors: ${JSON.stringify(counts)}\n`);

  // Start stop monitor (works with or without Alpaca — uses Yahoo for prices)
  startStopMonitor();

  // Start job scheduler (Tier 5)
  setRunScan(runScan);
  setSectorEtfs(SECTOR_ETFS);
  // Seed default cron jobs on first boot — idempotent, skips anything
  // already present in scheduled_jobs. Must run BEFORE startScheduler so
  // the newly-inserted rows get picked up and scheduled in one pass.
  try {
    seedDefaultJobs();
  } catch (e) {
    console.error(`   Scheduler seed failed: ${e.message}`);
  }
  startScheduler();
});
