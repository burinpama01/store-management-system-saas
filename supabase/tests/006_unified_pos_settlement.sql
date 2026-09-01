-- ============================================================
-- Task U7 (v0.35.7) — Governed dine-in table settlement + payment/rewards (pgTAP)
-- ครอบคลุม migration: supabase/migrations/20260901000005_unified_pos_settlement.sql
--   A) functions ครบ + grants (RPC ใหม่ service_role เท่านั้น)
--   B) envelope validation (key/hash/mode/method) → up_invalid_item / up_invalid_payment
--   C) cash gate: ไม่มี open cash session → error (mirror close_pos_order_payment)
--   D) partial settle (cash) → executed: paid + prep done + payment + income + cash ledger
--      + revision ที่รายงาน = revision จริงใน DB
--   E) same key+hash → replayed ผลเดิม ไม่เพิ่ม payment / same key ต่าง hash → hash_conflict
--   F) rewards: default 0.01 (SC ไม่มี settings) → round(total*ppc) แต้ม / settings ppc=1
--      → 90 แต้ม / replay ไม่โพสต์ซ้ำ (exactly-once) / earn off → 0 แต้ม
--   G) partial ชำระบางบิล: บิลอื่นยัง open + session โต๊ะไม่ถูกปิด
--   H) stale revision → up_stale_version โดยไม่ mutate
--   I) whole_table → ทุกบิล paid + prep done + ปิด session โต๊ะ
--   J) paid order → up_invalid_state_transition / ไม่มี membership → up_forbidden
--      (หลัง role switch ด้วย request.jwt.claims GUC ตาม pattern 001/005)
--   K) สต๊อก: staff order หัก quantity × unit_quantity / QR order ไม่ถูกหักซ้ำ /
--      สต๊อกไม่พอ → up_stock_insufficient rollback ทั้งก้อน
--   L) cashflow.record override denied → up_forbidden
--   M) cross-store → up_not_found / flag off → up_store_flag_disabled
--   N) ร้านไม่มีหมวด income → autocreate 'ยอดขาย POS' + transaction
--   O) purge financial: tombstone คงอยู่, financial คง result, ไม่ใช่ financial ล้าง result
--
-- หมายเหตุ: ไม่มี throws_ok เพราะ unified_pos_settle_table_order ไม่มี path ที่ RAISE
--   (error ทุกตัวคืน jsonb {status:'error',code,message} ตาม outcome contract U4-U6)
--
-- รันด้วย: supabase test db --local
-- (ไฟล์นี้เป็น pure SQL ไม่มี psql meta-command เพื่อรันผ่าน client ใดก็ได้)
-- ============================================================

BEGIN;
SELECT plan(67);

-- ============================================================
-- FIXTURES (uuid คงที่, hex เท่านั้น, prefix 7777 กันชนกับ seed/U2-U6)
--   org O มี 4 ร้าน: SA (flag on + loyalty ppc=1), SB (flag on — cross-store),
--   SC (flag on ไม่มีหมวด income — default reward + autocreate), SD (flag off)
--   users: UA owner, UB ไม่มี membership, UC staff (มี pos.use + cashflow.record)
-- ============================================================
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  phone, confirmation_token, recovery_token, email_change, email_change_token_new, phone_change, phone_change_token, reauthentication_token
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-7777-0000-0000-000000000001', 'authenticated', 'authenticated', 'u7-owner@demo.local',    extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-7777-0000-0000-000000000002', 'authenticated', 'authenticated', 'u7-outsider@demo.local', extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-7777-0000-0000-000000000003', 'authenticated', 'authenticated', 'u7-staff@demo.local',    extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organizations (id, name, slug, owner_id) VALUES
  ('aaaaaaaa-7777-0000-0000-000000000001', 'U7 Org', 'u7-org', '00000000-7777-0000-0000-000000000001');

INSERT INTO stores (id, organization_id, name, slug, qr_ordering_enabled, unified_pos_enabled) VALUES
  ('cccccccc-7777-0000-0000-000000000001', 'aaaaaaaa-7777-0000-0000-000000000001', 'U7 Store A', 'u7-store-a', true, true),
  ('cccccccc-7777-0000-0000-000000000002', 'aaaaaaaa-7777-0000-0000-000000000001', 'U7 Store B', 'u7-store-b', true, true),
  ('cccccccc-7777-0000-0000-000000000003', 'aaaaaaaa-7777-0000-0000-000000000001', 'U7 Store C', 'u7-store-c', true, true),
  ('cccccccc-7777-0000-0000-000000000004', 'aaaaaaaa-7777-0000-0000-000000000001', 'U7 Store D', 'u7-store-d', true, false);

