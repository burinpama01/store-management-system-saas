-- บันทึกช่องทางที่ส่ง OTP จริงของแต่ละรายการ
-- campaigns = SMS แคมเปญ (v1) ตรวจรหัสกับ code_hash ของเราเอง
-- otp_v2    = บริการ OTP v2 ของ SMSKUB (fallback เมื่อ v1 ล้ม) ตรวจรหัสกับผู้ให้บริการ
alter table customer_member_otps
  add column if not exists delivery_channel text not null default 'campaigns'
  check (delivery_channel in ('campaigns', 'otp_v2'));
