-- Stock pools let multiple variants in the same store consume a shared quantity.
create table public.stock_pools (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  store_id uuid not null references public.stores(id),
  name text not null check (btrim(name) <> ''),
  unit_label text not null check (btrim(unit_label) <> ''),
  quantity integer not null default 0 check (quantity >= 0),
  low_stock_threshold integer not null default 5 check (low_stock_threshold >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.variant_stock_links (
  variant_id uuid primary key references public.product_variants(id) on delete cascade,
  stock_pool_id uuid not null references public.stock_pools(id),
  consumption_quantity integer not null check (consumption_quantity > 0),
  created_at timestamptz not null default now()
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  stock_pool_id uuid not null references public.stock_pools(id),
  movement_type text not null check (movement_type in ('receive', 'set_balance', 'sale', 'cancel_restore', 'item_void_restore', 'migration')),
  quantity_delta integer not null,
  before_quantity integer not null check (before_quantity >= 0),
  after_quantity integer not null check (after_quantity >= 0),
  reason text,
  reference_type text,
  reference_id uuid,
  actor_id uuid,
  created_at timestamptz not null default now(),
  check (after_quantity = before_quantity + quantity_delta)
);

alter table public.order_items
  add column if not exists stock_pool_id uuid references public.stock_pools(id),
  add column if not exists stock_units_per_item integer check (stock_units_per_item > 0);

alter table public.order_items
  add constraint order_items_stock_pool_snapshot_pair_check
  check (
    (stock_pool_id is null and stock_units_per_item is null)
    or (stock_pool_id is not null and stock_units_per_item is not null)
  );

create index if not exists variant_stock_links_stock_pool_id_idx on public.variant_stock_links(stock_pool_id);
create index if not exists stock_movements_stock_pool_created_at_idx on public.stock_movements(stock_pool_id, created_at desc);
create index if not exists order_items_stock_pool_id_idx on public.order_items(stock_pool_id);

create or replace function public.enforce_stock_pool_tenant()
returns trigger
language plpgsql
as $$
declare
  v_store_organization_id uuid;
begin
  if tg_op = 'UPDATE'
    and (new.organization_id is distinct from old.organization_id or new.store_id is distinct from old.store_id) then
    raise exception 'stock pool organization_id and store_id are immutable after insert';
  end if;

  select organization_id into v_store_organization_id from public.stores where id = new.store_id;

  if v_store_organization_id is null then
    raise exception 'stock pool store must exist';
  end if;

  if v_store_organization_id is distinct from new.organization_id then
    raise exception 'stock pool store must belong to its organization';
  end if;

  return new;
end;
$$;

create trigger stock_pool_same_tenant
before insert or update on public.stock_pools
for each row execute function public.enforce_stock_pool_tenant();

create trigger stock_pools_set_updated_at
before update on public.stock_pools
for each row execute function public.set_updated_at();

create or replace function public.enforce_store_stock_pool_organization()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is distinct from old.organization_id
    and exists (select 1 from public.stock_pools where store_id = old.id) then
    raise exception 'store organization_id cannot change while stock pools exist';
  end if;

  return new;
end;
$$;

create trigger store_stock_pool_organization_immutable
before update of organization_id on public.stores
for each row execute function public.enforce_store_stock_pool_organization();

create or replace function public.enforce_variant_stock_link_store()
returns trigger
language plpgsql
as $$
declare
  v_variant_store_id uuid;
  v_pool_store_id uuid;
begin
  select p.store_id into v_variant_store_id from public.product_variants pv join public.products p on p.id = pv.product_id where pv.id = new.variant_id;
  select store_id into v_pool_store_id from public.stock_pools where id = new.stock_pool_id;

  if v_variant_store_id is null or v_pool_store_id is null then
    raise exception 'variant and stock pool must exist';
  end if;

  if v_variant_store_id is distinct from v_pool_store_id then
    raise exception 'variant and stock pool must belong to the same store';
  end if;

  return new;
end;
$$;

create trigger variant_stock_link_same_store
before insert or update on public.variant_stock_links
for each row execute function public.enforce_variant_stock_link_store();

create or replace function public.enforce_product_stock_link_scope()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.product_variants pv
    join public.variant_stock_links l on l.variant_id = pv.id
    join public.stock_pools sp on sp.id = l.stock_pool_id
    where pv.product_id = new.id
      and (sp.organization_id is distinct from new.organization_id or sp.store_id is distinct from new.store_id)
  ) then
    raise exception 'product scope cannot change while a linked variant uses a stock pool in the old scope';
  end if;

  return new;
end;
$$;

create trigger product_stock_link_scope
before update of organization_id, store_id on public.products
for each row execute function public.enforce_product_stock_link_scope();

create or replace function public.enforce_variant_stock_link_product_scope()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.products p
    join public.variant_stock_links l on l.variant_id = new.id
    join public.stock_pools sp on sp.id = l.stock_pool_id
    where p.id = new.product_id
      and (sp.organization_id is distinct from p.organization_id or sp.store_id is distinct from p.store_id)
  ) then
    raise exception 'variant product cannot change across a linked stock pool scope';
  end if;

  return new;
