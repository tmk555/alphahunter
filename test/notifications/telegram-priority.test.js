// ─── Tests: Telegram priority mirroring (src/notifications/channels.js) ────
//
// Verifies Phase 1.5 wiring:
//   1. `lookupPriority` resolves trade_-prefixed alert types correctly
//      (the latent bug: `auto_stop: 1` was never hit because callers
//      always passed `trade_auto_stop`).
//   2. `sendTelegram` sets `disable_notification: true` for priority ≤ -1.
//   3. `sendTelegram` sets `disable_notification: false` for priority ≥ 0.
//   4. Urgent (priority ≥ 1) messages get a visible "URGENT" banner in
//      the message body.
//   5. `lookupSound` also resolves trade_ prefixes (Pushover side).
//
// We stub `node-fetch` via require.cache BEFORE requiring channels.js so
// the module binds its internal `fetch` to our spy.

process.env.ALPHAHUNTER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Stub node-fetch so we can inspect what gets sent ────────────────────────
const fetchCalls = [];
require.cache[require.resolve('node-fetch')] = {
  exports: async (url, opts) => {
    fetchCalls.push({ url, opts });
    // Return a faux-Telegram success envelope that sendTelegram expects.
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: fetchCalls.length } };
      },
      async text() { return ''; },
    };
  },
};

const {
  sendTelegram,
  lookupPriority, lookupSound,
  NOTIFICATION_PRIORITY_MAP,
} = require('../../src/notifications/channels');

function clearCalls() { fetchCalls.length = 0; }

// ─── lookupPriority — the actual bug fix ───────────────────────────────────

test('lookupPriority: direct match (stop_violation → 1)', () => {
  assert.equal(lookupPriority('stop_violation'), 1);
});

test('lookupPriority: trade_-prefixed lifecycle event resolves to short-name entry', () => {
  // This is the bug fix: before Phase 1.5, every lifecycle alert came in
  // as `trade_auto_stop` (from notifyTradeEvent) but the map only had
  // `auto_stop: 1` — so it silently fell through to 0.
  assert.equal(lookupPriority('trade_auto_stop'),  1);
  assert.equal(lookupPriority('trade_force_stop'), 1);
  assert.equal(lookupPriority('trade_gap_cancel'), 1);
  assert.equal(lookupPriority('trade_rejected'),   1);
  assert.equal(lookupPriority('trade_filled'),     0);
  assert.equal(lookupPriority('trade_staged'),    -1);
  assert.equal(lookupPriority('trade_submitted'), -1);
  assert.equal(lookupPriority('trade_cancelled'), -1);
  assert.equal(lookupPriority('trade_expired'),   -1);
});

test('lookupPriority: unknown type falls through to default 0', () => {
  assert.equal(lookupPriority('never_heard_of_this_event'), 0);
  assert.equal(lookupPriority('trade_made_up_event'), 0);
});

test('lookupPriority: null/undefined safe', () => {
  assert.equal(lookupPriority(null), 0);
  assert.equal(lookupPriority(undefined), 0);
  assert.equal(lookupPriority(null, -1), -1);  // respects custom fallback
});

test('lookupPriority: custom fallback only kicks in when nothing matches', () => {
  assert.equal(lookupPriority('trade_auto_stop', -99), 1); // still 1, not -99
  assert.equal(lookupPriority('bogus_event',     -99), -99);
});

// ─── lookupSound — same bug, Pushover side ─────────────────────────────────

test('lookupSound: trade_-prefixed events resolve to the right sound', () => {
  assert.equal(lookupSound('trade_auto_stop'),   'falling');
  assert.equal(lookupSound('trade_force_stop'),  'siren');
  assert.equal(lookupSound('trade_gap_cancel'),  'falling');
  assert.equal(lookupSound('trade_filled'),      'cashregister');
  assert.equal(lookupSound('trade_scale_in'),    'pushover');
});

test('lookupSound: unknown type falls through to default pushover sound', () => {
  assert.equal(lookupSound('unknown_event'),            'pushover');
  assert.equal(lookupSound('trade_unknown_event'),      'pushover');
});

// ─── sendTelegram — urgent alerts ──────────────────────────────────────────