INSERT INTO memberships (id, organization_id, store_id, user_id, role, joined_at) VALUES
  ('bbbbbbbb-7777-0000-0000-000000000001', 'aaaaaaaa-7777-0000-0000-000000000001', NULL, '00000000-7777-0000-0000-000000000001', 'owner', NOW()),
  ('bbbbbbbb-7777-0000-0000-000000000003', 'aaaaaaaa-7777-0000-0000-000000000001', NULL, '00000000-7777-0000-0000-000000000003', 'staff', NOW());

INSERT INTO tables (id, organization_id, store_id, number, label, seats, is_active, qr_enabled, status) VALUES
  ('ffffffff-7777-0000-0000-000000000001', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', '1', 'U7 Table A1', 4, true, true, 'available'),
  ('ffffffff-7777-0000-0000-000000000002', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', '2', 'U7 Table A2', 2, true, true, 'available'),
  ('ffffffff-7777-0000-0000-000000000003', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000002', '3', 'U7 Table B3', 2, true, true, 'available');

INSERT INTO categories (id, organization_id, store_id, name) VALUES
  ('eeeeeeee-7777-0000-0000-000000000001', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7 Category A');

INSERT INTO kitchen_stations (id, organization_id, store_id, name) VALUES
  ('eeeeeeee-7777-0000-0000-000000000004', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7 Station A');

INSERT INTO products (id, organization_id, store_id, category_id, name, base_price, available_for_qr, kitchen_station_id) VALUES
  ('eeeeeeee-7777-0000-0000-000000000002', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'eeeeeeee-7777-0000-0000-000000000001', 'U7 Product A', 50, true, 'eeeeeeee-7777-0000-0000-000000000004');

-- variants: v1 (R11 QR ไม่หักซ้ำ / R12 insufficient) / v2 (R10 unit_quantity 3) /
--   v3 (R1 staff cash — หัก 1)
INSERT INTO product_variants (id, product_id, name, price_adjustment, is_active, track_stock, stock_quantity) VALUES
  ('eeeeeeee-7777-0000-0000-000000000003', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Size V1', 0, true, true, 10),
  ('eeeeeeee-7777-0000-0000-000000000009', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Size V2', 0, true, true, 10),
  ('eeeeeeee-7777-0000-0000-00000000000a', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Size V3', 0, true, true, 10);

INSERT INTO customers (id, organization_id, store_id, name, is_active) VALUES
  ('dddddddd-7777-0000-0000-000000000001', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7 Customer SA', true),
  ('dddddddd-7777-0000-0000-000000000002', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000003', 'U7 Customer SC', true);

INSERT INTO loyalty_settings (organization_id, store_id, points_per_currency, earn_enabled) VALUES
  ('aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 1.0000, true);

-- orders:
--   R1 SA staff cash 90 (variant v1 qty1) — happy path / replay / conflict
--   R2 SA QR 50 บนโต๊ะ T2 + R3 SA QR 100 บนโต๊ะ T2 — whole_table
--   R4 SC staff 150 customer SC — default rate (ไม่มี settings) → 2 แต้ม
--   R5 SA staff 90 customer SA — ppc 1 → 90 แต้ม (+ replay exactly-once)
--   R6 SA staff 90 customer SA — earn off → 0 แต้ม
--   R7 SA QR 50 บนโต๊ะ T1 — partial ชำระบางบิล / R8 SA QR 100 บนโต๊ะ T1 — คง open + stale
--   R9 SA paid 50 — up_invalid_state_transition
--   R10 SA staff 165 v2 qty1 unit_qty3 — หัก 3 / R11 SA QR 45 v1 — ไม่หักซ้ำ
--   R12 SA staff 4500 v1 qty100 — insufficient rollback
--   R13 SA staff cash 45 variant null actor UC — override denied
--   R14 SD staff 45 — flag off / R15 SA QR 45 — cross-store ผ่าน SB
--   R16 SC staff 45 variant null — autocreate หมวด
INSERT INTO orders (id, organization_id, store_id, order_number, status, table_id, subtotal, discount, total, qr_order_source, customer_id) VALUES
  ('aaaaaaaa-7777-0000-0000-000000000001', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R1', 'open', NULL, 90, 0, 90, false, NULL),
  ('aaaaaaaa-7777-0000-0000-000000000002', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R2', 'open', 'ffffffff-7777-0000-0000-000000000002', 50, 0, 50, true, NULL),
  ('aaaaaaaa-7777-0000-0000-000000000003', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R3', 'open', 'ffffffff-7777-0000-0000-000000000002', 100, 0, 100, true, NULL),
  ('aaaaaaaa-7777-0000-0000-000000000004', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000003', 'U7-R4', 'open', NULL, 150, 0, 150, false, 'dddddddd-7777-0000-0000-000000000002'),
  ('aaaaaaaa-7777-0000-0000-000000000005', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R5', 'open', NULL, 90, 0, 90, false, 'dddddddd-7777-0000-0000-000000000001'),
  ('aaaaaaaa-7777-0000-0000-000000000006', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R6', 'open', NULL, 90, 0, 90, false, 'dddddddd-7777-0000-0000-000000000001'),
  ('aaaaaaaa-7777-0000-0000-000000000007', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R7', 'open', 'ffffffff-7777-0000-0000-000000000001', 50, 0, 50, true, NULL),
  ('aaaaaaaa-7777-0000-0000-000000000008', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R8', 'open', 'ffffffff-7777-0000-0000-000000000001', 100, 0, 100, true, NULL),
  ('aaaaaaaa-7777-0000-0000-000000000009', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R9', 'paid', NULL, 50, 0, 50, true, NULL),
  ('aaaaaaaa-7777-0000-0000-00000000000a', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R10', 'open', NULL, 165, 0, 165, false, NULL),
  ('aaaaaaaa-7777-0000-0000-00000000000b', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R11', 'open', NULL, 45, 0, 45, true, NULL),
  ('aaaaaaaa-7777-0000-0000-00000000000c', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R12', 'open', NULL, 4500, 0, 4500, false, NULL),
  ('aaaaaaaa-7777-0000-0000-00000000000d', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R13', 'open', NULL, 45, 0, 45, false, NULL),
  ('aaaaaaaa-7777-0000-0000-00000000000e', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000004', 'U7-R14', 'open', NULL, 45, 0, 45, false, NULL),
  ('aaaaaaaa-7777-0000-0000-00000000000f', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'U7-R15', 'open', NULL, 45, 0, 45, true, NULL),
  ('aaaaaaaa-7777-0000-0000-000000000010', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000003', 'U7-R16', 'open', NULL, 45, 0, 45, false, NULL);

UPDATE orders SET paid_at = NOW() WHERE id = 'aaaaaaaa-7777-0000-0000-000000000009';

INSERT INTO order_items (order_id, product_id, product_name, variant_id, quantity, unit_quantity, unit_price, total_price) VALUES
  ('aaaaaaaa-7777-0000-0000-000000000001', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-00000000000a', 1, 1, 90, 90),
  ('aaaaaaaa-7777-0000-0000-000000000002', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-000000000003', 1, 1, 50, 50),
  ('aaaaaaaa-7777-0000-0000-000000000003', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-000000000003', 2, 1, 50, 100),
  ('aaaaaaaa-7777-0000-0000-000000000004', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', NULL, 1, 1, 150, 150),
  ('aaaaaaaa-7777-0000-0000-000000000005', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', NULL, 1, 1, 90, 90),
  ('aaaaaaaa-7777-0000-0000-000000000006', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', NULL, 1, 1, 90, 90),
  ('aaaaaaaa-7777-0000-0000-000000000007', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-000000000003', 1, 1, 50, 50),
  ('aaaaaaaa-7777-0000-0000-000000000008', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-000000000003', 2, 1, 50, 100),
  ('aaaaaaaa-7777-0000-0000-000000000009', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-000000000003', 1, 1, 50, 50),
  ('aaaaaaaa-7777-0000-0000-00000000000a', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-000000000009', 1, 3, 165, 165),
  ('aaaaaaaa-7777-0000-0000-00000000000b', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-000000000003', 1, 1, 45, 45),
  ('aaaaaaaa-7777-0000-0000-00000000000c', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-000000000003', 100, 1, 45, 4500),
  ('aaaaaaaa-7777-0000-0000-00000000000d', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', NULL, 1, 1, 45, 45),
  ('aaaaaaaa-7777-0000-0000-00000000000e', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', NULL, 1, 1, 45, 45),
  ('aaaaaaaa-7777-0000-0000-00000000000f', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', 'eeeeeeee-7777-0000-0000-000000000003', 1, 1, 45, 45),
  ('aaaaaaaa-7777-0000-0000-000000000010', 'eeeeeeee-7777-0000-0000-000000000002', 'U7 Product A', NULL, 1, 1, 45, 45);

-- session ของ T1 เปิดอยู่ (partial ต้องไม่ปิด) / T2 ปิด (whole_table จะปิดให้)
UPDATE tables SET session_started_at = NOW(), session_expires_at = NOW() + interval '1 hour'
WHERE id IN ('ffffffff-7777-0000-0000-000000000001', 'ffffffff-7777-0000-0000-000000000002');

-- ตัวช่วยย่อ (อ่าน revision ปัจจุบันของ order เพื่อสร้าง expected revisions)
-- ============================================================
-- A) Functions + grants (5 asserts)
-- ============================================================
SELECT has_function('unified_pos_settle_table_order', 'U7: unified_pos_settle_table_order มีอยู่');
SELECT has_function('purge_expired_unified_pos_receipt_payloads', 'U7: purge_expired_unified_pos_receipt_payloads คงอยู่');
SELECT ok(
  has_function_privilege('service_role', 'public.unified_pos_settle_table_order(uuid,uuid,uuid,text,jsonb,jsonb,text,text,uuid,text,numeric,numeric,numeric,text)', 'EXECUTE'),
  'U7: service_role เรียก unified_pos_settle_table_order ได้'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.unified_pos_settle_table_order(uuid,uuid,uuid,text,jsonb,jsonb,text,text,uuid,text,numeric,numeric,numeric,text)', 'EXECUTE'),
  'U7: anon เรียก settle_table_order ไม่ได้'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.unified_pos_settle_table_order(uuid,uuid,uuid,text,jsonb,jsonb,text,text,uuid,text,numeric,numeric,numeric,text)', 'EXECUTE'),
  'U7: authenticated เรียก settle_table_order ไม่ได้ (service_role เท่านั้น)'
);

-- ============================================================
-- B) Envelope validation (4 asserts) — key <8 / hash <16 / mode / method
-- ============================================================
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000001"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000001', 1),
    'u7-key1', 'a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7',
    '00000000-7777-0000-0000-000000000001', 'other', 90
  )->>'status'),
  'error',
  'U7: operation key สั้นกว่า 8 ตัว → error'
);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000001"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000001', 1),
    'u7-key-short', 'abc',
    '00000000-7777-0000-0000-000000000001', 'other', 90
  )->>'code'),
  'up_invalid_item',
  'U7: request hash สั้นกว่า 16 ตัว → up_invalid_item'
);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'whole', 'null'::jsonb, '{}'::jsonb,
    'u7-key-mode', 'a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7',
    '00000000-7777-0000-0000-000000000001', 'other', 90
  )->>'code'),
  'up_invalid_item',
  'U7: mode ไม่รู้จัก → up_invalid_item'
);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000001"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000001', 1),
    'u7-key-meth', 'a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7',
    '00000000-7777-0000-0000-000000000001', 'crypto', 90
  )->>'code'),
  'up_invalid_payment',
  'U7: method ไม่รู้จัก → up_invalid_payment'
);

-- ============================================================
-- C) Cash gate: ไม่มี open cash session → error (1 assert)
-- ============================================================
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000001"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000001', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000001')),
    'u7key-cash01', 'b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7',
    '00000000-7777-0000-0000-000000000001', 'cash', 90, 100, 10
  )->>'message'),
  'ต้องเปิดรอบเงินสดก่อนรับเงินสด',
  'U7: cash โดยไม่มี open session → ข้อความเดิมของ legacy'
);

-- ============================================================
-- D) Partial settle (cash + เปิด session แล้ว) → executed (8 asserts)
-- ============================================================
INSERT INTO cash_sessions (id, organization_id, store_id, status, opening_float, opened_by_user_id) VALUES
  ('eeeeeeee-7777-0000-0000-000000000005', 'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'open', 0, '00000000-7777-0000-0000-000000000001');

SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000001"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000001', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000001')),
    'u7key-r1sett', 'c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7',
    '00000000-7777-0000-0000-000000000001', 'cash', 90, 100, 10
  )->>'status'),
  'executed',
  'U7: R1 settle (cash) → executed'
);
SELECT is(
  (SELECT jsonb_build_object('status', status, 'prep', prep_status) FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000001'),
  '{"status": "paid", "prep": "done"}'::jsonb,
  'U7: R1 หลัง settle → status paid + prep done (derived)'
);
SELECT is(
  (SELECT count(*) FROM payments WHERE order_id = 'aaaaaaaa-7777-0000-0000-000000000001'),
  1::bigint,
  'U7: R1 มี payment row เดียว'
);
SELECT is(
  (SELECT jsonb_build_object('received', received_amount, 'change', change_amount) FROM payments WHERE order_id = 'aaaaaaaa-7777-0000-0000-000000000001'),
  '{"received": 100, "change": 10}'::jsonb,
  'U7: payment เก็บ received/change ตามจริง'
);
SELECT is(
  (SELECT count(*) FROM transactions WHERE order_id = 'aaaaaaaa-7777-0000-0000-000000000001' AND type = 'income'),
  1::bigint,
  'U7: R1 มี income transaction'
);
SELECT is(
  (SELECT jsonb_build_object('amount', amount, 'balance', balance_after) FROM cash_ledger_entries WHERE order_id = 'aaaaaaaa-7777-0000-0000-000000000001'),
  '{"amount": 90, "balance": 90}'::jsonb,
  'U7: cash ledger ต่อเนื่อง (balance_after = 0 + 90)'
);
SELECT is(
  (SELECT o.revision = (r.result->'orders'->0->>'revision')::bigint
     FROM orders o
     JOIN unified_pos_operation_receipts r ON r.store_id = 'cccccccc-7777-0000-0000-000000000001'
    WHERE o.id = 'aaaaaaaa-7777-0000-0000-000000000001' AND r.operation_key = 'u7key-r1sett'),
  true,
  'U7: revision ในผลลัพธ์ = revision จริงใน DB (ไม่เก่ากว่า)'
);
SELECT is(
  (SELECT is_financial FROM unified_pos_operation_receipts WHERE store_id = 'cccccccc-7777-0000-0000-000000000001' AND operation_key = 'u7key-r1sett'),
  true,
  'U7: receipt ของ settlement ถูกตั้ง is_financial = true'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-7777-0000-0000-00000000000a'),
  9,
  'U7: staff order หักสต๊อกตอนชำระ (v3: 10 → 9)'
);

-- ============================================================
-- E) Replay + conflict (4 asserts)
-- ============================================================
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000001"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000001', 1),
    'u7key-r1sett', 'c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7',
    '00000000-7777-0000-0000-000000000001', 'cash', 90, 100, 10
  )->>'status'),
  'replayed',
  'U7: same key+hash → replayed'
);
SELECT is(
  (SELECT count(*) FROM payments WHERE order_id = 'aaaaaaaa-7777-0000-0000-000000000001'),
  1::bigint,
  'U7: replay ไม่เพิ่ม payment row'
);
SELECT is(
  (SELECT count(*) FROM audit_logs WHERE action = 'unified_pos.table_settlement' AND request_id = 'u7key-r1sett'),
  1::bigint,
  'U7: audit เขียนครั้งเดียว (executed)'
);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000001"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000001', 1),
    'u7key-r1sett', 'd7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7',
    '00000000-7777-0000-0000-000000000001', 'cash', 90, 100, 10
  )->>'status'),
  'hash_conflict',
  'U7: same key ต่าง hash → hash_conflict'
);

-- ============================================================
-- F) Rewards (12 asserts)
-- ============================================================
-- F1) SC ไม่มี loyalty_settings → default 0.0100: 150 × 0.01 → round(x,2) = 1.50 แต้ม (ทศนิยม)
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000003', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000004"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000004', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000004')),
    'u7key-r4rwrd', 'e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7',
    '00000000-7777-0000-0000-000000000001', 'other', 150
  )->>'status'),
  'executed',
  'U7: R4 settle (default rate) → executed'
);
SELECT is(
  (SELECT points_delta FROM loyalty_ledger WHERE order_id = 'aaaaaaaa-7777-0000-0000-000000000004'),
  1.5::numeric,
  'U7: default rate 150 × 0.01 → round(1.5,2) = 1.50 แต้มทศนิยม (parity legacy)'
);
SELECT is(
  (SELECT points_balance FROM loyalty_accounts WHERE store_id = 'cccccccc-7777-0000-0000-000000000003' AND customer_id = 'dddddddd-7777-0000-0000-000000000002'),
  1.5::numeric,
  'U7: balance ของลูกค้า SC = 2'
);
SELECT is(
  (SELECT loyalty_points_earned FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000004'),
  1.5::numeric,
  'U7: orders.loyalty_points_earned = 2'
);
-- F2) SA settings ppc=1.0 → 90 แต้ม + replay โพสต์ครั้งเดียว (exactly-once)
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000005"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000005', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000005')),
    'u7key-r5rwrd', 'f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7',
    '00000000-7777-0000-0000-000000000001', 'other', 90
  )->>'status'),
  'executed',
  'U7: R5 settle (ppc=1) → executed'
);
SELECT is(
  (SELECT points_balance FROM loyalty_accounts WHERE store_id = 'cccccccc-7777-0000-0000-000000000001' AND customer_id = 'dddddddd-7777-0000-0000-000000000001'),
  90::numeric,
  'U7: ppc=1 → 90 แต้มเข้า balance'
);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000005"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000005', 1),
    'u7key-r5rwrd', 'f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7',
    '00000000-7777-0000-0000-000000000001', 'other', 90
  )->>'status'),
  'replayed',
  'U7: R5 replay (same key+hash) → replayed'
);
SELECT is(
  (SELECT count(*) FROM loyalty_ledger WHERE order_id = 'aaaaaaaa-7777-0000-0000-000000000005'),
  1::bigint,
  'U7: reward โพสต์ครั้งเดียวแม้เรียกซ้ำ (exactly-once)'
);
SELECT is(
  (SELECT points_balance FROM loyalty_accounts WHERE store_id = 'cccccccc-7777-0000-0000-000000000001' AND customer_id = 'dddddddd-7777-0000-0000-000000000001'),
  90::numeric,
  'U7: replay ไม่เพิ่ม balance'
);
-- F3) earn off → 0 แต้ม
UPDATE loyalty_settings SET earn_enabled = false WHERE store_id = 'cccccccc-7777-0000-0000-000000000001';
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000006"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000006', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000006')),
    'u7key-r6earn0', '177777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'other', 90
  )->>'status'),
  'executed',
  'U7: R6 settle (earn off) → executed'
);
SELECT is(
  (SELECT count(*) FROM loyalty_ledger WHERE order_id = 'aaaaaaaa-7777-0000-0000-000000000006'),
  0::bigint,
  'U7: earn off → ไม่มี ledger row'
);
SELECT is(
  (SELECT points_balance FROM loyalty_accounts WHERE store_id = 'cccccccc-7777-0000-0000-000000000001' AND customer_id = 'dddddddd-7777-0000-0000-000000000001'),
  90::numeric,
  'U7: earn off → balance ไม่เปลี่ยน'
);
SELECT is(
  (SELECT points_earned FROM (
    SELECT (result->'orders'->0->>'points_earned')::numeric AS points_earned
      FROM unified_pos_operation_receipts
     WHERE store_id = 'cccccccc-7777-0000-0000-000000000001' AND operation_key = 'u7key-r6earn0'
  ) t),
  0::numeric,
  'U7: earn off → points_earned ในผลลัพธ์ = 0'
);

