-- Development seed data for Store Management SaaS
-- Apply after migrations: supabase db reset (local) or supabase db push (remote)
-- All IDs are stable UUIDs so they can be referenced cross-table.

-- ============================================================
-- Auth user (owner) - seeded so the seed is self-sufficient on a
-- fresh local database; organizations.owner_id FK requires this row.
-- Login: owner@demo.local / demo1234 (local only)
-- ============================================================
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  phone, confirmation_token, recovery_token, email_change, email_change_token_new, phone_change, phone_change_token, reauthentication_token
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'owner@demo.local',
  extensions.crypt('demo1234', extensions.gen_salt('bf')),
  NOW(),
  NOW(),
  NOW(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  '', '', '', '', '', '', '', ''
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (
  id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'email',
  'email',
  jsonb_build_object('sub', '00000000-0000-0000-0000-000000000001', 'email', 'owner@demo.local'),
  NOW(),
  NOW(),
  NOW()
)
ON CONFLICT DO NOTHING;
-- ============================================================
-- Organization
-- ============================================================
INSERT INTO organizations (id, name, slug, owner_id)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Demo Restaurant Co.',
  'demo-restaurant',
  '00000000-0000-0000-0000-000000000001'  -- seeded auth user (must exist first via Supabase Dashboard or auth.users insert)
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Subscription (free tier)
-- ============================================================
INSERT INTO subscriptions (id, organization_id, plan, status, current_period_start, current_period_end, cancel_at_period_end)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'free',
  'active',
  NOW(),
  (NOW() + INTERVAL '30 days'),
  false
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Store
-- ============================================================
INSERT INTO stores (id, organization_id, name, slug, address, phone, currency_code, timezone, locale, is_active, buffet_enabled, qr_ordering_enabled)
VALUES (
  'cccccccc-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Main Branch',
  'main-branch',
  '123 Demo Street, Bangkok',
  '0812345678',
  'THB',
  'Asia/Bangkok',
  'th-TH',
  true,
  false,
  false
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Receipt settings (ร้านจริงมีแถวนี้เสมอ — สร้างตอนสมัคร/ตั้งค่าใบเสร็จ)
-- U17: หลัง `supabase db reset` เทส printing/e2e ต้องมีแถวนี้อยู่ก่อน ไม่งั้น fixture
-- จะล้มทั้งชุด (เทสตั้งใจไม่ upsert เพื่อไม่ทับค่าจริงของร้าน)
-- ============================================================
INSERT INTO receipt_settings (id, organization_id, store_id, store_name, address, phone, paper_width, print_copies)
VALUES (
  'cccccccc-1111-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000001',
  'Main Branch',
  '123 Demo Street, Bangkok',
  '0812345678',
  '80mm',
  1
)
ON CONFLICT (store_id) DO NOTHING;

-- ============================================================
-- Membership (owner)
-- Note: replace user_id with the actual auth UID after creating the test user
-- ============================================================
INSERT INTO memberships (id, organization_id, store_id, user_id, role, invited_at, joined_at)
VALUES (
  'dddddddd-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001',
  NULL,  -- org-level membership grants access to all stores
  '00000000-0000-0000-0000-000000000001',
  'owner',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Tables
-- ============================================================
INSERT INTO tables (id, organization_id, store_id, number, label, seats, is_active, qr_enabled, status)
VALUES
  ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '1', 'Window seat', 4, true, false, 'available'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '2', 'Center', 2, true, false, 'available'),
  ('eeeeeeee-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '3', 'Bar', 4, true, false, 'available')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Accounting categories (default set)
-- ============================================================
INSERT INTO accounting_categories (id, organization_id, store_id, name, type, is_default, sort_order)
VALUES
  ('ffffffff-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'ยอดขาย POS', 'income', true, 1),
  ('ffffffff-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'รายรับอื่นๆ', 'income', true, 2),
  ('ffffffff-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'ค่าวัตถุดิบ', 'expense', true, 3),
  ('ffffffff-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'ค่าแรง', 'expense', true, 4),
  ('ffffffff-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'ค่าสาธารณูปโภค', 'expense', true, 5),
  ('ffffffff-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'ค่าใช้จ่ายอื่นๆ', 'expense', true, 6),
  ('ffffffff-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'ปรับยอดเงินสด', 'cash_adjustment', true, 7)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Catalog: Categories
-- ============================================================
INSERT INTO categories (id, organization_id, store_id, name, sort_order, is_active)
VALUES
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'เครื่องดื่ม', 1, true),
  ('11111111-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'อาหาร', 2, true),
  ('11111111-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'ของหวาน', 3, true)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Catalog: Products
-- ============================================================
INSERT INTO products (id, organization_id, store_id, category_id, name, base_price, is_active, available_for_pos, available_for_qr, sort_order)
VALUES
  ('22222222-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'กาแฟดำ', 45, true, true, false, 1),
  ('22222222-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'ลาเต้', 55, true, true, false, 2),
  ('22222222-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'ชาเย็น', 40, true, true, false, 3),
  ('22222222-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000002', 'ข้าวผัดกุ้ง', 120, true, true, false, 1),
  ('22222222-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000002', 'ผัดกะเพราหมูสับ', 100, true, true, false, 2),
  ('22222222-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000003', 'วาฟเฟิลราดน้ำผึ้ง', 85, true, true, false, 1)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Catalog: Variants (size for drinks)
-- ============================================================
INSERT INTO product_variants (id, product_id, name, price_adjustment, is_active, sort_order)
VALUES
  ('33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 'เล็ก (S)', 0, true, 1),
  ('33333333-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000001', 'ใหญ่ (L)', 10, true, 2),
  ('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 'เล็ก (S)', 0, true, 1),
  ('33333333-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002', 'ใหญ่ (L)', 15, true, 2)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Catalog: Modifier groups (sweetness for drinks)
-- ============================================================
INSERT INTO modifier_groups (id, product_id, name, selection_type, is_required, min_selections, max_selections, sort_order)
VALUES
  ('44444444-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 'ความหวาน', 'single', true, 1, 1, 1),
  ('44444444-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', 'ความหวาน', 'single', true, 1, 1, 1),
  ('44444444-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000003', 'ความหวาน', 'single', true, 1, 1, 1),
  ('44444444-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000004', 'ตัวเลือกเพิ่ม', 'multiple', false, 0, 3, 1)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Catalog: Modifier options
-- ============================================================
INSERT INTO modifier_options (id, modifier_group_id, name, price_adjustment, is_default, is_active, sort_order)
VALUES
  -- กาแฟดำ sweetness
  ('55555555-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001', 'ไม่หวาน', 0, false, true, 1),
  ('55555555-0000-0000-0000-000000000002', '44444444-0000-0000-0000-000000000001', 'หวานน้อย', 0, false, true, 2),
  ('55555555-0000-0000-0000-000000000003', '44444444-0000-0000-0000-000000000001', 'หวานปกติ', 0, true, true, 3),
  ('55555555-0000-0000-0000-000000000004', '44444444-0000-0000-0000-000000000001', 'หวานมาก', 0, false, true, 4),
  -- ลาเต้ sweetness
  ('55555555-0000-0000-0000-000000000005', '44444444-0000-0000-0000-000000000002', 'ไม่หวาน', 0, false, true, 1),
  ('55555555-0000-0000-0000-000000000006', '44444444-0000-0000-0000-000000000002', 'หวานน้อย', 0, false, true, 2),
  ('55555555-0000-0000-0000-000000000007', '44444444-0000-0000-0000-000000000002', 'หวานปกติ', 0, true, true, 3),
  -- ชาเย็น sweetness
  ('55555555-0000-0000-0000-000000000008', '44444444-0000-0000-0000-000000000003', 'หวานน้อย', 0, false, true, 1),
  ('55555555-0000-0000-0000-000000000009', '44444444-0000-0000-0000-000000000003', 'หวานปกติ', 0, true, true, 2),
  -- ข้าวผัดกุ้ง extras
  ('55555555-0000-0000-0000-000000000010', '44444444-0000-0000-0000-000000000004', 'เพิ่มไข่ดาว', 15, false, true, 1),
  ('55555555-0000-0000-0000-000000000011', '44444444-0000-0000-0000-000000000004', 'เพิ่มผักบุ้ง', 10, false, true, 2),
  ('55555555-0000-0000-0000-000000000012', '44444444-0000-0000-0000-000000000004', 'ข้าวเพิ่ม', 20, false, true, 3)
ON CONFLICT (id) DO NOTHING;
