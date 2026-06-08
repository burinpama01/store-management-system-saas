-- Persist per-store notification event/channel switches.

create table if not exists notification_settings (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  notification_type text not null check (
    notification_type in (
      'payment',
      'new_table',
      'new_qr_order',
      'kitchen_order',
      'buffet_expiring',
      'stock_alert',
      'test'
    )
  ),
  channel text not null check (channel in ('line', 'telegram')),
  enabled boolean not null default true,
  destination text not null default 'owner' check (destination in ('owner', 'group', 'all')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, notification_type, channel)
);

create index if not exists notification_settings_store_id_idx
  on notification_settings(store_id);

alter table notification_settings enable row level security;

create policy "notification_settings: store member can read"
  on notification_settings for select
  using (
    exists (
      select 1 from stores
      where stores.id = notification_settings.store_id
        and stores.organization_id = notification_settings.organization_id
    )
    and (
      store_id in (select auth_user_store_ids())
      or auth_user_role_in_org(organization_id, 'owner')
    )
  );

create policy "notification_settings: manager+ can write"
  on notification_settings for all
  using (
    exists (
      select 1 from stores
      where stores.id = notification_settings.store_id
        and stores.organization_id = notification_settings.organization_id
    )
    and auth_user_role_in_store(organization_id, store_id, 'manager')
  )
  with check (
    exists (
      select 1 from stores
      where stores.id = notification_settings.store_id
        and stores.organization_id = notification_settings.organization_id
    )
    and auth_user_role_in_store(organization_id, store_id, 'manager')
  );

create trigger set_updated_at before update on notification_settings
  for each row execute function set_updated_at();
