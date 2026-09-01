-- ============================================================
-- Task U6 (v0.35.6) — Governed item reject/void + stock restore + totals recalc (pgTAP)
-- ครอบคลุม migration: supabase/migrations/20260901000004_unified_pos_reject.sql
--   A) functions ครบ + grants (RPC ใหม่ service_role เท่านั้น, wrapper คง authenticated)
--   B) reject ได้จากทุก fulfillment state (new/preparing/ready/served) + recalc ทุก step
--   C) already-voided → up_invalid_item + double-reject คนละ key คืนสต๊อกครั้งเดียว
--   D) paid order → up_invalid_state_transition
--   E) untracked variant → executed โดยไม่แตะสต๊อก (order ยัง open เมื่อเหลือ active)
--   F) flag off → up_store_flag_disabled
--   G) cross-store → up_not_found โดยไม่ mutate
--   H) ไม่มี membership / staff role (ไม่มี orders.manage_qr) → up_forbidden
--   I) recalc คง discount ของ order ไว้ + total = subtotal - discount (clamp 0)
--   J) same key+hash → replayed / same key ต่าง hash → hash_conflict
--   K) void_qr_order_item wrapper: flag on → canonical (receipt legacy_void:*),
--      replay, ไม่มีสิทธิ์ → exception, flag off → legacy body เดิม (ไม่ derive prep)
--   L) audit_logs มี unified_pos.item_reject
--
-- รันด้วย: supabase test db --local
-- (ไฟล์นี้เป็น pure SQL ไม่มี psql meta-command เพื่อรันผ่าน client ใดก็ได้)
-- ============================================================

BEGIN;
SELECT plan(61);

-- ============================================================
-- FIXTURES (uuid คงที่, hex เท่านั้น, prefix 6666 กันชนกับ seed/U2-U5)
--   org O มี 3 ร้าน: SA (flag on), SB (flag off), SC (flag on — cross-store caller)
--   users: UA owner, UB ไม่มี membership, UC staff (มี pos.use แต่ไม่มี orders.manage_qr)
-- ============================================================
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  phone, confirmation_token, recovery_token, email_change, email_change_token_new, phone_change, phone_change_token, reauthentication_token
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-6666-0000-0000-000000000001', 'authenticated', 'authenticated', 'u6-owner@demo.local',    extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-6666-0000-0000-000000000002', 'authenticated', 'authenticated', 'u6-outsider@demo.local', extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-6666-0000-0000-000000000003', 'authenticated', 'authenticated', 'u6-staff@demo.local',    extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organizations (id, name, slug, owner_id) VALUES
  ('aaaaaaaa-6666-0000-0000-000000000001', 'U6 Org', 'u6-org', '00000000-6666-0000-0000-000000000001');

INSERT INTO stores (id, organization_id, name, slug, qr_ordering_enabled, unified_pos_enabled) VALUES
  ('cccccccc-6666-0000-0000-000000000001', 'aaaaaaaa-6666-0000-0000-000000000001', 'U6 Store A', 'u6-store-a', true, true),
  ('cccccccc-6666-0000-0000-000000000002', 'aaaaaaaa-6666-0000-0000-000000000001', 'U6 Store B', 'u6-store-b', true, false),
  ('cccccccc-6666-0000-0000-000000000003', 'aaaaaaaa-6666-0000-0000-000000000001', 'U6 Store C', 'u6-store-c', true, true);

INSERT INTO memberships (id, organization_id, store_id, user_id, role, joined_at) VALUES
  ('bbbbbbbb-6666-0000-0000-000000000001', 'aaaaaaaa-6666-0000-0000-000000000001', NULL, '00000000-6666-0000-0000-000000000001', 'owner', NOW()),
  ('bbbbbbbb-6666-0000-0000-000000000002', 'aaaaaaaa-6666-0000-0000-000000000001', NULL, '00000000-6666-0000-0000-000000000003', 'staff', NOW());

