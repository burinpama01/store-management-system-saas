-- ============================================================
-- U2 — Unified POS Foundation (pgTAP)
-- ครอบคลุม migration: supabase/migrations/20260831000001_unified_pos_foundation.sql
--   1) stores flags: unified_pos_enabled / kitchen_queue_enabled / voice_command_enabled
--   2) orders.revision + order_items.fulfillment_status / fulfillment_version
--   3) triggers: กัน client เขียนทับ revision/version + bump revision ของ parent order ทุกเส้นทาง
--   4) unified_pos_operation_receipts — idempotency tombstone + purge function
--   5) voice_aliases — unique lower(alias_text) ต่อ store
--   6) cross-store RLS denial (receipts + voice_aliases)
-- รันด้วย: supabase test db --local
-- หมายเหตุ: supabase test db ติดตั้ง pgTAP ลง schema "extensions" และรันเป็น postgres
--   (superuser จึง bypass RLS) — ส่วนทดสอบ RLS จะ SET LOCAL ROLE authenticated + jwt claims
-- ============================================================

BEGIN;
SELECT plan(70);

-- ============================================================
-- FIXTURES (uuid คงที่ทั้งหมด, hex เท่านั้น, prefix 2222 กันชนกับ seed)
--   org A / store A = ร้านของ user A (manager ระดับ org)
--   org B / store B = ร้านอื่น (ไว้พิสูจน์ cross-store denial)
-- ============================================================
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  phone, confirmation_token, recovery_token, email_change, email_change_token_new, phone_change, phone_change_token, reauthentication_token
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  '00000000-2222-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'up2-fixture@demo.local',
  extensions.crypt('up2-fixture', extensions.gen_salt('bf')),
  NOW(), NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  NULL, '', '', '', '', '', '', ''
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO organizations (id, name, slug, owner_id) VALUES
  ('aaaaaaaa-2222-0000-0000-000000000001', 'U2 Org A', 'u2-org-a', '00000000-2222-0000-0000-000000000001'),
  ('aaaaaaaa-2222-0000-0000-000000000002', 'U2 Org B', 'u2-org-b', '00000000-2222-0000-0000-000000000001');

INSERT INTO stores (id, organization_id, name, slug) VALUES
  ('cccccccc-2222-0000-0000-000000000001', 'aaaaaaaa-2222-0000-0000-000000000001', 'U2 Store A', 'u2-store-a'),
  ('cccccccc-2222-0000-0000-000000000002', 'aaaaaaaa-2222-0000-0000-000000000002', 'U2 Store B', 'u2-store-b');

-- user A เป็น manager ระดับ org A (store_id NULL = เห็นทุก store ใน org ตาม helper เดิม)
INSERT INTO memberships (id, organization_id, store_id, user_id, role, joined_at) VALUES
  ('bbbbbbbb-2222-0000-0000-000000000001', 'aaaaaaaa-2222-0000-0000-000000000001', NULL, '00000000-2222-0000-0000-000000000001', 'manager', NOW());

INSERT INTO categories (id, organization_id, store_id, name) VALUES
  ('eeeeeeee-2222-0000-0000-000000000001', 'aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001', 'U2 Category');

INSERT INTO products (id, organization_id, store_id, category_id, name, base_price) VALUES
  ('eeeeeeee-2222-0000-0000-000000000002', 'aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001', 'eeeeeeee-2222-0000-0000-000000000001', 'U2 Product', 50);

INSERT INTO orders (id, organization_id, store_id, order_number, cashier_id) VALUES
  ('ffffffff-2222-0000-0000-000000000001', 'aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001', 'U2-0001', '00000000-2222-0000-0000-000000000001');

-- ============================================================
-- A) Schema: คอลัมน์/constraint/trigger/ตาราง/policy/function ครบ (41 asserts)
-- ============================================================
SELECT has_column('stores', 'unified_pos_enabled', 'U2: stores.unified_pos_enabled มีอยู่');
SELECT col_type_is('stores', 'unified_pos_enabled', 'boolean', 'U2: stores.unified_pos_enabled เป็น boolean');
SELECT col_not_null('stores', 'unified_pos_enabled', 'U2: stores.unified_pos_enabled not null');
SELECT col_has_default('stores', 'unified_pos_enabled', 'U2: stores.unified_pos_enabled มี default');

