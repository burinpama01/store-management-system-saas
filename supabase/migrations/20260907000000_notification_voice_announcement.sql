-- เสียงพูดแจ้งเตือน (TTS) — ค่าเริ่มต้นระดับร้าน
--
-- ทำไมต้องมีคอลัมน์ ไม่เก็บแค่ localStorage:
--   ร้านที่มีหลายเครื่อง (แคชเชียร์ + ครัว + เครื่องที่รัน Launcher) ต้องตั้งครั้งเดียวแล้วมีผลทุกเครื่อง
--   ส่วนเครื่องที่ไม่อยากให้พูด (เช่น เครื่องหน้าร้านที่อยู่ติดลูกค้า) ปรับทับได้เองที่ /settings/devices
--   ค่าที่เครื่องตั้งเองอยู่ใน localStorage — ไม่เกี่ยวกับคอลัมน์นี้
--
-- default false: deploy แล้วต้องไม่มีร้านไหนจู่ ๆ มีเสียงพูดขึ้นมาโดยไม่ได้ขอ
-- (เสียง beep เดิมยังทำงานเหมือนเดิมทุกประการจนกว่าจะเปิดสวิตช์)
alter table public.stores
  add column if not exists notification_voice_enabled boolean not null default false;

comment on column public.stores.notification_voice_enabled is
  'เปิดเสียงพูดแจ้งเตือน (TTS ภาษาไทย) แทนเสียง beep — เป็นค่าเริ่มต้นของร้าน แต่ละเครื่องปรับทับได้';
