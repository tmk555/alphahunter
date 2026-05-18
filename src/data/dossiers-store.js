// ─── Trade Architect: Dossier + Theme storage ────────────────────────────
//
// Per-ticker dossier captures the full trade thesis BEFORE entry — what
// you'd hand to a partner if they asked "why this name and why now."
// The point is to surface conviction rationale that survives the trade
// (post-mortem) and to enforce the discipline of writing it down.
//
// Themes table is the union of (a) the curated `theme` field on
// universe.INDUSTRY_ETFS and (b) user-added themes. The store auto-seeds
// the universe themes the first time it's read so the dropdown isn't
// empty for a fresh DB.

const { getDB } = require('./database');

function _ensure() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS dossiers (
      ticker        TEXT PRIMARY KEY,
      data          TEXT NOT NULL,            -- JSON blob (see shape below)
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS themes (
      theme   TEXT PRIMARY KEY,
      source  TEXT NOT NULL DEFAULT 'user_added',   -- 'industry_etf' | 'user_added'
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dossiers_updated ON dossiers(updated_at DESC);
  `);
  // Seed themes from INDUSTRY_ETFS once (idempotent).
  try {
    const { INDUSTRY_ETFS } = require('../../universe');
    const insert = db.prepare(`
      INSERT OR IGNORE INTO themes (theme, source) VALUES (?, 'industry_etf')
    `);
    const seedAll = db.transaction(() => {
      for (const e of INDUSTRY_ETFS) {
        if (e.theme) insert.run(e.theme);
      }
    });
    seedAll();
  } catch (_) { /* universe.js missing in test envs — silent */ }
}

// ─── Dossier CRUD ─────────────────────────────────────────────────────────
// Dossier shape (the `data` JSON blob):
//   {
//     ticker, pivotPrice, theme,
//     fundamentalSnapshot: { revGrowthQ0, revGrowthTrend, epsSurprise, guideDir, gmTrend },
//     technicalSnapshot:   { stage, sepa, rsRank, rsLineHigh, baseQuality, pattern, distFromPivot },
//     thesis:        [string, string, string],         // 3 bullets
//     killCriteria:  [string, string, string],         // 3 bullets
//     catalysts:     [{date, description}, ...],       // 3 entries
//     holdHorizonDays: number,
//     convictionGrade: 'A' | 'B' | 'C',
//     prefilledAt:    ISO timestamp (when auto-prefill ran)
//   }

function listDossiers() {
  _ensure();
  return getDB().prepare(`
    SELECT ticker, data, updated_at FROM dossiers
    ORDER BY updated_at DESC
  `).all().map(r => ({
    ticker:     r.ticker,
    updated_at: r.updated_at,
    ...(JSON.parse(r.data) || {}),
  }));
}

function getDossier(ticker) {
  _ensure();
  if (!ticker) return null;
  const row = getDB().prepare(
    `SELECT ticker, data, updated_at FROM dossiers WHERE ticker = ?`
  ).get(ticker.toUpperCase());
  if (!row) return null;
  return { ticker: row.ticker, updated_at: row.updated_at, ...(JSON.parse(row.data) || {}) };
}

function upsertDossier(ticker, payload) {
  _ensure();
  if (!ticker) throw new Error('ticker required');
  const t = ticker.toUpperCase();
  // Strip server-managed fields from incoming payload so callers can
  // round-trip GET → PUT without polluting the blob with `ticker` /
  // `updated_at` duplicates.
  const { ticker: _drop1, updated_at: _drop2, ...clean } = payload || {};
  // If the dossier names a brand-new theme, persist it so the dropdown
  // surfaces it next time. Source defaults to user_added.
  if (clean.theme && typeof clean.theme === 'string') {
    try {
      getDB().prepare(
        `INSERT OR IGNORE INTO themes (theme, source) VALUES (?, 'user_added')`
      ).run(clean.theme);
    } catch (_) { /* non-fatal */ }
  }
  getDB().prepare(`
    INSERT INTO dossiers (ticker, data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run(t, JSON.stringify(clean));
  return getDossier(t);
}

function deleteDossier(ticker) {
  _ensure();
  if (!ticker) throw new Error('ticker required');
  const r = getDB().prepare(`DELETE FROM dossiers WHERE ticker = ?`).run(ticker.toUpperCase());
  return { ticker: ticker.toUpperCase(), removed: r.changes };
}

// ─── Themes ───────────────────────────────────────────────────────────────

function listThemes() {
  _ensure();
  return getDB().prepare(
    `SELECT theme, source FROM themes ORDER BY source ASC, theme ASC`
  ).all();
}

function addTheme(theme) {
  _ensure();
  if (!theme || typeof theme !== 'string') throw new Error('theme required');
  const clean = theme.trim();
  if (!clean) throw new Error('theme cannot be empty');
  getDB().prepare(
    `INSERT OR IGNORE INTO themes (theme, source) VALUES (?, 'user_added')`
  ).run(clean);
  return { theme: clean };
}

module.exports = {
  listDossiers, getDossier, upsertDossier, deleteDossier,
  listThemes, addTheme,
};