-- ============================================================
-- G) Partial ชำระบางบิล (3 asserts)
-- ============================================================
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'ffffffff-7777-0000-0000-000000000001',
    'partial', '["aaaaaaaa-7777-0000-0000-000000000007"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000007', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000007')),
    'u7key-r7part', '277777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'qr_promptpay', 50
  )->>'status'),
  'executed',
  'U7: R7 partial (ผูกโต๊ะ T1) → executed'
);
SELECT is(
  (SELECT status FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000008'),
  'open',
  'U7: R8 (บิลอื่นของโต๊ะเดียวกัน) ยัง open'
);
SELECT is(
  (SELECT session_started_at IS NOT NULL FROM tables WHERE id = 'ffffffff-7777-0000-0000-000000000001'),
  true,
  'U7: partial ไม่ปิด session โต๊ะ'
);

-- ============================================================
-- H) Stale revision (3 asserts)
-- ============================================================
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'ffffffff-7777-0000-0000-000000000001',
    'partial', '["aaaaaaaa-7777-0000-0000-000000000008"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000008', (SELECT revision - 1 FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000008')),
    'u7key-r8stale', '377777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'qr_promptpay', 100
  )->>'code'),
  'up_stale_version',
  'U7: expected revision เก่ากว่า → up_stale_version'
);
SELECT is(
  (SELECT jsonb_build_object('status', status, 'rev', revision) FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000008'),
  '{"status": "open", "rev": 2}'::jsonb,
  'U7: stale → R8 ไม่ถูก mutate (status open + revision = 2 เท่าเดิม)'
);
SELECT is(
  (SELECT count(*) FROM unified_pos_operation_receipts WHERE store_id = 'cccccccc-7777-0000-0000-000000000001' AND operation_key = 'u7key-r8stale'),
  0::bigint,
  'U7: stale → ไม่เขียน receipt'
);

-- ============================================================
-- I) Whole_table → ปิดทุกบิล + ปิด session (5 asserts)
-- ============================================================
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'ffffffff-7777-0000-0000-000000000002',
    'whole_table', NULL,
    (SELECT jsonb_object_agg(id, revision) FROM orders WHERE store_id = 'cccccccc-7777-0000-0000-000000000001' AND table_id = 'ffffffff-7777-0000-0000-000000000002' AND status = 'open' AND paid_at IS NULL),
    'u7key-wtable1', '477777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'qr_promptpay', 150
  )->>'status'),
  'executed',
  'U7: whole_table T2 (R2+R3) → executed'
);
SELECT is(
  (SELECT count(*) FROM orders WHERE table_id = 'ffffffff-7777-0000-0000-000000000002' AND status = 'paid' AND prep_status = 'done'),
  2::bigint,
  'U7: ทุกบิลของโต๊ะ → paid + prep done'
);
SELECT is(
  (SELECT jsonb_build_object('status', status, 'session', session_started_at) FROM tables WHERE id = 'ffffffff-7777-0000-0000-000000000002'),
  '{"status": "available", "session": null}'::jsonb,
  'U7: โต๊ะว่าง + session ถูกล้าง'
);
SELECT is(
  (SELECT (result->>'grand_total')::numeric FROM unified_pos_operation_receipts WHERE store_id = 'cccccccc-7777-0000-0000-000000000001' AND operation_key = 'u7key-wtable1'),
  150.00,
  'U7: grand_total รวม 2 บิล = 150'
);
SELECT is(
  (SELECT count(*) FROM payments WHERE order_id IN ('aaaaaaaa-7777-0000-0000-000000000002', 'aaaaaaaa-7777-0000-0000-000000000003')),
  2::bigint,
  'U7: whole_table เก็บ payment ครบทุกบิล'
);