end;
$$;

create trigger variant_stock_link_product_scope
before update of product_id on public.product_variants
for each row execute function public.enforce_variant_stock_link_product_scope();

create or replace function public.enforce_order_item_stock_pool_scope()
returns trigger
language plpgsql
as $$
declare
  v_order_organization_id uuid;
  v_order_store_id uuid;
  v_pool_organization_id uuid;
  v_pool_store_id uuid;
begin
  if new.stock_pool_id is null then
    return new;
  end if;

  select organization_id, store_id into v_order_organization_id, v_order_store_id from public.orders where id = new.order_id;
  select organization_id, store_id into v_pool_organization_id, v_pool_store_id from public.stock_pools where id = new.stock_pool_id;

  if v_order_organization_id is null or v_pool_organization_id is null
    or v_order_organization_id is distinct from v_pool_organization_id
    or v_order_store_id is distinct from v_pool_store_id then
    raise exception 'order item stock pool must belong to the order store and organization';
  end if;

  return new;
end;
$$;

create trigger order_item_stock_pool_same_scope
before insert or update of order_id, stock_pool_id, stock_units_per_item on public.order_items
for each row execute function public.enforce_order_item_stock_pool_scope();

create or replace function public.enforce_order_stock_pool_scope()
returns trigger
language plpgsql
as $$
begin
  if (new.organization_id is distinct from old.organization_id or new.store_id is distinct from old.store_id)
    and exists (select 1 from public.order_items where order_id = old.id and stock_pool_id is not null) then
    raise exception 'order organization_id and store_id cannot change while stock pool snapshots exist';
  end if;

  return new;
end;
$$;

create trigger order_stock_pool_scope_immutable
before update of organization_id, store_id on public.orders
for each row execute function public.enforce_order_stock_pool_scope();

alter table public.stock_pools enable row level security;
alter table public.variant_stock_links enable row level security;
alter table public.stock_movements enable row level security;

create policy "stock_pools_select"
on public.stock_pools for select
using (auth_user_role_in_store(organization_id, store_id, 'staff'));

create policy "stock_pools_manage"
on public.stock_pools for all
using (auth_user_role_in_store(organization_id, store_id, 'manager'))
with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "variant_stock_links_select"
on public.variant_stock_links for select
using (
  exists (
    select 1 from public.stock_pools sp
    where sp.id = stock_pool_id
      and auth_user_role_in_store(sp.organization_id, sp.store_id, 'staff')
  )
);

create policy "variant_stock_links_manage"
on public.variant_stock_links for all
using (
  exists (
    select 1 from public.stock_pools sp
    where sp.id = stock_pool_id
      and auth_user_role_in_store(sp.organization_id, sp.store_id, 'manager')
  )
)
with check (
  exists (
    select 1 from public.stock_pools sp
    where sp.id = stock_pool_id
      and auth_user_role_in_store(sp.organization_id, sp.store_id, 'manager')
  )
);

