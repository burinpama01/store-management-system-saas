-- ============================================================
-- Audit ระบบแต้ม/สมาชิก — ข้อ 8 (ledger ตรงกับ balance) และข้อ 13 (คูปองผูกลูกค้า)
-- ครอบคลุม migration:
--   supabase/migrations/20260904000001_reward_coupon_bind_customer.sql
--   supabase/migrations/20260904000002_void_reversal_ledger_consistency.sql
--
-- สิ่งที่พิสูจน์:
--   A) ยกเลิกบิลปกติ (แต้มยังอยู่ครบ) → หักคืนเต็มจำนวน ledger = balance
--   B) ยกเลิกบิลหลังลูกค้าใช้แต้มไปแล้ว → คืนได้เท่าที่เหลือ, balance ไม่ติดลบ,
--      ledger บันทึกเท่ากับที่หักจริง (ไม่ drift) และ reason บอกส่วนที่ขาด
--   C) คูปองจากการแลกแต้มถูกผูกกับลูกค้าผู้แลก (customer_ids ไม่ว่าง)
--
-- รันด้วย: supabase test db --local
-- ============================================================
BEGIN;
SELECT plan(11);

-- ============================================================
-- FIXTURES (prefix 8888 กันชนกับชุดอื่น)
-- ============================================================
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  phone, confirmation_token, recovery_token, email_change, email_change_token_new, phone_change, phone_change_token, reauthentication_token
)
VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-8888-0000-0000-000000000001', 'authenticated', 'authenticated', 'loyalty-owner@demo.local', extensions.crypt('x', extensions.gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{}', NULL, '', '', '', '', '', '', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organizations (id, name, slug, owner_id) VALUES
  ('aaaaaaaa-8888-0000-0000-000000000001', 'Loyalty Org', 'loyalty-org', '00000000-8888-0000-0000-000000000001');

INSERT INTO stores (id, organization_id, name, slug) VALUES
  ('cccccccc-8888-0000-0000-000000000001', 'aaaaaaaa-8888-0000-0000-000000000001', 'Loyalty Store', 'loyalty-store');

INSERT INTO memberships (id, organization_id, store_id, user_id, role, joined_at) VALUES
  ('bbbbbbbb-8888-0000-0000-000000000001', 'aaaaaaaa-8888-0000-0000-000000000001', NULL, '00000000-8888-0000-0000-000000000001', 'owner', NOW());

