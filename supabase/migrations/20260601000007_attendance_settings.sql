-- Store-level attendance GPS/geofence configuration.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stores_id_organization_id_unique'
  ) then
    alter table stores
      add constraint stores_id_organization_id_unique unique (id, organization_id);
  end if;
end $$;

create table if not exists attendance_settings (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade unique,
  geofence_enabled boolean not null default false,
  geofence_center_lat numeric(9,6),
  geofence_center_lng numeric(9,6),
  geofence_radius_meters integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_settings_center_pair check (
    (geofence_center_lat is null and geofence_center_lng is null)
    or (geofence_center_lat is not null and geofence_center_lng is not null)
  ),
  constraint attendance_settings_lat_bounds check (
    geofence_center_lat is null or geofence_center_lat between -90 and 90
  ),
  constraint attendance_settings_lng_bounds check (
    geofence_center_lng is null or geofence_center_lng between -180 and 180
  ),
  constraint attendance_settings_radius_bounds check (
    geofence_radius_meters is null or geofence_radius_meters between 10 and 5000
  ),
  constraint attendance_settings_store_org_fk foreign key (store_id, organization_id)
    references stores(id, organization_id) on delete cascade
);

create index if not exists attendance_settings_store_id_idx
  on attendance_settings(store_id);

alter table attendance_settings enable row level security;

create policy "attendance_settings: store member can read"
  on attendance_settings for select
  using (store_id in (select auth_user_store_ids()));

-- Authenticated clients intentionally have no insert/update policies.
-- Writes go through the server action gate (`attendance.manage`) and service role.

create trigger attendance_settings_updated_at
  before update on attendance_settings
  for each row execute function set_updated_at();
