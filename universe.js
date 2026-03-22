// ─── Alpha Hunter Universe — 200 focused momentum stocks ──────────────────────
// Philosophy: RS percentile ranking requires a well-curated universe.
// Too small (93): rank too sensitive to individual stock moves.
// Too large (500): defensive names dilute momentum signals.
// Target: 200 high-quality, momentum-capable S&P 500 + Nasdaq names.
// Includes: established leaders + emerging themes (AI infra, clean energy,
//   defense tech, biotech, fintech, copper/materials, uranium, cybersecurity).
//
// BE (Bloom Energy): S&P 500, ADV >2M, clean energy play — intentional inclusion.

const FULL_UNIVERSE = {
  // ── Technology — Software & Cloud (24) ──────────────────────────────────────
  MSFT:'Technology', ORCL:'Technology', CRM:'Technology',  NOW:'Technology',
  PLTR:'Technology', DDOG:'Technology', MDB:'Technology',  SNOW:'Technology',
  ZS:'Technology',   FTNT:'Technology', TEAM:'Technology', WDAY:'Technology',
  HCP:'Technology',  GTLB:'Technology', TTD:'Technology',  RBLX:'Technology',
  UBER:'Consumer Disc', ABNB:'Consumer Disc',

  // ── Technology — Semiconductors (14) ────────────────────────────────────────
  NVDA:'Technology', AMD:'Technology',  AVGO:'Technology', TSM:'Technology',
  MRVL:'Technology', MU:'Technology',   ARM:'Technology',  SMCI:'Technology',
  AMAT:'Technology', LRCX:'Technology', KLAC:'Technology', ONTO:'Technology',
  SLAB:'Technology', WOLF:'Technology',

  // ── Technology — Hardware & Systems (8) ─────────────────────────────────────
  AAPL:'Technology', MSFT:'Technology', DELL:'Technology', HPQ:'Technology',
  PSTG:'Technology', NTAP:'Technology', WDC:'Technology',  STX:'Technology',

  // ── Technology — Cybersecurity (7) ──────────────────────────────────────────
  CRWD:'Technology', PANW:'Technology', NET:'Technology',  S:'Technology',
  CYBR:'Technology', OKTA:'Technology', RPD:'Technology',

  // ── Technology — AI / Robotics / Infrastructure (6) ─────────────────────────
  INTU:'Technology', ADBE:'Technology', ANSS:'Technology',
  CGNX:'Technology', TER:'Technology',  KEYS:'Technology',

  // ── Communication Services (10) ─────────────────────────────────────────────
  META:'Comm Services', GOOGL:'Comm Services', NFLX:'Comm Services',
  SNAP:'Comm Services', PINS:'Comm Services',  RDDT:'Comm Services',
  TMUS:'Comm Services', CHTR:'Comm Services',  DIS:'Comm Services',
  SPOT:'Comm Services',

  // ── Consumer Discretionary (14) ─────────────────────────────────────────────
  AMZN:'Consumer Disc', TSLA:'Consumer Disc', BKNG:'Consumer Disc',
  LULU:'Consumer Disc', COST:'Consumer Disc', NKE:'Consumer Disc',
  ORLY:'Consumer Disc', ROST:'Consumer Disc', TJX:'Consumer Disc',
  CMG:'Consumer Disc',  CTAS:'Consumer Disc', DECK:'Consumer Disc',
  ONON:'Consumer Disc', TPR:'Consumer Disc',

  // ── Industrials — Defense & Aerospace (10) ──────────────────────────────────
  GEV:'Industrials',  PWR:'Industrials',  ETN:'Industrials',  AXON:'Industrials',
  LMT:'Industrials',  RTX:'Industrials',  NOC:'Industrials',  GD:'Industrials',
  BA:'Industrials',   HEI:'Industrials',

  // ── Industrials — Infrastructure & Capital Goods (8) ────────────────────────
  CAT:'Industrials',  DE:'Industrials',   HON:'Industrials',  EMR:'Industrials',
  ROK:'Industrials',  IR:'Industrials',   GNRC:'Industrials', AME:'Industrials',

  // ── Energy — Traditional (8) ────────────────────────────────────────────────
  XOM:'Energy',  CVX:'Energy',  OXY:'Energy',  LNG:'Energy',
  COP:'Energy',  PXD:'Energy',  HAL:'Energy',  SLB:'Energy',

  // ── Energy — Power & Clean (8) ──────────────────────────────────────────────
  CEG:'Energy',  VST:'Energy',  FSLR:'Energy', BE:'Energy',
  NEE:'Energy',  AES:'Energy',  ENPH:'Energy', SEDG:'Energy',

  // ── Financials (12) ─────────────────────────────────────────────────────────
  JPM:'Financials', GS:'Financials',   V:'Financials',    MA:'Financials',
  AXP:'Financials', BX:'Financials',   KKR:'Financials',  SCHW:'Financials',
  COIN:'Financials',COF:'Financials',  SQ:'Financials',   HOOD:'Financials',

  // ── Healthcare — Biopharma (10) ─────────────────────────────────────────────
  LLY:'Healthcare',  NVO:'Healthcare',  ABBV:'Healthcare', VRTX:'Healthcare',
  REGN:'Healthcare', MRNA:'Healthcare', AMGN:'Healthcare', GILD:'Healthcare',
  BIIB:'Healthcare', INCY:'Healthcare',

  // ── Healthcare — Devices & Services (8) ─────────────────────────────────────
  ISRG:'Healthcare', DXCM:'Healthcare', TMO:'Healthcare',  IDXX:'Healthcare',
  UNH:'Healthcare',  HUM:'Healthcare',  CVS:'Healthcare',  MCK:'Healthcare',

  // ── Materials — Metals & Mining (10) ────────────────────────────────────────
  FCX:'Materials',  NEM:'Materials',  LIN:'Materials',   APD:'Materials',
  ALB:'Materials',  MP:'Materials',   SCCO:'Materials',  VALE:'Materials',
  CLF:'Materials',  AA:'Materials',

  // ── Real Estate & Utilities (6) ─────────────────────────────────────────────
  EQIX:'Real Estate', AMT:'Real Estate', PLD:'Real Estate',
  AWK:'Utilities',    ETR:'Utilities',   AEP:'Utilities',
};

