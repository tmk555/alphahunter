// ─── Test fixture helpers ────────────────────────────────────────────────────
// Small builders for synthetic price series. Kept deterministic and
// hand-computable so every assertion can be verified with a calculator.

// Array of `n` values all equal to `v`
function flat(n, v = 100) {
  return Array.from({ length: n }, () => v);
}

// Linear ramp from `start` to `end` inclusive over `n` points
function ramp(n, start, end) {
  if (n < 2) return [start];
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => start + step * i);
}

// Build a closes series where the last `m` bars are at `endPrice` and the
// preceding bars are at `startPrice`. Used to place a known %-move at a
// specific lookback offset so RS legs can be hand-computed.
function stepAtEnd(n, m, startPrice, endPrice) {
  const out = flat(n - m, startPrice);
  for (let i = 0; i < m; i++) out.push(endPrice);
  return out;
}

// Approximate float equality
function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

// OHLCV bar builder — defaults keep H=L=C for zero-volatility bars
function bar({ open = 100, high = 100, low = 100, close = 100, volume = 0 } = {}) {
  return { open, high, low, close, volume };
}

module.exports = { flat, ramp, stepAtEnd, approx, bar };
