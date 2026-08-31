-- ============================================================
-- Task U4 (v0.35.4) — Unified POS RPC v2 (pgTAP)
-- ครอบคลุม migration: supabase/migrations/20260901000002_unified_pos_rpc.sql
--   A) functions ครบ + grants (service_role เท่านั้น, anon/authenticated ไม่มี)
--   B) auth_user_has_permission delegate → user_has_permission_in_store
--   C) QR v2: executed → receipt → replay (same key+hash) → hash_conflict
--   D) flag false → error up_store_flag_disabled (ไม่ mutate อะไร)
--   E) ราคาไม่ตรง → up_invalid_item; สต๊อกไม่พอ → up_stock_insufficient
--      (rollback สมบูรณ์ — ไม่เหลือ order/item/receipt/สต๊อกเปลี่ยน)
--   F) session หมดอายุ + staff_only → up_session_not_active (ไม่ auto-open)
--      customer_self → auto-open + executed
--   G) staff add-items: pos.use + qr_order_source=false + ไม่หักสต๊อกตอนสร้าง
--      (convention 20260607000006) + audit + replay/conflict + forbidden
--
-- รันด้วย: supabase test db --local
-- หมายเหตุ: RPC v2 ทำงานใน service context (security definer) — การจำลอง JWT
--   ไม่จำเป็นสำหรับเส้นทาง v2; เฉพาะ assert ของ auth_user_has_permission (B)
--   ที่ใช้ SET LOCAL "request.jwt.claims" ตาม pattern ของ 001
-- ============================================================

BEGIN;
SELECT plan(52);

-- ============================================================
-- FIXTURES (uuid คงที่, hex เท่านั้น, prefix 3333 กันชนกับ seed/U2)
--   org O มี 3 ร้าน: SA (table_bound+customer_self, flag on), SB (flag off),
--                    SC (staff_only, flag on)
--   users: UA owner, UC cashier, UB ไม่มี membership
-- ============================================================
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  phone, confirmation_token, recovery_token, email_change, email_change_token_new, phone_change, phone_change_token, reauthentication_token
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-3333-0000-0000-000000000001', 'authenticated', 'authenticated', 'u4-owner@demo.local',    extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-3333-0000-0000-000000000002', 'authenticated', 'authenticated', 'u4-outsider@demo.local', extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-3333-0000-0000-000000000003', 'authenticated', 'authenticated', 'u4-cashier@demo.local',  extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organizations (id, name, slug, owner_id) VALUES
  ('aaaaaaaa-3333-0000-0000-000000000001', 'U4 Org', 'u4-org', '00000000-3333-0000-0000-000000000001');

INSERT INTO stores (id, organization_id, name, slug, qr_ordering_enabled, unified_pos_enabled, qr_ordering_mode, table_open_policy) VALUES
  ('cccccccc-3333-0000-0000-000000000001', 'aaaaaaaa-3333-0000-0000-000000000001', 'U4 Store A', 'u4-store-a', true, true,  'table_bound', 'customer_self'),
  ('cccccccc-3333-0000-0000-000000000002', 'aaaaaaaa-3333-0000-0000-000000000001', 'U4 Store B', 'u4-store-b', true, false, 'table_bound', 'customer_self'),
  ('cccccccc-3333-0000-0000-000000000003', 'aaaaaaaa-3333-0000-0000-000000000001', 'U4 Store C', 'u4-store-c', true, true,  'table_bound', 'staff_only');

INSERT INTO memberships (id, organization_id, store_id, user_id, role, joined_at) VALUES
  ('bbbbbbbb-3333-0000-0000-000000000001', 'aaaaaaaa-3333-0000-0000-000000000001', NULL, '00000000-3333-0000-0000-000000000001', 'owner',   NOW()),
  ('bbbbbbbb-3333-0000-0000-000000000002', 'aaaaaaaa-3333-0000-0000-000000000001', NULL, '00000000-3333-0000-0000-000000000003', 'cashier', NOW());

INSERT INTO kitchen_stations (id, organization_id, store_id, name) VALUES
  ('eeeeeeee-3333-0000-0000-000000000004', 'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001', 'U4 Station');

INSERT INTO categories (id, organization_id, store_id, name) VALUES
  ('eeeeeeee-3333-0000-0000-000000000001', 'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001', 'U4 Category');