INSERT INTO tables (id, organization_id, store_id, number, label, seats, is_active, qr_enabled, status) VALUES
  ('ffffffff-6666-0000-0000-000000000001', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', '1', 'U6 Table A1', 4, true, true, 'available'),
  ('ffffffff-6666-0000-0000-000000000002', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000002', '2', 'U6 Table B2', 2, true, true, 'available');

INSERT INTO categories (id, organization_id, store_id, name) VALUES
  ('eeeeeeee-6666-0000-0000-000000000001', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'U6 Category A'),
  ('eeeeeeee-6666-0000-0000-000000000006', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000002', 'U6 Category B');

INSERT INTO kitchen_stations (id, organization_id, store_id, name) VALUES
  ('eeeeeeee-6666-0000-0000-000000000004', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'U6 Station'),
  ('eeeeeeee-6666-0000-0000-00000000000d', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000002', 'U6 Station B');

INSERT INTO products (id, organization_id, store_id, category_id, name, base_price, available_for_qr, kitchen_station_id) VALUES
  ('eeeeeeee-6666-0000-0000-000000000002', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000001', 'U6 Product A', 50, true, 'eeeeeeee-6666-0000-0000-000000000004'),
  ('eeeeeeee-6666-0000-0000-000000000007', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000002', 'eeeeeeee-6666-0000-0000-000000000006', 'U6 Product B', 50, true, 'eeeeeeee-6666-0000-0000-00000000000d');

-- variants: แยกต่อ order ที่ reject สำเร็จ เพื่อให้เลขสต๊อกอ่านได้ตรงไปตรงมา
--   v1 (R1) / v2 (R2) / v3 (R7 wrapper flag-on) / v5 (R9 discount) / v6 untracked (R4) / v7 SB (R5 fail + R8 legacy)
INSERT INTO product_variants (id, product_id, name, price_adjustment, is_active, track_stock, stock_quantity) VALUES
  ('eeeeeeee-6666-0000-0000-000000000003', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Size R1', 0, true, true, 10),
  ('eeeeeeee-6666-0000-0000-000000000009', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Size R2', 0, true, true, 10),
  ('eeeeeeee-6666-0000-0000-00000000000a', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Size R7', 0, true, true, 10),
  ('eeeeeeee-6666-0000-0000-00000000000c', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Size R9', 0, true, true, 10),
  ('eeeeeeee-6666-0000-0000-000000000005', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Size Untracked', 0, true, false, NULL),
  ('eeeeeeee-6666-0000-0000-000000000008', 'eeeeeeee-6666-0000-0000-000000000007', 'U6 Size SB', 0, true, true, 5);

-- orders: R1 reject ทุก state (4 items) / R2 voided guard + replay (2 items) /
--   R3 paid / R4 staff order + untracked (2 items) / R5 SB flag off /
--   R6 cross-store + forbidden / R7 wrapper flag on (2 items) / R8 wrapper legacy (SB) /
--   R9 คง discount (1 item, discount 20)
INSERT INTO orders (id, organization_id, store_id, order_number, status, table_id, subtotal, discount, total, qr_order_source) VALUES
  ('aaaaaaaa-6666-0000-0000-000000000001', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'U6-O1', 'open', 'ffffffff-6666-0000-0000-000000000001', 200, 0, 200, true),
  ('aaaaaaaa-6666-0000-0000-000000000002', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'U6-O2', 'open', 'ffffffff-6666-0000-0000-000000000001', 100, 0, 100, true),
  ('aaaaaaaa-6666-0000-0000-000000000003', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'U6-O3', 'paid', 'ffffffff-6666-0000-0000-000000000001', 50, 0, 50, true),
  ('aaaaaaaa-6666-0000-0000-000000000004', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'U6-O4', 'open', 'ffffffff-6666-0000-0000-000000000001', 100, 0, 100, false),
  ('aaaaaaaa-6666-0000-0000-000000000005', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000002', 'U6-O5', 'open', 'ffffffff-6666-0000-0000-000000000002', 50, 0, 50, true),
  ('aaaaaaaa-6666-0000-0000-000000000006', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'U6-O6', 'open', 'ffffffff-6666-0000-0000-000000000001', 50, 0, 50, true),
  ('aaaaaaaa-6666-0000-0000-000000000007', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'U6-O7', 'open', 'ffffffff-6666-0000-0000-000000000001', 100, 0, 100, true),
  ('aaaaaaaa-6666-0000-0000-000000000008', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000002', 'U6-O8', 'open', 'ffffffff-6666-0000-0000-000000000002', 50, 0, 50, true),
  ('aaaaaaaa-6666-0000-0000-000000000009', 'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001', 'U6-O9', 'open', 'ffffffff-6666-0000-0000-000000000001', 50, 20, 30, true);

UPDATE orders SET paid_at = NOW() WHERE id = 'aaaaaaaa-6666-0000-0000-000000000003';

INSERT INTO order_items (id, order_id, product_id, product_name, variant_id, quantity, unit_price, total_price) VALUES
  ('eeeeeeee-6666-0000-0000-000000000011', 'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000012', 'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000013', 'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000014', 'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000021', 'aaaaaaaa-6666-0000-0000-000000000002', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000009', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000022', 'aaaaaaaa-6666-0000-0000-000000000002', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000009', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000031', 'aaaaaaaa-6666-0000-0000-000000000003', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000041', 'aaaaaaaa-6666-0000-0000-000000000004', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000005', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000042', 'aaaaaaaa-6666-0000-0000-000000000004', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000005', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000051', 'aaaaaaaa-6666-0000-0000-000000000005', 'eeeeeeee-6666-0000-0000-000000000007', 'U6 Product B', 'eeeeeeee-6666-0000-0000-000000000008', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000061', 'aaaaaaaa-6666-0000-0000-000000000006', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-000000000003', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000071', 'aaaaaaaa-6666-0000-0000-000000000007', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-00000000000a', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000072', 'aaaaaaaa-6666-0000-0000-000000000007', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-00000000000a', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000081', 'aaaaaaaa-6666-0000-0000-000000000008', 'eeeeeeee-6666-0000-0000-000000000007', 'U6 Product B', 'eeeeeeee-6666-0000-0000-000000000008', 1, 50, 50),
  ('eeeeeeee-6666-0000-0000-000000000091', 'aaaaaaaa-6666-0000-0000-000000000009', 'eeeeeeee-6666-0000-0000-000000000002', 'U6 Product A', 'eeeeeeee-6666-0000-0000-00000000000c', 1, 50, 50);

-- ============================================================
-- A) Functions + grants (7 asserts)
-- ============================================================
SELECT has_function('unified_pos_reject_order_item', 'U6: unified_pos_reject_order_item มีอยู่');
SELECT has_function('void_qr_order_item', 'U6: void_qr_order_item (wrapper) คงอยู่');
SELECT ok(
  has_function_privilege('service_role', 'public.unified_pos_reject_order_item(uuid,uuid,uuid,uuid,text,text,uuid,text)', 'EXECUTE'),
  'U6: service_role เรียก unified_pos_reject_order_item ได้'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.unified_pos_reject_order_item(uuid,uuid,uuid,uuid,text,text,uuid,text)', 'EXECUTE'),
  'U6: anon เรียก reject_order_item ไม่ได้'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.unified_pos_reject_order_item(uuid,uuid,uuid,uuid,text,text,uuid,text)', 'EXECUTE'),
  'U6: authenticated เรียก reject_order_item ไม่ได้ (service_role เท่านั้น)'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.void_qr_order_item(uuid,uuid,uuid,text)', 'EXECUTE'),
  'U6: wrapper คง grant เดิมให้ authenticated'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.void_qr_order_item(uuid,uuid,uuid,text)', 'EXECUTE'),
  'U6: anon เรียก wrapper ไม่ได้ (คง grants เดิม)'
);

-- ============================================================
-- B) Reject ได้จากทุก state + recalc ทุก step (17 asserts)
--     R1: item 11 (preparing), 12 (ready), 13 (served), 14 (new)
-- ============================================================
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000011',
    1, 'preparing', 'u6key-m1', 'a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6', '00000000-6666-0000-0000-000000000001'
  )->>'status'),
  'executed',
  'U6: setup item 11 → preparing'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000012',
    1, 'preparing', 'u6key-m2', 'b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6', '00000000-6666-0000-0000-000000000001'
  )->>'status'),
  'executed',
  'U6: setup item 12 → preparing'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000012',
    2, 'ready', 'u6key-m3', 'c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6', '00000000-6666-0000-0000-000000000001'
  )->>'status'),
  'executed',
  'U6: setup item 12 → ready'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000013',
    1, 'preparing', 'u6key-m4', 'd6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6', '00000000-6666-0000-0000-000000000001'
  )->>'status'),
  'executed',
  'U6: setup item 13 → preparing'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000013',
    2, 'ready', 'u6key-m5', 'e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6', '00000000-6666-0000-0000-000000000001'
  )->>'status'),
  'executed',
  'U6: setup item 13 → ready'
);
SELECT is(
  (public.unified_pos_update_item_fulfillment(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000013',
    3, 'served', 'u6key-m6', 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6', '00000000-6666-0000-0000-000000000001'
  )->>'status'),
  'executed',
  'U6: setup item 13 → served'
);

