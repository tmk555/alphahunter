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
// 10mb because the UI's POST /api/trade-setups/scan currently echoes the
// full RS scan payload back as `stocks` (~4-5MB on the 1620-symbol
// universe). Server-side only the ticker names matter — see the route
// comment — but until the UI is updated to send tickers only, the larger
// limit prevents PayloadTooLargeError. When the UI ships that change, this
// can drop back to 2mb (or less).
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser);

// ─── Authentication ─────────────────────────────────────────────────────────
// PIN auth routes must be registered before the guard
app.use('/api', authRoutes());
// Login page must be served without auth
app.get('/login.html', (_, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
// Guard all other routes (skips if APP_PIN not set in .env)
app.use(authGuard);

// Disable caching for index.html so code changes load immediately on refresh.
// `index: false` so express.static does NOT auto-serve public/index.html on
// '/' requests — that bypassed our SPA fallback below, which prefers the
// prebuilt index.dist.html when present. Without this, the inline-Babel
// HTML kept getting served even when a built bundle existed.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
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

// Merge DB-managed universe additions (stocks added via UI).
//
// Bug-watch: there is NO `status` column on universe_mgmt — the schema uses
// a null/non-null `removed_date` to flag active membership (see
// src/data/database.js:110). The previous `WHERE status = 'active'` query
// errored with "no such column", was swallowed by the catch, and EVERY
// DB-managed symbol silently failed to merge on startup. That caused a
// second-order bug: the scanner's post-scan syncUniverse() saw those
// DB-tracked symbols missing from the live UNIVERSE and marked them
// `auto_removed` — so any stock the user added via UI disappeared from
// the Scanner and reappeared in Discovery after the next restart.
try {
  const dbAdded = db.prepare(
    "SELECT symbol, sector FROM universe_mgmt WHERE removed_date IS NULL"
  ).all();
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

// Merge sector + industry ETFs into the main scanner universe.
//
// Pre-fix: ETFs were scanned ONLY by runETFScan (powering the Sectors tab)
// and never appeared in the main scanner. Users who wanted to see "is XLK
// strong right now alongside MKSI?" had to flip tabs. The Sectors tab
// continues to work — runETFScan still writes 'sector'/'industry' typed
// rs_snapshots rows for the dedicated sector dashboard. This addition just
// makes the same symbols ALSO available in the main RS scan ('stock' type)
// so they rank against the broader universe.
//
// Sector tag = the underlying sector the ETF tracks. SECTOR_ETFS list (XLK,
// XLF, ...) uses each ETF's `n` field directly. INDUSTRY_ETFS uses each
// ETF's `sec` (parent sector) so e.g. SMH → Technology, IGV → Technology.
// This keeps sector-filtering in the scanner correct (XLK + SMH both group
// under Technology when the user filters by that sector).
//
// assignStrategy in src/risk/strategy-manager.js detects ETFs by symbol
// match — its hardcoded list is updated to cover both sector + industry
// ETFs so any of these added here route to sector_rotation strategy.
{
  let etfCount = 0;
  for (const e of UNI_SECTOR_ETFS) {
    if (!SECTOR_MAP[e.t]) {
      SECTOR_MAP[e.t] = e.n;        // 'Technology', 'Healthcare', etc.
      UNIVERSE.push(e.t);
      etfCount++;
    }
  }
  for (const e of INDUSTRY_ETFS) {
    if (!SECTOR_MAP[e.t]) {
      SECTOR_MAP[e.t] = e.sec;      // parent sector (Technology for SMH/IGV/HACK/ROBO, etc.)
      UNIVERSE.push(e.t);
      etfCount++;
    }
  }
  if (etfCount) console.log(`   Universe: +${etfCount} ETFs (sector + industry, total ${UNIVERSE.length})`);
}

// Merge active S&P 1500 constituents (S&P 500 + 400 + 600) from
// universe_membership.
//
// Why: prior to this, breadth metrics (% above 50MA, A/D ratio, new highs,
// new lows) were computed from ~360 leadership-only names — heavily
// tech-skewed and missing entire sub-industries. User flagged this as a
// real architectural problem (2026-04-30): "breadth, regime, exposure,
// FTD should be driven by whole market, not just my universe."
//
// universe_membership is populated from:
//   • scripts/fetch-sp500-history.js  → SP500 (large caps, ~503)
//   • scripts/fetch-sp400-sp600.js    → SP400 (mid caps, 400) + SP600 (small caps, 603)
//
// Active constituents (rows with end_date IS NULL) are the ~1500 names
// currently in the indices. Sector data comes from those rows so each
// symbol gets a clean GICS sector tag from the index source.
//
// Effect: scanner universe grows from ~360 to ~1500. Daily scan time
// scales linearly — ~30s becomes ~2-3min for 1500 stocks (acceptable for
// a daily job). All downstream signals (breadth.js, regime, FTD via
// _countDistributionDays which is SPY-driven anyway, exposure ramp)
// automatically pick up the broader base from rs_snapshots without
// further code changes — the data IS the signal.
try {
  const spRows = db.prepare(`
    SELECT symbol, sector
      FROM universe_membership
     WHERE index_name IN ('SP500', 'SP400', 'SP600')
       AND end_date IS NULL
  `).all();
  let spCount = 0;
  for (const { symbol, sector } of spRows) {
    if (!SECTOR_MAP[symbol]) {
      SECTOR_MAP[symbol] = sector || 'Unknown';
      UNIVERSE.push(symbol);
      spCount++;
    }
  }
  if (spCount) console.log(`   Universe: +${spCount} S&P 1500 constituents (total ${UNIVERSE.length}) — breadth now reflects broader market`);
} catch(_) { /* universe_membership may not exist on fresh installs */ }

// Publish the assembled runtime universe via a singleton so route
// modules (replay.js) and scheduler jobs that can't receive it through
// a factory argument read the SAME 1620-symbol list as the explicit
// consumers. See src/data/runtime-universe.js for the rationale.
{
  const { setRuntimeUniverse } = require('./src/data/runtime-universe');
  setRuntimeUniverse(UNIVERSE, SECTOR_MAP);
}

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
const marketRoutes        = require('./src/routes/market');
const paperTradesRoutes   = require('./src/routes/paper-trades');

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
app.use('/api', marketRoutes);
app.use('/api', paperTradesRoutes);

// ─── SPA fallback ────────────────────────────────────────────────────────────
// Prefer the prebuilt bundle (public/index.dist.html + public/dist/app.js)
// when present — page loads without the in-browser Babel transformer (saved
// ~1-3s of cold-load time on a ~800KB file). Fall back to public/index.html
// for dev iteration where you don't want to re-run `npm run build` after
// every JSX edit. Compute once at boot, not per-request.
const _fs = require('fs');
const _DIST_HTML = path.join(__dirname, 'public', 'index.dist.html');
const _RAW_HTML  = path.join(__dirname, 'public', 'index.html');
const _ENTRY_HTML = _fs.existsSync(_DIST_HTML) ? _DIST_HTML : _RAW_HTML;
if (_ENTRY_HTML === _DIST_HTML) {
  console.log('   Serving prebuilt bundle (public/index.dist.html)');
} else {
  console.log('   Serving public/index.html (in-browser Babel — run "npm run build" for a faster load)');
}
app.get('*', (_, res) => res.sendFile(_ENTRY_HTML));

// ─── Broker Monitor ─────────────────────────────────────────────────────────
const { startStopMonitor } = require('./src/broker/monitor');
const alpacaConfig = require('./src/broker/alpaca').getConfig();

// ─── Job Scheduler (Tier 5) ─────────────────────────────────────────────────
const { startScheduler, runMissedJobsOnStartup } = require('./src/scheduler/engine');
const { setRunScan, setSectorEtfs, setIndustryEtfs, seedDefaultJobs } = require('./src/scheduler/jobs');

// ─── TLS — optional HTTPS listener ──────────────────────────────────────────
// Runs in parallel with the plain HTTP listener so the app is reachable on
// both protocols. We prefer mkcert-generated certs in ./certs/ (the canonical
// location) and fall back to the repo root for legacy installs. Absence is
// silent — HTTP still serves normally, so CI and the preview tool keep
// working.
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const certCandidates = [
  { cert: path.join(__dirname, 'certs', 'localhost.pem'), key: path.join(__dirname, 'certs', 'localhost-key.pem') },
  { cert: path.join(__dirname, 'localhost.pem'),          key: path.join(__dirname, 'localhost-key.pem') },
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
  setIndustryEtfs(INDUSTRY_ETFS);
  // Seed default cron jobs on first boot — idempotent, skips anything
  // already present in scheduled_jobs. Must run BEFORE startScheduler so
  // the newly-inserted rows get picked up and scheduled in one pass.
  try {
    seedDefaultJobs();
  } catch (e) {
    console.error(`   Scheduler seed failed: ${e.message}`);
  }
  // Restore replay jobs from disk. Pre-fix the job map was 100% in-memory,
  // so a server restart mid-sweep wiped every running job and the user got
  // a generic "Job N no longer available" 404 the next time they polled.
  // Now: completed jobs (done/error/cancelled) are restored verbatim and
  // any rows still in 'running' state get marked 'interrupted' so the UI
  // can surface them with a clear "RESTARTED — click to retry" button
  // instead of a confusing 404.
  try {
    const { loadPersistedJobs } = require('./src/signals/replay-jobs');
    const r = loadPersistedJobs();
    if (r.loaded) console.log(`   Replay jobs restored from disk: ${r.loaded} (${r.interrupted} marked 'interrupted')`);
  } catch (e) {
    console.error(`   Replay-jobs restore failed: ${e.message}`);
  }
  startScheduler();

  // Catch-up runner: walk every enabled job and fire any whose natural
  // cadence has lapsed during downtime (overnight, weekend, deploy gap).
  // Without this, weekend restarts silently skip Friday's rs_scan_daily,
  // Sunday's weekly_digest, etc. — Monday morning UI then reads stale
  // data with no visible signal.
  //
  // Fired async (not awaited) so the listen callback doesn't block on
  // potentially long-running scans. The in-flight guard inside executeJob
  // prevents same-job double-fires if a fast cron task ticks while
  // catchup is still working through the queue.
  //
  // Disable with SCHEDULER_DISABLE_CATCHUP=1 if a deploy needs to come
  // up cold without firing any jobs (e.g. troubleshooting a job that
  // crashes on every run).
  if (process.env.SCHEDULER_DISABLE_CATCHUP !== '1') {
    setImmediate(() => {
      runMissedJobsOnStartup().catch(e =>
        console.error(`   Scheduler catchup failed: ${e.message}`)
      );
    });
  } else {
    console.log('   Scheduler catchup: ⊘ disabled (SCHEDULER_DISABLE_CATCHUP=1)');
  }
});
