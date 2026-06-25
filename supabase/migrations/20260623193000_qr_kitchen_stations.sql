-- Store-scoped kitchen station routing for QR ordering.

create table if not exists kitchen_stations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, name)
);

create index if not exists kitchen_stations_store_id_idx
  on kitchen_stations(store_id, is_active, sort_order);

alter table products
  drop constraint if exists products_kitchen_station_store_fk;

alter table kitchen_stations
  drop constraint if exists kitchen_stations_id_store_id_key;

alter table kitchen_stations
  add constraint kitchen_stations_id_store_id_key
  unique (id, store_id);

drop trigger if exists set_updated_at on kitchen_stations;
create trigger set_updated_at before update on kitchen_stations
  for each row execute function set_updated_at();

alter table kitchen_stations enable row level security;

drop policy if exists "kitchen_stations: staff can read" on kitchen_stations;
create policy "kitchen_stations: staff can read"
  on kitchen_stations for select
  to authenticated
  using (
    auth_user_has_permission(organization_id, store_id, 'settings.view')
    or auth_user_has_permission(organization_id, store_id, 'orders.manage_qr')
  );

drop policy if exists "kitchen_stations: store managers can write" on kitchen_stations;
create policy "kitchen_stations: store managers can write"
  on kitchen_stations for all
  to authenticated
  using (auth_user_has_permission(organization_id, store_id, 'settings.manage_store'))
  with check (auth_user_has_permission(organization_id, store_id, 'settings.manage_store'));

alter table products
  add column if not exists kitchen_station_id uuid;

alter table products
  drop constraint if exists products_kitchen_station_store_fk;

alter table products
  add constraint products_kitchen_station_store_fk
  foreign key (kitchen_station_id, store_id)
  references kitchen_stations(id, store_id);

create index if not exists products_kitchen_station_id_idx
  on products(kitchen_station_id);

alter table order_items
  add column if not exists kitchen_station_id uuid,
  add column if not exists kitchen_station_name text;

alter table order_items
  drop constraint if exists order_items_kitchen_station_id_fkey;

alter table order_items
  add constraint order_items_kitchen_station_id_fkey
  foreign key (kitchen_station_id)
  references kitchen_stations(id)
  on delete set null;

create index if not exists order_items_kitchen_station_id_idx
  on order_items(kitchen_station_id);

create or replace function set_order_item_kitchen_station()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kitchen_station_id is null then
    select
      kitchen_stations.id,
      kitchen_stations.name
    into
      new.kitchen_station_id,
      new.kitchen_station_name
    from products
    join kitchen_stations
      on kitchen_stations.id = products.kitchen_station_id
      and kitchen_stations.store_id = products.store_id
      and kitchen_stations.is_active = true
    where products.id = new.product_id;
  elsif new.kitchen_station_id is not null then
    select
      kitchen_stations.id,
      kitchen_stations.name
    into
      new.kitchen_station_id,
      new.kitchen_station_name
    from kitchen_stations
    join products
      on products.id = new.product_id
      and products.store_id = kitchen_stations.store_id
    where kitchen_stations.id = new.kitchen_station_id
      and kitchen_stations.is_active = true;
  end if;

  return new;
end;
$$;

drop trigger if exists set_order_item_kitchen_station_before_insert on order_items;
create trigger set_order_item_kitchen_station_before_insert
  before insert on order_items
  for each row execute function set_order_item_kitchen_station();

update order_items
set
  kitchen_station_id = kitchen_stations.id,
  kitchen_station_name = kitchen_stations.name
from products
join kitchen_stations
  on kitchen_stations.id = products.kitchen_station_id
  and kitchen_stations.store_id = products.store_id
  and kitchen_stations.is_active = true
where order_items.product_id = products.id
  and order_items.kitchen_station_id is null;