-- reject จาก state preparing
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000011',
    'u6key-r11', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', '00000000-6666-0000-0000-000000000001', 'ของหมด'
  )->>'status'),
  'executed',
  'U6: reject จาก state preparing = executed'
);
SELECT is(
  (SELECT subtotal FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000001'),
  150.00::numeric,
  'U6: recalc หลัง reject แรก subtotal 200 → 150'
);
-- reject จาก state ready
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000012',
    'u6key-r12', 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', '00000000-6666-0000-0000-000000000001', 'ของไหม้'
  )->>'status'),
  'executed',
  'U6: reject จาก state ready = executed'
);
SELECT is(
  (SELECT subtotal FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000001'),
  100.00::numeric,
  'U6: recalc subtotal 150 → 100'
);
-- reject จาก state served — fulfillment_status ต้องคงเดิม (canonical void เป็น boolean เท่านั้น)
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000013',
    'u6key-r13', 'a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3', '00000000-6666-0000-0000-000000000001', NULL
  )->>'status'),
  'executed',
  'U6: reject จาก state served = executed'
);
SELECT is(
  (SELECT fulfillment_status || '/' || voided::text FROM order_items WHERE id = 'eeeeeeee-6666-0000-0000-000000000013'),
  'served/true',
  'U6: voided=true แต่ fulfillment_status คง served (ห้ามใช้ enum voided)'
);
SELECT is(
  (SELECT subtotal FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000001'),
  50.00::numeric,
  'U6: recalc subtotal 100 → 50'
);
-- reject จาก state new (item สุดท้าย) — ไม่เหลือ active → order cancelled + prep done
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000001', 'eeeeeeee-6666-0000-0000-000000000014',
    'u6key-r14', 'a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4', '00000000-6666-0000-0000-000000000001', 'ของหมด'
  )->>'status'),
  'executed',
  'U6: reject จาก state new = executed'
);
SELECT is(
  (SELECT status || '/' || prep_status FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000001'),
  'cancelled/done',
  'U6: reject รายการสุดท้าย → order cancelled + prep done (legacy parity)'
);
SELECT is(
  (SELECT subtotal || '/' || total FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000001'),
  '0.00/0.00',
  'U6: recalc subtotal/total ทั้งหมดเป็น 0 เมื่อไม่เหลือ active item'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-000000000003'),
  14::int,
  'U6: คืนสต๊อกครบ 4 รายการ (10 + 4)'
);

-- ============================================================
-- C) Already-voided + double-reject คนละ key คืนสต๊อกครั้งเดียว (4 asserts)
--     R2: item 21, 22 (v2 สต๊อก 10)
-- ============================================================
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000002', 'eeeeeeee-6666-0000-0000-000000000021',
    'u6key-c1', 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', '00000000-6666-0000-0000-000000000001', 'ของหมด'
  )->>'status'),
  'executed',
  'U6: reject item 21 = executed'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-000000000009'),
  11::int,
  'U6: คืนสต๊อกครั้งแรก 10 → 11'
);
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000002', 'eeeeeeee-6666-0000-0000-000000000021',
    'u6key-c2', 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', '00000000-6666-0000-0000-000000000001', 'ของหมด'
  )->>'code'),
  'up_invalid_item',
  'U6: reject ซ้ำ (key ใหม่) ที่ item ถูก void แล้ว → up_invalid_item'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-000000000009'),
  11::int,
  'U6: double-reject คืนสต๊อกครั้งเดียว (ยังเป็น 11)'
);

