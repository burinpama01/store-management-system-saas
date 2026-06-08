-- Phase D (#10/#11): employee wage profiles + payroll adjustments (penalties/bonuses).

-- Per-employee wage configuration and lateness policy.
create table if not exists employee_profiles (
  id                    uuid primary key default uuid_generate_v4(),
  organization_id       uuid not null references organizations(id) on delete cascade,
  store_id              uuid not null references stores(id) on delete cascade,
  user_id               uuid not null,
  display_name          text,
  pay_type              text not null default 'monthly' check (pay_type in ('monthly','daily','hourly')),
  monthly_salary        numeric(12,2) not null default 0 check (monthly_salary >= 0),
  daily_rate            numeric(12,2) not null default 0 check (daily_rate >= 0),
  hourly_rate           numeric(12,2) not null default 0 check (hourly_rate >= 0),
  expected_start_time   time,
  late_grace_minutes    int not null default 0 check (late_grace_minutes >= 0),
  late_penalty_amount   numeric(12,2) not null default 0 check (late_penalty_amount >= 0),
  absent_penalty_amount numeric(12,2) not null default 0 check (absent_penalty_amount >= 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (store_id, user_id)
);
create index employee_profiles_store_idx on employee_profiles(store_id);

alter table employee_profiles enable row level security;

create policy "employee_profiles: store member can read"
  on employee_profiles for select
  using (store_id in (select auth_user_store_ids()));

create policy "employee_profiles: manager+ can write"
  on employee_profiles for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- Manual payroll adjustments: penalties (absent/leave/late), bonuses.
create table if not exists payroll_adjustments (
  id                 uuid primary key default uuid_generate_v4(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  store_id           uuid not null references stores(id) on delete cascade,
  user_id            uuid not null,
  employee_name      text not null,
  date               date not null,
  type               text not null check (type in ('penalty','bonus','leave','absent','late')),
  amount             numeric(12,2) not null check (amount >= 0),
  note               text,
  created_by_user_id uuid not null,
  created_at         timestamptz not null default now()
);
create index payroll_adjustments_store_date_idx on payroll_adjustments(store_id, date desc);
create index payroll_adjustments_user_idx on payroll_adjustments(store_id, user_id);

alter table payroll_adjustments enable row level security;

create policy "payroll_adjustments: store member can read"
  on payroll_adjustments for select
  using (store_id in (select auth_user_store_ids()));

create policy "payroll_adjustments: manager+ can write"
  on payroll_adjustments for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- Allow managers to delete attendance records they corrected (backdated/adjusted fixes).
drop policy if exists "attendance: manager+ can delete" on attendance_records;
create policy "attendance: manager+ can delete"
  on attendance_records for delete
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));
