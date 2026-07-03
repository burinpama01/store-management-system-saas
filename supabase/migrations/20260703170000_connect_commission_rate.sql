-- #3 ยอดที่ร้านได้รับ = ยอดหลังหัก GP: เก็บ %GP ต่อร้าน (ร้าน/แอดมินตั้ง)
-- ถ้า JDC ส่ง commission มาใน payload จะใช้ค่านั้นก่อน; ไม่งั้นคิดจาก rate นี้
alter table connect_channel_links add column if not exists commission_rate numeric(5,2) not null default 0;
