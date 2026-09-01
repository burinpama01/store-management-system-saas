-- ============================================================
-- Task U5 (v0.35.5) — Versioned item fulfillment + order prep derive (pgTAP)
-- ครอบคลุม migration: supabase/migrations/20260901000003_unified_pos_fulfillment.sql
--   A) functions ครบ + grants (service_role เท่านั้น)
--   B) orders.prep_status CHECK เพิ่ม 'ready' โดยคง 'done'
--   C) transition matrix new→preparing→ready→served + derive order prep หลังทุก step
--   D) reject reverse / skip / same / stale version / target นอก enum
--   E) voided guard + derive 'done' เมื่อไม่มี active item + paid → 'done'
--   F) trigger gating: ร้านปิด flag ไม่ derive (legacy คงเดิม), ร้านเปิด flag
--      derive แม้เขียนตรงด้วย SQL (ครอบทุกเส้นทาง)
--   G) flag off → up_store_flag_disabled / ไม่มี membership → up_forbidden /
--      cross-store → up_not_found
--   H) customer cancel: ok (cancelled + prep done + คืนสต๊อกเฉพาะ active) /
--      replay / item ถูกเตรียมแล้ว / ไม่ใช่ QR / ชำระแล้ว → up_cancel_not_allowed
--
-- รันด้วย: supabase test db --local
-- ============================================================

BEGIN;
SELECT plan(48);

-- ============================================================
-- FIXTURES (uuid คงที่, hex เท่านั้น, prefix 4444 กันชนกับ seed/U2-U4)
--   org O มี 3 ร้าน: SA (flag on), SB (flag off), SC (flag on — ใช้ทดสอบ cross-store)
--   users: UA owner, UB ไม่มี membership, UC cashier
-- ============================================================
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  phone, confirmation_token, recovery_token, email_change, email_change_token_new, phone_change, phone_change_token, reauthentication_token
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-4444-0000-0000-000000000001', 'authenticated', 'authenticated', 'u5-owner@demo.local',    extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-4444-0000-0000-000000000002', 'authenticated', 'authenticated', 'u5-outsider@demo.local', extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-4444-0000-0000-000000000003', 'authenticated', 'authenticated', 'u5-cashier@demo.local',  extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organizations (id, name, slug, owner_id) VALUES
  ('aaaaaaaa-4444-0000-0000-000000000001', 'U5 Org', 'u5-org', '00000000-4444-0000-0000-000000000001');

INSERT INTO stores (id, organization_id, name, slug, qr_ordering_enabled, unified_pos_enabled) VALUES
  ('cccccccc-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000001', 'U5 Store A', 'u5-store-a', true, true),
  ('cccccccc-4444-0000-0000-000000000002', 'aaaaaaaa-4444-0000-0000-000000000001', 'U5 Store B', 'u5-store-b', true, false),
  ('cccccccc-4444-0000-0000-000000000003', 'aaaaaaaa-4444-0000-0000-000000000001', 'U5 Store C', 'u5-store-c', true, true);

INSERT INTO memberships (id, organization_id, store_id, user_id, role, joined_at) VALUES
  ('bbbbbbbb-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000001', NULL, '00000000-4444-0000-0000-000000000001', 'owner',   NOW()),
  ('bbbbbbbb-4444-0000-0000-000000000002', 'aaaaaaaa-4444-0000-0000-000000000001', NULL, '00000000-4444-0000-0000-000000000003', 'cashier', NOW());

