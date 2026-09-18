-- ============================================================
-- ขอเพลงแล้วแทรกเพลงของร้านได้ทันที (cut-in on the store's own song)
--
-- ปัญหา: เครื่องเล่นจะเปลี่ยนเพลงเมื่อเพลงปัจจุบันจบ (event ENDED ของ YouTube)
-- ร้านที่เปิดเพลงแบบ live stream จะไม่มีวันจบเพลง คำขอของลูกค้าจึงค้างคิวถาวร
--
-- แก้: ให้ร้านตั้งค่าได้ว่า "เมื่อมีคำขอเพลงเข้ามาและยังไม่มีคิว ให้ตัดเพลงของร้าน
-- ที่กำลังเล่นอยู่แล้วเล่นเพลงที่ขอทันที" (interrupt_base_on_request)
-- และจำเพลงของร้านที่ถูกตัดไว้ เพื่อกลับไปเล่นต่อเมื่อคิวคำขอหมด
-- ============================================================

-- 1. ปุ่มตั้งค่าของร้าน — เปิดเป็นค่าเริ่มต้น เพื่อไม่ให้คำขอค้างคิวในร้านที่เปิดเพลง live
alter table store_music_player_settings
  add column if not exists interrupt_base_on_request boolean not null default true;

-- 2. เพลงของร้านที่ถูกแทรกกลางเพลง — กลับไปเล่นต่อเมื่อคิวคำขอหมด
alter table store_now_playing
  add column if not exists resume_base_video_id text,
  add column if not exists resume_base_title text;