INSERT INTO products (id, organization_id, store_id, category_id, name, base_price, available_for_qr, kitchen_station_id) VALUES
  ('eeeeeeee-3333-0000-0000-000000000002', 'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001', 'eeeeeeee-3333-0000-0000-000000000001', 'U4 Product', 50, true, 'eeeeeeee-3333-0000-0000-000000000004');

INSERT INTO product_variants (id, product_id, name, price_adjustment, is_active, track_stock, stock_quantity) VALUES
  ('eeeeeeee-3333-0000-0000-000000000003', 'eeeeeeee-3333-0000-0000-000000000002', 'U4 Size', 0, true, true, 10);

INSERT INTO modifier_groups (id, product_id, name, selection_type, is_required, min_selections, max_selections) VALUES
  ('44444444-3333-0000-0000-000000000001', 'eeeeeeee-3333-0000-0000-000000000002', 'U4 Group', 'single', true, 1, 1);

INSERT INTO modifier_options (id, modifier_group_id, name, price_adjustment, is_active) VALUES
  ('55555555-3333-0000-0000-000000000001', '44444444-3333-0000-0000-000000000001', 'U4 Option', 0, true);

INSERT INTO tables (id, organization_id, store_id, number, label, seats, is_active, qr_enabled, status) VALUES
  ('ffffffff-3333-0000-0000-000000000001', 'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001', '1', 'U4 Table A1', 4, true, true, 'available'),
  ('ffffffff-3333-0000-0000-000000000003', 'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000003', '3', 'U4 Table C3', 4, true, true, 'available');

-- โต๊ะ C3 มี session หมดอายุแล้ว (staff_only → ห้าม auto-open)
UPDATE tables
   SET session_started_at = now() - interval '2 hours',
       session_expires_at = now() - interval '1 hour'
 WHERE id = 'ffffffff-3333-0000-0000-000000000003';

-- item ที่ใช้ทดสอบ: 50 (base) + 0 (variant) + 0 (modifier) = 50/ชิ้น
CREATE TEMP TABLE u4_item AS
  SELECT $j$[{"product_id":"eeeeeeee-3333-0000-0000-000000000002",
              "product_name":"U4 Product",
              "variant_id":"eeeeeeee-3333-0000-0000-000000000003",
              "variant_name":"U4 Size",
              "modifiers":[{"option":{"id":"55555555-3333-0000-0000-000000000001","name":"U4 Option","priceAdjustment":0}}],
              "quantity":2,"unit_price":50,"total_price":100,"note":null}]$j$::jsonb AS items;

-- ============================================================
-- A) Functions + grants (12 asserts)
-- ============================================================
SELECT has_function('create_qr_order_with_items_v2', 'U4: create_qr_order_with_items_v2 มีอยู่');
SELECT has_function('add_items_to_table_v2', 'U4: add_items_to_table_v2 มีอยู่');
SELECT has_function('unified_pos_submit_table_order', 'U4: engine unified_pos_submit_table_order มีอยู่');
SELECT has_function('unified_pos_validate_order_items', 'U4: validator มีอยู่');
SELECT has_function('user_has_permission_in_store', 'U4: user_has_permission_in_store มีอยู่');

SELECT ok(
  has_function_privilege('service_role', 'public.create_qr_order_with_items_v2(uuid,uuid,uuid,text,text,text,numeric,jsonb)', 'EXECUTE'),
  'U4: service_role เรียก create_qr_order_with_items_v2 ได้'
);
SELECT ok(
  has_function_privilege('service_role', 'public.add_items_to_table_v2(uuid,uuid,uuid,uuid,text,text,text,numeric,jsonb)', 'EXECUTE'),
  'U4: service_role เรียก add_items_to_table_v2 ได้'
);
SELECT ok(
  has_function_privilege('service_role', 'public.unified_pos_submit_table_order(uuid,uuid,uuid,text,text,text,numeric,jsonb,text,uuid)', 'EXECUTE'),
  'U4: service_role เรียก engine ได้'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.create_qr_order_with_items_v2(uuid,uuid,uuid,text,text,text,numeric,jsonb)', 'EXECUTE'),
  'U4: anon เรียก v2 ไม่ได้'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.add_items_to_table_v2(uuid,uuid,uuid,uuid,text,text,text,numeric,jsonb)', 'EXECUTE'),
  'U4: anon เรียก add_items ไม่ได้'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.create_qr_order_with_items_v2(uuid,uuid,uuid,text,text,text,numeric,jsonb)', 'EXECUTE'),
  'U4: authenticated เรียก v2 ไม่ได้'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.unified_pos_submit_table_order(uuid,uuid,uuid,text,text,text,numeric,jsonb,text,uuid)', 'EXECUTE'),
  'U4: authenticated เรียก engine ไม่ได้'
);

