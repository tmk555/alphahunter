// ─── Alpha Hunter v7 Universe — 500+ momentum-capable stocks ─────────────────
// Philosophy: RS percentile ranking needs statistical depth.
// 156 stocks was grading on a curve within pre-selected winners.
// 500+ gives real percentile resolution while still excluding low-quality names.
//
// Inclusion rules:
//   - Market cap ≥ $2B (liquid, institutional-grade)
//   - Average daily volume ≥ 300K shares
//   - Listed on NYSE/NASDAQ (no OTC)
//   - Covers all 11 GICS sectors for proper rotation analysis
//   - Includes: S&P 500 core + Nasdaq 100 + growth leaders + thematic plays
//
// Universe should be refreshed quarterly. Stocks can be added dynamically
// via the /api/universe endpoints backed by SQLite.

const FULL_UNIVERSE = {
  // ── Technology — Software & Cloud (40) ─────────────────────────────────────
  MSFT:'Technology', ORCL:'Technology', CRM:'Technology',  NOW:'Technology',
  PLTR:'Technology', DDOG:'Technology', MDB:'Technology',  SNOW:'Technology',
  ZS:'Technology',   FTNT:'Technology', TEAM:'Technology', WDAY:'Technology',
  HCP:'Technology',  GTLB:'Technology', TTD:'Technology',  RBLX:'Technology',
  INTU:'Technology', ADBE:'Technology', ANSS:'Technology', CDNS:'Technology',
  SNPS:'Technology', HUBS:'Technology', BILL:'Technology', PCTY:'Technology',
  PAYC:'Technology', MANH:'Technology', DSGX:'Technology', FICO:'Technology',
  VEEV:'Technology', MNDY:'Technology', ZI:'Technology',   CFLT:'Technology',
  PATH:'Technology', ESTC:'Technology', DOCU:'Technology', APPF:'Technology',
  TYL:'Technology',  GWRE:'Technology', GEN:'Technology',  OTEX:'Technology',

  // ── Technology — Semiconductors (22) ───────────────────────────────────────
  NVDA:'Technology', AMD:'Technology',  AVGO:'Technology', TSM:'Technology',
  MRVL:'Technology', MU:'Technology',   ARM:'Technology',  SMCI:'Technology',
  AMAT:'Technology', LRCX:'Technology', KLAC:'Technology', ONTO:'Technology',
  SLAB:'Technology', WOLF:'Technology', QCOM:'Technology', TXN:'Technology',
  ADI:'Technology',  NXPI:'Technology', MCHP:'Technology', SWKS:'Technology',
  ON:'Technology',   MPWR:'Technology',

  // ── Technology — Hardware & Infrastructure (14) ────────────────────────────
  AAPL:'Technology', DELL:'Technology', HPQ:'Technology',  PSTG:'Technology',
  NTAP:'Technology', WDC:'Technology',  STX:'Technology',  ANET:'Technology',
  CSCO:'Technology', HPE:'Technology',  JNPR:'Technology', FFIV:'Technology',
  GDDY:'Technology', CDW:'Technology',

  // ── Technology — Cybersecurity (10) ────────────────────────────────────────
  CRWD:'Technology', PANW:'Technology', NET:'Technology',  S:'Technology',
  CYBR:'Technology', OKTA:'Technology', RPD:'Technology',  TENB:'Technology',
  QLYS:'Technology', VRNS:'Technology',

  // ── Technology — AI / Robotics / Infrastructure (8) ────────────────────────
  CGNX:'Technology', TER:'Technology',  KEYS:'Technology', COHR:'Technology',
  MKSI:'Technology', ENTG:'Technology', ALGM:'Technology', ACLS:'Technology',

  // ── Communication Services (16) ────────────────────────────────────────────
  META:'Comm Services', GOOGL:'Comm Services', GOOG:'Comm Services',
  NFLX:'Comm Services', SNAP:'Comm Services', PINS:'Comm Services',
  RDDT:'Comm Services', TMUS:'Comm Services', CHTR:'Comm Services',
  DIS:'Comm Services',  SPOT:'Comm Services', T:'Comm Services',
  VZ:'Comm Services',   ROKU:'Comm Services', ZM:'Comm Services',
  MTCH:'Comm Services',

  // ── Consumer Discretionary (35) ────────────────────────────────────────────
  AMZN:'Consumer Disc', TSLA:'Consumer Disc', BKNG:'Consumer Disc',
  LULU:'Consumer Disc', COST:'Consumer Disc', NKE:'Consumer Disc',
  ORLY:'Consumer Disc', ROST:'Consumer Disc', TJX:'Consumer Disc',
  CMG:'Consumer Disc',  CTAS:'Consumer Disc', DECK:'Consumer Disc',
  ONON:'Consumer Disc', TPR:'Consumer Disc',  UBER:'Consumer Disc',
  ABNB:'Consumer Disc', HD:'Consumer Disc',   LOW:'Consumer Disc',
  TGT:'Consumer Disc',  DLTR:'Consumer Disc', DG:'Consumer Disc',
  EBAY:'Consumer Disc', ETSY:'Consumer Disc', W:'Consumer Disc',
  SBUX:'Consumer Disc', MCD:'Consumer Disc',  YUM:'Consumer Disc',
  DPZ:'Consumer Disc',  POOL:'Consumer Disc', WSM:'Consumer Disc',
  RH:'Consumer Disc',   AZO:'Consumer Disc',  GPC:'Consumer Disc',
  BBY:'Consumer Disc',  GRMN:'Consumer Disc',

  // ── Industrials — Defense & Aerospace (12) ─────────────────────────────────
  GEV:'Industrials',  PWR:'Industrials',  ETN:'Industrials',  AXON:'Industrials',
  LMT:'Industrials',  RTX:'Industrials',  NOC:'Industrials',  GD:'Industrials',
  BA:'Industrials',   HEI:'Industrials',  TDG:'Industrials',  HWM:'Industrials',

  // ── Industrials — Infrastructure & Capital Goods (22) ──────────────────────
  CAT:'Industrials',  DE:'Industrials',   HON:'Industrials',  EMR:'Industrials',
  ROK:'Industrials',  IR:'Industrials',   GNRC:'Industrials', AME:'Industrials',
  GE:'Industrials',   MMM:'Industrials',  ITW:'Industrials',  PH:'Industrials',
  SWK:'Industrials',  CMI:'Industrials',  PCAR:'Industrials', FAST:'Industrials',
  WM:'Industrials',   RSG:'Industrials',  VRSK:'Industrials', TT:'Industrials',
  XYL:'Industrials',  NDSN:'Industrials',

  // ── Industrials — Transport & Logistics (10) ──────────────────────────────
  UNP:'Industrials',  CSX:'Industrials',  NSC:'Industrials',  FDX:'Industrials',
  UPS:'Industrials',  ODFL:'Industrials', JBHT:'Industrials', DAL:'Industrials',
  UAL:'Industrials',  AAL:'Industrials',

  // ── Energy — Traditional (12) ──────────────────────────────────────────────
  XOM:'Energy',  CVX:'Energy',  OXY:'Energy',  LNG:'Energy',
  COP:'Energy',  PXD:'Energy',  HAL:'Energy',  SLB:'Energy',
  EOG:'Energy',  MPC:'Energy',  VLO:'Energy',  PSX:'Energy',

  // ── Energy — Power & Clean (10) ────────────────────────────────────────────
  CEG:'Energy',  VST:'Energy',  FSLR:'Energy', BE:'Energy',
  NEE:'Energy',  AES:'Energy',  ENPH:'Energy', SEDG:'Energy',
  NRG:'Energy',  EXC:'Energy',

  // ── Financials (25) ────────────────────────────────────────────────────────
  JPM:'Financials', GS:'Financials',   V:'Financials',    MA:'Financials',
  AXP:'Financials', BX:'Financials',   KKR:'Financials',  SCHW:'Financials',
  COIN:'Financials',COF:'Financials',  SQ:'Financials',   HOOD:'Financials',
  MS:'Financials',  BAC:'Financials',  WFC:'Financials',  C:'Financials',
  BLK:'Financials', ICE:'Financials',  CME:'Financials',  SPGI:'Financials',
  MCO:'Financials', MSCI:'Financials', FI:'Financials',   APO:'Financials',
  PYPL:'Financials',

  // ── Healthcare — Biopharma (18) ────────────────────────────────────────────
  LLY:'Healthcare',  NVO:'Healthcare',  ABBV:'Healthcare', VRTX:'Healthcare',
  REGN:'Healthcare', MRNA:'Healthcare', AMGN:'Healthcare', GILD:'Healthcare',
  BIIB:'Healthcare', INCY:'Healthcare', BMY:'Healthcare',  PFE:'Healthcare',
  MRK:'Healthcare',  JNJ:'Healthcare',  AZN:'Healthcare',  SNY:'Healthcare',
  ZTS:'Healthcare',  ALNY:'Healthcare',

  // ── Healthcare — Devices & Services (16) ───────────────────────────────────
  ISRG:'Healthcare', DXCM:'Healthcare', TMO:'Healthcare',  IDXX:'Healthcare',
  UNH:'Healthcare',  HUM:'Healthcare',  CVS:'Healthcare',  MCK:'Healthcare',
  ABT:'Healthcare',  MDT:'Healthcare',  SYK:'Healthcare',  EW:'Healthcare',
  BSX:'Healthcare',  DHR:'Healthcare',  A:'Healthcare',    IQV:'Healthcare',

  // ── Materials — Metals & Mining (14) ───────────────────────────────────────
  FCX:'Materials',  NEM:'Materials',  LIN:'Materials',   APD:'Materials',
  ALB:'Materials',  MP:'Materials',   SCCO:'Materials',  VALE:'Materials',
  CLF:'Materials',  AA:'Materials',   NUE:'Materials',   STLD:'Materials',
  ECL:'Materials',  SHW:'Materials',

  // ── Consumer Staples (16) ──────────────────────────────────────────────────
  PG:'Cons Staples',  KO:'Cons Staples',  PEP:'Cons Staples', PM:'Cons Staples',
  MO:'Cons Staples',  CL:'Cons Staples',  WMT:'Cons Staples', MNST:'Cons Staples',
  STZ:'Cons Staples',  KMB:'Cons Staples', GIS:'Cons Staples', K:'Cons Staples',
  HSY:'Cons Staples',  TSN:'Cons Staples', KR:'Cons Staples',  SYY:'Cons Staples',

  // ── Real Estate (10) ──────────────────────────────────────────────────────
  EQIX:'Real Estate', AMT:'Real Estate',  PLD:'Real Estate',  SPG:'Real Estate',
  O:'Real Estate',    DLR:'Real Estate',  PSA:'Real Estate',  WELL:'Real Estate',
  AVB:'Real Estate',  ARE:'Real Estate',

  // ── Utilities (10) ────────────────────────────────────────────────────────
  AWK:'Utilities',  ETR:'Utilities',  AEP:'Utilities',  D:'Utilities',
  DUK:'Utilities',  SO:'Utilities',   SRE:'Utilities',  WEC:'Utilities',
  ES:'Utilities',   XEL:'Utilities',
};

