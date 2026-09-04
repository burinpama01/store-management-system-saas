-- ใบเสร็จ: กำกับรูป QR ท้ายใบ และคุมกรณี QR ซ้อนกันหลายอัน
--
-- ปัญหาที่พบจากการพิมพ์จริง (each other II, 2026-09-04): ร้านอัปโหลด QR รับเงินไว้ท้าย
-- ใบเสร็จเป็น "รูป QR เปล่า ๆ ไม่มีข้อความกำกับสักตัว" เมื่อระบบพิมพ์ QR ของตัวเองเพิ่ม
-- (QR PromptPay ล็อกยอดบนใบแจ้งยอด หรือ QR รับแต้มบนบิลที่ยังไม่ผูกลูกค้า) ลูกค้าจะเห็น
-- QR สองอันบนกระดาษใบเดียวโดยไม่มีอะไรบอกว่าอันไหนคืออะไร
--
-- ความเสี่ยงที่แท้จริงไม่ใช่แค่ "งง" แต่คือเงิน:
--   * ใบแจ้งยอด: สแกนผิดอัน = กรอกยอดเอง จ่ายขาด/จ่ายเกิน
--   * บิลที่จ่ายแล้ว: สแกน QR รับเงินของร้าน = โอนซ้ำทั้งที่จ่ายไปแล้ว
--
-- จึงเพิ่มสองอย่าง:
--   footer_image_label            ข้อความกำกับใต้รูป (เช่น "สแกนติดตามร้าน")
--   footer_image_hide_with_system_qr  ซ่อนรูปท้ายใบเมื่อใบนั้นมี QR ของระบบอยู่แล้ว
--                                 ค่าเริ่มต้น true = ปลอดภัยไว้ก่อน ร้านปิดเองได้ถ้ายืนยัน

alter table receipt_settings
  add column if not exists footer_image_label text,
  add column if not exists footer_image_hide_with_system_qr boolean not null default true;

comment on column receipt_settings.footer_image_label is
  'ข้อความกำกับใต้รูป QR ท้ายใบเสร็จ — QR ที่ไม่มีคำอธิบายทำให้ลูกค้าเดาว่าต้องสแกนทำอะไร';
comment on column receipt_settings.footer_image_hide_with_system_qr is
  'true = ซ่อนรูปท้ายใบเมื่อใบนั้นมี QR ของระบบ (PromptPay / รับแต้ม) เพื่อไม่ให้ QR ซ้อนกัน';