-- ============================================================
-- J) Paid order + ไม่มี membership (2 asserts — role switch ด้วย GUC ก่อน)
-- ============================================================
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '00000000-7777-0000-0000-000000000001', 'email', 'u7-owner@demo.local')::text, false);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000009"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000009', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000009')),
    'u7key-r9paid1', '577777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'other', 50
  )->>'code'),
  'up_invalid_state_transition',
  'U7: order ที่ paid แล้ว → up_invalid_state_transition'
);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000008"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000008', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000008')),
    'u7key-r8noacc', '677777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000002', 'other', 100
  )->>'code'),
  'up_forbidden',
  'U7: actor ไม่มี membership → up_forbidden'
);
SELECT set_config('request.jwt.claims', '', false);

-- ============================================================
-- K) สต๊อก (7 asserts)
-- ============================================================
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-00000000000a"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-00000000000a', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-00000000000a')),
    'u7key-r10stck', '877777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'other', 165
  )->>'status'),
  'executed',
  'U7: R10 settle (staff + unit_quantity 3) → executed'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-7777-0000-0000-000000000009'),
  7,
  'U7: staff order หัก quantity × unit_quantity = 3 (10 → 7)'
);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-00000000000b"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-00000000000b', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-00000000000b')),
    'u7key-r11qrno', '977777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'other', 45
  )->>'status'),
  'executed',
  'U7: R11 settle (QR order) → executed'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-7777-0000-0000-000000000003'),
  10,
  'U7: QR order ไม่ถูกหักสต๊อกซ้ำตอน settle (คง 10)'
);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-00000000000c"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-00000000000c', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-00000000000c')),
    'u7key-r12stck', 'a77777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'other', 4500
  )->>'code'),
  'up_stock_insufficient',
  'U7: สต๊อกไม่พอ (100 > 10) → up_stock_insufficient'
);
SELECT is(
  (SELECT jsonb_build_object('status', status, 'payments', (SELECT count(*) FROM payments WHERE order_id = 'aaaaaaaa-7777-0000-0000-00000000000c')) FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-00000000000c'),
  '{"status": "open", "payments": 0}'::jsonb,
  'U7: insufficient → rollback สมบูรณ์ (order ยัง open + ไม่มี payment)'
);
SELECT is(
  (SELECT stock_quantity FROM product_variants WHERE id = 'eeeeeeee-7777-0000-0000-000000000003'),
  10,
  'U7: insufficient → สต๊อกไม่ถูกหัก'
);

-- ============================================================
-- L) cashflow.record override denied (2 asserts)
-- ============================================================
INSERT INTO membership_permission_overrides (id, membership_id, organization_id, store_id, permission_key, granted, reason, granted_by_user_id) VALUES
  ('bbbbbbbb-7777-0000-0000-000000000009', 'bbbbbbbb-7777-0000-0000-000000000003', 'aaaaaaaa-7777-0000-0000-000000000001', NULL, 'cashflow.record', false, 'U7 pgTAP', '00000000-7777-0000-0000-000000000001');
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-00000000000d"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-00000000000d', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-00000000000d')),
    'u7key-r13cash', 'b77777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000003', 'cash', 45, 45, 0
  )->>'code'),
  'up_forbidden',
  'U7: staff โดน override หักสิทธิ์ cashflow.record → up_forbidden'
);
SELECT is(
  (SELECT count(*) FROM unified_pos_operation_receipts WHERE store_id = 'cccccccc-7777-0000-0000-000000000001' AND operation_key = 'u7key-r13cash'),
  0::bigint,
  'U7: up_forbidden → ไม่เขียน receipt'
);