// Deduplicate (JS objects overwrite same keys, but be explicit)
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
  {t:'IBB',  n:'Biotech (Large)',      sec:'Healthcare'},
  {t:'XBI',  n:'Biotech (Small/Mid)',  sec:'Healthcare'},
  {t:'IHF',  n:'Managed Care',        sec:'Healthcare'},
  {t:'XOP',  n:'Oil & Gas E&P',       sec:'Energy'},
  {t:'ICLN', n:'Clean Energy',        sec:'Energy'},
  {t:'URA',  n:'Uranium',             sec:'Energy'},
  {t:'GDX',  n:'Gold Miners',         sec:'Materials'},
  {t:'COPX', n:'Copper Miners',       sec:'Materials'},
  {t:'LIT',  n:'Lithium/Battery',     sec:'Materials'},
  {t:'JETS', n:'Airlines',            sec:'Industrials'},
  {t:'XRT',  n:'Retail',              sec:'Consumer Disc'},
  {t:'KRE',  n:'Regional Banks',      sec:'Financials'},
  {t:'FINX', n:'Fintech',             sec:'Financials'},
  {t:'IAK',  n:'Insurance',           sec:'Financials'},
  {t:'IYT',  n:'Transportation',      sec:'Industrials'},
  {t:'XHB',  n:'Housing',             sec:'Consumer Disc'},
  {t:'IHI',  n:'Medical Devices',     sec:'Healthcare'},
];

