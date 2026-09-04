// ตรวจ Stock Pool ครบวงจรบน Postgres จริง (local supabase) — ตัด/คืน/กันติดลบ
//
// รัน: npm run verify:stock-pool  (ต้อง supabase local ขึ้นอยู่ + db reset มาแล้ว)
// ทุกอย่างอยู่ใน transaction เดียวและ rollback เสมอ จึงไม่ทิ้งข้อมูลค้างในฐาน
import pg from 'pg';

const DB_URL = process.env.LOCAL_SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const c = new pg.Client({ connectionString: DB_URL });
await c.connect();

const q = async (sql, params) => (await c.query(sql, params)).rows;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

await c.query('begin');
try {
  // ---- ตั้งข้อมูลตั้งต้น (org/store/category/product/variant/table) ----
  const [{ id: userId }] = await q(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             'pool-smoke@example.com', '', now(), now(), now())
     returning id`,
  );
  const [{ id: orgId }] = await q(
    `insert into organizations (name, slug, owner_id) values ('Pool Smoke', 'pool-smoke-' || substr(gen_random_uuid()::text,1,8), $1) returning id`,
    [userId],
  );
  const [{ id: storeId }] = await q(
    `insert into stores (organization_id, name, slug, qr_ordering_enabled) values ($1, 'Smoke Store', 'smoke-' || substr(gen_random_uuid()::text,1,8), true) returning id`,
    [orgId],
  );
  const [{ id: catId }] = await q(
    `insert into categories (organization_id, store_id, name) values ($1, $2, 'Drinks') returning id`,
    [orgId, storeId],
  );
  const [{ id: stationId }] = await q(
    `insert into kitchen_stations (organization_id, store_id, name) values ($1, $2, 'Bar') returning id`,
    [orgId, storeId],
  );
  const [{ id: productId }] = await q(
    `insert into products (organization_id, store_id, category_id, name, base_price, available_for_qr, available_for_pos, kitchen_station_id)
     values ($1, $2, $3, 'Singha', 60, true, true, $4) returning id`,
    [orgId, storeId, catId, stationId],
  );
  const [{ id: v1 }] = await q(
    `insert into product_variants (product_id, name, price_adjustment, track_stock, stock_quantity)
     values ($1, '1 ขวด', 0, true, 0) returning id`,
    [productId],
  );
  const [{ id: v3 }] = await q(
    `insert into product_variants (product_id, name, price_adjustment, track_stock, stock_quantity)
     values ($1, '3 ขวด', 100, true, 0) returning id`,
    [productId],
  );
  const [{ id: tableId }] = await q(
    `insert into tables (organization_id, store_id, number, qr_enabled) values ($1, $2, 'T1', true) returning id`,
    [orgId, storeId],
  );

  // ---- Pool เดียวใช้ร่วมสอง variant (1 ขวด = 1 หน่วย, 3 ขวด = 3 หน่วย) ----
  const [{ id: poolId }] = await q(
    `insert into stock_pools (organization_id, store_id, name, unit_label, quantity, low_stock_threshold)
     values ($1, $2, 'Singha (ขวด)', 'ขวด', 0, 5) returning id`,
    [orgId, storeId],
  );
  await q(`insert into variant_stock_links (variant_id, stock_pool_id, consumption_quantity) values ($1, $2, 1)`, [v1, poolId]);
  await q(`insert into variant_stock_links (variant_id, stock_pool_id, consumption_quantity) values ($1, $2, 3)`, [v3, poolId]);
  await q(
    `insert into stock_movements (stock_pool_id, movement_type, quantity_delta, before_quantity, after_quantity, reason)
     values ($1, 'receive', 20, 0, 20, 'smoke setup')`,
    [poolId],
  );
  await q(`update stock_pools set quantity = 20 where id = $1`, [poolId]);

  const poolQty = async () => (await q(`select quantity from stock_pools where id = $1`, [poolId]))[0].quantity;
  const variantQty = async (id) => (await q(`select stock_quantity from product_variants where id = $1`, [id]))[0].stock_quantity;

  // ---- 1) QR order (v1 legacy path): 2 × "3 ขวด" = 6 หน่วย ----
  const items = JSON.stringify([{
    product_id: productId, product_name: 'Singha', variant_id: v3, variant_name: '3 ขวด',
    modifiers: [], quantity: 2, unit_price: 160, total_price: 320, note: null,
  }]);
  const [{ create_qr_order_with_items: orderId }] = await q(
    `select create_qr_order_with_items($1, $2, $3, 'SM-1', 320, $4::jsonb)`,
    [orgId, storeId, tableId, items],
  );
  check('QR order หัก Pool ตามสูตรตัด (20 − 2×3)', (await poolQty()) === 14, `pool=${await poolQty()}`);
  check('QR order ไม่แตะ variant stock ที่ผูก Pool', (await variantQty(v3)) === 0);

  const [snap] = await q(`select stock_pool_id, stock_pool_name, stock_units_per_item from order_items where order_id = $1`, [orderId]);
  check('order_item ถือ snapshot ของ Pool', snap.stock_pool_id === poolId && snap.stock_units_per_item === 3, JSON.stringify(snap));

  const [sale] = await q(`select quantity_delta, before_quantity, after_quantity from stock_movements where reference_id = $1 and movement_type = 'sale'`, [orderId]);
  check('มี ledger sale ผูกกับออเดอร์', sale && sale.quantity_delta === -6 && sale.after_quantity === 14, JSON.stringify(sale));

  // ---- 2) ยกเลิกออเดอร์ → คืน Pool ครบ ----
  await q(`select cancel_qr_order_by_customer($1, $2, $3)`, [storeId, tableId, orderId]);
  check('ยกเลิกออเดอร์คืน Pool ครบ', (await poolQty()) === 20, `pool=${await poolQty()}`);
  check('ยกเลิกแล้วไม่คืนเข้า variant stock ซ้ำ', (await variantQty(v3)) === 0);

  // ---- 3) กันคืนซ้ำ ----
  let doubleRestoreBlocked = false;
  try {
    await q('savepoint sp1');
    await q(`select restore_cancelled_order_stock_pools($1, $2, $3, null)`, [orderId, storeId, orgId]);
    await q('rollback to savepoint sp1');
  } catch {
    doubleRestoreBlocked = true;
    await q('rollback to savepoint sp1');
  }
  check('คืนซ้ำถูกปฏิเสธ', doubleRestoreBlocked);

  // ---- 4) สั่งเกินยอด Pool ต้องถูกบล็อก ----
  const tooMany = JSON.stringify([{
    product_id: productId, product_name: 'Singha', variant_id: v3, variant_name: '3 ขวด',
    modifiers: [], quantity: 7, unit_price: 160, total_price: 1120, note: null,
  }]);
  let blocked = null;
  try {
    await q('savepoint sp2');
    await q(`select create_qr_order_with_items($1, $2, $3, 'SM-2', 1120, $4::jsonb)`, [orgId, storeId, tableId, tooMany]);
    await q('rollback to savepoint sp2');
  } catch (e) {
    blocked = e.message;
    await q('rollback to savepoint sp2');
  }
  check('สั่งเกินยอด Pool ถูกบล็อก (7×3 > 20)', blocked !== null, blocked ?? '');
  check('บล็อกแล้ว Pool ไม่เปลี่ยน', (await poolQty()) === 20, `pool=${await poolQty()}`);

  // ---- 5) helper ตรวจสต๊อกของ Unified POS ----
  const upItems = JSON.stringify([{ variant_id: v3, quantity: 7 }]);
  const [{ unified_pos_items_stock_pool_shortfall: short }] = await q(
    `select unified_pos_items_stock_pool_shortfall($1, $2, $3::jsonb)`, [storeId, orgId, upItems],
  );
  check('unified helper บอกชื่อ Pool ที่ไม่พอ', short === 'Singha (ขวด)', String(short));
  const [{ unified_pos_items_stock_pool_shortfall: ok }] = await q(
    `select unified_pos_items_stock_pool_shortfall($1, $2, $3::jsonb)`,
    [storeId, orgId, JSON.stringify([{ variant_id: v1, quantity: 5 }])],
  );
  check('unified helper ผ่านเมื่อสต๊อกพอ', ok === null, String(ok));

  // ---- 6) บิลพนักงาน (POS): หักตอนชำระ ไม่ใช่ตอนสร้าง ----
  const [{ id: posOrderId }] = await q(
    `insert into orders (organization_id, store_id, order_number, status, subtotal, discount, total, qr_order_source)
     values ($1, $2, 'POS-1', 'open', 60, 0, 60, false) returning id`,
    [orgId, storeId],
  );
  await q(
    `insert into order_items (order_id, product_id, product_name, variant_id, variant_name, quantity, unit_price, total_price)
     values ($1, $2, 'Singha', $3, '1 ขวด', 4, 60, 240)`,
    [posOrderId, productId, v1],
  );
  await q(`select snapshot_order_item_stock_pools($1, $2, $3)`, [posOrderId, storeId, orgId]);
  check('POS: snapshot แล้วยังไม่หัก Pool', (await poolQty()) === 20, `pool=${await poolQty()}`);
  await q(`select deduct_order_stock_pools($1, $2, $3, null)`, [posOrderId, storeId, orgId]);
  check('POS: ชำระแล้วหัก Pool 4 หน่วย', (await poolQty()) === 16, `pool=${await poolQty()}`);

  // ---- 7) void รายรายการของบิลที่หักแล้ว → คืนเฉพาะรายการนั้น ----
  const [{ id: itemId }] = await q(`select id from order_items where order_id = $1`, [posOrderId]);
  const [{ restore_voided_order_item_stock_pool: managed }] = await q(
    `select restore_voided_order_item_stock_pool($1, $2, $3, $4, 'smoke void', null)`,
    [posOrderId, itemId, storeId, orgId],
  );
  check('helper บอกว่ารายการอยู่ใต้ Pool', managed === true);
  check('void แล้วคืน Pool กลับเป็น 20', (await poolQty()) === 20, `pool=${await poolQty()}`);

  // ---- 8) ปิดใช้งาน Pool แล้วบิลที่เปิดค้างต้องยังปิดได้ ----
  await q(`update stock_pools set is_active = false where id = $1`, [poolId]);
  const [{ id: order2 }] = await q(
    `insert into orders (organization_id, store_id, order_number, status, subtotal, discount, total, qr_order_source)
     values ($1, $2, 'POS-2', 'open', 60, 0, 60, false) returning id`,
    [orgId, storeId],
  );
  await q(
    `insert into order_items (order_id, product_id, product_name, variant_id, variant_name, quantity, unit_price, total_price)
     values ($1, $2, 'Singha', $3, '1 ขวด', 1, 60, 60)`,
    [order2, productId, v1],
  );
  let closedOk = true;
  let closeErr = '';
  try {
    await q(`select snapshot_order_item_stock_pools($1, $2, $3)`, [order2, storeId, orgId]);
    await q(`select deduct_order_stock_pools($1, $2, $3, null)`, [order2, storeId, orgId]);
  } catch (e) {
    closedOk = false;
    closeErr = e.message;
  }
  check('Pool ถูกปิดใช้งานแล้วยังปิดบิลที่ค้างได้', closedOk, closeErr);
  await q(`update stock_pools set is_active = true where id = $1`, [poolId]);

  // ---- 9) variant ที่ไม่ผูก Pool ยังใช้เส้นทางเดิม ----
  const [{ id: vFree }] = await q(
    `insert into product_variants (product_id, name, price_adjustment, track_stock, stock_quantity)
     values ($1, 'ไม่ผูก Pool', 0, true, 10) returning id`,
    [productId],
  );
  const legacyItems = JSON.stringify([{
    product_id: productId, product_name: 'Singha', variant_id: vFree, variant_name: 'ไม่ผูก Pool',
    modifiers: [], quantity: 2, unit_price: 60, total_price: 120, note: null,
  }]);
  await q(`select create_qr_order_with_items($1, $2, $3, 'SM-3', 120, $4::jsonb)`, [orgId, storeId, tableId, legacyItems]);
  check('variant ที่ไม่ผูก Pool ยังตัด stock_quantity เดิม', (await variantQty(vFree)) === 8, `qty=${await variantQty(vFree)}`);

  console.log('');
  const failed = results.filter((r) => !r.pass);
  console.log(`สรุป: ${results.length - failed.length}/${results.length} ผ่าน`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await c.query('rollback');
  await c.end();
}