-- ============================================================
-- M) Cross-store + flag off (2 asserts)
-- ============================================================
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000002', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-00000000000f"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-00000000000f', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-00000000000f')),
    'u7key-r15xstr', 'c77777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'other', 45
  )->>'code'),
  'up_not_found',
  'U7: order ของ SA เรียกผ่าน SB → up_not_found'
);
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000004', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-00000000000e"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-00000000000e', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-00000000000e')),
    'u7key-r14flag0', 'd77777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'other', 45
  )->>'code'),
  'up_store_flag_disabled',
  'U7: SD ปิด flag → up_store_flag_disabled (fail closed)'
);

-- ============================================================
-- N) ร้านไม่มีหมวด income → autocreate 'ยอดขาย POS' (2 asserts)
-- ============================================================
SELECT is(
  (public.unified_pos_settle_table_order(
    'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000003', NULL,
    'partial', '["aaaaaaaa-7777-0000-0000-000000000010"]'::jsonb,
    jsonb_build_object('aaaaaaaa-7777-0000-0000-000000000010', (SELECT revision FROM orders WHERE id = 'aaaaaaaa-7777-0000-0000-000000000010')),
    'u7key-r16auto', 'e77777777777777777777777777777777777777777777777777777777777777',
    '00000000-7777-0000-0000-000000000001', 'other', 45
  )->>'status'),
  'executed',
  'U7: R16 settle ใน SC (ไม่มีหมวด) → executed'
);
SELECT is(
  (SELECT count(*) FROM accounting_categories WHERE store_id = 'cccccccc-7777-0000-0000-000000000003' AND name = 'ยอดขาย POS' AND type = 'income'),
  1::bigint,
  'U7: autocreate หมวด ยอดขาย POS ให้ร้านที่ไม่มี (mirror 20260623124138)'
);