INSERT INTO tables (id, organization_id, store_id, number, label, seats, is_active, qr_enabled, status) VALUES
  ('ffffffff-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', '1', 'U5 Table A1', 4, true, true, 'available'),
  ('ffffffff-4444-0000-0000-000000000002', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000002', '2', 'U5 Table B2', 2, true, true, 'available');

INSERT INTO categories (id, organization_id, store_id, name) VALUES
  ('eeeeeeee-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'U5 Category');

-- kitchen station (trigger set_order_item_kitchen_station บังคับ QR item ต้องมี station)
INSERT INTO kitchen_stations (id, organization_id, store_id, name) VALUES
  ('eeeeeeee-4444-0000-0000-000000000004', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'U5 Station');

INSERT INTO products (id, organization_id, store_id, category_id, name, base_price, available_for_qr, kitchen_station_id) VALUES
  ('eeeeeeee-4444-0000-0000-000000000002', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000001', 'U5 Product', 50, true, 'eeeeeeee-4444-0000-0000-000000000004');

INSERT INTO product_variants (id, product_id, name, price_adjustment, is_active, track_stock, stock_quantity) VALUES
  ('eeeeeeee-4444-0000-0000-000000000003', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Size', 0, true, true, 10);

-- ออเดอร์ fixture (เขียนตรงเพื่อ setup เท่านั้น — product path ผ่าน RPC)
-- O1: rejects + void (3 items) / O2: cancel ok / O3: cancel reject (item ถูกเตรียม) /
-- O4: ไม่ใช่ QR / O5: SB flag off / O6: cross-store source (SA) / O7: full matrix (2 items)
INSERT INTO orders (id, organization_id, store_id, order_number, status, table_id, subtotal, discount, total, qr_order_source) VALUES
  ('aaaaaaaa-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'U5-O1', 'open', 'ffffffff-4444-0000-0000-000000000001', 150, 0, 150, true),
  ('aaaaaaaa-4444-0000-0000-000000000002', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'U5-O2', 'open', 'ffffffff-4444-0000-0000-000000000001', 100, 0, 100, true),
  ('aaaaaaaa-4444-0000-0000-000000000003', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'U5-O3', 'open', 'ffffffff-4444-0000-0000-000000000001', 50,  0, 50,  true),
  ('aaaaaaaa-4444-0000-0000-000000000004', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'U5-O4', 'open', 'ffffffff-4444-0000-0000-000000000001', 50,  0, 50,  false),
  ('aaaaaaaa-4444-0000-0000-000000000005', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000002', 'U5-O5', 'open', 'ffffffff-4444-0000-0000-000000000002', 50,  0, 50,  true),
  ('aaaaaaaa-4444-0000-0000-000000000006', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'U5-O6', 'open', 'ffffffff-4444-0000-0000-000000000001', 50,  0, 50,  true),
  ('aaaaaaaa-4444-0000-0000-000000000007', 'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'U5-O7', 'open', 'ffffffff-4444-0000-0000-000000000001', 100, 0, 100, true);

INSERT INTO order_items (id, order_id, product_id, product_name, variant_id, quantity, unit_price, total_price) VALUES
  ('eeeeeeee-4444-0000-0000-000000000011', 'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000012', 'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000013', 'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000021', 'aaaaaaaa-4444-0000-0000-000000000002', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000022', 'aaaaaaaa-4444-0000-0000-000000000002', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000031', 'aaaaaaaa-4444-0000-0000-000000000003', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000041', 'aaaaaaaa-4444-0000-0000-000000000004', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000051', 'aaaaaaaa-4444-0000-0000-000000000005', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000061', 'aaaaaaaa-4444-0000-0000-000000000006', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000017', 'aaaaaaaa-4444-0000-0000-000000000007', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-4444-0000-0000-000000000018', 'aaaaaaaa-4444-0000-0000-000000000007', 'eeeeeeee-4444-0000-0000-000000000002', 'U5 Product', 'eeeeeeee-4444-0000-0000-000000000003', 1, 50, 50);

-- ตัวย่อของ RPC (positional args ตาม signature)
\set UA '00000000-4444-0000-0000-000000000001'
\set UB '00000000-4444-0000-0000-000000000002'

-- ============================================================
-- A) Functions + grants (8 asserts)
-- ============================================================
SELECT has_function('unified_pos_update_item_fulfillment', 'U5: unified_pos_update_item_fulfillment มีอยู่');
SELECT has_function('unified_pos_cancel_table_order', 'U5: unified_pos_cancel_table_order มีอยู่');
SELECT has_function('unified_pos_derive_order_prep_status', 'U5: unified_pos_derive_order_prep_status มีอยู่');

SELECT ok(
  has_function_privilege('service_role', 'public.unified_pos_update_item_fulfillment(uuid,uuid,uuid,uuid,bigint,text,text,text,uuid)', 'EXECUTE'),
  'U5: service_role เรียก unified_pos_update_item_fulfillment ได้'
);
SELECT ok(
  has_function_privilege('service_role', 'public.unified_pos_cancel_table_order(uuid,uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'U5: service_role เรียก unified_pos_cancel_table_order ได้'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.unified_pos_update_item_fulfillment(uuid,uuid,uuid,uuid,bigint,text,text,text,uuid)', 'EXECUTE'),
  'U5: anon เรียก update_item_fulfillment ไม่ได้'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.unified_pos_update_item_fulfillment(uuid,uuid,uuid,uuid,bigint,text,text,text,uuid)', 'EXECUTE'),
  'U5: authenticated เรียก update_item_fulfillment ไม่ได้'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.unified_pos_cancel_table_order(uuid,uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'U5: anon เรียก cancel_table_order ไม่ได้'
);

-- ============================================================
-- B) prep_status CHECK เพิ่ม 'ready' คง 'done' (2 asserts)
-- ============================================================
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'orders' AND con.conname = 'orders_prep_status_ready_check'
  ),
  'U5: constraint orders_prep_status_ready_check มีอยู่'
);
SELECT ok(
  (SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con
   JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'orders' AND con.conname = 'orders_prep_status_ready_check')
  LIKE '%ready%' AND
  (SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con
   JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'orders' AND con.conname = 'orders_prep_status_ready_check')
  LIKE '%done%',
  'U5: CHECK มีทั้ง ready และ done'
);

-- ============================================================
-- C) Transition matrix + derive หลังทุก step (13 asserts)
--     O7: item 17, 18 (all new) — เดินครบ new→preparing→ready→served
-- ============================================================
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000007', 'eeeeeeee-4444-0000-0000-000000000017',
    1, 'preparing', 'u5-key-c1', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', :'UA'
  )->>'status'),
  'executed',
  'U5: new → preparing (item 1) = executed'
);
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000007'),
  'preparing',
  'U5: derive หลัง item 1 preparing (mixed new+preparing) = preparing'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000007', 'eeeeeeee-4444-0000-0000-000000000018',
    1, 'preparing', 'u5-key-c2', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', :'UA'
  )->>'status'),
  'executed',
  'U5: new → preparing (item 2) = executed'
);
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000007'),
  'preparing',
  'U5: derive all preparing = preparing'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000007', 'eeeeeeee-4444-0000-0000-000000000017',
    2, 'ready', 'u5-key-c3', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', :'UA'
  )->>'status'),
  'executed',
  'U5: preparing → ready (item 1) = executed'
);
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000007'),
  'preparing',
  'U5: derive mixed preparing+ready = preparing'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000007', 'eeeeeeee-4444-0000-0000-000000000018',
    2, 'ready', 'u5-key-c4', 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', :'UA'
  )->>'status'),
  'executed',
  'U5: preparing → ready (item 2) = executed'
);
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000007'),
  'ready',
  'U5: derive all ready = ready'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000007', 'eeeeeeee-4444-0000-0000-000000000017',
    3, 'served', 'u5-key-c5', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', :'UA'
  )->>'status'),
  'executed',
  'U5: ready → served (item 1) = executed'
);
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000007'),
  'ready',
  'U5: derive mixed ready+served = ready'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000007', 'eeeeeeee-4444-0000-0000-000000000018',
    3, 'served', 'u5-key-c6', 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', :'UA'
  )->>'status'),
  'executed',
  'U5: ready → served (item 2) = executed'
);
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000007'),
  'served',
  'U5: derive all served = served'
);
SELECT is(
  (SELECT fulfillment_version FROM order_items WHERE id = 'eeeeeeee-4444-0000-0000-000000000018'),
  4::bigint,
  'U5: fulfillment_version bump ทุก move (item 2 = 4)'
);

