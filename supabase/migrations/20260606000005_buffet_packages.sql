-- #9 Buffet package presets configured per store.

create table if not exists buffet_packages (
  id               uuid primary key default uuid_generate_v4(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  name             text not null,
  price_per_guest  numeric(10,2) not null check (price_per_guest >= 0),
  duration_minutes integer check (duration_minutes is null or duration_minutes between 15 and 600),
  active           boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint buffet_packages_store_org_fk foreign key (store_id, organization_id)
    references stores(id, organization_id) on delete cascade
);

create index if not exists buffet_packages_store_id_idx on buffet_packages(store_id);

alter table buffet_packages enable row level security;

create policy "buffet_packages: store member can read"
  on buffet_packages for select
  using (store_id in (select auth_user_store_ids()));
-- writes go through the settings.manage_store server action + service role.

create trigger buffet_packages_updated_at
  before update on buffet_packages
  for each row execute function set_updated_at();