SELECT has_column('stores', 'kitchen_queue_enabled', 'U2: stores.kitchen_queue_enabled มีอยู่');
SELECT col_type_is('stores', 'kitchen_queue_enabled', 'boolean', 'U2: stores.kitchen_queue_enabled เป็น boolean');
SELECT col_not_null('stores', 'kitchen_queue_enabled', 'U2: stores.kitchen_queue_enabled not null');
SELECT col_has_default('stores', 'kitchen_queue_enabled', 'U2: stores.kitchen_queue_enabled มี default');

SELECT has_column('stores', 'voice_command_enabled', 'U2: stores.voice_command_enabled มีอยู่');
SELECT col_type_is('stores', 'voice_command_enabled', 'boolean', 'U2: stores.voice_command_enabled เป็น boolean');
SELECT col_not_null('stores', 'voice_command_enabled', 'U2: stores.voice_command_enabled not null');
SELECT col_has_default('stores', 'voice_command_enabled', 'U2: stores.voice_command_enabled มี default');

SELECT has_column('orders', 'revision', 'U2: orders.revision มีอยู่');
SELECT col_type_is('orders', 'revision', 'bigint', 'U2: orders.revision เป็น bigint');
SELECT col_not_null('orders', 'revision', 'U2: orders.revision not null');
SELECT col_has_default('orders', 'revision', 'U2: orders.revision มี default');

SELECT has_column('order_items', 'fulfillment_status', 'U2: order_items.fulfillment_status มีอยู่');
SELECT col_type_is('order_items', 'fulfillment_status', 'text', 'U2: order_items.fulfillment_status เป็น text');
SELECT col_not_null('order_items', 'fulfillment_status', 'U2: order_items.fulfillment_status not null');
SELECT col_has_default('order_items', 'fulfillment_status', 'U2: order_items.fulfillment_status มี default');

SELECT has_column('order_items', 'fulfillment_version', 'U2: order_items.fulfillment_version มีอยู่');
SELECT col_type_is('order_items', 'fulfillment_version', 'bigint', 'U2: order_items.fulfillment_version เป็น bigint');
SELECT col_not_null('order_items', 'fulfillment_version', 'U2: order_items.fulfillment_version not null');
SELECT col_has_default('order_items', 'fulfillment_version', 'U2: order_items.fulfillment_version มี default');

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.order_items'::regclass
      AND conname = 'order_items_fulfillment_status_check'
      AND contype = 'c'
  ),
  'U2: fulfillment_status มี CHECK enum (order_items_fulfillment_status_check)'
);

SELECT has_trigger('orders', 'unified_pos_orders_revision_bu', 'U2: trigger revision บน orders');
SELECT has_trigger('order_items', 'unified_pos_items_version_bu', 'U2: trigger version บน order_items');
SELECT has_trigger('order_items', 'unified_pos_items_parent_bump', 'U2: trigger parent bump บน order_items');

SELECT has_table('public', 'unified_pos_operation_receipts', 'U2: ตาราง unified_pos_operation_receipts มีอยู่');
SELECT has_table('public', 'voice_aliases', 'U2: ตาราง voice_aliases มีอยู่');

SELECT fk_ok('unified_pos_operation_receipts', 'store_id', 'stores', 'id', 'U2: receipts.store_id -> stores.id');
SELECT fk_ok('voice_aliases', 'store_id', 'stores', 'id', 'U2: voice_aliases.store_id -> stores.id');
-- (fk_ok ใช้กับ FK ข้าม schema เช่น auth.users ไม่ได้ตรงๆ จึงเช็ค pg_constraint โดยตรง)
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.voice_aliases'::regclass
      AND confrelid = 'auth.users'::regclass
      AND contype = 'f'
      AND conkey @> ARRAY[
        (SELECT attnum::smallint FROM pg_attribute
         WHERE attrelid = 'public.voice_aliases'::regclass AND attname = 'created_by')
      ]
  ),
  'U2: voice_aliases.created_by -> auth.users.id'
);

SELECT has_index('public', 'unified_pos_operation_receipts', 'unified_pos_operation_receipts_store_operation_key_unique', 'U2: unique (store_id, operation_key) บน receipts');
SELECT has_index('public', 'voice_aliases', 'voice_aliases_store_alias_text_lower_unique', 'U2: unique (store_id, lower(alias_text)) บน voice_aliases');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.unified_pos_operation_receipts')) IS TRUE,
  'U2: receipts เปิด RLS'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.voice_aliases')) IS TRUE,
  'U2: voice_aliases เปิด RLS'
);

