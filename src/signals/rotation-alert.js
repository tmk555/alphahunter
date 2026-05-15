// ─── Rotation: Leading Edge detector + daily alerter ──────────────────────
// "Leading Edge" = industry that's rotating IN but the tilt model hasn't
// promoted to 'leading' yet. Catches rotation 1-3 weeks before the
// composite-score-based tilt flips, which is when most of the move is
// already in. Used by /api/rotation/leading-edge for the UI banner and by
// the rotation_alert daily cron for phone pushes.
//
// Criteria (all must hold):
//   • direction == 'rising' OR vs1w ≥ +5 rank pts   ← acceleration is fresh
//   • vs1m ≥ +8 rank pts                            ← 1-month gain is real
//   • vs3m ≤ 0 rank pts                             ← still early (no chase)
//   • rotation tilt == neutral / unranked           ← not already flagged
//
// The 4th constraint is what makes this "leading edge" rather than
// "leading" — by the time tilt flips to 'leading', the 1-month rotation
// has compounded into the top-25% slot and the easy money is gone.

const { getRSTrendsBulk, IND_HISTORY } = require('../data/store');
const { computeIndustryRotation } = require('./rotation');
const { runETFScan } = require('../scanner');
const { INDUSTRY_ETFS, INDUSTRY_STOCKS } = require('../../universe');
const { getDB } = require('../data/database');