-- ============================================================
-- O) purge financial (5 asserts)
-- ============================================================
INSERT INTO unified_pos_operation_receipts (organization_id, store_id, operation_type, operation_key, request_hash, result, payload, payload_expires_at, is_financial) VALUES
  ('aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'table_settlement', 'u7purge-fin-001', 'x', '{"grand_total": 1}'::jsonb, '{"p": 1}'::jsonb, NOW() - interval '31 days', true),
  ('aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'qr_submit',       'u7purge-non-001', 'x', '{"order_id": "x"}'::jsonb, '{"p": 2}'::jsonb, NOW() - interval '31 days', false),
  ('aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'table_settlement', 'u7purge-keep001', 'x', '{"grand_total": 3}'::jsonb, '{"p": 3}'::jsonb, NOW() + interval '30 days', true);
SELECT ok(
  public.purge_expired_unified_pos_receipt_payloads() >= 2,
  'U7: purge ทำงาน (ล้างอย่างน้อย 2 แถวที่หมดอายุ)'
);
SELECT is(
  (SELECT jsonb_build_object('result', result IS NOT NULL, 'payload', payload IS NOT NULL) FROM unified_pos_operation_receipts WHERE operation_key = 'u7purge-fin-001'),
  '{"result": true, "payload": false}'::jsonb,
  'U7: financial → payload ถูกล้าง แต่ result คงอยู่ (replay ได้แม้เกิน 30 วัน)'
);
SELECT is(
  (SELECT jsonb_build_object('result', result IS NOT NULL, 'payload', payload IS NOT NULL) FROM unified_pos_operation_receipts WHERE operation_key = 'u7purge-non-001'),
  '{"result": false, "payload": false}'::jsonb,
  'U7: ไม่ใช่ financial → result + payload ถูกล้าง (พฤติกรรมเดิม U2)'
);
SELECT is(
  (SELECT jsonb_build_object('result', result IS NOT NULL, 'payload', payload IS NOT NULL) FROM unified_pos_operation_receipts WHERE operation_key = 'u7purge-keep001'),
  '{"result": true, "payload": true}'::jsonb,
  'U7: ยังไม่หมดอายุ → ไม่ถูกแตะ'
);
SELECT is(
  (SELECT count(*) FROM unified_pos_operation_receipts WHERE operation_key LIKE 'u7purge-%'),
  3::bigint,
  'U7: purge ห้ามลบ tombstone (คง key/hash/type ครบ 3 แถว)'
);

SELECT finish();
ROLLBACK;