-- ============================================================
-- B) auth_user_has_permission delegate (2 asserts)
-- ============================================================
SET LOCAL "request.jwt.claims" = '{"sub":"00000000-3333-0000-0000-000000000001","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT is(
  public.auth_user_has_permission('aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001', 'pos.use'),
  true,
  'U4: auth_user_has_permission (owner) delegate ผ่าน user_has_permission_in_store'
);
RESET ROLE;
SELECT is(
  public.user_has_permission_in_store('00000000-3333-0000-0000-000000000003', 'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001', 'pos.use'),
  true,
  'U4: cashier มี pos.use (ตาม role map เดิม)'
);

-- ============================================================
-- C) QR v2: executed → receipt → replay → hash_conflict (11 asserts)
-- ============================================================
SELECT is(
  (public.create_qr_order_with_items_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', 'U4-0001', 'u4-key-1', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    100, (SELECT items FROM u4_item)
  )->>'status'),
  'executed',
  'U4: first call → executed'
);

SELECT is(
  (SELECT count(*)::int FROM orders
    WHERE store_id = 'cccccccc-3333-0000-0000-000000000001' AND order_number = 'U4-0001'
      AND qr_order_source = true AND status = 'open' AND revision = 2),
  1,
  'U4: order ถูกสร้าง qr_order_source=true revision=2 (1 จาก insert + 1 จาก parent bump ของ item)'
);
SELECT is(
  (SELECT count(*)::int FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.order_number = 'U4-0001' AND oi.fulfillment_status = 'new'
      AND oi.fulfillment_version = 1 AND oi.kitchen_station_id = 'eeeeeeee-3333-0000-0000-000000000004'),
  1,
  'U4: item ถูกสร้าง fulfillment new + station auto-fill'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-3333-0000-0000-000000000003'),
  8,
  'U4: QR path หักสต๊อกตอนสร้าง (10-2=8)'
);
SELECT is(
  (SELECT count(*)::int FROM unified_pos_operation_receipts
    WHERE store_id = 'cccccccc-3333-0000-0000-000000000001' AND operation_key = 'u4-key-1'
      AND operation_type = 'qr_submit' AND request_hash = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'),
  1,
  'U4: receipt ถูกเขียน (commit ใน transaction เดียวกัน)'
);
SELECT is(
  (SELECT count(*)::int FROM audit_logs
    WHERE organization_id = 'aaaaaaaa-3333-0000-0000-000000000001' AND action = 'unified_pos.qr_submit'
      AND request_id = 'u4-key-1'),
  1,
  'U4: audit_logs มี entry ตาม convention'
);

-- replay: same key + same hash → replayed และไม่เพิ่ม order
SELECT is(
  (public.create_qr_order_with_items_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', 'U4-0001', 'u4-key-1', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    100, (SELECT items FROM u4_item)
  )->>'status'),
  'replayed',
  'U4: same key + same hash → replayed'
);
SELECT is(
  (public.create_qr_order_with_items_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', 'U4-0001', 'u4-key-1', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    100, (SELECT items FROM u4_item)
  )->'result'->>'order_id'),
  (SELECT o.id::text FROM orders o WHERE o.order_number = 'U4-0001'),
  'U4: replay คืน order_id เดิม'
);
SELECT is(
  (SELECT count(*)::int FROM orders WHERE store_id = 'cccccccc-3333-0000-0000-000000000001'),
  1,
  'U4: replay ไม่เพิ่ม order'
);

-- hash_conflict: same key + new hash → ห้าม execute
SELECT is(
  (public.create_qr_order_with_items_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', 'U4-0001', 'u4-key-1', 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
    100, (SELECT items FROM u4_item)
  )->>'status'),
  'hash_conflict',
  'U4: same key + new hash → hash_conflict'
);
SELECT is(
  (SELECT count(*)::int FROM orders WHERE store_id = 'cccccccc-3333-0000-0000-000000000001'),
  1,
  'U4: hash_conflict ไม่ mutate (ยัง 1 order)'
);