test('sendTelegram: priority ≥ 1 fires audibly with URGENT banner', async () => {
  clearCalls();

  await sendTelegram(
    {
      type: 'trade_auto_stop',
      symbol: 'AAPL',
      current_price: 195,
      trigger_price: 200,
      message: 'Stop hit at $195',
      timestamp: new Date().toISOString(),
    },
    { bot_token: 'fake_token', chat_id: '123' },
  );

  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.disable_notification, false,
    'priority-1 alerts must ping audibly (disable_notification:false)');
  assert.match(body.text, /URGENT/,
    'priority-1 alerts must show an URGENT banner in the message body');
  assert.match(body.text, /AAPL/);
});

test('sendTelegram: priority 0 fires audibly without URGENT banner', async () => {
  clearCalls();

  await sendTelegram(
    {
      type: 'trade_filled',
      symbol: 'MSFT',
      current_price: 400,
      trigger_price: 400,
      message: 'Bracket entry filled at $400',
      timestamp: new Date().toISOString(),
    },
    { bot_token: 'fake_token', chat_id: '123' },
  );

  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.disable_notification, false);
  assert.doesNotMatch(body.text, /URGENT/);
  assert.match(body.text, /MSFT/);
});

test('sendTelegram: priority ≤ -1 fires silently (no sound/vibration)', async () => {
  clearCalls();

  await sendTelegram(
    {
      type: 'trade_staged',
      symbol: 'NVDA',
      current_price: 500,
      trigger_price: 500,
      message: 'Order staged',
      timestamp: new Date().toISOString(),
    },
    { bot_token: 'fake_token', chat_id: '123' },
  );

  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.disable_notification, true,
    'priority ≤ -1 alerts must be silent (disable_notification:true)');
  assert.doesNotMatch(body.text, /URGENT/);
});

test('sendTelegram: gap_cancel event (new in Phase 1.4) is priority-1 urgent', async () => {
  clearCalls();

  await sendTelegram(
    {
      type: 'trade_gap_cancel',
      symbol: 'TSLA',
      current_price: 260,
      trigger_price: 250,
      message: 'GAP GUARD: gapped +4% past entry',
      timestamp: new Date().toISOString(),
    },
    { bot_token: 'fake_token', chat_id: '123' },
  );

  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.disable_notification, false,
    'gap_cancel must ping audibly so the user sees their staged entry died');
  assert.match(body.text, /URGENT/);
});

test('sendTelegram: unknown alert type defaults to priority 0 (audible, no banner)', async () => {
  clearCalls();

  await sendTelegram(
    {
      type: 'some_brand_new_event',
      symbol: 'SPY',
      current_price: 550,
      trigger_price: 550,
      message: 'Test',
      timestamp: new Date().toISOString(),
    },
    { bot_token: 'fake_token', chat_id: '123' },
  );

  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.disable_notification, false);
  assert.doesNotMatch(body.text, /URGENT/);
});

test('sendTelegram: missing bot_token throws (configuration error)', async () => {
  clearCalls();
  delete process.env.TELEGRAM_BOT_TOKEN;

  await assert.rejects(
    sendTelegram(
      { type: 'trade_filled', symbol: 'AAPL', current_price: 100, trigger_price: 100, message: '', timestamp: new Date().toISOString() },
      { chat_id: '123' },  // no bot_token
    ),
    /bot_token and chat_id required/,
  );
});

test('NOTIFICATION_PRIORITY_MAP: every Phase-1 lifecycle event is mapped', () => {
  // Schema sanity check — catches accidental deletions that would downgrade
  // urgent events to silent default.
  const criticalEvents = [
    'stop_violation', 'auto_stop', 'force_stop', 'rejected',
    'gap_cancel', 'regime_change',
  ];
  for (const e of criticalEvents) {
    assert.equal(NOTIFICATION_PRIORITY_MAP[e], 1,
      `${e} must be priority 1 — downgrading breaks phone alerts on real risk events`);
  }

  const lowPriorityEvents = ['staged', 'submitted', 'cancelled', 'expired', 'test'];
  for (const e of lowPriorityEvents) {
    assert.equal(NOTIFICATION_PRIORITY_MAP[e], -1,
      `${e} must be priority -1 — ping spam at 0 would train the user to ignore alerts`);
  }
});