SELECT policies_are(
  'public',
  'unified_pos_operation_receipts',
  ARRAY['unified_pos_operation_receipts: store member can read'],
  'U2: receipts มีเฉพาะ policy SELECT (ไม่มี client INSERT/UPDATE/DELETE)'
);
SELECT policies_are(
  'public',
  'voice_aliases',
  ARRAY[
    'voice_aliases: store member can read',
    'voice_aliases: manager+ can insert',
    'voice_aliases: manager+ can update',
    'voice_aliases: manager+ can delete'
  ],
  'U2: voice_aliases policies ครบ SELECT + manager+ write'
);

SELECT has_function('purge_expired_unified_pos_receipt_payloads', 'U2: purge function มีอยู่');
SELECT is(
  (SELECT prorettype::regtype::text FROM pg_proc WHERE proname = 'purge_expired_unified_pos_receipt_payloads'),
  'integer',
  'U2: purge function คืน integer'
);

-- ============================================================
-- B) Store flags ต้อง default false ทั้ง 3 ตัว (3 asserts)
-- ============================================================
INSERT INTO stores (id, organization_id, name, slug) VALUES
  ('cccccccc-2222-0000-0000-000000000003', 'aaaaaaaa-2222-0000-0000-000000000001', 'U2 Store Defaults', 'u2-store-defaults');

SELECT is((SELECT unified_pos_enabled FROM stores WHERE id = 'cccccccc-2222-0000-0000-000000000003'), false, 'U2: unified_pos_enabled default false');
SELECT is((SELECT kitchen_queue_enabled FROM stores WHERE id = 'cccccccc-2222-0000-0000-000000000003'), false, 'U2: kitchen_queue_enabled default false');
SELECT is((SELECT voice_command_enabled FROM stores WHERE id = 'cccccccc-2222-0000-0000-000000000003'), false, 'U2: voice_command_enabled default false');

-- ============================================================
-- C) Trigger ทำงานจริงทุกเส้นทาง (12 asserts)
-- ============================================================
-- INSERT order -> revision = 1
SELECT is((SELECT revision FROM orders WHERE id = 'ffffffff-2222-0000-0000-000000000001'), 1::bigint, 'U2: INSERT order -> revision 1');
-- UPDATE -> +1
UPDATE orders SET note = 'u2-bump-1' WHERE id = 'ffffffff-2222-0000-0000-000000000001';
SELECT is((SELECT revision FROM orders WHERE id = 'ffffffff-2222-0000-0000-000000000001'), 2::bigint, 'U2: UPDATE order -> revision 2');
-- client พยายามเขียน revision เอง -> ถูก trigger override เป็น OLD+1
UPDATE orders SET revision = 999 WHERE id = 'ffffffff-2222-0000-0000-000000000001';
SELECT is((SELECT revision FROM orders WHERE id = 'ffffffff-2222-0000-0000-000000000001'), 3::bigint, 'U2: set revision=999 ถูก override เป็น 3');

-- INSERT item -> fulfillment_version 1 + parent revision ถูก bump
INSERT INTO order_items (id, order_id, product_id, product_name, quantity, unit_price, total_price) VALUES
  ('ffffffff-2222-0000-0000-000000000002', 'ffffffff-2222-0000-0000-000000000001', 'eeeeeeee-2222-0000-0000-000000000002', 'U2 Product', 1, 50, 50);
SELECT is((SELECT fulfillment_version FROM order_items WHERE id = 'ffffffff-2222-0000-0000-000000000002'), 1::bigint, 'U2: INSERT item -> fulfillment_version 1');
SELECT is((SELECT fulfillment_status FROM order_items WHERE id = 'ffffffff-2222-0000-0000-000000000002'), 'new', 'U2: INSERT item -> fulfillment_status default new');
SELECT is((SELECT revision FROM orders WHERE id = 'ffffffff-2222-0000-0000-000000000001'), 4::bigint, 'U2: INSERT item -> parent revision bump เป็น 4');

-- UPDATE item -> version +1 + parent bump
UPDATE order_items SET fulfillment_status = 'preparing' WHERE id = 'ffffffff-2222-0000-0000-000000000002';
SELECT is((SELECT fulfillment_version FROM order_items WHERE id = 'ffffffff-2222-0000-0000-000000000002'), 2::bigint, 'U2: UPDATE item -> fulfillment_version 2');
SELECT is((SELECT revision FROM orders WHERE id = 'ffffffff-2222-0000-0000-000000000001'), 5::bigint, 'U2: UPDATE item -> parent revision bump เป็น 5');