-- ============================================================
-- J) Idempotency: replay / hash_conflict + item 22 (5 asserts)
-- ============================================================
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000002', 'eeeeeeee-6666-0000-0000-000000000022',
    'u6key-j1', 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1', '00000000-6666-0000-0000-000000000001', 'ลูกค้าเปลี่ยนใจ'
  )->>'status'),
  'executed',
  'U6: reject item 22 (key u6-j1) = executed'
);
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000002', 'eeeeeeee-6666-0000-0000-000000000022',
    'u6key-j1', 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1', '00000000-6666-0000-0000-000000000001', 'ลูกค้าเปลี่ยนใจ'
  )->>'status'),
  'replayed',
  'U6: same key + same hash → replayed'
);
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000002', 'eeeeeeee-6666-0000-0000-000000000022',
    'u6key-j1', 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2', '00000000-6666-0000-0000-000000000001', 'ลูกค้าเปลี่ยนใจ'
  )->>'status'),
  'hash_conflict',
  'U6: same key ต่าง hash → hash_conflict'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-000000000009'),
  12::int,
  'U6: replay/conflict ไม่เพิ่มสต๊อกซ้ำ (10 + 1 + 1)'
);
SELECT is(
  (SELECT result->>'subtotal' FROM unified_pos_operation_receipts WHERE store_id = 'cccccccc-6666-0000-0000-000000000001' AND operation_key = 'u6key-j1'),
  '0.00',
  'U6: receipt ของ u6-j1 เก็บ result subtotal 0.00 (order ไม่เหลือ active)'
);

