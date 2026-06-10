-- Store holidays (วันหยุดร้าน) — used by the attendance calendar to mark days off.
-- Only owner/admin may set them (settings.manage_store ≈ auth_user_role_in_store 'admin').

create table if not exists store_holidays (
  id                 uuid primary key default uuid_generate_v4(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  store_id           uuid not null references stores(id) on delete cascade,
  date               date not null,
  name               text,
  created_by_user_id uuid not null,
  created_at         timestamptz not null default now(),
  unique (store_id, date)
);
create index store_holidays_store_date_idx on store_holidays(store_id, date);

alter table store_holidays enable row level security;

create policy "store_holidays: store member can read"
  on store_holidays for select
  using (store_id in (select auth_user_store_ids()));

-- Owner/admin only (manager cannot set holidays).
create policy "store_holidays: admin+ can write"
  on store_holidays for all
  using (auth_user_role_in_store(organization_id, store_id, 'admin'))
  with check (auth_user_role_in_store(organization_id, store_id, 'admin'));
