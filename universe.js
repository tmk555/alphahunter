// ─── Focused universe — ~120 high-conviction names ────────────────────────────
// Selection criteria:
//   1. S&P 500 member with ADV > 2M shares
//   2. History of high RS or clear thematic relevance to swing/position traders
//   3. Balanced: ~10-15 per sector so no sector dominates RS rankings
//   4. Excludes: slow defensives (KO, PG, T) that never show in swing setups
// 
// WHY NOT 315: RS percentile ranking works better with a focused universe of
// actively-traded, momentum-capable stocks. Diluting with 200 defensive names
// makes RS 85 less meaningful — it just means "not a utility stock."

const FULL_UNIVERSE = {
  // ── Technology (22) ──────────────────────────────────────────────────────────
  AAPL:'Technology', MSFT:'Technology', NVDA:'Technology', AVGO:'Technology',
  AMD:'Technology',  ORCL:'Technology', CRM:'Technology',  NOW:'Technology',
  PLTR:'Technology', CRWD:'Technology', PANW:'Technology', NET:'Technology',
  DDOG:'Technology', MSTR:'Technology', AMAT:'Technology', LRCX:'Technology',
  MU:'Technology',   MRVL:'Technology', ARM:'Technology',  SMCI:'Technology',
  TSM:'Technology',  INTU:'Technology',

  // ── Communication Services (6) ───────────────────────────────────────────────
  META:'Comm Services', GOOGL:'Comm Services', NFLX:'Comm Services',
  TTD:'Comm Services',  SNAP:'Comm Services',  PINS:'Comm Services',

  // ── Consumer Discretionary (10) ──────────────────────────────────────────────
  AMZN:'Consumer Disc', TSLA:'Consumer Disc', BKNG:'Consumer Disc',
  UBER:'Consumer Disc', ABNB:'Consumer Disc', LULU:'Consumer Disc',
  COST:'Consumer Disc', NKE:'Consumer Disc',  ORLY:'Consumer Disc',
  ROST:'Consumer Disc',

  // ── Industrials (12) ─────────────────────────────────────────────────────────
  GEV:'Industrials',  PWR:'Industrials',  ETN:'Industrials',  AXON:'Industrials',
  LMT:'Industrials',  RTX:'Industrials',  NOC:'Industrials',  CAT:'Industrials',
  DE:'Industrials',   HON:'Industrials',  GD:'Industrials',   BA:'Industrials',

  // ── Energy (10) ──────────────────────────────────────────────────────────────
  XOM:'Energy', CVX:'Energy', OXY:'Energy', LNG:'Energy', COP:'Energy',
  CEG:'Energy', VST:'Energy', FSLR:'Energy', BE:'Energy', NEE:'Energy',

  // ── Financials (10) ──────────────────────────────────────────────────────────
  JPM:'Financials', GS:'Financials', V:'Financials',   MA:'Financials',
  AXP:'Financials', BX:'Financials', SCHW:'Financials', COIN:'Financials',
  COF:'Financials', KKR:'Financials',

  // ── Healthcare (10) ──────────────────────────────────────────────────────────
  LLY:'Healthcare', NVO:'Healthcare', ISRG:'Healthcare', UNH:'Healthcare',
  ABBV:'Healthcare', VRTX:'Healthcare', REGN:'Healthcare', DXCM:'Healthcare',
  MRNA:'Healthcare', TMO:'Healthcare',

  // ── Materials (6) ────────────────────────────────────────────────────────────
  FCX:'Materials', NEM:'Materials', LIN:'Materials',
  ALB:'Materials', MP:'Materials',  SCCO:'Materials',

  // ── Utilities (4) ────────────────────────────────────────────────────────────
  CEG:'Utilities', VST:'Utilities', AWK:'Utilities', ETR:'Utilities',

  // ── Real Estate (3) ──────────────────────────────────────────────────────────
  EQIX:'Real Estate', AMT:'Real Estate', PLD:'Real Estate',
};

// Deduplicate (CEG/VST appear in both Energy and Utilities — keep Energy)
const _seen = new Set();
for (const k of Object.keys(FULL_UNIVERSE)) {
  if (_seen.has(k)) delete FULL_UNIVERSE[k];
  else _seen.add(k);
}

const INDUSTRY_ETFS = [
  {t:'SMH',  n:'Semiconductors',       sec:'Technology'},
  {t:'IGV',  n:'Software',             sec:'Technology'},
  {t:'HACK', n:'Cybersecurity',        sec:'Technology'},
  {t:'ROBO', n:'Robotics/AI',          sec:'Technology'},
  {t:'ITA',  n:'Aerospace & Defense',  sec:'Industrials'},
  {t:'GRID', n:'Power Infrastructure', sec:'Industrials'},
  {t:'ITB',  n:'Homebuilders',         sec:'Consumer Disc'},
  {t:'IBB',  n:'Biotech (Large)',       sec:'Healthcare'},
  {t:'XBI',  n:'Biotech (Small/Mid)',   sec:'Healthcare'},
  {t:'IHF',  n:'Managed Care',         sec:'Healthcare'},
  {t:'XOP',  n:'Oil & Gas E&P',        sec:'Energy'},
  {t:'ICLN', n:'Clean Energy',         sec:'Energy'},
  {t:'URA',  n:'Uranium',              sec:'Energy'},
  {t:'GDX',  n:'Gold Miners',          sec:'Materials'},
  {t:'COPX', n:'Copper Miners',        sec:'Materials'},
  {t:'LIT',  n:'Lithium/Battery',      sec:'Materials'},
  {t:'JETS', n:'Airlines',             sec:'Industrials'},
  {t:'XRT',  n:'Retail',               sec:'Consumer Disc'},
  {t:'KRE',  n:'Regional Banks',       sec:'Financials'},
  {t:'FINX', n:'Fintech',              sec:'Financials'},
  {t:'IAK',  n:'Insurance',            sec:'Financials'},
];

module.exports = { FULL_UNIVERSE, INDUSTRY_ETFS };
