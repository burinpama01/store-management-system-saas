-- AI Voice Intent Phase 1 (v0.44.9) — flag แยกสำหรับ "ทางสำรอง AI" ของคำสั่งเสียง
--
-- ทำไมต้องเป็นคอลัมน์ใหม่ ไม่ใช้ voice_command_enabled ตัวเดิม:
--   แผน Phase 1 กำหนดให้ pilot มีคันโยกแยกกัน 3 ตัว (deterministic voice / AI fallback /
--   Windows standby) เพื่อให้ถอย AI ได้โดยที่เสียงแบบเดิมยังใช้ได้อยู่
--   ถ้าใช้ flag เดียวกัน การปิด AI จะทำให้ปุ่มเสียงหายไปทั้งอัน = ถอยไม่ได้จริง
--
-- default false: deploy แล้วต้องไม่มีอะไรเปลี่ยนสำหรับร้านใด ๆ จนกว่าจะเปิดให้ทีละร้าน
-- (และร้านนั้นต้องผ่านการทดสอบด้วยไมค์จริงก่อน)
alter table public.stores
  add column if not exists voice_ai_fallback_enabled boolean not null default false;

comment on column public.stores.voice_ai_fallback_enabled is
  'Phase 1 AI Voice: เปิดทางสำรอง AI สำหรับคำพูดที่ deterministic parser ไม่เข้าใจ (ต้องเปิด voice_command_enabled ด้วย)';
