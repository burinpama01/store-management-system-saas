-- โบนัสยอดขาย: เลือกแจกรายคน/หารตามคนเข้างาน + เลือกพนักงานที่ร่วม + โบนัสรายเดือนตามยอดทั้งรอบเงินเดือน
--   ค่าเริ่มต้นทุกคอลัมน์ = พฤติกรรมเดิม (แจกรายคน, พนักงานประจำทุกคน, รายเดือนปิด) → ร้านเดิมเงินเดือนไม่เปลี่ยน
alter table store_hr_settings
  add column if not exists sales_bonus_mode text not null default 'per_person',
  -- null = พนักงานประจำทุกคน (แบบเดิม) · มีรายชื่อ = เฉพาะคนในรายชื่อ (รายวัน + รายเดือน)
  add column if not exists sales_bonus_user_ids uuid[],
  add column if not exists feat_monthly_sales_bonus boolean not null default false,
  add column if not exists monthly_bonus_tiers jsonb not null
    default '[{"minSales":900000,"amount":1000},{"minSales":1000000,"amount":2000}]'::jsonb,
  add column if not exists monthly_bonus_mode text not null default 'per_person';

alter table store_hr_settings drop constraint if exists store_hr_settings_bonus_mode_check;
alter table store_hr_settings add constraint store_hr_settings_bonus_mode_check
  check (
    sales_bonus_mode in ('per_person', 'split')
    and monthly_bonus_mode in ('per_person', 'split')
    and jsonb_typeof(monthly_bonus_tiers) = 'array'
    and (sales_bonus_user_ids is null or cardinality(sales_bonus_user_ids) <= 500)
  );