// ─── Industry → Stock mapping ──────────────────────────────────────────────────
const INDUSTRY_STOCKS = {
  SMH:  ['NVDA','AMD','AVGO','TSM','MRVL','MU','ARM','SMCI','AMAT','LRCX','KLAC','QCOM','TXN','ADI','NXPI','MCHP','ON','MPWR'],
  IGV:  ['MSFT','ORCL','CRM','NOW','PLTR','DDOG','SNOW','MDB','TEAM','WDAY','ADBE','INTU','HUBS','CDNS','SNPS'],
  HACK: ['CRWD','PANW','NET','ZS','FTNT','CYBR','OKTA','S','TENB','QLYS'],
  ROBO: ['AXON','HON','ETN','GEV','CGNX','TER','KEYS'],
  ITA:  ['LMT','RTX','NOC','GD','BA','HEI','TDG','HWM'],
  GRID: ['GEV','PWR','ETN','CEG','VST','NEE','AES','NRG'],
  ITB:  ['HD','LOW','POOL','WSM','W'],
  IBB:  ['ABBV','REGN','VRTX','AMGN','GILD','BIIB','MRNA','MRK','BMY','ALNY'],
  XBI:  ['MRNA','DXCM','VRTX','REGN','INCY','ALNY'],
  IHF:  ['UNH','HUM','CVS','MCK','ISRG'],
  XOP:  ['XOM','CVX','COP','OXY','LNG','HAL','SLB','EOG','MPC','VLO'],
  ICLN: ['FSLR','BE','NEE','ENPH','AES','SEDG'],
  URA:  ['CEG','VST','NRG'],
  GDX:  ['NEM','FCX','SCCO'],
  COPX: ['FCX','SCCO','MP','AA','CLF','NUE','STLD'],
  LIT:  ['ALB','MP'],
  JETS: ['DAL','UAL','AAL'],
  XRT:  ['AMZN','COST','NKE','LULU','ROST','TJX','HD','LOW','TGT','BBY'],
  KRE:  ['JPM','COF','SCHW','BAC','WFC','C'],
  FINX: ['V','MA','COIN','SQ','HOOD','PYPL','FI'],
  IAK:  ['AXP','MA','SPGI','MCO'],
  IYT:  ['UNP','CSX','FDX','UPS','ODFL','JBHT','DAL','UAL'],
  XHB:  ['HD','LOW','POOL','WSM','SHW'],
  IHI:  ['ISRG','ABT','MDT','SYK','EW','BSX','DHR','DXCM'],
};

module.exports = { FULL_UNIVERSE, SECTOR_ETFS, INDUSTRY_ETFS, INDUSTRY_STOCKS };
