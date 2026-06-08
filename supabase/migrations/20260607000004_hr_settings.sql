-- Phase D batch (items 2/3): store-level HR policy + per-employee working days & OT eligibility.

-- Store-wide payroll/penalty policy (one row per store).
create table if not exists store_hr_settings (
  store_id                  uuid primary key references stores(id) on delete cascade,
  organization_id           uuid not null references organizations(id) on delete cascade,
  regular_hours_per_day     numeric(5,2) not null default 8 check (regular_hours_per_day > 0 and regular_hours_per_day <= 24),
  ot_multiplier             numeric(5,2) not null default 1.5 check (ot_multiplier >= 1 and ot_multiplier <= 5),
  ot_daily_cap_hours        numeric(5,2) not null default 2 check (ot_daily_cap_hours >= 0 and ot_daily_cap_hours <= 12),
  late_penalty_per_minute   numeric(10,2) not null default 0 check (late_penalty_per_minute >= 0),
  late_penalty_max_per_day  numeric(12,2) not null default 0 check (late_penalty_max_per_day >= 0),
  absent_penalty_per_day    numeric(12,2) not null default 0 check (absent_penalty_per_day >= 0),
  backdated_rights_per_month int not null default 3 check (backdated_rights_per_month >= 0 and backdated_rights_per_month <= 31),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

alter table store_hr_settings enable row level security;

create policy "store_hr_settings: store member can read"
  on store_hr_settings for select
  using (store_id in (select auth_user_store_ids()));

create policy "store_hr_settings: manager+ can write"
  on store_hr_settings for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- Per-employee scheduling: working weekdays (0=Sun .. 6=Sat) and OT eligibility.
alter table employee_profiles
  add column if not exists working_days int[] not null default '{1,2,3,4,5}',
  add column if not exists ot_eligible boolean not null default true;
