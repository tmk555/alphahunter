// ─── PIN Authentication Middleware ───────────────────────────────────────────
// Simple, secure PIN-based authentication for single-user access.
// Set APP_PIN in .env (4-8 digits). Sessions are httpOnly cookies.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ─── Config ─────────────────────────────────────────────────────────────────
const PIN              = process.env.APP_PIN || '';
const SESSION_TTL      = parseInt(process.env.SESSION_TTL_HOURS || '72', 10) * 60 * 60 * 1000; // default 72h
const MAX_ATTEMPTS     = 5;
const LOCKOUT_MINUTES  = 15;
const LOCKOUT_MS       = LOCKOUT_MINUTES * 60 * 1000;

// ─── In-memory stores ───────────────────────────────────────────────────────
const sessions     = new Map();   // token → { createdAt }
const failedState  = { count: 0, lockedUntil: 0 };

// Clean expired sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of sessions) {
    if (now - sess.createdAt > SESSION_TTL) sessions.delete(token);
  }
}, 30 * 60 * 1000);

// ─── Helpers ────────────────────────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isEnabled() {
  return PIN.length >= 4;
}

function isLockedOut() {
  if (failedState.lockedUntil && Date.now() < failedState.lockedUntil) {
    const remainSec = Math.ceil((failedState.lockedUntil - Date.now()) / 1000);
    return remainSec;
  }
  // Reset if lockout expired
  if (failedState.lockedUntil && Date.now() >= failedState.lockedUntil) {
    failedState.count = 0;
    failedState.lockedUntil = 0;
  }
  return 0;
}

// ─── Verify PIN ─────────────────────────────────────────────────────────────
function verifyPin(attempt) {
  const lockSec = isLockedOut();
  if (lockSec) {
    return { ok: false, error: `Too many attempts. Locked for ${Math.ceil(lockSec / 60)} min.`, locked: true };
  }

  // Constant-time comparison to prevent timing attacks
  const pinBuf = Buffer.from(PIN);
  const attBuf = Buffer.from(String(attempt));
  const match  = pinBuf.length === attBuf.length && crypto.timingSafeEqual(pinBuf, attBuf);

  if (!match) {
    failedState.count++;
    const remaining = MAX_ATTEMPTS - failedState.count;
    if (failedState.count >= MAX_ATTEMPTS) {
      failedState.lockedUntil = Date.now() + LOCKOUT_MS;
      return { ok: false, error: `Too many attempts. Locked for ${LOCKOUT_MINUTES} min.`, locked: true };
    }
    return { ok: false, error: `Wrong PIN. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` };
  }

  // Success — reset failures, create session
  failedState.count = 0;
  failedState.lockedUntil = 0;
  const token = generateToken();
  sessions.set(token, { createdAt: Date.now() });
  return { ok: true, token };
}

// ─── Logout ─────────────────────────────────────────────────────────────────
function destroySession(token) {
  sessions.delete(token);
}

// ─── Auth Routes ────────────────────────────────────────────────────────────
function authRoutes(router) {
  const express = require('express');
  const r = express.Router();

  // Login
  r.post('/auth/login', (req, res) => {
    const { pin } = req.body;
    const result = verifyPin(pin);
    if (!result.ok) {
      return res.status(result.locked ? 429 : 401).json({ error: result.error });
    }
    res.cookie('ah_session', result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: SESSION_TTL,
      path: '/',
    });
    res.json({ ok: true });
  });

  // Logout
  r.post('/auth/logout', (req, res) => {
    const token = req.cookies?.ah_session;
    if (token) destroySession(token);
    res.clearCookie('ah_session', { path: '/' });
    res.json({ ok: true });
  });

  // Status check
  r.get('/auth/status', (req, res) => {
    const token = req.cookies?.ah_session;
    const valid = token && sessions.has(token);
    if (valid) {
      const sess = sessions.get(token);
      if (Date.now() - sess.createdAt > SESSION_TTL) {
        sessions.delete(token);
        return res.json({ authenticated: false });
      }
    }
    res.json({ authenticated: !!valid });
  });

  return r;
}

// ─── Guard Middleware ───────────────────────────────────────────────────────
// Blocks all non-auth requests unless session is valid.
function authGuard(req, res, next) {
  // Skip if PIN not configured
  if (!isEnabled()) return next();

  // Allow auth endpoints through
  if (req.path.startsWith('/api/auth/')) return next();

  // Allow health check (for monitoring)
  if (req.path === '/api/health') return next();

  // Check session cookie
  const token = req.cookies?.ah_session;
  if (token && sessions.has(token)) {
    const sess = sessions.get(token);
    if (Date.now() - sess.createdAt <= SESSION_TTL) {
      return next();
    }
    sessions.delete(token);
  }

  // Not authenticated — serve login page for HTML requests, 401 for API
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Serve login page
  return res.sendFile(require('path').join(__dirname, '..', 'public', 'login.html'));
}

// ─── Simple cookie parser (no extra dependency) ─────────────────────────────
function cookieParser(req, res, next) {
  const header = req.headers.cookie || '';
  req.cookies = {};
  header.split(';').forEach(pair => {
    const [key, ...vals] = pair.trim().split('=');
    if (key) req.cookies[key.trim()] = decodeURIComponent(vals.join('='));
  });
  next();
}

module.exports = { authRoutes, authGuard, cookieParser, isEnabled };