-- ============================================================
-- D) Order paid → up_invalid_state_transition (2 asserts) — R3
-- ============================================================
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000003', 'eeeeeeee-6666-0000-0000-000000000031',
    'u6key-d1', 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1', '00000000-6666-0000-0000-000000000001', NULL
  )->>'code'),
  'up_invalid_state_transition',
  'U6: order ชำระแล้ว → up_invalid_state_transition'
);
SELECT is(
  (SELECT voided::text || '/' || (SELECT stock_quantity::text FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-000000000003') FROM order_items WHERE id = 'eeeeeeee-6666-0000-0000-000000000031'),
  'false/14',
  'U6: reject ที่ order ปิดแล้วไม่ void และไม่แตะสต๊อก'
);

-- ============================================================
-- E) Untracked variant → executed ไม่แตะสต๊อก + order ยัง open (3 asserts) — R4
-- ============================================================
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000004', 'eeeeeeee-6666-0000-0000-000000000041',
    'u6key-e1', 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1', '00000000-6666-0000-0000-000000000001', 'สั่งผิด'
  )->>'status'),
  'executed',
  'U6: reject untracked item (staff order) = executed'
);
SELECT is(
  (SELECT (stock_quantity IS NULL)::text FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-000000000005'),
  'true',
  'U6: untracked variant ไม่ถูก restore (stock คง null)'
);
SELECT is(
  (SELECT status || '/' || subtotal FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000004'),
  'open/50.00',
  'U6: staff order เหลือ active 1 รายการ → ยัง open + subtotal 50'
);

-- ============================================================
-- F) Flag off → up_store_flag_disabled (1 assert) — R5 (SB)
-- ============================================================
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000002',
    'aaaaaaaa-6666-0000-0000-000000000005', 'eeeeeeee-6666-0000-0000-000000000051',
    'u6key-f1', 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1', '00000000-6666-0000-0000-000000000001', NULL
  )->>'code'),
  'up_store_flag_disabled',
  'U6: ร้านปิด flag → up_store_flag_disabled (fail closed)'
);

