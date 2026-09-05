-- ทำงานครึ่งวัน = จ่ายครึ่งเดียว (2026-09-06)
-- วันที่ทำงานจริงไม่เกินชั่วโมงนี้ ถือเป็น "ครึ่งวัน" ทั้งฝั่งค่าแรงและปฏิทิน
-- ค่าเริ่มต้น 0 = ปิดไว้ก่อน ร้านที่ต้องการค่อยเปิดเอง — การใส่ค่า > 0 ให้ทุกร้าน
-- อัตโนมัติจะไปลดค่าแรงวันที่เข้ากะสั้นของพนักงานรายวันทันทีโดยที่ร้านไม่ได้สั่ง
alter table public.store_hr_settings
  add column if not exists half_day_max_hours numeric(4,2) not null default 0
  check (half_day_max_hours >= 0 and half_day_max_hours <= 24);

comment on column public.store_hr_settings.half_day_max_hours is
  'ชั่วโมงทำงานสูงสุดที่ยังนับเป็นครึ่งวัน (จ่ายครึ่งเดียว); 0 = ปิดการคิดครึ่งวัน';
