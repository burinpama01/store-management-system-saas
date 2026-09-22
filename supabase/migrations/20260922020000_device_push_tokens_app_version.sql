-- รุ่นแอปของเครื่องที่ลงทะเบียน push (อ่านจาก User-Agent "StoreOSApp/x.y.z" ฝั่งเซิร์ฟเวอร์)
-- ใช้เลือกรูปแบบ push: แอป Android 1.0.3+ รับออเดอร์ใหม่แบบ data-only แล้วสร้างแจ้งเตือนเสียงดังวนเอง
-- แอปรุ่นเก่า (null) ต้องได้ notification ปกติต่อ ไม่งั้นแจ้งเตือนหายเงียบ
alter table device_push_tokens add column if not exists app_version text;
