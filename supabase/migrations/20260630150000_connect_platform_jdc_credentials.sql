-- JDC ออก key/secret ชุดเดียวสำหรับ StoreOS ทั้งระบบ (ผูกร้านด้วย merchant_id)
-- → เก็บ JDC API key + shared webhook secret ที่ระดับแพลตฟอร์ม (super-admin กรอกค่าที่ JDC ออกให้)
alter table platform_settings add column if not exists jdc_api_key text;
alter table platform_settings add column if not exists jdc_webhook_secret text;
