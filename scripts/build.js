#!/usr/bin/env node
// ─── Pre-build: compile inline JSX → static JS bundle ──────────────────────
//
// Pre-build the giant <script type="text/babel"> block inside public/index.html
// into a precompiled JS file so the browser doesn't have to run @babel/standalone
// on every page load. In-browser Babel was the dominant cost on refresh
// (~800KB of JSX, ~1-3s of transform time on cold load).
//
// Output:
//   public/dist/app.js      — esbuild output of the extracted JSX
//   public/index.dist.html  — index.html with the inline script replaced by
//                              <script src="/dist/app.js">
//
// Server (server.js) will prefer index.dist.html when present, else fall
// back to index.html (in-browser Babel mode kept for dev iteration).
//
// Usage:
//   npm run build
//
// React/Recharts/LightweightCharts stay loaded from CDN as window globals;
// esbuild compiles JSX-only and trusts the runtime.

const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC_HTML = path.join(ROOT, 'public', 'index.html');
const OUT_HTML = path.join(ROOT, 'public', 'index.dist.html');
const DIST_DIR = path.join(ROOT, 'public', 'dist');
const OUT_JSX = path.join(DIST_DIR, 'app.jsx');
const OUT_JS  = path.join(DIST_DIR, 'app.js');

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

const html = fs.readFileSync(SRC_HTML, 'utf8');

// Extract the (single) <script type="text/babel"> block.
const re = /<script type="text\/babel">([\s\S]*?)<\/script>/;
const m = re.exec(html);
if (!m) {
  console.error('build: no <script type="text/babel"> block found in public/index.html');
  process.exit(1);
}

const jsxSource = m[1];
fs.writeFileSync(OUT_JSX, jsxSource);

// esbuild — JSX → JS, mark React/ReactDOM/etc. as globals (they're loaded
// by CDN tags above). loader:'jsx' so .jsx is recognized; jsx:'transform'
// emits classic React.createElement calls (matches our React 17 setup,
// not the new automatic runtime).
const t0 = Date.now();
buildSync({
  entryPoints: [OUT_JSX],
  outfile: OUT_JS,
  bundle: false,           // single file, no module resolution needed
  format: 'iife',
  loader: { '.jsx': 'jsx' },
  jsx: 'transform',        // classic React.createElement
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  target: ['es2019'],
  minify: false,           // readable build for now; flip to true after we confirm parity
  sourcemap: 'inline',
});
const compileMs = Date.now() - t0;

// Build the swapped HTML. Replace the inline block with a <script src=> tag.
const built = html.replace(
  re,
  `<script src="/dist/app.js?v=${Date.now()}"></script>`
);
fs.writeFileSync(OUT_HTML, built);

const jsxBytes = jsxSource.length;
const jsBytes  = fs.statSync(OUT_JS).size;
console.log('build: OK');
console.log(`  jsx source : ${(jsxBytes / 1024).toFixed(1)} KB`);
console.log(`  js output  : ${(jsBytes  / 1024).toFixed(1)} KB`);
console.log(`  compile    : ${compileMs} ms`);
console.log(`  → public/index.dist.html`);
console.log(`  → public/dist/app.js`);
