-- StoreOS Print Hub: USB printer identity + binding policy (แผน v3 Task 4)
--
-- ของเดิมผูกเครื่องพิมพ์ด้วย "ชื่อเครื่องพิมพ์ของ Windows" อย่างเดียว (printers.hub_usb_name)
-- ซึ่งเปลี่ยนได้เมื่อผู้ใช้เปลี่ยนชื่อ/ลงไดรเวอร์ใหม่ และซ้ำกันได้เมื่อร้านมีเครื่องรุ่นเดียวกัน
-- สองตัว. v3 จึงเพิ่ม identity ที่เสถียรกว่า (PnP device id / VID+PID / serial) ไว้ข้าง ๆ
-- โดย **ไม่ย้าย source of truth**: binding ยังอยู่ที่แถว printers เหมือนเดิม ส่วน
-- stores.print_hub_devices เป็นเพียงผลสแกนล่าสุด ไม่ใช่ binding.
--
-- hub_usb_binding_policy กำหนดว่าจะให้ Hub เลือกเองแค่ไหน:
--   auto_single  = พบเครื่องพิมพ์ใบเสร็จ USB ตัวเดียว → ผูกให้เลย (ร้านเครื่องเดียว, ค่าเริ่มต้น)
--   confirm_multi= ต้องให้คนยืนยันก่อนผูกเสมอ (ร้านที่มีเครื่องพิมพ์หลายตัว)
--   manual       = ใช้เฉพาะเครื่องที่ระบุไว้ ไม่เดาให้เลย
-- ทั้งสามโหมด **ไม่มี** การถอยไปใช้ "เครื่องพิมพ์เริ่มต้นของ Windows" เป็นทางเลือกสุดท้าย
-- เพราะนั่นทำให้ใบเสร็จไหลไปออกที่เครื่องพิมพ์ A4/PDF ของสำนักงานได้เงียบ ๆ

alter table printers
  add column if not exists hub_usb_identity jsonb,
  add column if not exists hub_usb_binding_policy text not null default 'auto_single';

alter table printers drop constraint if exists printers_hub_usb_binding_policy_check;
alter table printers
  add constraint printers_hub_usb_binding_policy_check
  check (hub_usb_binding_policy in ('auto_single', 'confirm_multi', 'manual'));

comment on column printers.hub_usb_identity is
  'identity ที่เสถียรของเครื่องพิมพ์ USB ที่เคยพิมพ์สำเร็จ: { v, queueName, pnpDeviceId, vid, pid, serial, driverName }';
comment on column printers.hub_usb_binding_policy is
  'auto_single | confirm_multi | manual — ระดับที่อนุญาตให้ Hub เลือกเครื่องพิมพ์เอง';