-- ============================================================
-- D) Reject: skip / reverse / same / stale / target นอก enum (7 asserts)
--     O1: item 11, 12, 13 (all new)
-- ============================================================
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000013',
    1, 'ready', 'u5-key-d1', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', :'UA'
  )->>'code'),
  'up_invalid_state_transition',
  'U5: skip new → ready = up_invalid_state_transition'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000011',
    1, 'preparing', 'u5-key-d1b', 'cbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcb', :'UA'
  )->>'status'),
  'executed',
  'U5: setup item 11 → preparing (สำหรับทดสอบ reverse/same)'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000011',
    2, 'new', 'u5-key-d2', 'c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4', :'UA'
  )->>'code'),
  'up_invalid_state_transition',
  'U5: reverse preparing → new = up_invalid_state_transition'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000011',
    2, 'preparing', 'u5-key-d3', 'c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5', :'UA'
  )->>'code'),
  'up_invalid_state_transition',
  'U5: same status preparing → preparing = up_invalid_state_transition'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000012',
    0, 'preparing', 'u5-key-d4', 'c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6', :'UA'
  )->>'code'),
  'up_stale_version',
  'U5: expected version เก่า = up_stale_version'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000013',
    1, 'voided', 'u5-key-d5', 'd7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7', :'UA'
  )->>'code'),
  'up_invalid_state_transition',
  'U5: target นอก enum (voided) = up_invalid_state_transition'
);
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000001'),
  'preparing',
  'U5: rejects ทั้งหมดไม่เปลี่ยน prep status (mixed new+preparing)'
);

