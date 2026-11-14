-- จ่ายค่าแรงรายสัปดาห์ (แผน Plan/Weekly Pay Plan v1.html)
--   ตั้งรายคน: monthly (เดิม) / weekly (แยกรอบ ไม่อยู่ในงวดรายเดือน) / weekly_advance (จ่ายล่วงหน้า หักในงวดรายเดือน)
--   คิดเฉพาะวันที่มาทำงาน (เต็มวัน 1, ครึ่งวัน 0.5) ไม่นับขาด/ลา/วันหยุด + OT + โบนัสรายวัน
--   ค่าเริ่มต้นทุกคอลัมน์ = พฤติกรรมเดิม (สวิตช์ปิด, ทุกคนรายเดือน) → ร้านเดิมเงินเดือนไม่เปลี่ยน

alter table employee_profiles
  add column if not exists pay_frequency text not null default 'monthly';
alter table employee_profiles drop constraint if exists employee_profiles_pay_frequency_check;
alter table employee_profiles add constraint employee_profiles_pay_frequency_check
  check (pay_frequency in ('monthly', 'weekly', 'weekly_advance'));

alter table store_hr_settings
  add column if not exists feat_weekly_pay boolean not null default false,
  -- 0 = อาทิตย์ … 6 = เสาร์
  add column if not exists weekly_start_day smallint not null default 1,
  -- profile = เรทรายวัน หรือ เงินเดือน ÷ 30 · working_days = เงินเดือน ÷ วันทำงานในงวดเดือนนั้น
  add column if not exists weekly_rate_basis text not null default 'profile',
  -- วันที่เปิดสวิตช์ — cron บันทึกอัตโนมัติเฉพาะสัปดาห์ที่จบตั้งแต่วันนี้ (สัปดาห์ก่อนหน้า ผู้จัดการกดบันทึกเอง)
  add column if not exists weekly_pay_enabled_at date;
alter table store_hr_settings drop constraint if exists store_hr_settings_weekly_pay_check;
alter table store_hr_settings add constraint store_hr_settings_weekly_pay_check
  check (weekly_start_day between 0 and 6 and weekly_rate_basis in ('profile', 'working_days'));

-- ยอดรายสัปดาห์ที่บันทึกแล้ว (snapshot) — แบบล่วงหน้าใช้หักในงวดรายเดือนที่วันจบสัปดาห์อยู่
create table if not exists payroll_weekly_payouts (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  user_id         uuid not null,
  week_start      date not null,
  week_end        date not null,
  mode            text not null check (mode in ('weekly', 'weekly_advance')),
  amount          numeric(14,2) not null,
  data            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (store_id, user_id, week_start),
  check (week_end >= week_start)
);
create index if not exists payroll_weekly_payouts_store_end_idx on payroll_weekly_payouts(store_id, week_end);

-- ผูก store กับ organization ให้ตรงกัน (ISSUE-20261110-RLS-001)
do $$
begin
  alter table public.payroll_weekly_payouts
    add constraint payroll_weekly_payouts_store_org_fk
    foreign key (store_id, organization_id) references public.stores(id, organization_id) on delete cascade;
exception when duplicate_object then null;
end $$;

alter table payroll_weekly_payouts enable row level security;
-- อ่าน: ผู้จัดการเงินเดือน หรือเจ้าตัว · เขียนผ่าน service role เท่านั้น (cron / server action ที่เช็กสิทธิ์แล้ว)
drop policy if exists "payroll_weekly_payouts: manager or own read" on payroll_weekly_payouts;
create policy "payroll_weekly_payouts: manager or own read" on payroll_weekly_payouts for select
  using (user_id = auth.uid() or auth_user_has_permission(organization_id, store_id, 'attendance.manage'));