function _ensureStateTable() {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS rotation_alert_state (
      etf TEXT PRIMARY KEY,
      first_seen_date TEXT NOT NULL,
      last_seen_date TEXT NOT NULL,
      last_alert_date TEXT,
      vs1m_at_alert INTEGER
    );
  `);
}

// Classify an industry's rotation status. Returns one of:
//   'leading_edge' — full strict criteria (alert-worthy, fresh, not late)
//   'watching'     — rising + 1m strong, but vs3m is already positive
//                    (rotation already matured; tradable but not "early")
//   'rising_weak'  — rising direction but 1m gain modest (<+8) — early
//                    hints; surface as context only
//   null           — neutral or falling
function _classifyTrend(t, tilt) {
  if (!t) return null;
  const isRising = t.direction === 'rising' || (t.vs1w != null && t.vs1w >= 5);
  if (!isRising) return null;
  const fresh   = (t.vs1m ?? -999) >= 8;
  const notLate = (t.vs3m ?? 999)  <= 0;
  const notPromoted = !tilt || tilt.tilt !== 'leading';
  if (fresh && notLate && notPromoted) return 'leading_edge';
  if (fresh && notPromoted)            return 'watching';
  if ((t.vs1m ?? 0) >= 3)              return 'rising_weak';
  return null;
}

// Returns Leading Edge + Watching + Rising-Weak lists. Pure compute — no
// side effects. The UI shows all three so the dashboard never goes empty
// in a no-rotation tape (which the strict criteria intentionally produce).
async function computeLeadingEdge() {
  const etfList = INDUSTRY_ETFS.map(e => e.t);
  const trends = getRSTrendsBulk(IND_HISTORY, etfList);

  // Pull the live rotation tilt model. Caller may run this on a worker
  // path with no warm cache — runETFScan singleflights so a concurrent
  // /api/industries request won't duplicate the provider sweep.
  let tiltMap = new Map();
  try {
    const industryData = await runETFScan(INDUSTRY_ETFS, IND_HISTORY, 'IND_');
    const model = computeIndustryRotation(INDUSTRY_ETFS, industryData);
    for (const i of (model?.industries || [])) tiltMap.set(i.etf, i);
  } catch (_) { /* additive — proceed without tilt if scan fails */ }

  const leadingEdge = [];
  const watching    = [];
  const risingWeak  = [];

  for (const def of INDUSTRY_ETFS) {
    const t = trends.get(def.t);
    if (!t) continue;
    const tilt = tiltMap.get(def.t);
    const cls = _classifyTrend(t, tilt);
    if (!cls) continue;
    const row = {
      etf:        def.t,
      name:       def.n,
      sector:     def.sec,
      current:    t.current,
      direction:  t.direction,
      vs1w:       t.vs1w,
      vs1m:       t.vs1m,
      vs3m:       t.vs3m,
      tiltStatus: tilt?.tilt || 'unranked',
      tiltRank:   tilt?.rank || null,
      constituents: (INDUSTRY_STOCKS[def.t] || []).length,
      classification: cls,
    };
    if      (cls === 'leading_edge') leadingEdge.push(row);
    else if (cls === 'watching')     watching.push(row);
    else                             risingWeak.push(row);
  }
  const byMomentum = (a, b) => (b.vs1m ?? 0) - (a.vs1m ?? 0);
  leadingEdge.sort(byMomentum);
  watching.sort(byMomentum);
  risingWeak.sort(byMomentum);
  return { leadingEdge, watching, risingWeak };
}

// Helper: top-N RS-leader stocks in an industry bucket (RS ≥ floor).
function _topPicksForIndustry(etf, floor = 70, limit = 5) {
  const stocks = INDUSTRY_STOCKS[etf] || [];
  if (!stocks.length) return [];
  const db = getDB();
  const placeholders = stocks.map(() => '?').join(',');
  return db.prepare(`
    SELECT symbol, rs_rank FROM rs_snapshots
    WHERE type = 'stock'
      AND date = (SELECT MAX(date) FROM rs_snapshots WHERE type = 'stock')
      AND symbol IN (${placeholders})
      AND rs_rank >= ?
    ORDER BY rs_rank DESC
    LIMIT ?
  `).all(...stocks, floor, limit).map(r => ({ symbol: r.symbol, rsRank: r.rs_rank }));
}

// Daily alerter — idempotent. Inserts a row into `alerts` and dispatches
// to enabled notification channels the FIRST time an industry enters
// Leading Edge state, and re-alerts only if vs1m has grown ≥5 points
// AND ≥14 days have passed since the last alert (avoids re-pinging the
// same name daily).
async function runRotationAlert(config = {}) {
  const { quietMode = false } = config;
  _ensureStateTable();
  const db = getDB();
  const today = new Date().toISOString().slice(0, 10);

  const { leadingEdge: edge } = await computeLeadingEdge();

  const existing = new Map(
    db.prepare('SELECT * FROM rotation_alert_state').all().map(r => [r.etf, r])
  );

  const upsert = db.prepare(`
    INSERT INTO rotation_alert_state (etf, first_seen_date, last_seen_date)
    VALUES (?, ?, ?)
    ON CONFLICT(etf) DO UPDATE SET last_seen_date = excluded.last_seen_date
  `);
  const markAlerted = db.prepare(`
    UPDATE rotation_alert_state SET last_alert_date = ?, vs1m_at_alert = ? WHERE etf = ?
  `);
  const logAlert = db.prepare(`
    INSERT INTO alerts (type, symbol, message, data) VALUES (?, ?, ?, ?)
  `);

  const newAlerts = [];
  for (const e of edge) {
    upsert.run(e.etf, today, today);
    const prev = existing.get(e.etf);
    const lastAlert = prev?.last_alert_date;
    const daysSinceAlert = lastAlert
      ? Math.round((new Date(today) - new Date(lastAlert)) / 86_400_000)
      : 999;
    const grewMaterially = prev?.vs1m_at_alert != null &&
      ((e.vs1m ?? 0) - (prev.vs1m_at_alert ?? 0)) >= 5;
    const shouldAlert = !lastAlert || (daysSinceAlert >= 14 && grewMaterially);
    if (!shouldAlert) continue;

    const topPicks = _topPicksForIndustry(e.etf);
    const picksStr = topPicks.length
      ? topPicks.map(p => `${p.symbol}(${p.rsRank})`).join(', ')
      : 'no RS≥70 names in bucket';
    const arrow = (e.vs1m ?? 0) > 0 ? '+' : '';
    const message =
      `🌱 ${e.etf} entered Leading Edge — ${e.name} ${arrow}${e.vs1m} ranks (30d), ` +
      `tilt still ${e.tiltStatus}. Top RS leaders: ${picksStr}`;
    const data = { ...e, topPicks };
    logAlert.run('rotation_leading_edge', e.etf, message, JSON.stringify(data));
    markAlerted.run(today, e.vs1m, e.etf);
    newAlerts.push({ etf: e.etf, name: e.name, message, topPicks });

    if (!quietMode) {
      try {
        const ch = require('../notifications/channels');
        const channels = ch.getEnabledChannels?.('rotation_leading_edge') || [];
        if (channels.length) {
          await ch.deliverAlert(
            { type: 'rotation_leading_edge', symbol: e.etf, message, ...data },
            channels,
          );
        }
      } catch (_) { /* notifications are best-effort */ }
    }
  }

  // Prune stale state (industry hasn't shown Leading Edge in 14+ days).
  db.prepare(
    `DELETE FROM rotation_alert_state WHERE last_seen_date < date('now', '-14 days')`
  ).run();

  return { date: today, leadingEdge: edge, newAlerts };
}

module.exports = { computeLeadingEdge, runRotationAlert };
