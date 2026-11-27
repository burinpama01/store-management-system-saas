-- พนักงานเบิกเงินล่วงหน้า (Plan/Employee Salary Advance Plan v2.html · B1–B8)
--   เบิกได้ไม่เกินค่าแรงจากวันที่มาทำงานแล้วในรอบ · เจ้าของ/ผู้จัดการอนุมัติ · หักอัตโนมัติในงวด/สัปดาห์
--   ค่าเริ่มต้น = สวิตช์ปิด → ร้านเดิมไม่เปลี่ยน

alter table store_hr_settings
  add column if not exists feat_salary_advance boolean not null default false,
  -- % ของค่าแรงที่ทำได้แล้วที่เบิกได้ (1–100)
  add column if not exists advance_max_percent numeric(5,2) not null default 100,
  -- ยอดสูงสุดต่อรอบ (null = ไม่จำกัด)
  add column if not exists advance_max_amount numeric(12,2),
  -- จำนวนครั้งต่อรอบ (null = ไม่จำกัด)
  add column if not exists advance_max_requests int;
alter table store_hr_settings drop constraint if exists store_hr_settings_salary_advance_check;
alter table store_hr_settings add constraint store_hr_settings_salary_advance_check
  check (
    advance_max_percent > 0 and advance_max_percent <= 100
    and (advance_max_amount is null or advance_max_amount > 0)
    and (advance_max_requests is null or advance_max_requests between 1 and 31)
  );

create table if not exists salary_advances (
  id               uuid primary key default uuid_generate_v4(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  user_id          uuid not null,
  status           text not null default 'pending' check (status in ('pending', 'paid', 'rejected', 'cancelled')),
  requested_amount numeric(12,2) not null check (requested_amount > 0),
  approved_amount  numeric(12,2) check (approved_amount is null or approved_amount > 0),
  reason           text check (reason is null or char_length(reason) <= 200),
  -- รอบที่ขอ (งวดเงินเดือน หรือสัปดาห์สำหรับพนักงานรายสัปดาห์แยกรอบ) — ใช้นับครั้ง/ยอดต่อรอบ
  cycle_start      date not null,
  requested_by     uuid not null,
  decided_by       uuid,
  decided_at       timestamptz,
  decision_note    text check (decision_note is null or char_length(decision_note) <= 200),
  pay_method       text check (pay_method is null or pay_method in ('cash', 'transfer')),
  -- วันที่จ่าย (เวลาสาขา) — หักในงวด/สัปดาห์ที่วันนี้อยู่
  paid_date        date,
  transaction_id   uuid references transactions(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (status <> 'paid' or (approved_amount is not null and pay_method is not null and paid_date is not null))
);
create index if not exists salary_advances_store_user_idx on salary_advances(store_id, user_id, created_at desc);
create index if not exists salary_advances_store_status_idx on salary_advances(store_id, status);

-- ยอดที่หักแล้วต่องวด/สัปดาห์ (เขียนตอนปิดงวด/บันทึกสัปดาห์) — ส่วนที่ยังไม่ถูกหักยกไปงวดถัดไป
create table if not exists salary_advance_deductions (
  advance_id      uuid not null references salary_advances(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  user_id         uuid not null,
  cycle_kind      text not null check (cycle_kind in ('monthly', 'weekly')),
  cycle_start     date not null,
  amount          numeric(12,2) not null check (amount >= 0),
  created_at      timestamptz not null default now(),
  primary key (advance_id, cycle_kind, cycle_start)
);
create index if not exists salary_advance_deductions_store_idx on salary_advance_deductions(store_id, cycle_kind, cycle_start);

do $$
begin
  alter table public.salary_advances
    add constraint salary_advances_store_org_fk
    foreign key (store_id, organization_id) references public.stores(id, organization_id) on delete cascade;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.salary_advance_deductions
    add constraint salary_advance_deductions_store_org_fk
    foreign key (store_id, organization_id) references public.stores(id, organization_id) on delete cascade;
exception when duplicate_object then null;
end $$;

alter table salary_advances enable row level security;
alter table salary_advance_deductions enable row level security;
-- อ่าน: เจ้าตัว หรือผู้จัดการเงินเดือน · เขียนผ่าน server (service role) ที่ตรวจสิทธิ์/เพดานแล้วเท่านั้น
drop policy if exists "salary_advances: own or manager read" on salary_advances;
create policy "salary_advances: own or manager read" on salary_advances for select
  using (user_id = auth.uid() or auth_user_has_permission(organization_id, store_id, 'attendance.manage'));
drop policy if exists "salary_advance_deductions: own or manager read" on salary_advance_deductions;
create policy "salary_advance_deductions: own or manager read" on salary_advance_deductions for select
  using (user_id = auth.uid() or auth_user_has_permission(organization_id, store_id, 'attendance.manage'));