-- ลูกค้า 2 ราย: C1 สำหรับ void เต็มจำนวน, C2 สำหรับกรณีใช้แต้มไปก่อน
INSERT INTO customers (id, organization_id, store_id, name, phone, is_active) VALUES
  ('dddddddd-8888-0000-0000-000000000001', 'aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'ลูกค้า หนึ่ง', '0800000001', true),
  ('dddddddd-8888-0000-0000-000000000002', 'aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'ลูกค้า สอง', '0800000002', true);

INSERT INTO loyalty_accounts (id, organization_id, store_id, customer_id, points_balance) VALUES
  ('a1a1a1a1-8888-0000-0000-000000000001', 'aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'dddddddd-8888-0000-0000-000000000001', 10.00),
  ('a1a1a1a1-8888-0000-0000-000000000002', 'aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'dddddddd-8888-0000-0000-000000000002', 3.00);

-- บิลที่จะถูกยกเลิก (ยังไม่จ่าย ตามเงื่อนไขของ RPC)
INSERT INTO orders (id, organization_id, store_id, order_number, status, subtotal, discount, total, customer_id) VALUES
  ('0de40de4-8888-0000-0000-000000000001', 'aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'L-0001', 'open', 1000, 0, 1000, 'dddddddd-8888-0000-0000-000000000001'),
  ('0de40de4-8888-0000-0000-000000000002', 'aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'L-0002', 'open', 1000, 0, 1000, 'dddddddd-8888-0000-0000-000000000002');

-- ledger "ได้แต้ม" ที่ผูกกับบิลทั้งสอง (คนละ 10 แต้ม)
INSERT INTO loyalty_ledger (organization_id, store_id, account_id, customer_id, order_id, type, points_delta, reason, idempotency_key) VALUES
  ('aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'a1a1a1a1-8888-0000-0000-000000000001', 'dddddddd-8888-0000-0000-000000000001', '0de40de4-8888-0000-0000-000000000001', 'earn', 10.00, 'ซื้อสินค้า', 'l-earn-1'),
  ('aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'a1a1a1a1-8888-0000-0000-000000000002', 'dddddddd-8888-0000-0000-000000000002', '0de40de4-8888-0000-0000-000000000002', 'earn', 10.00, 'ซื้อสินค้า', 'l-earn-2');

-- ลูกค้า C2 ใช้แต้มไป 7 แต้มก่อนบิลจะถูกยกเลิก (เหลือ 3) — นี่คือเงื่อนไขที่ทำให้เกิด drift
INSERT INTO loyalty_ledger (organization_id, store_id, account_id, customer_id, order_id, type, points_delta, reason, idempotency_key) VALUES
  ('aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'a1a1a1a1-8888-0000-0000-000000000002', 'dddddddd-8888-0000-0000-000000000002', NULL, 'redeem', -7.00, 'แลกของรางวัล', 'l-redeem-2');

-- สวมสิทธิ์เจ้าของร้าน (RPC ตรวจ auth.uid() + role)
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-8888-0000-0000-000000000001","role":"authenticated"}',
  true
);

-- ============================================================
-- A) ยกเลิกบิลของ C1 — แต้มยังอยู่ครบ 10 จึงหักคืนได้เต็ม
-- ============================================================
SELECT lives_ok(
  $$ SELECT void_grocery_pos_order_with_rewards(
       '0de40de4-8888-0000-0000-000000000001'::uuid,
       'cccccccc-8888-0000-0000-000000000001'::uuid,
       '00000000-8888-0000-0000-000000000001'::uuid,
       'ทดสอบยกเลิก', 'void-key-1') $$,
  'A1: ยกเลิกบิลที่แต้มยังอยู่ครบทำได้'
);

SELECT is(
  (SELECT points_balance FROM loyalty_accounts WHERE id = 'a1a1a1a1-8888-0000-0000-000000000001'),
  0.00::numeric,
  'A2: หักคืนเต็ม 10 แต้ม เหลือ 0'
);

SELECT is(
  (SELECT points_delta FROM loyalty_ledger
    WHERE account_id = 'a1a1a1a1-8888-0000-0000-000000000001' AND type = 'reversal'),
  -10.00::numeric,
  'A3: ledger บันทึก -10 ตรงกับที่หักจริง'
);

SELECT is(
  (SELECT sum(points_delta) FROM loyalty_ledger WHERE account_id = 'a1a1a1a1-8888-0000-0000-000000000001'),
  (SELECT points_balance FROM loyalty_accounts WHERE id = 'a1a1a1a1-8888-0000-0000-000000000001'),
  'A4: ผลรวม ledger เท่ากับ balance (ไม่ drift)'
);

-- ============================================================
-- B) ยกเลิกบิลของ C2 — ลูกค้าใช้แต้มไปแล้ว เหลือ 3 หักคืนได้แค่ 3
--    นี่คือเคสที่เดิมทำให้ ledger บอก -10 แต่ balance ลดแค่ 3
-- ============================================================
SELECT lives_ok(
  $$ SELECT void_grocery_pos_order_with_rewards(
       '0de40de4-8888-0000-0000-000000000002'::uuid,
       'cccccccc-8888-0000-0000-000000000001'::uuid,
       '00000000-8888-0000-0000-000000000001'::uuid,
       'ทดสอบยกเลิก', 'void-key-2') $$,
  'B1: ยกเลิกบิลหลังลูกค้าใช้แต้มไปแล้วทำได้ ไม่ชน CHECK'
);

SELECT is(
  (SELECT points_balance FROM loyalty_accounts WHERE id = 'a1a1a1a1-8888-0000-0000-000000000002'),
  0.00::numeric,
  'B2: balance ลงถึง 0 และไม่ติดลบ'
);

SELECT is(
  (SELECT points_delta FROM loyalty_ledger
    WHERE account_id = 'a1a1a1a1-8888-0000-0000-000000000002' AND type = 'reversal'),
  -3.00::numeric,
  'B3: ledger บันทึก -3 เท่าที่หักได้จริง ไม่ใช่ -10 (บั๊กเดิม)'
);

SELECT is(
  (SELECT sum(points_delta) FROM loyalty_ledger WHERE account_id = 'a1a1a1a1-8888-0000-0000-000000000002'),
  (SELECT points_balance FROM loyalty_accounts WHERE id = 'a1a1a1a1-8888-0000-0000-000000000002'),
  'B4: ผลรวม ledger เท่ากับ balance (บั๊ก drift ถูกปิด)'
);

SELECT ok(
  (SELECT reason LIKE '%คืนได้ไม่ครบ%' FROM loyalty_ledger
    WHERE account_id = 'a1a1a1a1-8888-0000-0000-000000000002' AND type = 'reversal'),
  'B5: reason บอกว่าคืนได้ไม่ครบเพราะลูกค้าใช้แต้มไปแล้ว'
);

RESET ROLE;

-- ============================================================
-- C) คูปองจากการแลกแต้มต้องผูกกับลูกค้าผู้แลก (audit ข้อ 13)
-- ============================================================
INSERT INTO loyalty_rewards (id, organization_id, store_id, name, points_cost, reward_type, discount_kind, discount_value, is_active) VALUES
  ('bebebebe-8888-0000-0000-000000000001', 'aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001', 'ส่วนลด 50 บาท', 5, 'discount', 'amount', 50, true);

UPDATE loyalty_accounts SET points_balance = 20
 WHERE id = 'a1a1a1a1-8888-0000-0000-000000000001';

SELECT lives_ok(
  $$ SELECT redeem_loyalty_reward(
       'aaaaaaaa-8888-0000-0000-000000000001'::uuid,
       'cccccccc-8888-0000-0000-000000000001'::uuid,
       'dddddddd-8888-0000-0000-000000000001'::uuid,
       'bebebebe-8888-0000-0000-000000000001'::uuid,
       'redeem-key-0001') $$,
  'C1: แลกของรางวัลแบบส่วนลดสำเร็จ'
);

SELECT is(
  (SELECT customer_ids FROM coupons
    WHERE store_id = 'cccccccc-8888-0000-0000-000000000001'
      AND name LIKE 'ของรางวัล:%'),
  ARRAY['dddddddd-8888-0000-0000-000000000001']::uuid[],
  'C2: คูปองผูกกับลูกค้าผู้แลกเท่านั้น ไม่ใช่ bearer code'
);

SELECT * FROM finish();
ROLLBACK;
