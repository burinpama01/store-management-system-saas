-- ============================================================
-- ปิดรายการลงเวลาที่ลืมกดออกงาน ให้กลายเป็น "ขาดงาน" แทนที่จะค้างว่ายังทำงานอยู่
--
-- ปัญหาเดิม: ระบบไม่มี auto clock-out เลย (ไม่มี cron ปิดกะสิ้นวัน) แถวที่พนักงาน
-- ลืมกดออกงานจึงค้าง status = 'active', clock_out_at = null ไปตลอดกาล ทำให้ทุกที่
-- ที่ถามว่า "ตอนนี้มีใครอยู่ที่ร้านไหม" ได้คำตอบว่ามี ทั้งที่ผ่านมาหลายวันแล้ว
-- (ตัวแรกที่เจอปัญหานี้คือ Print Hub ที่ใช้สัญญาณนี้ตัดสินว่าร้านเปิดอยู่ไหม)
--
-- เงินเดือนไม่เปลี่ยน: payroll คิดชั่วโมงจาก clock_out_at อยู่แล้ว วันที่ไม่มีเวลาออก
-- ถูกนับเป็น 'in_no_out' (เข้างานไม่ลงออก = นับขาด ไม่จ่าย) มาตั้งแต่ต้น การปิดแถว
-- เป็น 'abandoned' จึงเปลี่ยนแค่สถานะของแถว ไม่ได้เปลี่ยนยอดเงินของใครแม้แต่บาทเดียว
--
-- แก้ให้ถูกได้เหมือนเดิม: ผู้จัดการยังขอย้อนหลัง/แก้เวลาผ่าน backdated/adjusted ได้
-- ตามสิทธิ์เดิมทุกอย่าง ถ้าไม่มีใครขอย้อนหลัง วันนั้นก็เป็นขาดงานตามเดิม
-- ============================================================

alter table public.attendance_records
  drop constraint if exists attendance_records_status_check;

alter table public.attendance_records
  add constraint attendance_records_status_check
    check (status in ('active', 'completed', 'backdated', 'adjusted', 'abandoned'));

comment on column public.attendance_records.status is
  'active = กำลังทำงาน, completed = ลงออกแล้ว, backdated/adjusted = ผู้จัดการเพิ่ม/แก้ย้อนหลัง, abandoned = ลืมกดออกงาน (นับขาด จนกว่าจะขอย้อนหลังและอนุมัติ)';

-- แถวที่ค้างอยู่ก่อนหน้านี้: ปิดเฉพาะของวันก่อนหน้าเท่านั้น ไม่แตะกะที่กำลังทำงาน
-- จริงอยู่ตอนนี้ (date = วันนี้) เพราะยังไม่ถึงเวลาที่ควรกดออก
--
-- ใช้ timezone ของแต่ละร้านในระดับ SQL นี้ไม่ได้ จึงเผื่อไว้เต็มหนึ่งวันด้วย
-- date < current_date - 1 แทน date < current_date — ร้านที่ timezone ต่างจาก UTC
-- มากที่สุดยังห่างไม่ถึง 24 ชั่วโมง กะข้ามคืนที่เพิ่งจบจึงไม่ถูกปิดผิด
update public.attendance_records
set status = 'abandoned'
where status = 'active'
  and clock_out_at is null
  and date < current_date - 1;