-- ============================================================
-- E) Voided guard + derive 'done' เมื่อไม่เหลือ active + paid → done (4 asserts)
--     (void ด้วย fixture UPDATE ตรง — พิสูจน์ว่า trigger derive ครอบ direct SQL)
-- ============================================================
UPDATE order_items SET voided = true, voided_reason = 'ของหมด' WHERE id = 'eeeeeeee-4444-0000-0000-000000000013';
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000001'),
  'preparing',
  'U5: void รายการ new → derive preparing (active ยังมี preparing+new ผสม)'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000001', 'eeeeeeee-4444-0000-0000-000000000013',
    2, 'preparing', 'u5-key-e2', 'd8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8', :'UA'
  )->>'code'),
  'up_invalid_item',
  'U5: voided item → up_invalid_item'
);
UPDATE order_items SET voided = true WHERE id IN ('eeeeeeee-4444-0000-0000-000000000011', 'eeeeeeee-4444-0000-0000-000000000012');
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000001'),
  'done',
  'U5: void ทุก active item → derive done (trigger ครอบ direct SQL)'
);
UPDATE orders SET status = 'paid', paid_at = now() WHERE id = 'aaaaaaaa-4444-0000-0000-000000000001';
SELECT is(
  (public.unified_pos_derive_order_prep_status('aaaaaaaa-4444-0000-0000-000000000001')),
  'done',
  'U5: order paid → derive done'
);

