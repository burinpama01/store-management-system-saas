-- ย้าย URL ของ JDC Edge Functions ไปเป็น config ระดับแพลตฟอร์ม (super-admin ตั้งที่ /system/settings)
-- เพราะ JDC เป็นปลายทางเดียวทั้งระบบ tenant ไม่ควร/ไม่ต้องกรอกเอง
alter table platform_settings add column if not exists jdc_functions_base_url text;

-- connect_channel_links ไม่ต้องเก็บ URL ต่อร้านอีก (อ่านจาก platform_settings) → ปลด NOT NULL
alter table connect_channel_links alter column jdc_functions_base_url drop not null;
