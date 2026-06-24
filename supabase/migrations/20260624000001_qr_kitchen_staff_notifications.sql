create table if not exists kitchen_station_staff (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  kitchen_station_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  unique (kitchen_station_id, user_id),
  constraint kitchen_station_staff_station_store_fk
    foreign key (kitchen_station_id, store_id)
    references kitchen_stations(id, store_id)
    on delete cascade
);

create index if not exists kitchen_station_staff_store_user_idx
  on kitchen_station_staff(store_id, user_id);

create index if not exists kitchen_station_staff_station_idx
  on kitchen_station_staff(kitchen_station_id);

grant select, insert, update, delete on table kitchen_station_staff to authenticated;
grant select, insert, update, delete on table kitchen_station_staff to service_role;

alter table kitchen_station_staff enable row level security;

drop policy if exists "kitchen_station_staff: read scoped assignments"
  on kitchen_station_staff;
create policy "kitchen_station_staff: read scoped assignments"
  on kitchen_station_staff
  for select
  to authenticated
  using (
    auth.uid() = user_id
    or auth_user_has_permission(organization_id, store_id, 'settings.manage_store')
  );

drop policy if exists "kitchen_station_staff: store managers can write"
  on kitchen_station_staff;
create policy "kitchen_station_staff: store managers can write"
  on kitchen_station_staff
  for all
  to authenticated
  using (auth_user_has_permission(organization_id, store_id, 'settings.manage_store'))
  with check (auth_user_has_permission(organization_id, store_id, 'settings.manage_store'));

create or replace function auth_can_read_qr_order_with_kitchen_scope(
  target_order_id uuid,
  target_organization_id uuid,
  target_store_id uuid,
  is_qr_order boolean
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    auth_user_role_in_store(target_organization_id, target_store_id, 'cashier')
    or (
      is_qr_order = true
      and exists (
        select 1
        from memberships
        where memberships.organization_id = target_organization_id
          and (memberships.store_id = target_store_id or memberships.store_id is null)
          and memberships.user_id = auth.uid()
          and memberships.role = 'staff'
          and memberships.joined_at is not null
      )
      and exists (
        select 1
        from order_items
        join kitchen_station_staff
          on kitchen_station_staff.kitchen_station_id = order_items.kitchen_station_id
          and kitchen_station_staff.store_id = target_store_id
          and kitchen_station_staff.user_id = auth.uid()
        where order_items.order_id = target_order_id
      )
    );
$$;

create or replace function auth_can_read_qr_order_item_with_kitchen_scope(
  target_order_id uuid,
  target_kitchen_station_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from orders
    where orders.id = target_order_id
      and (
        auth_user_role_in_store(orders.organization_id, orders.store_id, 'cashier')
        or (
          orders.qr_order_source = true
          and target_kitchen_station_id is not null
          and exists (
            select 1
            from memberships
            where memberships.organization_id = orders.organization_id
              and (memberships.store_id = orders.store_id or memberships.store_id is null)
              and memberships.user_id = auth.uid()
              and memberships.role = 'staff'
              and memberships.joined_at is not null
          )
          and exists (
            select 1
            from kitchen_station_staff
            where kitchen_station_staff.kitchen_station_id = target_kitchen_station_id
              and kitchen_station_staff.store_id = orders.store_id
              and kitchen_station_staff.user_id = auth.uid()
          )
        )
      )
  );
$$;

revoke execute on function auth_can_read_qr_order_with_kitchen_scope(uuid, uuid, uuid, boolean)
  from public, anon;
grant execute on function auth_can_read_qr_order_with_kitchen_scope(uuid, uuid, uuid, boolean)
  to authenticated, service_role;

revoke execute on function auth_can_read_qr_order_item_with_kitchen_scope(uuid, uuid)
  from public, anon;
grant execute on function auth_can_read_qr_order_item_with_kitchen_scope(uuid, uuid)
  to authenticated, service_role;

drop policy if exists "orders: store member can read" on orders;
create policy "orders: store member can read"
  on orders
  for select
  to authenticated
  using (
    auth_can_read_qr_order_with_kitchen_scope(id, organization_id, store_id, qr_order_source)
  );

drop policy if exists "order_items: store member can read" on order_items;
create policy "order_items: store member can read"
  on order_items
  for select
  to authenticated
  using (
    auth_can_read_qr_order_item_with_kitchen_scope(order_id, kitchen_station_id)
  );

create or replace function qr_product_has_active_kitchen_station(
  target_product_id uuid,
  target_store_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from products
    join kitchen_stations
      on kitchen_stations.id = products.kitchen_station_id
      and kitchen_stations.store_id = products.store_id
      and kitchen_stations.is_active = true
    where products.id = target_product_id
      and products.store_id = target_store_id
  );
$$;

revoke execute on function qr_product_has_active_kitchen_station(uuid, uuid)
  from public;
grant execute on function qr_product_has_active_kitchen_station(uuid, uuid)
  to anon, authenticated, service_role;

drop policy if exists "products: anon can read active QR products" on products;
create policy "products: anon can read active QR products"
  on products
  for select
  to anon, authenticated
  using (
    is_active = true
    and available_for_qr = true
    and qr_product_has_active_kitchen_station(id, store_id)
    and exists (
      select 1
      from stores
      where stores.id = products.store_id
        and stores.is_active = true
        and stores.qr_ordering_enabled = true
    )
  );

grant select on table kitchen_stations to anon, authenticated, service_role;

drop policy if exists "kitchen_stations: anon can read active QR stations" on kitchen_stations;
create policy "kitchen_stations: anon can read active QR stations"
  on kitchen_stations
  for select
  to anon, authenticated
  using (
    is_active = true
    and exists (
      select 1
      from stores
      where stores.id = kitchen_stations.store_id
        and stores.is_active = true
        and stores.qr_ordering_enabled = true
    )
  );

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

  if new.kitchen_station_id is null and exists (
    select 1
    from orders
    where orders.id = new.order_id
      and orders.qr_order_source = true
  ) then
    raise exception 'QR order item requires an active kitchen station'
      using errcode = '23514';
  end if;

  return new;
end;
$$;