-- ============================================================
-- G) Cross-store → up_not_found โดยไม่ mutate (2 asserts) — R6 ผ่าน SC
-- ============================================================
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000003',
    'aaaaaaaa-6666-0000-0000-000000000006', 'eeeeeeee-6666-0000-0000-000000000061',
    'u6key-g1', 'a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7', '00000000-6666-0000-0000-000000000001', NULL
  )->>'code'),
  'up_not_found',
  'U6: order ของร้านอื่น (cross-store) → up_not_found'
);
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000000', 'eeeeeeee-6666-0000-0000-000000000061',
    'u6key-g2', 'e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7', '00000000-6666-0000-0000-000000000001', NULL
  )->>'code'),
  'up_not_found',
  'U6: order ไม่มีจริง → up_not_found'
);
SELECT is(
  (SELECT voided::text || '/' || (SELECT stock_quantity::text FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-000000000003') FROM order_items WHERE id = 'eeeeeeee-6666-0000-0000-000000000061'),
  'false/14',
  'U6: cross-store ไม่ void และไม่แตะสต๊อก'
);

-- ============================================================
-- H) ไม่มี membership / staff role → up_forbidden (3 asserts) — R6
-- ============================================================
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000006', 'eeeeeeee-6666-0000-0000-000000000061',
    'u6key-h1', 'b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7', '00000000-6666-0000-0000-000000000002', NULL
  )->>'code'),
  'up_forbidden',
  'U6: actor ไม่มี membership → up_forbidden'
);
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000006', 'eeeeeeee-6666-0000-0000-000000000061',
    'u6key-h2', 'c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7', '00000000-6666-0000-0000-000000000003', NULL
  )->>'code'),
  'up_forbidden',
  'U6: staff role (ไม่มี orders.manage_qr) → up_forbidden'
);
SELECT is(
  (SELECT voided::text || '/' || fulfillment_status FROM order_items WHERE id = 'eeeeeeee-6666-0000-0000-000000000061'),
  'false/new',
  'U6: forbidden ไม่ mutate item'
);

