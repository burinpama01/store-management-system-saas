-- ============================================================
-- U3 — Unified POS Realtime publication (pgTAP)
-- ครอบคลุม migration: supabase/migrations/20260901000001_unified_pos_realtime.sql
--   1) order_items อยู่ใน publication supabase_realtime ครั้งเดียว (idempotent outcome)
--   2) replica identity เป็น full (relreplident = 'f')
--   3) RLS ของ order_items ยัง enable + policy SELECT เดิมยังอยู่
--   4) publication ของตารางอื่น (orders / service_requests / music_requests /
--      store_now_playing / notifications) ไม่ถูกแตะ
--
-- หมายเหตุเรื่อง idempotency ของ migration:
--   ห้ามเรียกไฟล์ migration ซ้ำแบบ lives_ok ภายใน pgTAP (ไฟล์ test รันหลัง
--   migrations ถูก apply แล้ว การเรียกซ้ำจะพา dependency ของไฟล์มาด้วย)
--   จึงใช้ assert เชิงโครงสร้างแทน:
--     - "publication count = 1" (ยืนยันว่า DO-block guard เขียนแถวซ้ำไม่ได้
--       เพราะ add table ซ้ำจะ throw duplicate_object และ count จาก
--       pg_publication_tables ต้องคงเป็น 1 เสมอ)
--     - ส่วน "DO-block guard มีอยู่ในไฟล์ migration" ตรวจที่ unit test
--       tests/unit/unified-pos-realtime.test.ts (lint-level gate)
--
-- รันด้วย: supabase test db --local
-- ============================================================

BEGIN;
SELECT plan(9);

-- ============================================================
-- A) order_items อยู่ใน supabase_realtime ครั้งเดียว (1 assert)
-- ============================================================
SELECT is(
  (SELECT count(*)::int
     FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'order_items'),
  1,
  'U3: order_items อยู่ใน publication supabase_realtime ครั้งเดียว (guard กัน add ซ้ำ)'
);

-- ============================================================
-- B) replica identity full (1 assert)
-- ============================================================
SELECT is(
  (SELECT relreplident::text FROM pg_class WHERE oid = 'public.order_items'::regclass),
  'f',
  'U3: order_items มี replica identity full (relreplident = f)'
);

-- ============================================================
-- C) RLS ของ order_items ยัง enable + policy SELECT เดิมยังอยู่ (2 asserts)
-- ============================================================
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.order_items'::regclass) IS TRUE,
  'U3: order_items ยังเปิด RLS อยู่'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'order_items: store member can read'
      AND polrelid = 'public.order_items'::regclass
  ),
  'U3: policy "order_items: store member can read" ยังอยู่ (เส้นกันข้ามร้านของ realtime)'
);

-- ============================================================
-- D) publication ของตารางอื่นไม่ถูกแตะ (5 asserts)
--    (ชุดที่ migration เดิมเพิ่มไว้ก่อนหน้า — ต้องคงอยู่ครบ)
-- ============================================================
SELECT is(
  (SELECT count(*)::int FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'orders'),
  1,
  'U3: orders ยังอยู่ใน supabase_realtime ครั้งเดียว'
);
SELECT is(
  (SELECT count(*)::int FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'service_requests'),
  1,
  'U3: service_requests ยังอยู่ใน supabase_realtime ครั้งเดียว'
);
SELECT is(
  (SELECT count(*)::int FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'music_requests'),
  1,
  'U3: music_requests ยังอยู่ใน supabase_realtime ครั้งเดียว'
);
SELECT is(
  (SELECT count(*)::int FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'store_now_playing'),
  1,
  'U3: store_now_playing ยังอยู่ใน supabase_realtime ครั้งเดียว'
);
SELECT is(
  (SELECT count(*)::int FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'),
  1,
  'U3: notifications ยังอยู่ใน supabase_realtime ครั้งเดียว'
);

SELECT * FROM finish();
ROLLBACK;
