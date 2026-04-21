// ─── /api/chart/:symbol — OHLCV + overlay data for TradingView Lightweight Charts
const express = require('express');

const { getHistoryFull, getIntradayBars } = require('../data/providers/manager');
const { getDB }          = require('../data/database');

// ─── Check if US equity market is open (or within ~30 min after close) ─────
// Used to decide whether to refresh today's bar from intraday data.
function isMarketOpenOrRecent() {
  const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const dt = new Date(nowET);
  const day = dt.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = dt.getHours() * 60 + dt.getMinutes();
  // Market open 9:30 ET through 16:30 ET (30 min buffer for intraday data settle)
  return mins >= 9 * 60 + 30 && mins <= 16 * 60 + 30;
}

// ─── Regular-session ET filter ─────────────────────────────────────────────
// Polygon's /v2/aggs minute endpoint returns bars for the full trading day
// INCLUDING pre-market (04:00–09:30 ET) and after-hours (16:00–20:00 ET).
// Without this filter, buildTodayLiveBar would sum extended-hours volume
// into the daily bar, producing visually-wrong "volume spikes" on the chart
// (today's bar ~20–40% higher than regular-session volume) and a corrupt
// open (4 AM pre-market print) / close (8 PM after-hours print).
//
// Yahoo's intraday provider already passes includePrePost=false so Yahoo bars
// rarely need filtering, but applying this universally is both safe and cheap.
function barEtMinutes(b) {
  // Every provider returns a bar.timestamp in ms epoch. Convert to ET minutes-of-day.
  if (!b || typeof b.timestamp !== 'number') return null;
  const d = new Date(b.timestamp);
  const etString = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const m = etString.match(/(\d+):(\d+):/);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}
function isRegularSessionBar(b) {
  const mins = barEtMinutes(b);
  if (mins == null) return true; // fail-open — never drop a bar we can't classify
  // 9:30 ET (570) ≤ start < 16:00 ET (960). The last regular 5-min bar starts at 15:55.
  return mins >= 570 && mins < 960;
}

// ─── Build today's "in-progress" daily bar from 5-min intraday bars ─────────
// Returns null if market is closed / no intraday data available.
async function buildTodayLiveBar(symbol) {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const rawBars = await getIntradayBars(symbol, 'minute', 5, today, today);
    if (!rawBars || rawBars.length === 0) return null;
    // Filter to regular session (9:30–16:00 ET) so pre/after-hours don't
    // contaminate the synthesized daily bar. See barEtMinutes note above.
    const bars = rawBars.filter(isRegularSessionBar);
    if (bars.length === 0) return null;
    const open  = bars[0].open;
    const close = bars[bars.length - 1].close;
    let high = -Infinity, low = Infinity, volume = 0;
    for (const b of bars) {
      if (b.high  > high) high = b.high;
      if (b.low   < low)  low  = b.low;
      volume += b.volume || 0;
    }
    if (!isFinite(high) || !isFinite(low)) return null;
    return {
      date: today, open, high, low, close, volume,
      _live: true,
      barCount: bars.length,
      rawBarCount: rawBars.length,  // for debugging: how many bars got filtered
    };
  } catch (_) {
    return null;
  }
}

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

// ─── Rolling VWAP over N bars (for daily charts) ───────────────────────────
// VWAP = Σ(typical_price × volume) / Σ(volume), where typical_price = (H+L+C)/3.
// Returns one value per bar with nulls until the window fills.
function rollingVWAP(bars, period = 20) {
  const n = bars.length;
  const result = new Array(n).fill(null);
  if (n < period) return result;

  const pv = bars.map(b => ((b.high + b.low + b.close) / 3) * (b.volume || 0));
  const v  = bars.map(b => b.volume || 0);

  let pvSum = 0, vSum = 0;
  for (let i = 0; i < period; i++) { pvSum += pv[i]; vSum += v[i]; }
  result[period - 1] = vSum > 0 ? pvSum / vSum : null;

  for (let i = period; i < n; i++) {
    pvSum += pv[i] - pv[i - period];
    vSum  += v[i]  - v[i - period];
    result[i] = vSum > 0 ? pvSum / vSum : null;
  }
  return result;
}

