-- แผนสลิปพนักงาน v4 · P1: ข้อมูลพนักงานและร้านที่สลิปต้องใช้
-- (Plan/Employee Payslip Self-Service Plan v4.html — กติกา R8, R10, R12, R20, R25–R27)
--
-- employee_profiles: รหัส/ชื่อจริง/ตำแหน่ง, ประเภทการจ้าง + วันที่เป็นพนักงานประจำ,
--   วันเริ่มนับอายุงาน (ระบบตั้งเองจากการลงเวลาครั้งแรกในสาขา), วันออกงาน, บัญชีรับเงิน (เก็บเต็ม)
-- store_hr_settings: ข้อมูลนิติบุคคลบนสลิป (ว่าง = ใช้ชื่อ/ที่อยู่/เลขภาษีจากตั้งค่าใบเสร็จ)
--
-- RLS ของ employee_profiles เป็น "แถวตัวเอง หรือ attendance.manage" แล้ว (20261106000000)
-- เลขบัญชีเต็มจึงอ่านได้แค่เจ้าตัวกับผู้จัดการ

alter table employee_profiles
  add column if not exists employee_code text,
  add column if not exists full_name text,
  add column if not exists position text,
  add column if not exists employment_type text not null default 'permanent',
  add column if not exists permanent_since date,
  add column if not exists seniority_start_date date,
  add column if not exists employment_end_date date,
  add column if not exists bank_name text,
  add column if not exists bank_account_no text,
  add column if not exists bank_account_name text;

alter table employee_profiles drop constraint if exists employee_profiles_employment_type_check;
alter table employee_profiles add constraint employee_profiles_employment_type_check
  check (employment_type in ('permanent', 'daily', 'part_time', 'temporary'));

alter table employee_profiles drop constraint if exists employee_profiles_text_lengths_check;
alter table employee_profiles add constraint employee_profiles_text_lengths_check
  check (
    coalesce(length(employee_code), 0) <= 30
    and coalesce(length(full_name), 0) <= 150
    and coalesce(length(position), 0) <= 80
    and coalesce(length(bank_name), 0) <= 80
    and coalesce(length(bank_account_no), 0) <= 30
    and coalesce(length(bank_account_name), 0) <= 150
  );

alter table employee_profiles drop constraint if exists employee_profiles_end_after_start_check;
alter table employee_profiles add constraint employee_profiles_end_after_start_check
  check (employment_end_date is null or seniority_start_date is null or employment_end_date >= seniority_start_date);

-- รหัสพนักงานไม่ซ้ำในสาขาเดียวกัน (ว่างได้หลายคน)
create unique index if not exists employee_profiles_store_code_uidx
  on employee_profiles (store_id, employee_code)
  where employee_code is not null and employee_code <> '';

-- โปรไฟล์เดิม: รายวัน/รายชั่วโมง ยังไม่ใช่พนักงานประจำ (ค่าทักษะ/อายุงาน/โบนัสยอดขายต้องรอปรับ — R8)
update employee_profiles
   set employment_type = 'daily'
 where pay_type in ('daily', 'hourly')
   and employment_type = 'permanent'
   and permanent_since is null;

-- อายุงานเริ่มจากวันแรกที่ลงเวลาในสาขานั้น (R10, R12)
update employee_profiles p
   set seniority_start_date = first_day.d
  from (
    select store_id, user_id, min(date) as d
      from attendance_records
     group by store_id, user_id
  ) first_day
 where first_day.store_id = p.store_id
   and first_day.user_id = p.user_id
   and p.seniority_start_date is null;

-- พนักงานประจำเดิม: ถือว่าเป็นประจำตั้งแต่วันเริ่มอายุงาน (มีผลแค่การคิดสิทธิ์ ②③④ ในเฟสถัดไป)
update employee_profiles
   set permanent_since = seniority_start_date
 where employment_type = 'permanent'
   and permanent_since is null
   and seniority_start_date is not null;

-- ลงเวลาครั้งแรก → บันทึกวันเริ่มอายุงานให้เอง (ทุกช่องทางลงเวลา: เว็บ, แอป, POS native)
-- security definer: พนักงานลงเวลาเองไม่มีสิทธิ์เขียน employee_profiles ผ่าน RLS
create or replace function public.employee_profiles_set_seniority_from_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ห้ามทำให้การลงเวลาล้ม: ข้ามคนที่มีวันออกงานก่อนวันนี้ (ไม่งั้นชน end_after_start_check)
  update employee_profiles
     set seniority_start_date = new.date
   where store_id = new.store_id
     and user_id = new.user_id
     and seniority_start_date is null
     and (employment_end_date is null or employment_end_date >= new.date);
  return new;
end;
$$;

drop trigger if exists attendance_records_set_seniority on attendance_records;
create trigger attendance_records_set_seniority
  after insert on attendance_records
  for each row execute function public.employee_profiles_set_seniority_from_attendance();

-- ตั้งค่าจ้างให้คนที่ลงเวลามาก่อนแล้ว → เติมวันเริ่มอายุงานจากประวัติ
create or replace function public.employee_profiles_fill_seniority_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.seniority_start_date is null then
    select min(date) into new.seniority_start_date
      from attendance_records
     where store_id = new.store_id
       and user_id = new.user_id
       and (new.employment_end_date is null or date <= new.employment_end_date);
  end if;
  return new;
end;
$$;

drop trigger if exists employee_profiles_fill_seniority on employee_profiles;
create trigger employee_profiles_fill_seniority
  before insert on employee_profiles
  for each row execute function public.employee_profiles_fill_seniority_on_insert();

revoke all on function public.employee_profiles_set_seniority_from_attendance() from public, anon, authenticated;
revoke all on function public.employee_profiles_fill_seniority_on_insert() from public, anon, authenticated;

-- ข้อมูลนิติบุคคลบนสลิป (ว่าง = ใช้ค่าจากตั้งค่าใบเสร็จ)
alter table store_hr_settings
  add column if not exists payslip_legal_name text,
  add column if not exists payslip_address text,
  add column if not exists payslip_tax_id text;

alter table store_hr_settings drop constraint if exists store_hr_settings_payslip_text_check;
alter table store_hr_settings add constraint store_hr_settings_payslip_text_check
  check (
    coalesce(length(payslip_legal_name), 0) <= 200
    and coalesce(length(payslip_address), 0) <= 400
    and coalesce(length(payslip_tax_id), 0) <= 20
  );
