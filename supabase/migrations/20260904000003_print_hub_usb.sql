-- StoreOS Print Hub: USB printer support with auto-detection.
--
-- ร้านที่ใช้คอม/โน้ตบุ๊ก Windows หน้าเคาน์เตอร์ต้องการเสียบสาย USB เข้าเครื่องพิมพ์ตรง ๆ
-- แล้วให้ระบบตรวจจับ+พิมพ์ได้เลย โดยไม่ต้องตั้งค่า WiFi ของเครื่องพิมพ์ใหม่ทุกครั้งที่
-- ย้ายร้าน/เปลี่ยนเราเตอร์. WebUSB ทำแทนไม่ได้บน Windows เพราะไดรเวอร์ usbprint.sys
-- ยึดอุปกรณ์ไว้ (claimInterface = Access denied) จึงให้ Print Hub agent บนพีซีแคชเชียร์
-- ส่งไบต์ ESC/POS ดิบผ่าน Windows Spooler (datatype RAW) แทน — และแท็บเล็ต/iPad ในร้าน
-- ก็ยิงงานเข้าเครื่องพิมพ์ตัวเดียวกันผ่านคิวได้ด้วย.

-- 1. งานพิมพ์ชนิดใหม่: 'usb' = พิมพ์ผ่านเครื่องพิมพ์ Windows บนพีซีที่รัน Hub.
--    target_device เก็บ "ชื่อเครื่องพิมพ์ของ Windows"; null = ให้ Hub ตรวจจับเอง.
alter table print_jobs drop constraint if exists print_jobs_target_kind_check;
alter table print_jobs
  add constraint print_jobs_target_kind_check check (target_kind in ('ip', 'bt', 'usb'));

-- 2. เครื่องพิมพ์ USB ที่ผูกกับ Hub.
--    hub_usb_enabled แยกเครื่องพิมพ์ USB แบบใหม่ (พิมพ์ผ่าน Hub) ออกจากของเดิมที่พิมพ์ตรง
--    ด้วย WebUSB จากเบราว์เซอร์ — ร้านเดิมที่ตั้งค่า type='usb' ไว้แล้วจึงไม่เปลี่ยนพฤติกรรม.
--    hub_usb_name = ชื่อเครื่องพิมพ์ Windows ที่ร้านเลือก; null = ให้ Hub ตรวจจับเอง
--    (ย้ายพอร์ต USB / เปลี่ยนสายแล้วยังพิมพ์ได้โดยไม่ต้องตั้งค่าซ้ำ)
alter table printers
  add column if not exists hub_usb_enabled boolean not null default false,
  add column if not exists hub_usb_name text;

-- 3. ผลสแกนเครื่องพิมพ์ล่าสุดที่ Hub agent รายงานกลับมาทุกรอบ poll
--    ใช้แสดงรายการให้ผู้ใช้กดเลือกได้ในคลิกเดียวที่ /settings/print-hub
alter table stores
  add column if not exists print_hub_devices jsonb,
  add column if not exists print_hub_devices_at timestamptz;