-- client พยายามเขียน fulfillment_version เอง -> ถูก override เป็น OLD+1
UPDATE order_items SET fulfillment_version = 999 WHERE id = 'ffffffff-2222-0000-0000-000000000002';
SELECT is((SELECT fulfillment_version FROM order_items WHERE id = 'ffffffff-2222-0000-0000-000000000002'), 3::bigint, 'U2: set fulfillment_version=999 ถูก override เป็น 3');
SELECT is((SELECT revision FROM orders WHERE id = 'ffffffff-2222-0000-0000-000000000001'), 6::bigint, 'U2: override item ยัง bump parent เป็น 6');

-- DELETE item -> parent bump (ทุกเส้นทางรวมถึง delete)
DELETE FROM order_items WHERE id = 'ffffffff-2222-0000-0000-000000000002';
SELECT is((SELECT revision FROM orders WHERE id = 'ffffffff-2222-0000-0000-000000000001'), 7::bigint, 'U2: DELETE item -> parent revision bump เป็น 7');

-- enum ห้ามมี voided (canonical void คือ order_items.voided boolean เดิม)
SELECT throws_ok(
  $t$INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, total_price, fulfillment_status)
  VALUES ('ffffffff-2222-0000-0000-000000000001', 'eeeeeeee-2222-0000-0000-000000000002', 'U2 Product', 1, 50, 50, 'voided')$t$,
  '23514'
);

-- ============================================================
-- D) Receipts: unique (store_id, operation_key) + purge แบบ tombstone (7 asserts)
-- ============================================================
SELECT lives_ok(
  $t$INSERT INTO unified_pos_operation_receipts (id, organization_id, store_id, operation_type, operation_key, request_hash, result, targets, payload)
  VALUES ('bbbbbbbb-2222-0000-0000-000000000011', 'aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001', 'qr_submit', 'op-future', 'hash-future', '{"status":"executed"}'::jsonb, '[{"type":"order"}]'::jsonb, '{"amount":100}'::jsonb)$t$,
  'U2: INSERT receipt (ยังไม่หมดอายุ)'
);
SELECT lives_ok(
  $t$INSERT INTO unified_pos_operation_receipts (id, organization_id, store_id, operation_type, operation_key, request_hash, result, targets, payload, payload_expires_at)
  VALUES ('bbbbbbbb-2222-0000-0000-000000000012', 'aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001', 'add_items', 'op-past', 'hash-past', '{"status":"executed"}'::jsonb, '[{"type":"item"}]'::jsonb, '{"amount":200}'::jsonb, now() - interval '1 day')$t$,
  'U2: INSERT receipt (หมดอายุแล้ว)'
);

-- purge รอบแรก: เคลียร์เฉพาะแถวหมดอายุ = 1
SELECT is(purge_expired_unified_pos_receipt_payloads(), 1, 'U2: purge ครั้งแรกคืน 1');
-- tombstone: result/payload เป็น NULL แต่ key/hash/type/targets ยังอยู่ (ห้ามลบแถว)
SELECT is(
  (SELECT count(*)::int FROM unified_pos_operation_receipts
   WHERE id = 'bbbbbbbb-2222-0000-0000-000000000012'
     AND result IS NULL AND payload IS NULL
     AND operation_type = 'add_items' AND operation_key = 'op-past'
     AND request_hash = 'hash-past' AND targets IS NOT NULL),
  1,
  'U2: purge เป็น tombstone (key/hash/type/targets คงอยู่ แถวยังไม่ถูกลบ)'
);
-- แถวที่ยังไม่หมดอายุต้องไม่โดนแตะ
SELECT is(
  (SELECT count(*)::int FROM unified_pos_operation_receipts
   WHERE id = 'bbbbbbbb-2222-0000-0000-000000000011' AND result IS NOT NULL AND payload IS NOT NULL),
  1,
  'U2: receipt ที่ยังไม่หมดอายุไม่ถูก purge'
);
-- purge รอบสอง: idempotent = 0
SELECT is(purge_expired_unified_pos_receipt_payloads(), 0, 'U2: purge ครั้งที่สองคืน 0 (idempotent)');
-- (store_id, operation_key) ซ้ำ -> unique violation
SELECT throws_ok(
  $t$INSERT INTO unified_pos_operation_receipts (id, organization_id, store_id, operation_type, operation_key, request_hash)
  VALUES ('bbbbbbbb-2222-0000-0000-000000000019', 'aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001', 'qr_submit', 'op-future', 'hash-other')$t$,
  '23505'
);

