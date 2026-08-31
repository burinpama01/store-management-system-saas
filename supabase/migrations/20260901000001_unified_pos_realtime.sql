-- ============================================================
-- Task U3 (v0.35.3) — Unified POS Realtime publication
-- ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U3)
--
-- เนื้อหา:
--   a) order_items เข้า publication supabase_realtime แบบ idempotent
--      (guard เช็ค pg_publication_tables ก่อน add — re-run ต้องปลอดภัย
--       ไม่ duplicate ไม่ throw duplicate_object)
--   b) replica identity full บน order_items เพื่อให้ event UPDATE/DELETE
--      ที่ส่งผ่าน Realtime มี row เต็มใน old record (จำเป็นต่อ parser ที่
--      อ่าน fulfillment_version/fulfillment_status จาก old ตอน DELETE)
--   c) ห้ามแตะ publication ของตารางอื่น (orders / service_requests /
--      music_requests / store_now_playing / notifications คงเดิม)
--
-- หมายเหตุ: order_items ไม่มีคอลัมน์ store_id — การ scope ต่อร้านเกิดฝั่ง
--   RLS เดิม ("order_items: store member can read" → orders.store_id ∈
--   auth_user_store_ids()) ซึ่ง Realtime postgres_changes เคารพอยู่แล้ว
-- ============================================================

-- ------------------------------------------------------------
-- (a) publication: order_items เข้า supabase_realtime (idempotent)
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'order_items'
  ) then
    alter publication supabase_realtime add table public.order_items;
  end if;
end
$$;

-- ------------------------------------------------------------
-- (b) replica identity full (idempotent: set ซ้ำด้วยค่าเดิมไม่เกิด error)
-- ------------------------------------------------------------
alter table public.order_items replica identity full;
