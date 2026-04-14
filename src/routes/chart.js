// ─── /api/chart/:symbol — OHLCV + overlay data for TradingView Lightweight Charts
const express = require('express');

const { getHistoryFull } = require('../data/providers/manager');
const { getDB }          = require('../data/database');

// ─── Moving average helper ──────────────────────────────────────────────────
// Returns an array the same length as `values`, with nulls where the window
// hasn't filled yet.  period=50 means the first 49 entries are null.
function sma(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;

  // Seed: sum the first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;

  // Slide the window forward one bar at a time
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    result[i] = sum / period;
  }
  return result;
}

module.exports = function () {
  const router = express.Router();

  // GET /api/chart/:symbol?days=252&entry=150&stop=145&target1=160&target2=170
  router.get('/chart/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const days   = Math.min(parseInt(req.query.days) || 252, 1000);

      // ── Fetch full history so MAs are seeded properly ──────────────────
      const allBars = await getHistoryFull(symbol);
      if (!allBars || allBars.length === 0) {
        return res.status(404).json({ error: `No price data for ${symbol}` });
      }

      // We need at least 200 extra bars before the visible window to seed
      // the 200-day moving average.  Keep everything available and trim at
      // the end so the MA series are accurate.
      const closes  = allBars.map(b => b.close);
      const ma50s   = sma(closes, 50);
      const ma150s  = sma(closes, 150);
      const ma200s  = sma(closes, 200);

      // Trim to the requested visible window
      const visibleBars = allBars.slice(-days);
      const offset      = allBars.length - visibleBars.length;

      // ── Build OHLCV series ────────────────────────────────────────────
      const ohlcv = visibleBars.map(b => ({
        time: b.date,          // 'YYYY-MM-DD' — Lightweight Charts accepts this
        open:  +b.open.toFixed(2),
        high:  +b.high.toFixed(2),
        low:   +b.low.toFixed(2),
        close: +b.close.toFixed(2),
      }));

      // ── Volume series ─────────────────────────────────────────────────
      const volume = visibleBars.map(b => ({
        time:  b.date,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
      }));

      // ── MA overlay series ─────────────────────────────────────────────
      // Only include bars within the visible window.  Filter out nulls at
      // the start so the chart only draws where the MA actually exists.
      function maSlice(maArr) {
        return maArr
          .slice(offset)
          .map((v, i) => v != null ? { time: visibleBars[i].date, value: +v.toFixed(2) } : null)
          .filter(Boolean);
      }

      const ma50  = maSlice(ma50s);
      const ma150 = maSlice(ma150s);
      const ma200 = maSlice(ma200s);

      // ── Entry / Stop / Target horizontal markers ──────────────────────
      const markers = [];
      const entryPrice   = parseFloat(req.query.entry);
      const stopPrice    = parseFloat(req.query.stop);
      const target1Price = parseFloat(req.query.target1);
      const target2Price = parseFloat(req.query.target2);

      if (!isNaN(entryPrice))   markers.push({ label: 'Entry',    price: entryPrice,   color: '#2196F3' });
      if (!isNaN(stopPrice))    markers.push({ label: 'Stop',     price: stopPrice,    color: '#f44336' });
      if (!isNaN(target1Price)) markers.push({ label: 'Target 1', price: target1Price, color: '#4CAF50' });
      if (!isNaN(target2Price)) markers.push({ label: 'Target 2', price: target2Price, color: '#8BC34A' });

      // ── Latest RS rank & stage from scan_results ──────────────────────
      let rsRank = null;
      let stage  = null;
      try {
        const db  = getDB();
        const row = db.prepare(
          `SELECT data FROM scan_results
           WHERE symbol = ?
           ORDER BY date DESC
           LIMIT 1`
        ).get(symbol);

        if (row) {
          const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          rsRank = parsed.rsRank ?? parsed.rs_rank ?? null;
          stage  = parsed.stage ?? null;
        }
      } catch (_) {
        // scan_results may not exist yet — silently ignore
      }

      // ── Current MA values (latest bar) ────────────────────────────────
      const lastIdx      = allBars.length - 1;
      const currentMa50  = ma50s[lastIdx]  != null ? +ma50s[lastIdx].toFixed(2)  : null;
      const currentMa150 = ma150s[lastIdx] != null ? +ma150s[lastIdx].toFixed(2) : null;
      const currentMa200 = ma200s[lastIdx] != null ? +ma200s[lastIdx].toFixed(2) : null;

      res.json({
        symbol,
        bars:    ohlcv,
        volume,
        overlays: { ma50, ma150, ma200 },
        markers,
        meta: {
          totalBars:  allBars.length,
          visibleBars: visibleBars.length,
          currentMa50,
          currentMa150,
          currentMa200,
          rsRank,
          stage,
          lastDate: visibleBars[visibleBars.length - 1]?.date || null,
        },
      });
    } catch (e) {
      console.error(`  Chart error ${req.params.symbol}:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
