-- Stock Pool order integration. All stock mutations and their idempotency
-- movements stay in the same transaction as the owning order mutation.
--
-- ต้องเปิด transaction เอง: migration runner ของ supabase CLI ไม่ได้ห่อไฟล์ไว้ใน
-- transaction ให้ (LOCK TABLE จึงล้มด้วย 25P01) และ cutover ด้านล่างต้องเป็น
-- all-or-nothing ร่วมกับ lock ทั้งชุด
begin;

-- Canonical migration-wide lock boundary. EXCLUSIVE waits for runtime row
-- lockers and writers while still allowing ordinary reads. order_items needs
-- ACCESS EXCLUSIVE later for ALTER TABLE, so acquire it up front instead of
-- upgrading after another transaction has taken locks in runtime order.
-- The order matches the order flow: Order, Item, Variant, Product, Pool, Link,
-- then Movement. Function definitions below only reference other relations;
-- they do not touch those relations during this migration.
lock table public.orders in exclusive mode;
lock table public.order_items in access exclusive mode;
lock table public.product_variants in exclusive mode;
lock table public.products in exclusive mode;
lock table public.stock_pools in exclusive mode;
lock table public.variant_stock_links in exclusive mode;
lock table public.stock_movements in exclusive mode;

alter table public.order_items
  add column if not exists stock_pool_name text;

update public.order_items oi
set stock_pool_name = sp.name
from public.stock_pools sp
where oi.stock_pool_id = sp.id
  and oi.stock_pool_name is null;

alter table public.order_items
  drop constraint if exists order_items_stock_pool_snapshot_complete_check;

alter table public.order_items
  add constraint order_items_stock_pool_snapshot_complete_check
  check (
    (stock_pool_id is null and stock_pool_name is null and stock_units_per_item is null)
    or (
      stock_pool_id is not null
      and nullif(btrim(stock_pool_name), '') is not null
      and stock_units_per_item is not null
      and stock_units_per_item > 0
    )
  );

