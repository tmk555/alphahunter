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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Universe ────────────────────────────────────────────────────────────────
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

// ─── Scanner (needs universe context) ────────────────────────────────────────
const { runRSScan } = require('./src/scanner');
const runScan = () => runRSScan(UNIVERSE, SECTOR_MAP);

// ─── Routes ──────────────────────────────────────────────────────────────────
const scanRoutes          = require('./src/routes/scan')(UNIVERSE, SECTOR_MAP);
const sectorRoutes        = require('./src/routes/sectors')(SECTOR_ETFS, INDUSTRY_ETFS, INDUSTRY_STOCKS, UNIVERSE, SECTOR_MAP);
const macroRoutes         = require('./src/routes/macro');
const swinglabRoutes      = require('./src/routes/swinglab')(runScan, anthropic);
const watchlistRoutes     = require('./src/routes/watchlist');
const picksRoutes         = require('./src/routes/picks')(runScan);
const fundamentalsRoutes  = require('./src/routes/fundamentals');
const claudeRoutes        = require('./src/routes/claude')(anthropic);
const historyRoutes       = require('./src/routes/history');
const healthRoutes        = require('./src/routes/health')(UNIVERSE, SECTOR_MAP, anthropic);
const portfolioRoutes     = require('./src/routes/portfolio')(db);

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

// ─── SPA fallback ────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const counts = Object.entries(SECTOR_MAP).reduce((a,[,s])=>{a[s]=(a[s]||0)+1;return a},{});
  console.log(`\n🎯 Alpha Hunter v7  →  http://localhost:${PORT}`);
  console.log(`   Universe: ${UNIVERSE.length} stocks`);
  console.log(`   RS model: REAL IBD (12-month daily closes)`);
  console.log(`   Database: SQLite (WAL mode)`);
  console.log(`   Risk Engine: Position sizing + Portfolio heat + Drawdown circuit breaker`);
  console.log(`   Market Cycle: O'Neil distribution days + FTD detection`);
  console.log(`   Claude: ${anthropic?'✓ sonnet-4-6 / haiku-4-5':'⚠ Set ANTHROPIC_API_KEY'}`);
  console.log(`   Sectors: ${JSON.stringify(counts)}\n`);
});
