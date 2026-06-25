-- Persist per-store customer display advertisement layout and media slides.

create table if not exists customer_display_settings (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  ad_enabled boolean not null default true,
  ad_layout text not null default 'single' check (ad_layout in ('single', 'split')),
  top_slot_enabled boolean not null default true,
  bottom_slot_enabled boolean not null default true,
  slide_interval_seconds integer not null default 8 check (slide_interval_seconds between 3 and 60),
  top_slides jsonb not null default '[]',
  bottom_slides jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id)
);

create index if not exists customer_display_settings_store_id_idx
  on customer_display_settings(store_id);

alter table customer_display_settings enable row level security;

create policy "customer_display_settings: store member can read"
  on customer_display_settings for select
  using (
    exists (
      select 1 from stores
      where stores.id = customer_display_settings.store_id
        and stores.organization_id = customer_display_settings.organization_id
    )
    and (
      store_id in (select auth_user_store_ids())
      or auth_user_role_in_org(organization_id, 'owner')
    )
  );

create policy "customer_display_settings: manager+ can write"
  on customer_display_settings for all
  using (
    exists (
      select 1 from stores
      where stores.id = customer_display_settings.store_id
        and stores.organization_id = customer_display_settings.organization_id
    )
    and auth_user_has_permission(organization_id, store_id, 'settings.manage_store')
  )
  with check (
    exists (
      select 1 from stores
      where stores.id = customer_display_settings.store_id
        and stores.organization_id = customer_display_settings.organization_id
    )
    and auth_user_has_permission(organization_id, store_id, 'settings.manage_store')
  );

create trigger set_updated_at before update on customer_display_settings
  for each row execute function set_updated_at();