-- Trusted cutover evidence for QR orders that were already open when 00004
-- was applied. This is deliberately separate from stock_movements: inventing
-- a sale movement would make its before/after quantity equation untrue.
create table public.order_item_stock_pool_cutover_provenance (
  order_item_id uuid primary key references public.order_items(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  stock_pool_id uuid not null references public.stock_pools(id),
  stock_pool_name text not null check (nullif(btrim(stock_pool_name), '') is not null),
  item_quantity integer not null check (item_quantity > 0),
  unit_quantity integer not null check (unit_quantity > 0),
  stock_units_per_item integer not null check (stock_units_per_item > 0),
  total_stock_units integer not null check (total_stock_units > 0),
  order_created_at timestamptz not null,
  cutover_at timestamptz not null,
  cutover_migration text not null check (cutover_migration = '20260905000004'),
  check (order_created_at < cutover_at),
  check (
    total_stock_units::numeric = item_quantity::numeric
      * unit_quantity::numeric
      * stock_units_per_item::numeric
  )
);

alter table public.order_item_stock_pool_cutover_provenance enable row level security;
revoke all privileges on table public.order_item_stock_pool_cutover_provenance from public, anon, authenticated;

-- Cutover-only critical section. The migration-wide relation locks above are
-- already held; lock candidate rows in the same deterministic source order.
-- Validation, marker insert, and the exact 1:1 postcondition stay in this one
-- statement. Runtime order helpers do not acquire migration-wide table locks.
do $$
declare
  v_cutover_at timestamptz := transaction_timestamp();
  v_candidate_count bigint;
  v_marker_count bigint;
begin
  perform o.id
  from public.orders o
  where o.qr_order_source is true
    and o.status = 'open'
    and o.created_at < v_cutover_at
    and exists (
      select 1
      from public.order_items oi
      where oi.order_id = o.id
        and coalesce(oi.voided, false) = false
        and (
          oi.stock_pool_id is not null
          or exists (
            select 1
            from public.variant_stock_links l
            where l.variant_id = oi.variant_id
          )
        )
    )
  order by o.id
  for share of o;

  perform oi.id
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.qr_order_source is true
    and o.status = 'open'
    and coalesce(oi.voided, false) = false
    and o.created_at < v_cutover_at
    and (
      oi.stock_pool_id is not null
      or exists (
        select 1
        from public.variant_stock_links l
        where l.variant_id = oi.variant_id
      )
    )
  order by oi.id
  for share of oi;

  perform pv.id
  from public.product_variants pv
  join public.order_items oi on oi.variant_id = pv.id
  join public.orders o on o.id = oi.order_id
  where o.qr_order_source is true
    and o.status = 'open'
    and coalesce(oi.voided, false) = false
    and o.created_at < v_cutover_at
    and (
      oi.stock_pool_id is not null
      or exists (
        select 1
        from public.variant_stock_links l
        where l.variant_id = oi.variant_id
      )
    )
  order by pv.id
  for share of pv;

  perform p.id
  from public.products p
  join public.product_variants pv on pv.product_id = p.id
  join public.order_items oi on oi.variant_id = pv.id
  join public.orders o on o.id = oi.order_id
  where o.qr_order_source is true
    and o.status = 'open'
    and coalesce(oi.voided, false) = false
    and o.created_at < v_cutover_at
    and (
      oi.stock_pool_id is not null
      or exists (
        select 1
        from public.variant_stock_links l
        where l.variant_id = oi.variant_id
      )
    )
  order by p.id
  for share of p;

  perform sp.id
  from public.stock_pools sp
  join public.order_items oi on oi.stock_pool_id = sp.id
    or exists (
      select 1
      from public.variant_stock_links source_link
      where source_link.variant_id = oi.variant_id
        and source_link.stock_pool_id = sp.id
    )
  join public.orders o on o.id = oi.order_id
  where o.qr_order_source is true
    and o.status = 'open'
    and coalesce(oi.voided, false) = false
    and o.created_at < v_cutover_at
  order by sp.id
  for share of sp;

  perform l.variant_id
  from public.variant_stock_links l
  join public.order_items oi on oi.variant_id = l.variant_id
  join public.orders o on o.id = oi.order_id
  where o.qr_order_source is true
    and o.status = 'open'
    and coalesce(oi.voided, false) = false
    and o.created_at < v_cutover_at
  order by l.variant_id
  for share of l;

  -- Any pre-cutover open QR item that has either a Pool snapshot or a
  -- current Variant link must prove the complete 00001 backfill identity.
  if exists (
    select 1
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    left join public.variant_stock_links l on l.variant_id = oi.variant_id
    left join public.product_variants pv on pv.id = oi.variant_id
    left join public.products p on p.id = pv.product_id
    left join public.stock_pools sp on sp.id = oi.stock_pool_id
    where o.qr_order_source is true
      and o.status = 'open'
      and coalesce(oi.voided, false) = false
      and o.created_at < v_cutover_at
      and (oi.stock_pool_id is not null or l.variant_id is not null)
      and (
        oi.stock_pool_id is null
        or nullif(btrim(oi.stock_pool_name), '') is null
        or oi.stock_units_per_item is null
        or oi.quantity <= 0
        or coalesce(oi.unit_quantity, 1) <= 0
        or oi.stock_units_per_item <= 0
        or oi.quantity::numeric
          * coalesce(oi.unit_quantity, 1)::numeric
          * oi.stock_units_per_item::numeric > 2147483647
        or l.variant_id is null
        or l.stock_pool_id is distinct from oi.stock_pool_id
        or l.consumption_quantity is distinct from oi.stock_units_per_item
        or pv.id is null
        or pv.product_id is distinct from oi.product_id
        or pv.is_active is distinct from true
        or p.id is null
        or p.is_active is distinct from true
        or sp.id is null
        or sp.is_active is distinct from true
        or sp.name is distinct from oi.stock_pool_name
        or p.organization_id is distinct from o.organization_id
        or p.store_id is distinct from o.store_id
        or sp.organization_id is distinct from o.organization_id
        or sp.store_id is distinct from o.store_id
      )
  ) then
    raise exception 'ไม่สามารถยืนยัน Stock Pool snapshot ก่อน cutover ได้';
  end if;

  select count(*)
  into v_candidate_count
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.variant_stock_links l on l.variant_id = oi.variant_id
  where o.qr_order_source is true
    and o.status = 'open'
    and coalesce(oi.voided, false) = false
    and o.created_at < v_cutover_at
    and (oi.stock_pool_id is not null or l.variant_id is not null);

  insert into public.order_item_stock_pool_cutover_provenance (
    order_item_id,
    order_id,
    stock_pool_id,
    stock_pool_name,
    item_quantity,
    unit_quantity,
    stock_units_per_item,
    total_stock_units,
    order_created_at,
    cutover_at,
    cutover_migration
  )
  select
    oi.id,
    oi.order_id,
    oi.stock_pool_id,
    oi.stock_pool_name,
    oi.quantity,
    coalesce(oi.unit_quantity, 1),
    oi.stock_units_per_item,
    (
      oi.quantity::numeric
        * coalesce(oi.unit_quantity, 1)::numeric
        * oi.stock_units_per_item::numeric
    )::integer,
    o.created_at,
    v_cutover_at,
    '20260905000004'
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.variant_stock_links l
    on l.variant_id = oi.variant_id
    and l.stock_pool_id = oi.stock_pool_id
    and l.consumption_quantity = oi.stock_units_per_item
  join public.product_variants pv
    on pv.id = oi.variant_id
    and pv.product_id = oi.product_id
    and pv.is_active = true
  join public.products p
    on p.id = pv.product_id
    and p.is_active = true
    and p.organization_id = o.organization_id
    and p.store_id = o.store_id
  join public.stock_pools sp
    on sp.id = oi.stock_pool_id
    and sp.is_active = true
    and sp.name = oi.stock_pool_name
    and sp.organization_id = o.organization_id
    and sp.store_id = o.store_id
  where o.qr_order_source is true
    and o.status = 'open'
    and coalesce(oi.voided, false) = false
    and o.created_at < v_cutover_at
    and oi.stock_pool_id is not null
    and oi.stock_pool_name is not null
    and oi.stock_units_per_item is not null
  order by oi.id;

  get diagnostics v_marker_count = row_count;

  if v_marker_count is distinct from v_candidate_count
    or exists (
      select oi.id
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      left join public.variant_stock_links l on l.variant_id = oi.variant_id
      left join public.order_item_stock_pool_cutover_provenance cp
        on cp.order_item_id = oi.id
      where o.qr_order_source is true
        and o.status = 'open'
        and coalesce(oi.voided, false) = false
        and o.created_at < v_cutover_at
        and (oi.stock_pool_id is not null or l.variant_id is not null)
        and (
          cp.order_item_id is null
          or cp.order_id is distinct from oi.order_id
          or cp.stock_pool_id is distinct from oi.stock_pool_id
          or cp.stock_pool_name is distinct from oi.stock_pool_name
          or cp.item_quantity is distinct from oi.quantity
          or cp.unit_quantity is distinct from coalesce(oi.unit_quantity, 1)
          or cp.stock_units_per_item is distinct from oi.stock_units_per_item
          or cp.total_stock_units::numeric is distinct from (
            oi.quantity::numeric
              * coalesce(oi.unit_quantity, 1)::numeric
              * oi.stock_units_per_item::numeric
          )
          or cp.order_created_at is distinct from o.created_at
          or cp.cutover_at is distinct from v_cutover_at
          or cp.cutover_migration is distinct from '20260905000004'
        )
    )
    or exists (
      select cp.order_item_id
      from public.order_item_stock_pool_cutover_provenance cp
      left join public.order_items oi on oi.id = cp.order_item_id
      left join public.orders o on o.id = oi.order_id
      left join public.variant_stock_links l on l.variant_id = oi.variant_id
      left join public.product_variants pv on pv.id = oi.variant_id
      left join public.products p on p.id = pv.product_id
      left join public.stock_pools sp on sp.id = oi.stock_pool_id
      where oi.id is null
        or o.id is null
        or o.qr_order_source is distinct from true
        or o.status is distinct from 'open'
        or coalesce(oi.voided, false) is distinct from false
        or o.created_at >= v_cutover_at
        or l.variant_id is null
        or l.stock_pool_id is distinct from oi.stock_pool_id
        or l.consumption_quantity is distinct from oi.stock_units_per_item
        or pv.id is null
        or pv.product_id is distinct from oi.product_id
        or pv.is_active is distinct from true
        or p.id is null
        or p.is_active is distinct from true
        or sp.id is null
        or sp.is_active is distinct from true
        or sp.name is distinct from oi.stock_pool_name
        or p.organization_id is distinct from o.organization_id
        or p.store_id is distinct from o.store_id
        or sp.organization_id is distinct from o.organization_id
        or sp.store_id is distinct from o.store_id
        or cp.order_id is distinct from oi.order_id
        or cp.stock_pool_id is distinct from oi.stock_pool_id
        or cp.stock_pool_name is distinct from oi.stock_pool_name
        or cp.item_quantity is distinct from oi.quantity
        or cp.unit_quantity is distinct from coalesce(oi.unit_quantity, 1)
        or cp.stock_units_per_item is distinct from oi.stock_units_per_item
        or cp.total_stock_units::numeric is distinct from (
          oi.quantity::numeric
            * coalesce(oi.unit_quantity, 1)::numeric
            * oi.stock_units_per_item::numeric
        )
        or cp.order_created_at is distinct from o.created_at
        or cp.cutover_at is distinct from v_cutover_at
        or cp.cutover_migration is distinct from '20260905000004'
    ) then
    raise exception 'cutover provenance ไม่ตรงกับ source แบบ 1:1';
  end if;
end;
$$;

create or replace function public.enforce_order_item_stock_pool_snapshot_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order_items_owner name;
begin
  if tg_op = 'INSERT' then
    if new.stock_pool_id is not null
      or new.stock_pool_name is not null
      or new.stock_units_per_item is not null then
      raise exception 'ห้ามกำหนด Stock Pool snapshot ตอนสร้างรายการออร์เดอร์';
    end if;

    return new;
  end if;

  if (
    new.stock_pool_id is distinct from old.stock_pool_id
    or new.stock_pool_name is distinct from old.stock_pool_name
    or new.stock_units_per_item is distinct from old.stock_units_per_item
  ) then
    if old.stock_pool_id is not null
      or old.stock_pool_name is not null
      or old.stock_units_per_item is not null then
      raise exception 'ข้อมูล Stock Pool snapshot ของรายการออร์เดอร์แก้ไขไม่ได้';
    end if;

    select pg_get_userbyid(c.relowner)
    into v_order_items_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'order_items'
      and c.relkind in ('r', 'p');

    if v_order_items_owner is null
      or current_user is distinct from v_order_items_owner then
      raise exception 'กำหนด Stock Pool snapshot ได้เฉพาะ trusted helper';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists order_item_stock_pool_snapshot_immutable on public.order_items;
create trigger order_item_stock_pool_snapshot_immutable
before insert or update of stock_pool_id, stock_pool_name, stock_units_per_item
on public.order_items
for each row execute function public.enforce_order_item_stock_pool_snapshot_immutable();

-- This index is created before any new mutation function. Duplicate movement
-- identities abort the whole transaction; mutations never use conflict-ignore.
create unique index if not exists stock_movements_reference_idempotency_idx
on public.stock_movements (
  stock_pool_id, movement_type, reference_type, reference_id
)
where reference_type is not null and reference_id is not null;

create or replace function public.snapshot_order_item_stock_pools(
  p_order_id uuid,
  p_store_id uuid,
  p_organization_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link_state_before text[];
  v_link_state_after text[];
begin
  if p_order_id is null or p_store_id is null or p_organization_id is null then
    raise exception 'ข้อมูลออร์เดอร์สำหรับ Stock Pool ไม่ครบถ้วน';
  end if;

  perform o.id
    from public.orders o
    where o.id = p_order_id
      and o.store_id = p_store_id
      and o.organization_id = p_organization_id
    for update;

  if not found then
    raise exception 'ไม่พบออร์เดอร์ในร้านปัจจุบัน';
  end if;

  -- Shared lock order with link_variant_to_stock_pool is Variant, Product,
  -- Pool, then Link. Sorted row acquisition also keeps multi-item orders
  -- deterministic; adjust_stock_pool only takes the Pool row lock.
  perform pv.id
  from public.order_items oi
  join public.product_variants pv on pv.id = oi.variant_id
  where oi.order_id = p_order_id
  order by pv.id
  for update of pv;

  perform p.id
  from public.order_items oi
  join public.product_variants pv on pv.id = oi.variant_id
  join public.products p on p.id = pv.product_id
  where oi.order_id = p_order_id
  order by p.id
  for update of p;

  select coalesce(array_agg(
    oi.id::text || ':' || l.variant_id::text || ':'
      || l.stock_pool_id::text || ':' || l.consumption_quantity::text
    order by oi.id, l.variant_id
  ), array[]::text[])
  into v_link_state_before
  from public.order_items oi
  join public.variant_stock_links l on l.variant_id = oi.variant_id
  where oi.order_id = p_order_id;

  perform sp.id
  from public.order_items oi
  join public.variant_stock_links l on l.variant_id = oi.variant_id
  join public.stock_pools sp on sp.id = l.stock_pool_id
  where oi.order_id = p_order_id
  order by sp.id
  for update of sp;

  perform l.variant_id
  from public.order_items oi
  join public.variant_stock_links l on l.variant_id = oi.variant_id
  where oi.order_id = p_order_id
  order by l.variant_id
  for update of l;

  select coalesce(array_agg(
    oi.id::text || ':' || l.variant_id::text || ':'
      || l.stock_pool_id::text || ':' || l.consumption_quantity::text
    order by oi.id, l.variant_id
  ), array[]::text[])
  into v_link_state_after
  from public.order_items oi
  join public.variant_stock_links l on l.variant_id = oi.variant_id
  where oi.order_id = p_order_id;

  if v_link_state_after is distinct from v_link_state_before then
    raise exception 'Stock Pool Link เปลี่ยนระหว่างสร้าง snapshot';
  end if;

  if exists (
    select 1
    from public.order_items oi
    join public.variant_stock_links l on l.variant_id = oi.variant_id
    left join public.product_variants pv on pv.id = oi.variant_id
    left join public.products p on p.id = pv.product_id
    left join public.stock_pools sp on sp.id = l.stock_pool_id
    where oi.order_id = p_order_id
      and (
        pv.id is null
        or p.id is null
        or p.store_id is distinct from p_store_id
        or p.organization_id is distinct from p_organization_id
        or sp.id is null
        or sp.store_id is distinct from p_store_id
        or sp.organization_id is distinct from p_organization_id
      )
  ) then
    -- ตรวจเฉพาะ "คนละร้าน/คนละองค์กร" ซึ่งเป็น invariant จริง — ไม่ตรวจ is_active
    -- เพราะออเดอร์ที่เปิดค้างอยู่แล้วต้องปิดบิลได้เสมอ แม้ร้านจะเพิ่งปิดเมนูนั้นไป
    raise exception 'Stock Pool ของรายการไม่ถูกต้อง (คนละร้าน)';
  end if;

  update public.order_items oi
  set stock_pool_id = l.stock_pool_id,
      stock_pool_name = sp.name,
      stock_units_per_item = l.consumption_quantity
  from public.variant_stock_links l
  join public.product_variants pv on pv.id = l.variant_id
  join public.products p on p.id = pv.product_id
  join public.stock_pools sp on sp.id = l.stock_pool_id
  where oi.order_id = p_order_id
    and oi.variant_id = l.variant_id
    and oi.stock_pool_id is null
    and oi.stock_pool_name is null
    and oi.stock_units_per_item is null
    and p.store_id = p_store_id
    and p.organization_id = p_organization_id
    and sp.store_id = p_store_id
    and sp.organization_id = p_organization_id;

  if exists (
    select 1
    from public.order_items oi
    join public.variant_stock_links l on l.variant_id = oi.variant_id
    where oi.order_id = p_order_id
      and (
        oi.stock_pool_id is null
        or oi.stock_pool_name is null
        or oi.stock_units_per_item is null
      )
  ) then
    raise exception 'มีรายการที่เชื่อม Stock Pool แต่ยังไม่มี snapshot';
  end if;
end;
$$;

create or replace function public.assert_order_stock_pool_restore_provenance(
  p_order_id uuid,
  p_pool_id uuid,
  p_restore_units numeric,
  p_require_full_restore boolean default false,
  p_order_item_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale_units numeric;
  v_snapshot_units numeric;
  v_original_units numeric;
  v_prior_restore_units numeric;
  v_marker_count bigint;
  v_valid_marker_count bigint;
  v_marker_item_units numeric;
begin
  if p_order_id is null or p_pool_id is null
    or p_restore_units is null or p_restore_units <= 0 then
    raise exception 'ข้อมูลอ้างอิงการคืน Stock Pool ไม่ครบถ้วน';
  end if;

  select (-sm.quantity_delta)::numeric
  into v_sale_units
  from public.stock_movements sm
  where sm.stock_pool_id = p_pool_id
    and sm.movement_type = 'sale'
    and sm.reference_type = 'order'
    and sm.reference_id = p_order_id;

  if found then
    if v_sale_units <= 0 then
      raise exception 'รายการตัด Stock Pool ต้นทางไม่ถูกต้อง';
    end if;

    select sum(
      oi.quantity::numeric
        * coalesce(oi.unit_quantity, 1)::numeric
        * oi.stock_units_per_item::numeric
    )
    into v_snapshot_units
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.stock_pool_id = p_pool_id;

    if v_snapshot_units is null
      or v_snapshot_units <= 0
      or v_snapshot_units is distinct from v_sale_units then
      raise exception 'Stock Pool snapshot ไม่ตรงกับรายการตัดสต๊อกต้นทาง';
    end if;

    if p_order_item_id is not null and not exists (
      select 1
      from public.order_items oi
      where oi.id = p_order_item_id
        and oi.order_id = p_order_id
        and oi.stock_pool_id = p_pool_id
        and oi.quantity::numeric
          * coalesce(oi.unit_quantity, 1)::numeric
          * oi.stock_units_per_item::numeric = p_restore_units
    ) then
      raise exception 'รายการที่คืนไม่ตรงกับ Stock Pool snapshot ต้นทาง';
    end if;

    v_original_units := v_sale_units;
  else
    select count(*)
    into v_marker_count
    from public.order_item_stock_pool_cutover_provenance cp
    where cp.order_id = p_order_id
      and cp.stock_pool_id = p_pool_id;

    select count(*), coalesce(sum(cp.total_stock_units), 0)::numeric
    into v_valid_marker_count, v_original_units
    from public.order_item_stock_pool_cutover_provenance cp
    join public.order_items oi
      on oi.id = cp.order_item_id
      and oi.order_id = cp.order_id
      and oi.stock_pool_id = cp.stock_pool_id
      and oi.stock_pool_name = cp.stock_pool_name
      and oi.quantity = cp.item_quantity
      and oi.unit_quantity = cp.unit_quantity
      and oi.stock_units_per_item = cp.stock_units_per_item
    join public.orders o
      on o.id = cp.order_id
      and o.created_at = cp.order_created_at
    where cp.order_id = p_order_id
      and cp.stock_pool_id = p_pool_id
      and cp.cutover_migration = '20260905000004'
      and cp.total_stock_units = cp.item_quantity::numeric
        * cp.unit_quantity::numeric
        * cp.stock_units_per_item::numeric
      and o.created_at < cp.cutover_at
      and o.qr_order_source is true
      and o.status = 'open';

    if v_marker_count = 0
      or v_valid_marker_count is distinct from v_marker_count
      or v_original_units <= 0 then
      raise exception 'ไม่พบ sale movement หรือ cutover provenance ที่เชื่อถือได้';
    end if;

    if p_order_item_id is not null then
      select cp.total_stock_units::numeric
      into v_marker_item_units
      from public.order_item_stock_pool_cutover_provenance cp
      where p_order_item_id is not null
        and cp.order_item_id = p_order_item_id
        and cp.order_id = p_order_id
        and cp.stock_pool_id = p_pool_id;

      if not found or v_marker_item_units is distinct from p_restore_units then
        raise exception 'ไม่พบ sale movement หรือ cutover provenance ที่เชื่อถือได้';
      end if;
    end if;
  end if;

  select coalesce(sum(sm.quantity_delta), 0)::numeric
  into v_prior_restore_units
  from public.stock_movements sm
  where sm.stock_pool_id = p_pool_id
    and sm.movement_type in ('cancel_restore', 'item_void_restore')
    and (
      (
        sm.movement_type = 'cancel_restore'
        and sm.reference_type = 'order'
        and sm.reference_id = p_order_id
      )
      or (
        sm.movement_type = 'item_void_restore'
        and sm.reference_type = 'order_item'
        and exists (
          select 1
          from public.order_items oi
          where oi.id = sm.reference_id
            and oi.order_id = p_order_id
            and oi.stock_pool_id = p_pool_id
        )
      )
    );

  if v_prior_restore_units < 0
    or v_prior_restore_units + p_restore_units > v_original_units then
    raise exception 'ยอดคืน Stock Pool เกินรายการตัดสต๊อกต้นทาง';
  end if;

  if p_require_full_restore
    and v_prior_restore_units + p_restore_units is distinct from v_original_units then
    raise exception 'ยอดคืน Stock Pool ทั้งออร์เดอร์ไม่ตรงกับยอดคงเหลือ';
  end if;
end;
$$;

create or replace function public.deduct_order_stock_pools(
  p_order_id uuid,
  p_store_id uuid,
  p_organization_id uuid,
  p_actor_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_demand record;
  v_pool public.stock_pools%rowtype;
  v_after integer;
begin
  for v_demand in
    select
      oi.stock_pool_id,
      sum(
        oi.quantity::numeric
          * coalesce(oi.unit_quantity, 1)::numeric
          * oi.stock_units_per_item::numeric
      ) as required_units
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.stock_pool_id is not null
      and coalesce(oi.voided, false) = false
    group by oi.stock_pool_id
    order by oi.stock_pool_id
  loop
    if v_demand.required_units is null
      or v_demand.required_units <= 0
      or v_demand.required_units > 2147483647 then
      raise exception 'จำนวน Stock Pool ที่ต้องตัดเกินช่วงที่รองรับ';
    end if;

    select sp.*
    into v_pool
    from public.stock_pools sp
    where sp.id = v_demand.stock_pool_id
    for update;

    -- ไม่ตรวจ is_active: ออเดอร์ที่มี snapshot แล้วต้องตัดสต๊อกได้เสมอ แม้ Pool จะถูก
    -- ปิดใช้งานระหว่างที่บิลยังเปิดค้าง (ปิดบิลไม่ได้ = ขายของแล้วเก็บเงินไม่ได้)
    if not found
      or v_pool.store_id is distinct from p_store_id
      or v_pool.organization_id is distinct from p_organization_id then
      raise exception 'Stock Pool ของออร์เดอร์ไม่ถูกต้อง';
    end if;

    if exists (
      select 1
      from public.stock_movements sm
      where sm.stock_pool_id = v_pool.id
        and sm.movement_type = 'sale'
        and sm.reference_type = 'order'
        and sm.reference_id = p_order_id
    ) then
      raise exception 'ออร์เดอร์นี้ตัด Stock Pool แล้ว';
    end if;

    if v_pool.quantity::bigint < v_demand.required_units then
      raise exception 'สต๊อกไม่เพียงพอ';
    end if;

    v_after := (v_pool.quantity::bigint - v_demand.required_units)::integer;

    update public.stock_pools
    set quantity = v_after,
        updated_at = now()
    where id = v_pool.id;

    insert into public.stock_movements (
      stock_pool_id,
      movement_type,
      quantity_delta,
      before_quantity,
      after_quantity,
      reason,
      reference_type,
      reference_id,
      actor_id
    ) values (
      v_pool.id,
      'sale',
      (-v_demand.required_units)::integer,
      v_pool.quantity,
      v_after,
      'order stock deduction',
      'order',
      p_order_id,
      p_actor_id
    );
  end loop;
end;
$$;

create or replace function public.restore_cancelled_order_stock_pools(
  p_order_id uuid,
  p_store_id uuid,
  p_organization_id uuid,
  p_actor_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restore record;
  v_pool public.stock_pools%rowtype;
  v_after integer;
begin
  for v_restore in
    select
      oi.stock_pool_id,
      sum(
        oi.quantity::numeric
          * coalesce(oi.unit_quantity, 1)::numeric
          * oi.stock_units_per_item::numeric
      ) as restore_units
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.stock_pool_id is not null
      and coalesce(oi.voided, false) = false
    group by oi.stock_pool_id
    order by oi.stock_pool_id
  loop
    if v_restore.restore_units is null
      or v_restore.restore_units <= 0
      or v_restore.restore_units > 2147483647 then
      raise exception 'จำนวน Stock Pool ที่ต้องคืนเกินช่วงที่รองรับ';
    end if;

    select sp.*
    into v_pool
    from public.stock_pools sp
    where sp.id = v_restore.stock_pool_id
    for update;

    if not found
      or v_pool.store_id is distinct from p_store_id
      or v_pool.organization_id is distinct from p_organization_id then
      raise exception 'Stock Pool ของออร์เดอร์ไม่ถูกต้อง';
    end if;

    perform public.assert_order_stock_pool_restore_provenance(
      p_order_id,
      v_pool.id,
      v_restore.restore_units,
      true,
      null
    );

    if exists (
      select 1
      from public.stock_movements sm
      where sm.stock_pool_id = v_pool.id
        and sm.movement_type = 'cancel_restore'
        and sm.reference_type = 'order'
        and sm.reference_id = p_order_id
    ) then
      raise exception 'ออร์เดอร์นี้คืน Stock Pool แล้ว';
    end if;

    if v_pool.quantity::bigint + v_restore.restore_units > 2147483647 then
      raise exception 'ยอด Stock Pool หลังคืนเกินช่วงที่รองรับ';
    end if;

    v_after := (v_pool.quantity::bigint + v_restore.restore_units)::integer;

    update public.stock_pools
    set quantity = v_after,
        updated_at = now()
    where id = v_pool.id;

    insert into public.stock_movements (
      stock_pool_id,
      movement_type,
      quantity_delta,
      before_quantity,
      after_quantity,
      reason,
      reference_type,
      reference_id,
      actor_id
    ) values (
      v_pool.id,
      'cancel_restore',
      v_restore.restore_units::integer,
      v_pool.quantity,
      v_after,
      'QR order cancellation',
      'order',
      p_order_id,
      p_actor_id
    );
  end loop;
end;
$$;

revoke all on function public.snapshot_order_item_stock_pools(uuid, uuid, uuid) from public;
revoke execute on function public.snapshot_order_item_stock_pools(uuid, uuid, uuid) from anon, authenticated;
revoke all on function public.assert_order_stock_pool_restore_provenance(uuid, uuid, numeric, boolean, uuid) from public;
revoke execute on function public.assert_order_stock_pool_restore_provenance(uuid, uuid, numeric, boolean, uuid) from anon, authenticated;
revoke all on function public.deduct_order_stock_pools(uuid, uuid, uuid, uuid) from public;
revoke execute on function public.deduct_order_stock_pools(uuid, uuid, uuid, uuid) from anon, authenticated;
revoke all on function public.restore_cancelled_order_stock_pools(uuid, uuid, uuid, uuid) from public;
revoke execute on function public.restore_cancelled_order_stock_pools(uuid, uuid, uuid, uuid) from anon, authenticated;

create or replace function public.create_qr_order_with_items(p_organization_id uuid, p_store_id uuid, p_table_id uuid, p_order_number text, p_subtotal numeric, p_items jsonb default '[]'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_system_account_id uuid;
  v_table_number text;
  v_item_count integer;
  v_items_subtotal numeric;
  v_stock record;
  v_variant public.product_variants%rowtype;
  v_invalid_required_modifier_count integer;
  v_invalid_max_modifier_count integer;
  v_invalid_single_modifier_count integer;
  v_duplicate_modifier_count integer;
begin
  if p_items is null
    or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'ไม่มีรายการในออร์เดอร์';
  end if;

  if p_subtotal is null or p_subtotal < 0 then
    raise exception 'ยอดออร์เดอร์ไม่ถูกต้อง';
  end if;

  if not exists (
    select 1
    from public.stores
    where id = p_store_id
      and organization_id = p_organization_id
      and is_active = true
      and qr_ordering_enabled = true
  ) then
    raise exception 'ร้านไม่พร้อมรับ QR order';
  end if;

  select number
  into v_table_number
  from public.tables
  where id = p_table_id
    and organization_id = p_organization_id
    and store_id = p_store_id
    and is_active = true
    and qr_enabled = true;

  if not found then
    raise exception 'โต๊ะไม่ถูกต้อง';
  end if;

  insert into public.system_accounts (
    organization_id,
    store_id,
    kind,
    display_name
  ) values (
    p_organization_id,
    p_store_id,
    'qr_order',
    'QR Ordering'
  )
  on conflict (store_id, kind)
  do update set display_name = excluded.display_name
  returning id into v_system_account_id;

  select count(*), coalesce(sum(item.total_price), 0)
  into v_item_count, v_items_subtotal
  from jsonb_to_recordset(p_items) as item(
    product_id uuid,
    product_name text,
    variant_id uuid,
    variant_name text,
    modifiers jsonb,
    quantity integer,
    unit_price numeric,
    total_price numeric,
    note text
  )
  join public.products on products.id = item.product_id
  left join public.product_variants on product_variants.id = item.variant_id
  where item.product_id is not null
    and item.product_name is not null
    and item.quantity > 0
    and item.unit_price >= 0
    and item.total_price >= 0
    and round(item.total_price, 2) = round(item.unit_price * item.quantity, 2)
    and products.organization_id = p_organization_id
    and products.store_id = p_store_id
    and products.is_active = true
    and products.available_for_qr = true
    and (
      item.variant_id is null
      or (
        product_variants.product_id = products.id
        and product_variants.is_active = true
      )
    )
    and round(item.unit_price, 2) = round(products.base_price
      + coalesce(product_variants.price_adjustment, 0)
      + coalesce((
        select sum(modifier_options.price_adjustment)
        from jsonb_array_elements(coalesce(item.modifiers, '[]'::jsonb)) as selected_modifier
        join public.modifier_options
          on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
        join public.modifier_groups
          on modifier_groups.id = modifier_options.modifier_group_id
        where modifier_groups.product_id = products.id
          and modifier_options.is_active = true
      ), 0), 2)
    and jsonb_array_length(coalesce(item.modifiers, '[]'::jsonb)) = (
      select count(*)
      from jsonb_array_elements(coalesce(item.modifiers, '[]'::jsonb)) as selected_modifier
      join public.modifier_options
        on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
      join public.modifier_groups
        on modifier_groups.id = modifier_options.modifier_group_id
      where modifier_groups.product_id = products.id
        and modifier_options.is_active = true
    );

  if v_item_count is distinct from jsonb_array_length(p_items) then
    raise exception 'รายการออร์เดอร์ไม่ถูกต้อง';
  end if;

  if round(p_subtotal, 2) is distinct from round(v_items_subtotal, 2) then
    raise exception 'ยอดรวมสินค้าไม่ตรงกับรายการ';
  end if;

  with item_rows as (
    select item.*, item_ordinality as line_number
    from jsonb_array_elements(p_items) with ordinality as _elems(elem, item_ordinality)
    cross join lateral jsonb_to_recordset(jsonb_build_array(_elems.elem)) as item(
      product_id uuid,
      modifiers jsonb
    )
  ),
  selected as (
    select
      item_rows.line_number,
      item_rows.product_id,
      modifier_groups.id as modifier_group_id,
      modifier_groups.is_required,
      modifier_groups.min_selections,
      modifier_groups.max_selections,
      modifier_groups.selection_type,
      modifier_options.id as option_id
    from item_rows
    cross join lateral jsonb_array_elements(coalesce(item_rows.modifiers, '[]'::jsonb)) as selected_modifier
    join public.modifier_options
      on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
    join public.modifier_groups
      on modifier_groups.id = modifier_options.modifier_group_id
    where modifier_groups.product_id = item_rows.product_id
      and modifier_options.is_active = true
  )
  select count(*)
  into v_duplicate_modifier_count
  from (
    select line_number, product_id, option_id, count(*) as selected_count
    from selected
    group by line_number, product_id, option_id
    having count(*) > 1
  ) duplicate_options;

  if v_duplicate_modifier_count > 0 then
    raise exception 'duplicate modifier option';
  end if;

  with item_rows as (
    select item.*, item_ordinality as line_number
    from jsonb_array_elements(p_items) with ordinality as _elems(elem, item_ordinality)
    cross join lateral jsonb_to_recordset(jsonb_build_array(_elems.elem)) as item(
      product_id uuid,
      modifiers jsonb
    )
  ),
  selected_counts as (
    select
      item_rows.line_number,
      item_rows.product_id,
      modifier_groups.id as modifier_group_id,
      count(modifier_options.id) as selected_count
    from item_rows
    join public.modifier_groups on modifier_groups.product_id = item_rows.product_id
    left join lateral jsonb_array_elements(coalesce(item_rows.modifiers, '[]'::jsonb)) as selected_modifier on true
    left join public.modifier_options
      on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
      and modifier_options.modifier_group_id = modifier_groups.id
      and modifier_options.is_active = true
    group by item_rows.line_number, item_rows.product_id, modifier_groups.id
  )
  select count(*)
  into v_invalid_required_modifier_count
  from selected_counts
  join public.modifier_groups on modifier_groups.id = selected_counts.modifier_group_id
  where selected_counts.selected_count < case
    when modifier_groups.is_required then greatest(1, modifier_groups.min_selections)
    else modifier_groups.min_selections
  end;

  if v_invalid_required_modifier_count > 0 then
    raise exception 'missing required modifier';
  end if;

  with item_rows as (
    select item.*, item_ordinality as line_number
    from jsonb_array_elements(p_items) with ordinality as _elems(elem, item_ordinality)
    cross join lateral jsonb_to_recordset(jsonb_build_array(_elems.elem)) as item(
      product_id uuid,
      modifiers jsonb
    )
  ),
  selected_counts as (
    select
      item_rows.line_number,
      item_rows.product_id,
      modifier_groups.id as modifier_group_id,
      modifier_groups.selection_type,
      modifier_groups.max_selections,
      count(modifier_options.id) as selected_count
    from item_rows
    join public.modifier_groups on modifier_groups.product_id = item_rows.product_id
    left join lateral jsonb_array_elements(coalesce(item_rows.modifiers, '[]'::jsonb)) as selected_modifier on true
    left join public.modifier_options
      on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
      and modifier_options.modifier_group_id = modifier_groups.id
      and modifier_options.is_active = true
    group by item_rows.line_number, item_rows.product_id, modifier_groups.id, modifier_groups.selection_type, modifier_groups.max_selections
  )
  select
    count(*) filter (where selected_count > max_selections),
    count(*) filter (where selection_type = 'single' and selected_count > 1)
  into v_invalid_max_modifier_count, v_invalid_single_modifier_count
  from selected_counts;

  if v_invalid_max_modifier_count > 0 then
    raise exception 'too many modifier selections';
  end if;

  if v_invalid_single_modifier_count > 0 then
    raise exception 'invalid single-choice modifier selection';
  end if;

  insert into public.orders (
    organization_id,
    store_id,
    order_number,
    status,
    table_id,
    table_number,
    cashier_id,
    system_account_id,
    subtotal,
    discount,
    total,
    qr_order_source
  ) values (
    p_organization_id,
    p_store_id,
    p_order_number,
    'open',
    p_table_id,
    v_table_number,
    null,
    v_system_account_id,
    round(p_subtotal, 2),
    0,
    round(p_subtotal, 2),
    true
  )
  returning id into v_order_id;

  insert into public.order_items (
    order_id,
    product_id,
    product_name,
    variant_id,
    variant_name,
    modifiers,
    quantity,
    unit_price,
    total_price,
    note
  )
  select
    v_order_id,
    item.product_id,
    products.name,
    item.variant_id,
    product_variants.name,
    coalesce(item.modifiers, '[]'::jsonb),
    item.quantity,
    round(item.unit_price, 2),
    round(item.total_price, 2),
    item.note
  from jsonb_to_recordset(p_items) as item(
    product_id uuid,
    product_name text,
    variant_id uuid,
    variant_name text,
    modifiers jsonb,
    quantity integer,
    unit_price numeric,
    total_price numeric,
    note text
  )
  join public.products on products.id = item.product_id
  left join public.product_variants on product_variants.id = item.variant_id;

  perform public.snapshot_order_item_stock_pools(v_order_id, p_store_id, p_organization_id);

  -- Preserve the previous Variant-stock path only for lines with no Pool link.
  -- Variant locks precede Pool locks to keep cross-feature lock order stable.
  for v_stock in
    select
      oi.variant_id,
      sum(oi.quantity::bigint * coalesce(oi.unit_quantity, 1)::bigint) as requested_quantity
    from public.order_items oi
    where oi.order_id = v_order_id
      and oi.variant_id is not null
      and oi.stock_pool_id is null
      and coalesce(oi.voided, false) = false
    group by oi.variant_id
    order by oi.variant_id
  loop
    if v_stock.requested_quantity <= 0 or v_stock.requested_quantity > 2147483647 then
      raise exception 'จำนวนสินค้าที่ต้องตัดเกินช่วงที่รองรับ';
    end if;

    select pv.*
    into v_variant
    from public.product_variants pv
    join public.products p on p.id = pv.product_id
    where pv.id = v_stock.variant_id
      and p.organization_id = p_organization_id
      and p.store_id = p_store_id
    for update of pv;

    if not found then
      raise exception 'สินค้าไม่ถูกต้อง';
    end if;

    if v_variant.track_stock then
      if v_variant.stock_quantity is null
        or v_variant.stock_quantity::bigint < v_stock.requested_quantity then
        raise exception 'สินค้าเหลือไม่พอ';
      end if;

      update public.product_variants
      set stock_quantity = (stock_quantity::bigint - v_stock.requested_quantity)::integer
      where id = v_stock.variant_id;
    end if;
  end loop;

  perform public.deduct_order_stock_pools(v_order_id, p_store_id, p_organization_id, null);

  return v_order_id;
end;
$$;

revoke all on function public.create_qr_order_with_items(uuid, uuid, uuid, text, numeric, jsonb) from public;
revoke execute on function public.create_qr_order_with_items(uuid, uuid, uuid, text, numeric, jsonb) from anon, authenticated;
grant execute on function public.create_qr_order_with_items(uuid, uuid, uuid, text, numeric, jsonb) to service_role;

create or replace function public.close_pos_order_payment(
  p_order_id uuid,
  p_store_id uuid,
  p_processed_by_user_id uuid,
  p_method text,
  p_amount numeric,
  p_received_amount numeric default null,
  p_change_amount numeric default null,
  p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_payment_id uuid;
  v_category public.accounting_categories%rowtype;
  v_transaction_id uuid;
  v_previous_balance numeric := 0;
  v_net_cash numeric;
  v_open_cash_session_id uuid;
  v_now timestamptz := now();
  v_stock record;
  v_variant public.product_variants%rowtype;
begin
  select *
  into v_order
  from public.orders
  where id = p_order_id
    and store_id = p_store_id
    and status in ('pending_payment', 'open')
  for update;

  if not found then
    raise exception 'ออร์เดอร์นี้ไม่สามารถชำระได้';
  end if;

  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนชำระเงิน';
  end if;

  if p_processed_by_user_id is distinct from auth.uid() then
    raise exception 'ผู้ชำระเงินไม่ถูกต้อง';
  end if;

  if not public.auth_user_has_permission(v_order.organization_id, p_store_id, 'pos.use') then
    raise exception 'ไม่มีสิทธิ์ชำระเงินออร์เดอร์นี้';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'ยอดชำระไม่ถูกต้อง';
  end if;

  if p_amount is distinct from v_order.total then
    raise exception 'ยอดชำระไม่ตรงกับยอดออร์เดอร์';
  end if;

  if p_method = 'cash' then
    if not public.auth_user_has_permission(v_order.organization_id, p_store_id, 'cashflow.record') then
      raise exception 'ไม่มีสิทธิ์รับเงินสด';
    end if;

    if coalesce(p_received_amount, p_amount) < p_amount then
      raise exception 'เงินสดที่รับไม่พอ';
    end if;

    if coalesce(p_change_amount, 0) < 0 then
      raise exception 'เงินทอนไม่ถูกต้อง';
    end if;

    v_net_cash := coalesce(p_received_amount, p_amount) - coalesce(p_change_amount, 0);

    if v_net_cash is distinct from p_amount then
      raise exception 'ยอดเงินสดไม่ตรงกับยอดขาย';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 0));

    select id
    into v_open_cash_session_id
    from public.cash_sessions
    where organization_id = v_order.organization_id
      and store_id = p_store_id
      and status = 'open'
    order by opened_at desc
    limit 1
    for update;

    if not found then
      raise exception 'ต้องเปิดรอบเงินสดก่อนรับเงินสด';
    end if;
  end if;

  -- QR orders are deducted by create_qr_order_with_items. POS orders snapshot
  -- and deduct only while closing payment.
  if not coalesce(v_order.qr_order_source, false) then
    perform public.snapshot_order_item_stock_pools(
      p_order_id,
      p_store_id,
      v_order.organization_id
    );

    -- Preserve legacy no-link stock, locking Variants before Stock Pools.
    for v_stock in
      select
        oi.variant_id,
        sum(
          oi.quantity::bigint * coalesce(oi.unit_quantity, 1)::bigint
        ) as requested_quantity
      from public.order_items oi
      where oi.order_id = p_order_id
        and oi.variant_id is not null
        and oi.stock_pool_id is null
        and coalesce(oi.voided, false) = false
      group by oi.variant_id
      order by oi.variant_id
    loop
      if v_stock.requested_quantity <= 0 or v_stock.requested_quantity > 2147483647 then
        raise exception 'จำนวนสินค้าที่ต้องตัดเกินช่วงที่รองรับ';
      end if;

      select pv.*
      into v_variant
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
      where pv.id = v_stock.variant_id
        and p.organization_id = v_order.organization_id
        and p.store_id = p_store_id
      for update of pv;

      if not found then
        raise exception 'สินค้าไม่ถูกต้อง';
      end if;

      if v_variant.track_stock then
        if v_variant.stock_quantity is null
          or v_variant.stock_quantity::bigint < v_stock.requested_quantity then
          raise exception 'สินค้าเหลือไม่พอ';
        end if;

        update public.product_variants
        set stock_quantity = (stock_quantity::bigint - v_stock.requested_quantity)::integer
        where id = v_stock.variant_id;
      end if;
    end loop;

    perform public.deduct_order_stock_pools(
      p_order_id,
      p_store_id,
      v_order.organization_id,
      p_processed_by_user_id
    );
  end if;

  update public.orders
  set status = 'paid',
      paid_at = v_now
  where id = p_order_id;

  insert into public.payments (
    order_id,
    method,
    amount,
    status,
    received_amount,
    change_amount,
    reference,
    processed_by_user_id
  ) values (
    p_order_id,
    p_method,
    p_amount,
    'completed',
    p_received_amount,
    p_change_amount,
    p_reference,
    p_processed_by_user_id
  )
  returning id into v_payment_id;

  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 2));

  select *
  into v_category
  from public.accounting_categories
  where store_id = p_store_id
    and type = 'income'
    and name = 'ยอดขาย POS'
  order by sort_order, name
  limit 1;

  if not found then
    insert into public.accounting_categories (
      organization_id,
      store_id,
      name,
      type,
      is_default,
      sort_order
    ) values (
      v_order.organization_id,
      p_store_id,
      'ยอดขาย POS',
      'income',
      true,
      0
    )
    returning * into v_category;
  end if;

  insert into public.transactions (
    organization_id,
    store_id,
    type,
    category_id,
    category_name,
    amount,
    note,
    date,
    created_by_user_id,
    order_id
  ) values (
    v_order.organization_id,
    p_store_id,
    'income',
    v_category.id,
    v_category.name,
    p_amount,
    'POS ' || p_order_id::text,
    (v_now at time zone 'UTC')::date,
    p_processed_by_user_id,
    p_order_id
  )
  returning id into v_transaction_id;

  if p_method = 'cash' then
    select balance_after
    into v_previous_balance
    from public.cash_ledger_entries
    where store_id = p_store_id
    order by created_at desc
    limit 1;

    insert into public.cash_ledger_entries (
      organization_id,
      store_id,
      type,
      amount,
      balance_after,
      transaction_id,
      order_id,
      created_by_user_id
    ) values (
      v_order.organization_id,
      p_store_id,
      'pos_sale',
      v_net_cash,
      coalesce(v_previous_balance, 0) + v_net_cash,
      v_transaction_id,
      p_order_id,
      p_processed_by_user_id
    );
  end if;

  return v_payment_id;
end;
$$;

revoke all on function public.close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) from public;
revoke execute on function public.close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) from anon;
grant execute on function public.close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) to authenticated;

