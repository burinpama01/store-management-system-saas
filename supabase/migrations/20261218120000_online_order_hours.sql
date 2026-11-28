-- เวลารับออเดอร์ออนไลน์: เวลาประจำสัปดาห์ + วันหยุด/เวลาพิเศษเฉพาะวัน (ordering_hours) และปิดด่วน (paused_until)
-- ไม่มีค่า = เปิดตลอดเหมือนเดิม (ร้านที่เปิดสั่งออนไลน์อยู่แล้วไม่เปลี่ยนพฤติกรรม)
-- โค้ดอ่านแบบ select("*") — ถ้า migration ยังไม่ขึ้น ร้านยังสั่งได้ตามเดิม

alter table public.store_online_order_settings
  add column if not exists ordering_hours jsonb,
  add column if not exists paused_until timestamptz,
  add column if not exists paused_reason text,
  add column if not exists paused_by uuid references auth.users(id) on delete set null;

alter table public.store_online_order_settings
  drop constraint if exists store_online_order_settings_ordering_hours_object;
alter table public.store_online_order_settings
  add constraint store_online_order_settings_ordering_hours_object
  check (ordering_hours is null or jsonb_typeof(ordering_hours) = 'object');

alter table public.store_online_order_settings
  drop constraint if exists store_online_order_settings_paused_reason_len;
alter table public.store_online_order_settings
  add constraint store_online_order_settings_paused_reason_len
  check (paused_reason is null or char_length(paused_reason) <= 120);

comment on column public.store_online_order_settings.ordering_hours is
  'เวลารับออเดอร์ {enabled, weekly[7]{closed,open,close}, exceptions[]{date,closed,open,close,note}} — ตรวจรูปแบบด้วย zod ฝั่งแอป';
comment on column public.store_online_order_settings.paused_until is
  'ปิดรับด่วนถึงเวลานี้ (2999-12-31 = จนกว่าจะกดเปิด)';