create policy "stock_movements_select"
on public.stock_movements for select
using (
  exists (
    select 1 from public.stock_pools sp
    where sp.id = stock_pool_id
      and auth_user_role_in_store(sp.organization_id, sp.store_id, 'staff')
  )
);

create policy "stock_movements_insert"
on public.stock_movements for insert
with check (
  exists (
    select 1 from public.stock_pools sp
    where sp.id = stock_pool_id
      and auth_user_role_in_store(sp.organization_id, sp.store_id, 'manager')
  )
);

-- ตัวแปร loop ห้ามชื่อ v ซ้ำกับ alias ของตาราง (plpgsql จะ resolve v.id ไปที่ record
-- ที่ยังไม่ถูก assign → "record v is not assigned yet" ตั้งแต่ statement แรก)
do $$
declare
  v_row record;
  v_pool_id uuid;
  v_quantity integer;
begin
  for v_row in
    select pv.id, pv.name as variant_name, pv.stock_quantity, p.organization_id, p.store_id, p.name as product_name, p.unit_label
    from public.product_variants pv join public.products p on p.id = pv.product_id
    where pv.track_stock = true
  loop
    if not exists (select 1 from public.variant_stock_links l where l.variant_id = v_row.id) then
      v_quantity := greatest(coalesce(v_row.stock_quantity, 0), 0);

      insert into public.stock_pools (organization_id, store_id, name, unit_label, quantity)
      values (
        v_row.organization_id,
        v_row.store_id,
        coalesce(nullif(btrim(v_row.product_name), ''), 'Product') || ' · ' || coalesce(nullif(btrim(v_row.variant_name), ''), 'Variant'),
        coalesce(nullif(btrim(v_row.unit_label), ''), 'unit'),
        v_quantity
      )
      returning id into v_pool_id;

      insert into public.variant_stock_links (variant_id, stock_pool_id, consumption_quantity)
      values (v_row.id, v_pool_id, 1);

      insert into public.stock_movements (stock_pool_id, movement_type, quantity_delta, before_quantity, after_quantity, reason)
      values (
        v_pool_id,
        'migration',
        v_quantity,
        0,
        v_quantity,
        case
          when v_row.stock_quantity < 0 then 'legacy variant stock backfill (negative quantity normalized to zero)'
          else 'legacy variant stock backfill'
        end
      );
    end if;
  end loop;
end;
$$;

-- Preflight: legacy order_items with variant links but mismatched order/pool scope remain without a stock snapshot.
update public.order_items oi
set stock_pool_id = l.stock_pool_id,
    stock_units_per_item = l.consumption_quantity
from public.variant_stock_links l
join public.stock_pools sp on sp.id = l.stock_pool_id,
     public.orders o
where oi.variant_id = l.variant_id
  and oi.order_id = o.id
  and oi.stock_pool_id is null
  and oi.stock_units_per_item is null
  and o.organization_id = sp.organization_id
  and o.store_id = sp.store_id;

-- Install the write guard only after the trusted migration backfill above.
-- 00004 replaces this function/trigger when stock_pool_name is introduced.
create or replace function public.enforce_order_item_stock_pool_snapshot_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.stock_pool_id is not null or new.stock_units_per_item is not null then
      raise exception 'ห้ามกำหนด Stock Pool snapshot ตอนสร้างรายการออร์เดอร์';
    end if;

    return new;
  end if;

  if new.stock_pool_id is distinct from old.stock_pool_id
    or new.stock_units_per_item is distinct from old.stock_units_per_item then
    raise exception 'ข้อมูล Stock Pool snapshot ของรายการออร์เดอร์แก้ไขไม่ได้';
  end if;

  return new;
end;
$$;

create trigger order_item_stock_pool_snapshot_immutable
before insert or update of stock_pool_id, stock_units_per_item on public.order_items
for each row execute function public.enforce_order_item_stock_pool_snapshot_immutable();