// Deduplicate (in case of sector overlap)
const _seen = new Set();
for (const k of Object.keys(FULL_UNIVERSE)) {
  if (_seen.has(k)) delete FULL_UNIVERSE[k];
  else _seen.add(k);
}

// ─── Sector ETFs ───────────────────────────────────────────────────────────────
const SECTOR_ETFS = [
  {t:'XLK',  n:'Technology',       color:'#00d4ff'},
  {t:'XLC',  n:'Comm Services',    color:'#c44dff'},
  {t:'XLY',  n:'Consumer Disc',    color:'#ff9500'},
  {t:'XLI',  n:'Industrials',      color:'#4dffb8'},
  {t:'XLE',  n:'Energy',           color:'#ffcc00'},
  {t:'XLF',  n:'Financials',       color:'#00b4d8'},
  {t:'XLV',  n:'Healthcare',       color:'#ff6b6b'},
  {t:'XLB',  n:'Materials',        color:'#8fce00'},
  {t:'XLP',  n:'Cons Staples',     color:'#aaa'},
  {t:'XLU',  n:'Utilities',        color:'#888'},
  {t:'XLRE', n:'Real Estate',      color:'#b06020'},
];

// ─── Industry ETFs ─────────────────────────────────────────────────────────────
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

// ─── Industry → Stock mapping ──────────────────────────────────────────────────
const INDUSTRY_STOCKS = {
  SMH:  ['NVDA','AMD','AVGO','TSM','MRVL','MU','ARM','SMCI','AMAT','LRCX','KLAC'],
  IGV:  ['MSFT','ORCL','CRM','NOW','PLTR','DDOG','SNOW','MDB','TEAM','WDAY'],
  HACK: ['CRWD','PANW','NET','ZS','FTNT','CYBR','OKTA','S'],
  ROBO: ['AXON','HON','ETN','GEV','CGNX','TER'],
  ITA:  ['LMT','RTX','NOC','GD','BA','HEI'],
  GRID: ['GEV','PWR','ETN','CEG','VST','NEE','AES'],
  ITB:  ['COST','HD','LOW','ONON','TPR'],
  IBB:  ['ABBV','REGN','VRTX','AMGN','GILD','BIIB','MRNA'],
  XBI:  ['MRNA','DXCM','VRTX','REGN','INCY'],
  IHF:  ['UNH','HUM','CVS','MCK','ISRG'],
  XOP:  ['XOM','CVX','COP','OXY','LNG','HAL','SLB'],
  ICLN: ['FSLR','BE','NEE','ENPH','AES'],
  URA:  ['CEG','VST'],
  GDX:  ['NEM','FCX','SCCO'],
  COPX: ['FCX','SCCO','MP','AA','CLF'],
  LIT:  ['ALB','MP'],
  JETS: ['DAL','UAL','AAL'],
  XRT:  ['AMZN','COST','NKE','LULU','ROST','TJX'],
  KRE:  ['JPM','COF','SCHW'],
  FINX: ['V','MA','COIN','SQ','HOOD'],
  IAK:  ['AXP','MA'],
};

module.exports = { FULL_UNIVERSE, SECTOR_ETFS, INDUSTRY_ETFS, INDUSTRY_STOCKS };