// ─── Session VWAP for intraday (resets each trading day) ───────────────────
// Cumulative Σ(TP×V)/Σ(V) from the first bar of each session. Bars must
// carry a `.date` field (YYYY-MM-DD in ET) as the session key. This is the
// standard intraday VWAP traders watch on minute/39-min charts.
function sessionVWAP(bars) {
  const result = new Array(bars.length).fill(null);
  let currentDate = null;
  let cumPV = 0, cumV = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.date !== currentDate) {
      currentDate = b.date;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (b.high + b.low + b.close) / 3;
    const vol = b.volume || 0;
    cumPV += tp * vol;
    cumV  += vol;
    result[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return result;
}

// ─── Extract ET date and minute-of-day from a timestamp ────────────────────
// Uses Intl to avoid DST headaches.  Returns `null` outside cash session.
const etPartsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function getETParts(ts) {
  const parts = etPartsFmt.formatToParts(new Date(ts));
  const p = {};
  for (const x of parts) if (x.type !== 'literal') p[x.type] = x.value;
  // Intl may report hour '24' for midnight; normalize.
  const hour = parseInt(p.hour, 10) % 24;
  const minute = parseInt(p.minute, 10);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: hour * 60 + minute,
  };
}

// ─── Aggregate 1-min bars into 39-min buckets anchored to 9:30 ET ──────────
// US cash session is exactly 390 minutes (9:30–16:00 ET), so 390 / 39 = 10
// bars per trading day. The intraday chart uses these 10 buckets for clean
// alignment to market open — the "39-minute chart" popularized by O'Neil.
function aggregateTo39Min(oneMinBars) {
  const MARKET_OPEN_MIN = 9 * 60 + 30;  // 9:30 AM ET
  const MARKET_CLOSE_MIN = 16 * 60;     // 4:00 PM ET
  const BUCKET_MIN = 39;

  const buckets = new Map(); // key = `${date}|${bucketIdx}` → bar

  for (const bar of oneMinBars) {
    const ts = bar.timestamp || new Date(bar.date).getTime();
    const { date, minutes } = getETParts(ts);
    if (minutes < MARKET_OPEN_MIN || minutes >= MARKET_CLOSE_MIN) continue;

    const bucketIdx = Math.floor((minutes - MARKET_OPEN_MIN) / BUCKET_MIN);
    const key = `${date}|${bucketIdx}`;

    if (!buckets.has(key)) {
      // Compute bucket start time in Unix seconds (ET → UTC)
      const bucketStartMin = MARKET_OPEN_MIN + bucketIdx * BUCKET_MIN;
      const h = Math.floor(bucketStartMin / 60);
      const m = bucketStartMin % 60;
      // Use the first bar's timestamp as the bucket anchor (avoids timezone math)
      const bucketTs = Math.floor(ts / 1000);
      buckets.set(key, {
        time:   bucketTs,
        date,
        bucketIdx,
        startMinuteET: bucketStartMin,
        startLabelET: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
        open:   bar.open,
        high:   bar.high,
        low:    bar.low,
        close:  bar.close,
        volume: bar.volume || 0,
        barCount: 1,
      });
    } else {
      const b = buckets.get(key);
      if (bar.high > b.high) b.high = bar.high;
      if (bar.low  < b.low)  b.low  = bar.low;
      b.close = bar.close;
      b.volume += bar.volume || 0;
      b.barCount += 1;
    }
  }

  // Sort chronologically
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

// ─── Determine calendar-day range for 1-min intraday fetch ────────────────
// Yahoo's 1-min endpoint is capped at ~7 calendar days from "now". Request
// exceeding the cap returns an empty result. We go back `calendarDays` days
// (6 is safe under the cap, yielding 4-5 trading days of 39-min bars = 40-50
// bars, enough for short-term pattern work).
function getIntradayDateRange(calendarDays = 6) {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const start = new Date(todayStr + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - calendarDays);
  return {
    from: start.toISOString().slice(0, 10),
    to:   todayStr,
  };
}

module.exports = function () {
  const router = express.Router();

  // GET /api/chart/:symbol?days=252&entry=150&stop=145&target1=160&target2=170
  //         &timeframe=daily|39m
  router.get('/chart/:symbol', async (req, res) => {
    try {
      const symbol    = req.params.symbol.toUpperCase();
      const days      = Math.min(parseInt(req.query.days) || 252, 1000);
      const timeframe = (req.query.timeframe || 'daily').toLowerCase();

      // ─── 39-MINUTE INTRADAY CHART ────────────────────────────────────
      // Aggregates 1-minute bars into 39-minute buckets anchored to 9:30 ET.
      // Yahoo's 1-min endpoint is capped to ~7 calendar days; Polygon paid
      // tier extends further. MAs are computed on 39-min closes.
      if (timeframe === '39m' || timeframe === '39min') {
        const range = getIntradayDateRange(6); // 6 calendar days — safe under Yahoo's 7-day 1m cap
        let oneMin;
        try {
          oneMin = await getIntradayBars(symbol, 'minute', 1, range.from, range.to);
        } catch (e) {
          return res.status(502).json({ error: `39-min chart requires 1-min intraday data: ${e.message}` });
        }
        if (!oneMin || oneMin.length === 0) {
          return res.status(404).json({ error: `No intraday data for ${symbol}` });
        }

        const bars39 = aggregateTo39Min(oneMin);
        if (bars39.length === 0) {
          return res.status(404).json({ error: `No cash-session bars for ${symbol}` });
        }

        // Build OHLCV series — use Unix seconds so Lightweight Charts renders intraday time labels
        const ohlcv = bars39.map(b => ({
          time:  b.time,
          open:  +b.open.toFixed(2),
          high:  +b.high.toFixed(2),
          low:   +b.low.toFixed(2),
          close: +b.close.toFixed(2),
        }));
        const volumeSeries = bars39.map(b => ({
          time:  b.time,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
        }));

        // MAs on 39-min closes — 10/50/200 bars ≈ 1 day / 5 days / 20 days
        const closes39 = bars39.map(b => b.close);
        const ma10s    = sma(closes39, 10);
        const ma50s39  = sma(closes39, 50);
        const ma200s39 = sma(closes39, 200);
        // Session VWAP — resets each trading day at 9:30 ET
        const vwap39   = sessionVWAP(bars39);
        const maSeries = (arr) => arr
          .map((v, i) => v != null ? { time: bars39[i].time, value: +v.toFixed(2) } : null)
          .filter(Boolean);

        // Entry / stop / target markers
        const markers = [];
        const entryPrice   = parseFloat(req.query.entry);
        const stopPrice    = parseFloat(req.query.stop);
        const target1Price = parseFloat(req.query.target1);
        const target2Price = parseFloat(req.query.target2);
        if (!isNaN(entryPrice))   markers.push({ label: 'Entry',    price: entryPrice,   color: '#2196F3' });
        if (!isNaN(stopPrice))    markers.push({ label: 'Stop',     price: stopPrice,    color: '#f44336' });
        if (!isNaN(target1Price)) markers.push({ label: 'Target 1', price: target1Price, color: '#4CAF50' });
        if (!isNaN(target2Price)) markers.push({ label: 'Target 2', price: target2Price, color: '#8BC34A' });

        // Unique trading days covered (for info display)
        const uniqueDays = new Set(bars39.map(b => b.date)).size;

        return res.json({
          symbol,
          timeframe: '39min',
          bars:    ohlcv,
          volume:  volumeSeries,
          overlays: {
            // Reuse same keys the frontend expects, but these are shorter periods
            ma50:  maSeries(ma10s),    // fast MA (~1 day)
            ma150: maSeries(ma50s39),  // mid  MA (~5 days)
            ma200: maSeries(ma200s39), // slow MA (~20 days)
            vwap:  maSeries(vwap39),   // session VWAP (resets daily)
          },
          markers,
          meta: {
            timeframe:   '39min',
            bucketMinutes: 39,
            totalBars:   bars39.length,
            visibleBars: bars39.length,
            tradingDays: uniqueDays,
            maLabels:    { ma50: '10', ma150: '50', ma200: '200' },
            vwapLabel:   'Session VWAP',
            firstTime:   bars39[0].time,
            lastTime:    bars39[bars39.length - 1].time,
            dataRange:   range,
            todayLive:   isMarketOpenOrRecent(),
          },
        });
      }

      // ─── WEEKLY CHART ───────────────────────────────────────────────────
      // Aggregates daily OHLCV into Mon-Fri weekly candles. Shows 2-3 years
      // of weekly bars with 10w/30w/40w MAs — the position trader's primary
      // timeframe for trend identification and stage analysis.
      if (timeframe === 'weekly' || timeframe === 'w') {
        const dailyBars = await getHistoryFull(symbol);
        if (!dailyBars || dailyBars.length === 0) {
          return res.status(404).json({ error: `No price data for ${symbol}` });
        }

        // Aggregate dailies into weekly OHLCV. Week boundary = Monday.
        // Each weekly bar uses Monday's date as the time key.
        const weeklyBars = [];
        let currentWeek = null;

        for (const bar of dailyBars) {
          // Parse date and find the Monday of this bar's week
          const d = new Date(bar.date + 'T12:00:00Z');
          const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
          const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
          const monday = new Date(d);
          monday.setUTCDate(d.getUTCDate() + mondayOffset);
          const weekKey = monday.toISOString().slice(0, 10);

          if (!currentWeek || currentWeek._weekKey !== weekKey) {
            currentWeek = {
              _weekKey: weekKey,
              date: weekKey,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume || 0,
            };
            weeklyBars.push(currentWeek);
          } else {
            if (bar.high > currentWeek.high) currentWeek.high = bar.high;
            if (bar.low < currentWeek.low) currentWeek.low = bar.low;
            currentWeek.close = bar.close;
            currentWeek.volume += bar.volume || 0;
          }
        }

        // Trim to requested window (default 156 weeks ≈ 3 years)
        const weekDays = Math.min(Math.ceil(days / 5), weeklyBars.length);
        const visibleWeekly = weeklyBars.slice(-weekDays);
        const wOffset = weeklyBars.length - visibleWeekly.length;

        // Weekly MAs: 10w (≈50d), 30w (≈150d), 40w (≈200d)
        const wCloses = weeklyBars.map(b => b.close);
        const wma10  = sma(wCloses, 10);
        const wma30  = sma(wCloses, 30);
        const wma40  = sma(wCloses, 40);
        const wVwap  = rollingVWAP(weeklyBars, 10);

        function wmaSlice(arr) {
          return arr.slice(wOffset)
            .map((v, i) => v != null ? { time: visibleWeekly[i].date, value: +v.toFixed(2) } : null)
            .filter(Boolean);
        }

        const ohlcv = visibleWeekly.map(b => ({
          time: b.date,
          open: +b.open.toFixed(2),
          high: +b.high.toFixed(2),
          low: +b.low.toFixed(2),
          close: +b.close.toFixed(2),
        }));

        const volumeSeries = visibleWeekly.map(b => ({
          time: b.date,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
        }));

        // Entry/stop/target markers
        const markers = [];
        const entryPrice   = parseFloat(req.query.entry);
        const stopPrice    = parseFloat(req.query.stop);
        const target1Price = parseFloat(req.query.target1);
        const target2Price = parseFloat(req.query.target2);
        if (!isNaN(entryPrice))   markers.push({ label: 'Entry',    price: entryPrice,   color: '#2196F3' });
        if (!isNaN(stopPrice))    markers.push({ label: 'Stop',     price: stopPrice,    color: '#f44336' });
        if (!isNaN(target1Price)) markers.push({ label: 'Target 1', price: target1Price, color: '#4CAF50' });
        if (!isNaN(target2Price)) markers.push({ label: 'Target 2', price: target2Price, color: '#8BC34A' });

        return res.json({
          symbol,
          timeframe: 'weekly',
          bars: ohlcv,
          volume: volumeSeries,
          overlays: {
            ma50:  wmaSlice(wma10),
            ma150: wmaSlice(wma30),
            ma200: wmaSlice(wma40),
            vwap:  wmaSlice(wVwap),
          },
          markers,
          meta: {
            timeframe: 'weekly',
            totalBars: weeklyBars.length,
            visibleBars: visibleWeekly.length,
            maLabels: { ma50: '10W', ma150: '30W', ma200: '40W' },
            vwapLabel: 'VWAP(10W)',
            lastDate: visibleWeekly[visibleWeekly.length - 1]?.date || null,
          },
        });
      }

      // ── Fetch full history so MAs are seeded properly ──────────────────
      //
      // preferConsolidatedVolume: on. Chart bars must have consistent volume
      // magnitudes across history + today's live bar. Today's live bar comes
      // from getIntradayBars (Polygon/Yahoo = consolidated). Without this
      // flag, the manager might serve historical bars from Alpaca's free-tier
      // IEX feed (~2% of consolidated volume), making today's bar LOOK like
      // a 50× spike. This flag moves Alpaca to the end of the fallback chain
      // so the chart prefers Yahoo/Polygon/FMP (all consolidated) first.
      const allBars = await getHistoryFull(symbol, { preferConsolidatedVolume: true });
      if (!allBars || allBars.length === 0) {
        return res.status(404).json({ error: `No price data for ${symbol}` });
      }

      // ── Append/refresh today's live bar from 5-min intraday aggregation ──
      // Daily providers cache aggressively (23hr TTL) and may not reflect the
      // latest intraday price action. During market hours we always build the
      // current day's bar from 5-min intraday data (cached 5min) so the chart
      // shows live price action. If historical already has today, we replace
      // that bar with the fresher intraday-built version.
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const lastHistDate = allBars[allBars.length - 1]?.date;
      let todayLive = false;
      let todayLiveMeta = null;
      if (isMarketOpenOrRecent()) {
        const liveBar = await buildTodayLiveBar(symbol);
        if (liveBar) {
          if (lastHistDate === todayStr) {
            // Replace cached daily bar with fresher intraday-built bar
            allBars[allBars.length - 1] = liveBar;
          } else if (lastHistDate && lastHistDate < todayStr) {
            allBars.push(liveBar);
          }
          todayLive = true;
          todayLiveMeta = {
            open:  +liveBar.open.toFixed(2),
            high:  +liveBar.high.toFixed(2),
            low:   +liveBar.low.toFixed(2),
            close: +liveBar.close.toFixed(2),
            volume: liveBar.volume,
            barCount: liveBar.barCount,
          };
        }
      }

      // We need at least 200 extra bars before the visible window to seed
      // the 200-day moving average.  Keep everything available and trim at
      // the end so the MA series are accurate.
      const closes  = allBars.map(b => b.close);
      const ma50s   = sma(closes, 50);
      const ma150s  = sma(closes, 150);
      const ma200s  = sma(closes, 200);
      // 20-day rolling VWAP — volume-weighted mean-reversion / support level
      const vwap20s = rollingVWAP(allBars, 20);

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
      const vwap  = maSlice(vwap20s);

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
        timeframe: 'daily',
        bars:    ohlcv,
        volume,
        overlays: { ma50, ma150, ma200, vwap },
        markers,
        meta: {
          timeframe:  'daily',
          totalBars:  allBars.length,
          visibleBars: visibleBars.length,
          currentMa50,
          currentMa150,
          currentMa200,
          rsRank,
          stage,
          lastDate: visibleBars[visibleBars.length - 1]?.date || null,
          todayLive,
          todayLiveBar: todayLiveMeta,
          maLabels: { ma50: '50', ma150: '150', ma200: '200' },
          vwapLabel: 'VWAP(20)',
        },
      });
    } catch (e) {
      console.error(`  Chart error ${req.params.symbol}:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