-- ============================================================
-- F) Trigger gating: ร้านปิด flag = ไม่ derive (legacy คงเดิม) (1 assert)
-- ============================================================
UPDATE order_items SET fulfillment_status = 'preparing' WHERE id = 'eeeeeeee-4444-0000-0000-000000000051';
SELECT is(
  (SELECT prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000005'),
  'new',
  'U5: ร้านปิด flag — item เปลี่ยนแต่ prep ไม่ถูก derive ทับ (legacy)'
);

-- ============================================================
-- G) Guards: flag off / forbidden / cross-store (4 asserts)
-- ============================================================
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000002',
    'aaaaaaaa-4444-0000-0000-000000000005', 'eeeeeeee-4444-0000-0000-000000000051',
    2, 'ready', 'u5-key-g1', 'e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9', :'UA'
  )->>'code'),
  'up_store_flag_disabled',
  'U5: ร้านปิด flag → up_store_flag_disabled'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000006', 'eeeeeeee-4444-0000-0000-000000000061',
    1, 'preparing', 'u5-key-g2', 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', :'UB'
  )->>'code'),
  'up_forbidden',
  'U5: actor ไม่มี membership → up_forbidden'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000003',
    'aaaaaaaa-4444-0000-0000-000000000006', 'eeeeeeee-4444-0000-0000-000000000061',
    1, 'preparing', 'u5-key-g3', 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', :'UA'
  )->>'code'),
  'up_not_found',
  'U5: order ของร้านอื่น (cross-store) → up_not_found'
);
SELECT is(
  (SELECT fulfillment_status FROM order_items WHERE id = 'eeeeeeee-4444-0000-0000-000000000061'),
  'new',
  'U5: cross-store / forbidden ไม่ mutate item'
);

-- ============================================================
-- H) Customer cancel (5 asserts) — O2 (2 items, all new, open, unpaid)
-- ============================================================
SELECT is(
  (public.unified_pos_cancel_table_order(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'ffffffff-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000002',
    'u5-key-h1', 'b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3'
  )->>'status'),
  'executed',
  'U5: customer cancel (all new + unpaid + open) = executed'
);
SELECT is(
  (SELECT status || '/' || prep_status FROM orders WHERE id = 'aaaaaaaa-4444-0000-0000-000000000002'),
  'cancelled/done',
  'U5: cancel สำเร็จ → status cancelled + prep done'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-4444-0000-0000-000000000003'),
  12::int,
  'U5: คืนสต๊อกเฉพาะ active items (10 + 2)'
);
SELECT is(
  (public.unified_pos_cancel_table_order(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'ffffffff-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000002',
    'u5-key-h1', 'b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3'
  )->>'status'),
  'replayed',
  'U5: same key + same hash → replayed'
);
SELECT is(
  (public.unified_pos_cancel_table_order(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'ffffffff-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000002',
    'u5-key-h1', 'b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4'
  )->>'status'),
  'hash_conflict',
  'U5: same key ต่าง hash → hash_conflict'
);

-- cancel reject: item ถูกเตรียมแล้ว (O3) — เลื่อน item ผ่าน RPC ก่อน
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'aaaaaaaa-4444-0000-0000-000000000003', 'eeeeeeee-4444-0000-0000-000000000031',
    1, 'preparing', 'u5-key-h2', 'b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5', :'UA'
  )->>'status'),
  'executed',
  'U5: เตรียม item ของ O3 ก่อนทดสอบ cancel reject'
);
SELECT is(
  (public.unified_pos_cancel_table_order(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'ffffffff-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000003',
    'u5-key-h3', 'b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6'
  )->>'code'),
  'up_cancel_not_allowed',
  'U5: มี item ถูกเตรียมแล้ว → up_cancel_not_allowed'
);

-- cancel reject: ไม่ใช่ QR order (O4) และชำระแล้ว (O1)
SELECT is(
  (public.unified_pos_cancel_table_order(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'ffffffff-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000004',
    'u5-key-h4', 'b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7'
  )->>'code'),
  'up_cancel_not_allowed',
  'U5: ไม่ใช่ QR order → up_cancel_not_allowed'
);
SELECT is(
  (public.unified_pos_cancel_table_order(
    'aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001',
    'ffffffff-4444-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000001',
    'u5-key-h5', 'b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8'
  )->>'code'),
  'up_cancel_not_allowed',
  'U5: order ชำระแล้ว → up_cancel_not_allowed'
);

SELECT * FROM finish();
ROLLBACK;
