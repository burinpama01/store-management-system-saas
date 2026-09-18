-- เปิดโต๊ะที่ POS แล้วเปิดตั๋ว (pos_saved_tickets) ของโต๊ะรอไว้ทันที
-- ออเดอร์ QR ของโต๊ะจะแสดงในตั๋วนั้นเป็นรายการ "ส่งครัวแล้ว" (ผูกด้วย table_id)
-- additive: ร้านที่ไม่ต้องการปิดได้ที่ตั้งค่าร้าน
alter table stores
  add column if not exists table_open_auto_ticket boolean not null default true;