-- ============================================================
-- D) Flag disabled → up_store_flag_disabled ไม่ mutate (3 asserts)
-- ============================================================
SELECT is(
  (public.create_qr_order_with_items_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000002',
    'ffffffff-3333-0000-0000-000000000001', 'U4-B1', 'u4-key-b', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
    100, (SELECT items FROM u4_item)
  )->>'code'),
  'up_store_flag_disabled',
  'U4: flag false → error code up_store_flag_disabled'
);
SELECT is(
  (SELECT count(*)::int FROM orders WHERE store_id = 'cccccccc-3333-0000-0000-000000000002'),
  0,
  'U4: flag false → ไม่มี order ถูกสร้าง'
);
SELECT is(
  (SELECT count(*)::int FROM unified_pos_operation_receipts WHERE store_id = 'cccccccc-3333-0000-0000-000000000002'),
  0,
  'U4: flag false → ไม่มี receipt'
);

-- ============================================================
-- E) Validation + stock shortage → rollback สมบูรณ์ (6 asserts)
-- ============================================================
-- ราคาไม่ตรง (unit_price 999) → up_invalid_item
SELECT is(
  (public.create_qr_order_with_items_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', 'U4-0002', 'u4-key-2', 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4',
    100,
    $j$[{"product_id":"eeeeeeee-3333-0000-0000-000000000002","product_name":"U4 Product",
         "variant_id":"eeeeeeee-3333-0000-0000-000000000003","variant_name":"U4 Size",
         "modifiers":[],"quantity":1,"unit_price":999,"total_price":999,"note":null}]$j$::jsonb
  )->>'code'),
  'up_invalid_item',
  'U4: ราคาไม่ตรงกับ DB → up_invalid_item'
);
SELECT is(
  (SELECT count(*)::int FROM unified_pos_operation_receipts WHERE operation_key = 'u4-key-2'),
  0,
  'U4: invalid item → ไม่มี receipt'
);

-- สต๊อกไม่พอ (คงเหลือ 8 แต่ขอ 99) → up_stock_insufficient
SELECT is(
  (public.create_qr_order_with_items_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', 'U4-0003', 'u4-key-3', 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
    4950,
    $j$[{"product_id":"eeeeeeee-3333-0000-0000-000000000002","product_name":"U4 Product",
         "variant_id":"eeeeeeee-3333-0000-0000-000000000003","variant_name":"U4 Size",
         "modifiers":[{"option":{"id":"55555555-3333-0000-0000-000000000001","name":"U4 Option","priceAdjustment":0}}],
         "quantity":99,"unit_price":50,"total_price":4950,"note":null}]$j$::jsonb
  )->>'code'),
  'up_stock_insufficient',
  'U4: สต๊อกไม่พอ → up_stock_insufficient'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-3333-0000-0000-000000000003'),
  8,
  'U4: stock shortage → สต๊อกไม่เปลี่ยน'
);
SELECT is(
  (SELECT count(*)::int FROM orders WHERE store_id = 'cccccccc-3333-0000-0000-000000000001'),
  1,
  'U4: stock shortage → rollback สมบูรณ์ (ไม่เหลือ order)'
);
SELECT is(
  (SELECT count(*)::int FROM unified_pos_operation_receipts WHERE store_id = 'cccccccc-3333-0000-0000-000000000001'),
  1,
  'U4: stock shortage → rollback สมบูรณ์ (ไม่เหลือ receipt)'
);

-- ============================================================
-- F) Session: staff_only ห้าม auto-open / customer_self auto-open (6 asserts)
-- ============================================================
SELECT is(
  (public.create_qr_order_with_items_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000003',
    'ffffffff-3333-0000-0000-000000000003', 'U4-C1', 'u4-key-c', 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6',
    100, (SELECT items FROM u4_item)
  )->>'code'),
  'up_session_not_active',
  'U4: session หมดอายุ + staff_only → up_session_not_active'
);
SELECT is(
  (SELECT count(*)::int FROM orders WHERE store_id = 'cccccccc-3333-0000-0000-000000000003'),
  0,
  'U4: staff_only → ไม่สร้าง order'
);
SELECT is(
  (SELECT count(*)::int FROM unified_pos_operation_receipts WHERE operation_key = 'u4-key-c'),
  0,
  'U4: staff_only → ไม่มี receipt'
);
SELECT ok(
  (SELECT session_expires_at < now() FROM tables WHERE id = 'ffffffff-3333-0000-0000-000000000003'),
  'U4: staff_only → session ไม่ถูกเปิดใหม่'
);

-- Store A เป็น customer_self → หมดอายุแล้ว auto-open ได้
UPDATE tables
   SET session_started_at = now() - interval '2 hours',
       session_expires_at = now() - interval '1 hour'
 WHERE id = 'ffffffff-3333-0000-0000-000000000001';

