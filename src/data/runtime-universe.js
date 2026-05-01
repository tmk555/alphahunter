// ─── Runtime universe singleton ──────────────────────────────────────────
//
// The CANONICAL view of the live trading universe — assembled at server
// boot from four sources (see server.js):
//
//   1. universe.js FULL_UNIVERSE       (~360 leadership names, hardcoded)
//   2. universe_mgmt table              (user-added stocks via UI)
//   3. universe_membership table        (SP500 + SP400 + SP600 actives)
//   4. universe.js SECTOR_ETFS + INDUSTRY_ETFS (ETF list)
//
// server.js builds UNIVERSE (array) and SECTOR_MAP (object) in memory and
// passes them to most route factories explicitly. Two consumers couldn't
// receive that injection cleanly:
//
//   • src/routes/replay.js — module-level export, no factory pattern
//   • src/scheduler/jobs.js — runs in worker context, no req-scope access
//
// Pre-fix those modules `require('../../universe')` and read FULL_UNIVERSE
// directly — meaning Replay tab → Backfill silently used the 360 hardcoded
// names and skipped the 1213 newly-added SP1500 stocks. User-flagged
// 2026-04-30: "every component has its own universe."
//
// This module is the single shared singleton. server.js calls
// setRuntimeUniverse(UNIVERSE, SECTOR_MAP) after boot; consumers call
// getRuntimeUniverse() to receive the same arrays without going through a
// factory chain.
//
// Falls back to FULL_UNIVERSE if setRuntimeUniverse hasn't been called yet
// (e.g. unit tests, scripts that import a route module without booting
// server.js). The fallback warns once so silent staleness can't masquerade
// as the runtime.

let _universe = null;
let _sectorMap = null;
let _warnedFallback = false;

function setRuntimeUniverse(universe, sectorMap) {
  _universe = Array.isArray(universe) ? universe.slice() : [];
  _sectorMap = sectorMap && typeof sectorMap === 'object' ? { ...sectorMap } : {};
  _warnedFallback = false; // reset — caller has supplied real data now
}

function getRuntimeUniverse() {
  if (_universe && _universe.length) {
    return { universe: _universe, sectorMap: _sectorMap };
  }
  // Fallback path — emit a one-shot warning so missing initialization is
  // visible in logs, not silent.
  if (!_warnedFallback) {
    console.warn('[runtime-universe] no runtime data set; falling back to universe.js FULL_UNIVERSE (~360 leadership names). Did server.js boot before this caller?');
    _warnedFallback = true;
  }
  const { FULL_UNIVERSE } = require('../../universe');
  return {
    universe: Object.keys(FULL_UNIVERSE),
    sectorMap: { ...FULL_UNIVERSE },
  };
}

module.exports = { setRuntimeUniverse, getRuntimeUniverse };