-- ============================================================
-- E) Cross-store RLS (7 asserts)
--    fixture: receipt/alias ของ store A (2 receipts + 1 alias) และ store B (1 + 1)
--    จำลอง user A (member ของ org A) -> ต้องเห็นเฉพาะ store A เท่านั้น
-- ============================================================
INSERT INTO unified_pos_operation_receipts (id, organization_id, store_id, operation_type, operation_key, request_hash) VALUES
  ('bbbbbbbb-2222-0000-0000-000000000013', 'aaaaaaaa-2222-0000-0000-000000000002', 'cccccccc-2222-0000-0000-000000000002', 'qr_submit', 'op-storeb', 'hash-storeb');
INSERT INTO voice_aliases (id, organization_id, store_id, alias_text, intent_type, created_by) VALUES
  ('bbbbbbbb-2222-0000-0000-000000000021', 'aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001', 'เปิดโต๊ะ', 'open_table', '00000000-2222-0000-0000-000000000001');
INSERT INTO voice_aliases (id, organization_id, store_id, alias_text, intent_type, created_by) VALUES
  ('bbbbbbbb-2222-0000-0000-000000000022', 'aaaaaaaa-2222-0000-0000-000000000002', 'cccccccc-2222-0000-0000-000000000002', 'สั่งเป็นเสียง', 'voice_order', '00000000-2222-0000-0000-000000000001');

SET LOCAL "request.jwt.claims" = '{"sub":"00000000-2222-0000-0000-000000000001","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- read: เห็นเฉพาะร้านตัวเอง
SELECT is((SELECT count(*)::int FROM unified_pos_operation_receipts), 2, 'U2 RLS: user A เห็น receipt เฉพาะ store A (2 แถว)');
SELECT is((SELECT count(*)::int FROM unified_pos_operation_receipts WHERE store_id = 'cccccccc-2222-0000-0000-000000000002'), 0, 'U2 RLS: user A ไม่เห็น receipt ของ store B');
SELECT is((SELECT count(*)::int FROM voice_aliases), 1, 'U2 RLS: user A เห็น voice_alias เฉพาะ store A (1 แถว)');
SELECT is((SELECT count(*)::int FROM voice_aliases WHERE store_id = 'cccccccc-2222-0000-0000-000000000002'), 0, 'U2 RLS: user A ไม่เห็น voice_alias ของ store B');

-- write: voice_aliases ร้านอื่นไม่ได้ (manager ของ org A แต่ไม่ใช่ member ของ store B)
SELECT throws_ok(
  $t$INSERT INTO voice_aliases (id, organization_id, store_id, alias_text, intent_type, created_by)
  VALUES ('bbbbbbbb-2222-0000-0000-000000000023', 'aaaaaaaa-2222-0000-0000-000000000002', 'cccccccc-2222-0000-0000-000000000002', 'ห้ามผ่าน', 'voice_order', '00000000-2222-0000-0000-000000000001')$t$,
  '42501'
);
-- write: voice_aliases ร้านตัวเองได้ (manager+ insert policy)
SELECT lives_ok(
  $t$INSERT INTO voice_aliases (id, organization_id, store_id, alias_text, intent_type, created_by)
  VALUES ('bbbbbbbb-2222-0000-0000-000000000024', 'aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001', 'เปิดโต๊ะใหม่', 'open_table', '00000000-2222-0000-0000-000000000001')$t$,
  'U2 RLS: manager เขียน voice_aliases ของ store ตัวเองได้'
);
-- write: receipts ห้าม client เขียนแม้แต่ร้านตัวเอง (การเขียนเกิดผ่าน SECURITY DEFINER RPC เท่านั้น)
SELECT throws_ok(
  $t$INSERT INTO unified_pos_operation_receipts (id, organization_id, store_id, operation_type, operation_key, request_hash)
  VALUES ('bbbbbbbb-2222-0000-0000-000000000025', 'aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001', 'qr_submit', 'op-client', 'hash-client')$t$,
  '42501'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
