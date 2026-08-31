// U0 perf baseline (plan: QR Order Voice Unified POS Implementation Plan v2, task U0 check 6)
// Measures p50/p95 for: QR submit RPC, active orders, kitchen fetch, bill fetch, 20-way parallel reads.
// Runs against the LOCAL supabase stack with the seeded dataset (seed.sql @ v0.34.5).
// Env: PERF_SUPABASE_URL (default http://127.0.0.1:54321), PERF_PUBLISHABLE_KEY (required),
//      PERF_OWNER_EMAIL (default owner@demo.local), PERF_OWNER_PASSWORD (default demo1234),
//      PERF_ITERATIONS (default 30), PERF_OUT (default artifacts/unified-pos/u0-perf-baseline.json)
import { createClient } from '@supabase/supabase-js';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const URL = process.env.PERF_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const KEY = process.env.PERF_PUBLISHABLE_KEY;
if (!KEY) { console.error('PERF_PUBLISHABLE_KEY is required'); process.exit(2); }
const EMAIL = process.env.PERF_OWNER_EMAIL ?? 'owner@demo.local';
const PASSWORD = process.env.PERF_OWNER_PASSWORD ?? 'demo1234';
const N = Number(process.env.PERF_ITERATIONS ?? 30);
const OUT = process.env.PERF_OUT ?? 'artifacts/unified-pos/u0-perf-baseline.json';

const ORG = 'aaaaaaaa-0000-0000-0000-000000000001';
const STORE = 'cccccccc-0000-0000-0000-000000000001';
const TABLES = ['eeeeeeee-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000003'];
const PRODUCT = '22222222-0000-0000-0000-000000000001';   // กาแฟดำ base 45
const VARIANT = '33333333-0000-0000-0000-000000000002';   // ใหญ่ (L) +10
const MOD_OPT  = '55555555-0000-0000-0000-000000000003';  // หวานปกติ +0
const UNIT_PRICE = 55, QTY = 1;

const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length + 0.5) - 1 < 0 ? 0 : Math.ceil(q * sorted.length) - 1)];
const stats = (arr) => { const s = [...arr].sort((a,b)=>a-b); const sum = s.reduce((a,b)=>a+b,0); return { n: s.length, p50: quantile(s, .5), p95: quantile(s, .95), min: s[0], max: s[s.length-1], mean: Math.round(sum/s.length*1000)/1000 }; };

const sb = createClient(URL, KEY);
const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (authErr) fail('auth sign-in: ' + authErr.message);
const token = auth.session.access_token;
const db = createClient(URL, KEY, { global: { headers: { Authorization: 'Bearer ' + token } } });
const admin = createClient(URL, process.env.PERF_SECRET_KEY ?? KEY); // service_role (QR RPC is service_role-only, matches production server path)
console.log('auth: ok (owner)');

// enable QR on the seeded store + tables (idempotent)
const { error: e1 } = await db.from('stores').update({ qr_ordering_enabled: true }).eq('id', STORE);
if (e1) fail('enable store qr: ' + e1.message);
const { error: e2 } = await db.from('tables').update({ qr_enabled: true }).eq('store_id', STORE);
const { error: e3 } = await db.from('products').update({ available_for_qr: true }).eq('store_id', STORE);
if (e3) fail('enable product qr: ' + e3.message);
// QR items require an active kitchen station (trigger set_order_item_kitchen_station)
let stationId;
const { data: st0, error: es0 } = await admin.from('kitchen_stations').select('id').eq('store_id', STORE).limit(1);
if (es0) fail('read kitchen_stations: ' + es0.message);
if (st0 && st0.length > 0) { stationId = st0[0].id; }
else {
  const { data: st1, error: es1 } = await admin.from('kitchen_stations').insert({ store_id: STORE, organization_id: ORG, name: 'ครัวหลัก', is_active: true }).select('id').single();
  if (es1) fail('insert kitchen_stations: ' + es1.message);
  stationId = st1.id;
}
const { error: e4 } = await db.from('products').update({ kitchen_station_id: stationId }).eq('store_id', STORE);
if (e4) fail('attach kitchen station: ' + e4.message);
if (e2) fail('enable table qr: ' + e2.message);

const item = { product_id: PRODUCT, product_name: 'กาแฟดำ', variant_id: VARIANT, variant_name: 'ใหญ่ (L)',
  modifiers: [{ option: { id: MOD_OPT } }], quantity: QTY, unit_price: UNIT_PRICE, total_price: UNIT_PRICE * QTY, note: null };

let orderCounter = 0;
const shapes = {
  qr_submit: async () => {
    orderCounter++;
    const { error, data } = await admin.rpc('create_qr_order_with_items', {
      p_organization_id: ORG, p_store_id: STORE, p_table_id: TABLES[orderCounter % 3],
      p_order_number: 'PERF-' + Date.now() + '-' + orderCounter, p_subtotal: UNIT_PRICE * QTY, p_items: [item]
    });
    if (error) throw new Error(error.message);
    return data;
  },
  active_orders: async () => {
    const { error, data } = await db.from('orders').select('id,status,total,table_id,created_at')
      .eq('store_id', STORE).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    return data.length;
  },
  kitchen_fetch: async () => {
    const { error, data } = await db.from('orders').select('id,table_id,status,prep_status,created_at,order_items(id,quantity,product_name,kitchen_station_name,voided)')
      .eq('store_id', STORE).in('status', ['open','confirmed','preparing','ready']).order('created_at').limit(20);
    if (error) throw new Error(error.message);
    return data.length;
  },
  bill_fetch: async () => {
    const { error, data } = await db.from('orders').select('id,status,subtotal,total,created_at,order_items(id,product_name,quantity,unit_price,total_price,voided)')
      .eq('store_id', STORE).order('created_at', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data.length;
  },
  reads_20way: async () => {
    const jobs = [];
    for (let i = 0; i < 20; i++) {
      const t = i % 3;
      jobs.push(t === 0
        ? db.from('tables').select('id,number,status,qr_enabled').eq('store_id', STORE)
        : t === 1
          ? db.from('products').select('id,name,base_price,is_active').eq('store_id', STORE).limit(20)
          : db.from('orders').select('id,status,total').eq('store_id', STORE).limit(20));
    }
    const res = await Promise.all(jobs);
    const err = res.find(r => r.error);
    if (err) throw new Error(err.error.message);
    return res.length;
  }
};

const results = {};
for (const [name, fn] of Object.entries(shapes)) {
  const times = [];
  for (let i = 0; i < 3; i++) { await fn(); } // warmup
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    try { await fn(); } catch (e) { fail(name + ' iteration ' + i + ': ' + e.message); }
    times.push(Math.round((performance.now() - t0) * 1000) / 1000);
  }
  results[name] = stats(times);
  console.log(name + ': ' + JSON.stringify(results[name]));
}

let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}
const payload = {
  schema: 'storeos.u0-perf-baseline/v1',
  captured_at_local: new Date().toISOString(),
  version: JSON.parse(readFileSync("package.json", "utf8")).version,
  commit, dataset: 'supabase/seed.sql (demo dataset)', iterations: N, warmup: 3,
  units: 'milliseconds (client-observed, local stack)',
  results
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log('written: ' + OUT);