-- ============================================================
-- I) Recalc คง discount ของ order + clamp total ≥ 0 (6 asserts) — R9
-- ============================================================
SELECT is(
  (public.unified_pos_reject_order_item(
    'aaaaaaaa-6666-0000-0000-000000000001', 'cccccccc-6666-0000-0000-000000000001',
    'aaaaaaaa-6666-0000-0000-000000000009', 'eeeeeeee-6666-0000-0000-000000000091',
    'u6key-i1', 'd7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7', '00000000-6666-0000-0000-000000000001', 'สั่งผิด'
  )->>'status'),
  'executed',
  'U6: reject บน order ที่มี discount 20 = executed'
);
SELECT is(
  (SELECT subtotal FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000009'),
  0.00::numeric,
  'U6: recalc subtotal 50 → 0'
);
SELECT is(
  (SELECT discount FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000009'),
  20.00::numeric,
  'U6: discount ของ order คงเดิม (20)'
);
SELECT is(
  (SELECT total FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000009'),
  0.00::numeric,
  'U6: total = subtotal - discount clamp ที่ 0'
);
SELECT is(
  (SELECT status FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000009'),
  'cancelled',
  'U6: R9 ไม่เหลือ active item → cancelled'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-00000000000c'),
  11::int,
  'U6: R9 คืนสต๊อก 10 → 11'
);

-- ============================================================
-- K) void_qr_order_item wrapper (flags-gated) (10 asserts)
--     R7 (SA flag on → canonical) / R8 (SB flag off → legacy)
--     ใช้ request.jwt GUC จำลอง auth.uid()
-- ============================================================
SELECT set_config('request.jwt.claim.sub', '00000000-6666-0000-0000-000000000001', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-6666-0000-0000-000000000001","email":"u6-owner@demo.local"}', false);

SELECT lives_ok(
  'SELECT public.void_qr_order_item(''cccccccc-6666-0000-0000-000000000001'', ''aaaaaaaa-6666-0000-0000-000000000007'', ''eeeeeeee-6666-0000-0000-000000000071'', ''ของหมด'')',
  'U6: wrapper (flag on) route เข้า canonical path สำเร็จ'
);
SELECT is(
  (SELECT operation_type FROM unified_pos_operation_receipts WHERE store_id = 'cccccccc-6666-0000-0000-000000000001' AND operation_key = 'legacy_void:eeeeeeee-6666-0000-0000-000000000071'),
  'item_reject',
  'U6: wrapper สร้าง receipt item_reject ด้วย key legacy_void:<item_id>'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-00000000000a'),
  11::int,
  'U6: wrapper (flag on) คืนสต๊อกผ่าน canonical path 10 → 11'
);
SELECT lives_ok(
  'SELECT public.void_qr_order_item(''cccccccc-6666-0000-0000-000000000001'', ''aaaaaaaa-6666-0000-0000-000000000007'', ''eeeeeeee-6666-0000-0000-000000000071'', ''ของหมด'')',
  'U6: wrapper retry เดิม (same key+hash) → replayed ไม่ raise'
);
SELECT lives_ok(
  'SELECT public.void_qr_order_item(''cccccccc-6666-0000-0000-000000000001'', ''aaaaaaaa-6666-0000-0000-000000000007'', ''eeeeeeee-6666-0000-0000-000000000072'', NULL)',
  'U6: wrapper ยกเลิกรายการที่สองสำเร็จ'
);
SELECT is(
  (SELECT status || '/' || prep_status || '/' || subtotal::text FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000007'),
  'cancelled/done/0.00',
  'U6: R7 ไม่เหลือ active → cancelled + prep done + subtotal 0'
);
-- สลับเป็น actor ที่ไม่มีสิทธิ์ก่อนทดสอบ wrapper raise
SELECT set_config('request.jwt.claim.sub', '00000000-6666-0000-0000-000000000002', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-6666-0000-0000-000000000002","email":"u6-outsider@demo.local"}', false);
SELECT throws_ok(
  'SELECT public.void_qr_order_item(''cccccccc-6666-0000-0000-000000000001'', ''aaaaaaaa-6666-0000-0000-000000000006'', ''eeeeeeee-6666-0000-0000-000000000061'', NULL)',
  'P0001',
  'ไม่มีสิทธิ์ยกเลิกรายการออเดอร์',
  'U6: wrapper โดย actor ไม่มีสิทธิ์ → raise exception (ข้อความไทยจาก governed RPC)'
);
-- กลับมาเป็น owner ก่อนทดสอบ legacy path
SELECT set_config('request.jwt.claim.sub', '00000000-6666-0000-0000-000000000001', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-6666-0000-0000-000000000001","email":"u6-owner@demo.local"}', false);
SELECT lives_ok(
  'SELECT public.void_qr_order_item(''cccccccc-6666-0000-0000-000000000002'', ''aaaaaaaa-6666-0000-0000-000000000008'', ''eeeeeeee-6666-0000-0000-000000000081'', ''ของหมด'')',
  'U6: wrapper (flag off) รัน legacy path สำเร็จ'
);
SELECT is(
  (SELECT stock_quantity || '/' || (SELECT status || '/' || prep_status FROM orders WHERE id = 'aaaaaaaa-6666-0000-0000-000000000008') FROM product_variants WHERE id = 'eeeeeeee-6666-0000-0000-000000000008'),
  '6/cancelled/new',
  'U6: legacy path คืนสต๊อก 5 → 6 + cancel order + ไม่ derive prep (คง legacy)'
);

-- ============================================================
-- L) Audit (1 assert)
-- ============================================================
SELECT ok(
  EXISTS (
    SELECT 1 FROM audit_logs
     WHERE action = 'unified_pos.item_reject'
       AND store_id = 'cccccccc-6666-0000-0000-000000000001'
       AND request_id = 'u6key-r11'
  ),
  'U6: audit_logs บันทึก unified_pos.item_reject พร้อม request_id = operation key'
);

SELECT * FROM finish();
ROLLBACK;
