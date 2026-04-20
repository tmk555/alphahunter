// Cleanup script for duplicate pyramid orders caused by the pre-fix
// pyramid-plans.js re-submission bug. Dry-run by default.
//
//   node run-cleanup-mksi-duplicates.js           # audit only, no cancels
//   node run-cleanup-mksi-duplicates.js --apply   # actually cancel duplicates
//
// Uses raw Alpaca REST (not adapter) so client_order_id + parent_order_id
// survive the round-trip.

require('dotenv').config();
const fetch = require('node-fetch');
const { getDB } = require('./src/data/database');
const raw = require('./src/broker/alpaca');

// Local helper: alpaca.js's exported getOrder doesn't forward nested=true.
async function getOrderNested(orderId) {
  const base = (process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets').replace(/\/v2\/?$/, '');
  const r = await fetch(`${base}/v2/orders/${orderId}?nested=true`, {
    headers: {
      'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET,
    },
  });
  if (!r.ok) throw new Error(`getOrderNested ${orderId} → ${r.status}`);
  return r.json();
}

const PLAN_ID = 1;
const SYMBOL  = 'MKSI';
const APPLY   = process.argv.includes('--apply');

(async () => {
  const db = getDB();
  const planRow = db.prepare('SELECT * FROM pyramid_plans WHERE id = ?').get(PLAN_ID);
  if (!planRow) { console.error(`Plan #${PLAN_ID} not found`); process.exit(1); }
  const tranches = JSON.parse(planRow.tranches_json);
  const blessedParentId = tranches[0]?.orderId || null;

  console.log(`\n=== Pyramid plan #${PLAN_ID} (${planRow.symbol}) ===`);
  console.log(`  DB status:         ${planRow.status}`);
  console.log(`  blessed pilot id:  ${blessedParentId || '(none in DB)'}`);

  // Position snapshot
  const positions = await raw.getPositions().catch(() => []);
  const pos = positions.find(p => p.symbol === SYMBOL);
  const longQty = pos ? Number(pos.qty) : 0;
  console.log(`  actual ${SYMBOL} long qty at broker: ${longQty}  (avg $${pos?.avg_entry_price ?? '-'})`);

  // Pull open + filled-today so we can assemble parent→child tree
  const openOrders   = await raw.getOrders({ status: 'open',   limit: 500 });
  const closedOrders = await raw.getOrders({ status: 'closed', limit: 500 });
  const allOrders    = [...openOrders, ...closedOrders].filter(o => o.symbol === SYMBOL);

  const pilotPrefix = `pyramid-${PLAN_ID}-pilot-`;

  // Pilot parents: bracket parents whose client_order_id we issued
  const pilotParents = allOrders.filter(o =>
    (o.client_order_id || '').startsWith(pilotPrefix) && !o.parent_order_id
  );

  // Alpaca doesn't populate parent_order_id on bracket children in the flat
  // order list — child cids are auto-generated UUIDs, not our prefix. Fetch
  // each parent with nested=true to get its leg IDs, then map.
  const childByParent = new Map();
  const childIdToParentId = new Map();
  for (const p of pilotParents) {
    try {
      const nested = await getOrderNested(p.id);
      const legs = (nested && nested.legs) || [];
      childByParent.set(p.id, legs);
      for (const l of legs) childIdToParentId.set(l.id, p.id);
    } catch (e) {
      console.warn(`  could not fetch legs for ${p.id}: ${e.message}`);
      childByParent.set(p.id, []);
    }
  }

  const pilotChildren = [...childByParent.values()].flat();

  // Orphans: MKSI orders that aren't a pilot parent and aren't a linked leg.
  const orphans = openOrders
    .filter(o => o.symbol === SYMBOL)
    .filter(o => !pilotParents.find(p => p.id === o.id))
    .filter(o => !childIdToParentId.has(o.id));

  console.log(`\n─── Pilot parents (${pilotParents.length}) ───`);
  for (const o of pilotParents) {
    const keep = o.id === blessedParentId;
    console.log(`  ${keep ? 'KEEP' : 'KILL'}  ${o.id.slice(0,8)}  status=${o.status}  ${o.side} ${o.qty} filled=${o.filled_qty || 0}  cid=${o.client_order_id}`);
  }

  console.log(`\n─── Pilot children (${pilotChildren.length}) ───`);
  const openKillIds = [];
  for (const o of pilotChildren) {
    // Alpaca legs don't carry parent_order_id — use our map built from nested=true fetch.
    const resolvedParent = childIdToParentId.get(o.id);
    const parentKeep = resolvedParent === blessedParentId;
    const isOpen = !['filled','canceled','cancelled','expired','rejected','done_for_day'].includes(o.status);
    const verdict = !isOpen ? 'SKIP' : (parentKeep ? 'KEEP' : 'KILL');
    if (verdict === 'KILL') openKillIds.push(o.id);
    const px = o.limit_price || o.stop_price || '-';
    console.log(`  ${verdict}  ${o.id.slice(0,8)}  ${o.side} ${o.type} ${o.qty} @ ${px}  status=${o.status}  parent=${resolvedParent?.slice(0,8) || '?'}`);
  }

  if (orphans.length) {
    console.log(`\n─── Open ${SYMBOL} orphans (no pyramid-${PLAN_ID}-* ancestor — NOT touched) ───`);
    for (const o of orphans) {
      const px = o.limit_price || o.stop_price || '-';
      console.log(`  SKIP  ${o.id.slice(0,8)}  ${o.side} ${o.type} ${o.qty} @ ${px}  status=${o.status}  cid=${o.client_order_id}  parent=${o.parent_order_id?.slice(0,8) || '-'}`);
    }
  }

  console.log(`\n─── Summary ───`);
  console.log(`  pilot parents found:        ${pilotParents.length}`);
  console.log(`  pilot children found:       ${pilotChildren.length}`);
  console.log(`  open orphans (untouched):   ${orphans.length}`);
  console.log(`  cancel candidates (open):   ${openKillIds.length}`);
  console.log(`  position size at broker:    ${longQty} shares  (intended pilot: ${tranches[0]?.qty || '?'})`);

  if (!openKillIds.length) {
    console.log(`\n  Nothing to cancel automatically.`);
    console.log(`  If ${SYMBOL} shows duplicate TP/stop orders at Alpaca whose parent order_id is NOT`);
    console.log(`  ${blessedParentId}, they likely have no pyramid-${PLAN_ID}-* cid — either the pilot`);
    console.log(`  cid was generated with a different prefix, or bracket children don't inherit it.`);
    console.log(`  Inspect the JSON for one order:\n`);
    if (openOrders.length) {
      const sample = openOrders.find(o => o.symbol === SYMBOL);
      if (sample) console.log(JSON.stringify(sample, null, 2));
    }
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\n  DRY RUN — re-run with --apply to cancel the ${openKillIds.length} KILL orders.`);
    process.exit(0);
  }

  console.log(`\n  APPLYING cancels on ${openKillIds.length} orders...`);
  let ok = 0, fail = 0;
  for (const id of openKillIds) {
    try { await raw.cancelOrder(id); console.log(`    cancelled ${id}`); ok++; }
    catch (e) { console.warn(`    FAILED   ${id}  ${e.message}`); fail++; }
  }
  console.log(`\n  done: ${ok} cancelled, ${fail} failed`);

  // Post-audit
  const after = (await raw.getOrders({ status: 'open', limit: 500 })).filter(o => o.symbol === SYMBOL);
  console.log(`\n  remaining open ${SYMBOL} orders: ${after.length}`);
  for (const o of after) {
    console.log(`    ${o.id.slice(0,8)}  ${o.side} ${o.type} ${o.qty} @ ${o.limit_price || o.stop_price || '-'}  status=${o.status}`);
  }

  process.exit(0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