create or replace function public.cancel_qr_order_by_customer(
  p_store_id uuid,
  p_table_id uuid,
  p_order_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_stock record;
  v_variant public.product_variants%rowtype;
begin
  select *
  into v_order
  from public.orders
  where id = p_order_id
    and store_id = p_store_id
    and table_id = p_table_id
  for update;

  if not found then
    raise exception 'ไม่พบออเดอร์';
  end if;
  if not coalesce(v_order.qr_order_source, false) then
    raise exception 'ยกเลิกได้เฉพาะออเดอร์ที่สั่งผ่าน QR';
  end if;
  if v_order.status = 'cancelled' then
    return;
  end if;
  if v_order.status <> 'open' then
    raise exception 'ออเดอร์นี้ยกเลิกไม่ได้';
  end if;
  if v_order.prep_status <> 'new' then
    raise exception 'ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้';
  end if;

  -- Restore legacy no-link Variants first so lock order remains Variant -> Pool.
  for v_stock in
    select
      oi.variant_id,
      sum(
        oi.quantity::bigint * coalesce(oi.unit_quantity, 1)::bigint
      ) as restore_quantity
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.variant_id is not null
      and oi.stock_pool_id is null
      and coalesce(oi.voided, false) = false
    group by oi.variant_id
    order by oi.variant_id
  loop
    if v_stock.restore_quantity <= 0 or v_stock.restore_quantity > 2147483647 then
      raise exception 'จำนวนสินค้าที่ต้องคืนเกินช่วงที่รองรับ';
    end if;

    select pv.*
    into v_variant
    from public.product_variants pv
    join public.products p on p.id = pv.product_id
    where pv.id = v_stock.variant_id
      and p.organization_id = v_order.organization_id
      and p.store_id = p_store_id
    for update of pv;

    if not found then
      raise exception 'สินค้าไม่ถูกต้อง';
    end if;

    if v_variant.track_stock then
      if coalesce(v_variant.stock_quantity, 0)::bigint + v_stock.restore_quantity > 2147483647 then
        raise exception 'ยอดสินค้าหลังคืนเกินช่วงที่รองรับ';
      end if;

      update public.product_variants
      set stock_quantity = (coalesce(stock_quantity, 0)::bigint + v_stock.restore_quantity)::integer
      where id = v_stock.variant_id;
    end if;
  end loop;

  perform public.restore_cancelled_order_stock_pools(
    p_order_id,
    p_store_id,
    v_order.organization_id,
    null
  );

  update public.orders
  set status = 'cancelled',
      updated_at = now()
  where id = p_order_id;
end;
$$;

revoke all on function public.cancel_qr_order_by_customer(uuid, uuid, uuid) from public;
revoke execute on function public.cancel_qr_order_by_customer(uuid, uuid, uuid) from anon, authenticated;
grant execute on function public.cancel_qr_order_by_customer(uuid, uuid, uuid) to service_role;


-- Per-item Pool restore helper. void_qr_order_item ถูก 20260901000004 เขียนใหม่เป็น
-- wrapper ของ Unified POS ไปแล้ว migration นี้จึงห้ามนิยามทับ (จะย้อน Unified POS
-- ของร้านนำร่อง) — แยกตรรกะคืนสต๊อกรายรายการมาเป็น helper ให้ทั้งเส้นทาง legacy
-- และ unified_pos_reject_order_item เรียกใช้ร่วมกันแทน (ดู 20260905000006)
-- คืนค่า true = รายการนี้ "อยู่ใต้การดูแลของ Pool" ผู้เรียกห้ามแตะ Variant stock
-- (true ได้แม้ไม่ได้คืนจริง เช่น บิลพนักงานที่ยังไม่ชำระ = ยังไม่เคยตัด Pool)
create or replace function public.restore_voided_order_item_stock_pool(
  p_order_id uuid,
  p_item_id uuid,
  p_store_id uuid,
  p_organization_id uuid,
  p_reason text default null,
  p_actor_id uuid default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.order_items%rowtype;
  v_pool public.stock_pools%rowtype;
  v_restore_units numeric;
  v_after integer;
begin
  select *
  into v_item
  from public.order_items
  where id = p_item_id
    and order_id = p_order_id
  for update;

  if not found then
    raise exception 'ไม่พบรายการ';
  end if;

  if v_item.stock_pool_id is null then
    return false;
  end if;

  -- ผู้เรียกทุกตัวล็อกและเช็ค voided มาก่อนแล้ว — กันไว้อีกชั้นให้เรียกซ้ำเป็น no-op
  if v_item.voided then return true; end if;

  v_restore_units := v_item.quantity::numeric
    * coalesce(v_item.unit_quantity, 1)::numeric
    * v_item.stock_units_per_item::numeric;

  if v_restore_units <= 0 or v_restore_units > 2147483647 then
    raise exception 'จำนวน Stock Pool ที่ต้องคืนเกินช่วงที่รองรับ';
  end if;

  select sp.*
  into v_pool
  from public.stock_pools sp
  where sp.id = v_item.stock_pool_id
  for update;

  if not found
    or v_pool.store_id is distinct from p_store_id
    or v_pool.organization_id is distinct from p_organization_id then
    raise exception 'Stock Pool ของรายการไม่ถูกต้อง';
  end if;

  -- ยังไม่เคยตัด Pool ของออร์เดอร์นี้ (บิลพนักงานที่ยังไม่ชำระ — ตัดตอนชำระ) →
  -- ไม่มีอะไรให้คืน แต่ยังถือว่าเป็นรายการของ Pool เพื่อกันผู้เรียกไปคืน Variant ซ้ำ
  if not exists (
    select 1
    from public.stock_movements sm
    where sm.stock_pool_id = v_pool.id
      and sm.movement_type = 'sale'
      and sm.reference_type = 'order'
      and sm.reference_id = p_order_id
  ) and not exists (
    select 1
    from public.order_item_stock_pool_cutover_provenance cp
    where cp.order_id = p_order_id
      and cp.stock_pool_id = v_pool.id
  ) then
    return true;
  end if;

  perform public.assert_order_stock_pool_restore_provenance(
    p_order_id,
    v_pool.id,
    v_restore_units,
    false,
    p_item_id
  );

  if exists (
    select 1
    from public.stock_movements sm
    where sm.stock_pool_id = v_pool.id
      and sm.movement_type = 'item_void_restore'
      and sm.reference_type = 'order_item'
      and sm.reference_id = p_item_id
  ) then
    raise exception 'รายการนี้คืน Stock Pool แล้ว';
  end if;

  if v_pool.quantity::bigint + v_restore_units > 2147483647 then
    raise exception 'ยอด Stock Pool หลังคืนเกินช่วงที่รองรับ';
  end if;

  v_after := (v_pool.quantity::bigint + v_restore_units)::integer;

  update public.stock_pools
  set quantity = v_after,
      updated_at = now()
  where id = v_pool.id;

  insert into public.stock_movements (
    stock_pool_id,
    movement_type,
    quantity_delta,
    before_quantity,
    after_quantity,
    reason,
    reference_type,
    reference_id,
    actor_id
  ) values (
    v_pool.id,
    'item_void_restore',
    v_restore_units::integer,
    v_pool.quantity,
    v_after,
    coalesce(nullif(btrim(p_reason), ''), 'QR order item void'),
    'order_item',
    p_item_id,
    coalesce(p_actor_id, auth.uid())
  );

  return true;
end;
$$;

revoke all on function public.restore_voided_order_item_stock_pool(uuid, uuid, uuid, uuid, text, uuid) from public;
revoke execute on function public.restore_voided_order_item_stock_pool(uuid, uuid, uuid, uuid, text, uuid) from anon, authenticated;

commit;