SELECT is(
  (public.create_qr_order_with_items_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', 'U4-0004', 'u4-key-4', 'a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7',
    100, (SELECT items FROM u4_item)
  )->>'status'),
  'executed',
  'U4: customer_self → auto-open session + executed'
);
SELECT ok(
  (SELECT session_started_at > now() - interval '1 minute' AND session_expires_at > now()
   FROM tables WHERE id = 'ffffffff-3333-0000-0000-000000000001'),
  'U4: auto-open ตั้ง session window ใหม่'
);

-- ============================================================
-- G) Staff add-items v2 (14 asserts)
-- ============================================================
SELECT is(
  (public.add_items_to_table_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', '00000000-3333-0000-0000-000000000001',
    'U4-S1', 'u4-key-s1', 'b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8',
    100, (SELECT items FROM u4_item)
  )->>'status'),
  'executed',
  'U4: staff (owner, pos.use) → executed'
);
SELECT is(
  (SELECT count(*)::int FROM orders
    WHERE store_id = 'cccccccc-3333-0000-0000-000000000001' AND order_number = 'U4-S1'
      AND qr_order_source = false AND cashier_id = '00000000-3333-0000-0000-000000000001'),
  1,
  'U4: staff order qr_order_source=false + cashier_id = actor'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-3333-0000-0000-000000000003'),
  6,
  'U4: staff path ไม่หักสต๊อกตอนสร้าง (6 จาก QR k4; หักตอนชำระตาม convention 20260607000006)'
);
SELECT is(
  (SELECT operation_type FROM unified_pos_operation_receipts WHERE operation_key = 'u4-key-s1'),
  'add_items',
  'U4: receipt operation_type = add_items'
);
SELECT is(
  (SELECT count(*)::int FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.order_number = 'U4-S1' AND oi.kitchen_station_id IS NOT NULL),
  1,
  'U4: staff item ได้ kitchen station auto-fill จาก product (ไม่บังคับ)'
);

-- replay + conflict ของ staff key
SELECT is(
  (public.add_items_to_table_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', '00000000-3333-0000-0000-000000000001',
    'U4-S1', 'u4-key-s1', 'b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8',
    100, (SELECT items FROM u4_item)
  )->>'status'),
  'replayed',
  'U4: staff same key + same hash → replayed'
);
SELECT is(
  (public.add_items_to_table_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', '00000000-3333-0000-0000-000000000001',
    'U4-S1', 'u4-key-s1', 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
    100, (SELECT items FROM u4_item)
  )->>'status'),
  'hash_conflict',
  'U4: staff same key + new hash → hash_conflict'
);
SELECT is(
  (SELECT count(*)::int FROM orders WHERE order_number = 'U4-S1'),
  1,
  'U4: staff replay/conflict ไม่เพิ่ม order'
);

-- ผู้เรียกไม่มีสิทธิ์ → up_forbidden
SELECT is(
  (public.add_items_to_table_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001',
    'ffffffff-3333-0000-0000-000000000001', '00000000-3333-0000-0000-000000000002',
    'U4-S2', 'u4-key-s2', 'c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9',
    100, (SELECT items FROM u4_item)
  )->>'code'),
  'up_forbidden',
  'U4: ไม่มี membership/pos.use → up_forbidden'
);
SELECT is(
  (SELECT count(*)::int FROM orders WHERE order_number = 'U4-S2'),
  0,
  'U4: forbidden → ไม่สร้าง order'
);

-- staff กับโต๊ะ staff_only ที่ session หมดอายุ → up_session_not_active (กฎเดิม)
SELECT is(
  (public.add_items_to_table_v2(
    'aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000003',
    'ffffffff-3333-0000-0000-000000000003', '00000000-3333-0000-0000-000000000001',
    'U4-S3', 'u4-key-s3', 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0',
    100, (SELECT items FROM u4_item)
  )->>'code'),
  'up_session_not_active',
  'U4: staff add-items กับ session หมดอายุ → up_session_not_active'
);

-- ท้ายสุด: นับ order รวมของ Store A (U4-0001, U4-0004, U4-S1)
SELECT is(
  (SELECT count(*)::int FROM orders WHERE store_id = 'cccccccc-3333-0000-0000-000000000001'),
  3,
  'U4: สรุป order ของ Store A = 3 (2 QR + 1 staff)'
);

SELECT * FROM finish();
ROLLBACK;
