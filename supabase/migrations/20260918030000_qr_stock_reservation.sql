-- จองสต๊อกออเดอร์ QR จนกว่าครัวจะรับ (ร้านที่ไม่ได้เปิด unified_pos_enabled)
--
-- เดิม: create_qr_order_with_items ตัดสต๊อกจริงทันทีที่ลูกค้ากดสั่ง
-- ใหม่: ลูกค้าสั่ง = "จอง" (reserved) → ยอดพร้อมขาย = สต๊อก − ยอดจอง ลดทันที (หน้าลูกค้า/POS เห็น)
--       ครัวรับออเดอร์ (prep_status ออกจาก 'new') หรือชำระเงิน = ตัดสต๊อกจริง
--       ลูกค้ายกเลิก / ครัวปฏิเสธก่อนรับ = คืนยอดจอง (ไม่แตะสต๊อกจริง)
--
-- orders.stock_state: null = ออเดอร์เดิม/ออเดอร์ POS (พฤติกรรมเดิม 100%)
--                     reserved → committed | released
-- Unified POS ใช้ RPC ของตัวเอง (create_qr_order_with_items_v2 / unified_pos_*) ไม่ถูกเปลี่ยน
-- additive: ไม่แตะออเดอร์ที่เปิดค้างอยู่ (stock_state = null ตัดไปแล้วตามเดิม)

alter table public.product_variants
  add column if not exists reserved_quantity integer not null default 0;
alter table public.product_variants
  drop constraint if exists product_variants_reserved_quantity_check;
alter table public.product_variants
  add constraint product_variants_reserved_quantity_check check (reserved_quantity >= 0);

alter table public.stock_pools
  add column if not exists reserved_units integer not null default 0;
alter table public.stock_pools
  drop constraint if exists stock_pools_reserved_units_check;
alter table public.stock_pools
  add constraint stock_pools_reserved_units_check check (reserved_units >= 0);

alter table public.orders
  add column if not exists stock_state text;
alter table public.orders
  drop constraint if exists orders_stock_state_check;
alter table public.orders
  add constraint orders_stock_state_check
  check (stock_state is null or stock_state in ('reserved', 'committed', 'released'));

-- ---------------------------------------------------------------------------
-- จองสต๊อกของทั้งออเดอร์ (Variant ก่อน Pool — ลำดับล็อกเดียวกับของเดิม)
-- ---------------------------------------------------------------------------
create or replace function public.qr_reserve_order_stock(
  p_order_id uuid,
  p_store_id uuid,
  p_organization_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stock record;
  v_variant public.product_variants%rowtype;
  v_pool public.stock_pools%rowtype;
begin
  for v_stock in
    select
      oi.variant_id,
      sum(oi.quantity::bigint * coalesce(oi.unit_quantity, 1)::bigint) as requested_quantity
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.variant_id is not null
      and oi.stock_pool_id is null
      and coalesce(oi.voided, false) = false
    group by oi.variant_id
    order by oi.variant_id
  loop
    if v_stock.requested_quantity <= 0 or v_stock.requested_quantity > 2147483647 then
      raise exception 'จำนวนสินค้าที่ต้องจองเกินช่วงที่รองรับ';
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
        or v_variant.stock_quantity::bigint - v_variant.reserved_quantity::bigint < v_stock.requested_quantity then
        raise exception 'สินค้าเหลือไม่พอ';
      end if;

      update public.product_variants
      set reserved_quantity = (reserved_quantity::bigint + v_stock.requested_quantity)::integer
      where id = v_stock.variant_id;
    end if;
  end loop;

  for v_stock in
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
    if v_stock.required_units is null
      or v_stock.required_units <= 0
      or v_stock.required_units > 2147483647 then
      raise exception 'จำนวน Stock Pool ที่ต้องจองเกินช่วงที่รองรับ';
    end if;

    select sp.*
    into v_pool
    from public.stock_pools sp
    where sp.id = v_stock.stock_pool_id
    for update;

    if not found
      or v_pool.store_id is distinct from p_store_id
      or v_pool.organization_id is distinct from p_organization_id then
      raise exception 'Stock Pool ของออร์เดอร์ไม่ถูกต้อง';
    end if;

    if v_pool.quantity::bigint - v_pool.reserved_units::bigint < v_stock.required_units then
      raise exception 'สต๊อกไม่เพียงพอ';
    end if;

    update public.stock_pools
    set reserved_units = (reserved_units::bigint + v_stock.required_units)::integer,
        updated_at = now()
    where id = v_pool.id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- คืนยอดจอง: ทั้งออเดอร์ (รายการที่ยังไม่ void) หรือเฉพาะบรรทัด p_item_id
-- (เรียกก่อน mark voided) — greatest(0, …) กันยอดจองติดลบจากข้อมูลเพี้ยน
-- ---------------------------------------------------------------------------
create or replace function public.qr_release_order_stock(
  p_order_id uuid,
  p_store_id uuid,
  p_organization_id uuid,
  p_item_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stock record;
begin
  for v_stock in
    select
      oi.variant_id,
      sum(oi.quantity::bigint * coalesce(oi.unit_quantity, 1)::bigint) as qty
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.variant_id is not null
      and oi.stock_pool_id is null
      and coalesce(oi.voided, false) = false
      and (p_item_id is null or oi.id = p_item_id)
    group by oi.variant_id
    order by oi.variant_id
  loop
    update public.product_variants pv
    set reserved_quantity = greatest(0, pv.reserved_quantity::bigint - v_stock.qty)::integer
    from public.products p
    where pv.id = v_stock.variant_id
      and p.id = pv.product_id
      and p.organization_id = p_organization_id
      and p.store_id = p_store_id
      and pv.track_stock = true;
  end loop;

  for v_stock in
    select
      oi.stock_pool_id,
      sum(
        oi.quantity::numeric
          * coalesce(oi.unit_quantity, 1)::numeric
          * oi.stock_units_per_item::numeric
      ) as units
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.stock_pool_id is not null
      and coalesce(oi.voided, false) = false
      and (p_item_id is null or oi.id = p_item_id)
    group by oi.stock_pool_id
    order by oi.stock_pool_id
  loop
    update public.stock_pools sp
    set reserved_units = greatest(0, sp.reserved_units::numeric - v_stock.units)::integer,
        updated_at = now()
    where sp.id = v_stock.stock_pool_id
      and sp.store_id = p_store_id
      and sp.organization_id = p_organization_id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- ตัดสต๊อกจริงของออเดอร์ที่จองไว้: คืนยอดจองของตัวเองก่อน แล้วตัดตามเส้นทางเดิม
-- (Variant ที่ไม่ผูก Pool + deduct_order_stock_pools ซึ่งบันทึก movement 'sale'
--  → การคืนสต๊อกตอน void หลังรับยังใช้ provenance เดิมได้)
-- ---------------------------------------------------------------------------
create or replace function public.qr_commit_order_stock(
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
  v_stock record;
  v_variant public.product_variants%rowtype;
begin
  perform public.qr_release_order_stock(p_order_id, p_store_id, p_organization_id, null);

  for v_stock in
    select
      oi.variant_id,
      sum(oi.quantity::bigint * coalesce(oi.unit_quantity, 1)::bigint) as requested_quantity
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.variant_id is not null
      and oi.stock_pool_id is null
      and coalesce(oi.voided, false) = false
    group by oi.variant_id
    order by oi.variant_id
  loop
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
        or v_variant.stock_quantity::bigint - v_variant.reserved_quantity::bigint < v_stock.requested_quantity then
        raise exception 'สินค้าเหลือไม่พอ';
      end if;

      update public.product_variants
      set stock_quantity = (stock_quantity::bigint - v_stock.requested_quantity)::integer
      where id = v_stock.variant_id;
    end if;
  end loop;

  perform public.deduct_order_stock_pools(p_order_id, p_store_id, p_organization_id, p_actor_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- จุดเดียวที่เปลี่ยนสถานะสต๊อกของออเดอร์ที่จองไว้ ไม่ว่าจะมาจากเส้นทางไหน
-- (บอร์ดครัวอัปเดต prep_status ตรง, close_pos_order_payment, cancel, void ทั้งใบ)
-- ---------------------------------------------------------------------------
create or replace function public.qr_order_stock_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.stock_state is distinct from 'reserved' then
    return new;
  end if;

  if new.status in ('cancelled', 'voided') then
    perform public.qr_release_order_stock(new.id, new.store_id, new.organization_id, null);
    new.stock_state := 'released';
  elsif new.status = 'paid'
    or (old.prep_status = 'new' and new.prep_status is distinct from 'new') then
    perform public.qr_commit_order_stock(new.id, new.store_id, new.organization_id, auth.uid());
    new.stock_state := 'committed';
  end if;

  return new;
end;
$$;

drop trigger if exists qr_order_stock_lifecycle on public.orders;
create trigger qr_order_stock_lifecycle
  before update of status, prep_status on public.orders
  for each row
  when (old.stock_state = 'reserved')
  execute function public.qr_order_stock_lifecycle();

revoke all on function public.qr_reserve_order_stock(uuid, uuid, uuid) from public;
revoke execute on function public.qr_reserve_order_stock(uuid, uuid, uuid) from anon, authenticated;
revoke all on function public.qr_release_order_stock(uuid, uuid, uuid, uuid) from public;
revoke execute on function public.qr_release_order_stock(uuid, uuid, uuid, uuid) from anon, authenticated;
revoke all on function public.qr_commit_order_stock(uuid, uuid, uuid, uuid) from public;
revoke execute on function public.qr_commit_order_stock(uuid, uuid, uuid, uuid) from anon, authenticated;
revoke all on function public.qr_order_stock_lifecycle() from public;
revoke execute on function public.qr_order_stock_lifecycle() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- เส้นทางเดิมที่ต้องเคารพยอดจอง
-- ---------------------------------------------------------------------------
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

    -- ยอดที่จองให้ออเดอร์ QR อื่นขายซ้ำไม่ได้
    if v_pool.quantity::bigint - coalesce(v_pool.reserved_units, 0) < v_demand.required_units then
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
    qr_order_source,
    stock_state
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
    true,
    'reserved'
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

  -- จองสต๊อก (ยังไม่ตัดจริง) — ตัดจริงเมื่อครัวรับออเดอร์ / ชำระเงิน ผ่าน trigger
  -- qr_order_stock_lifecycle; ยกเลิก/ปฏิเสธก่อนรับ = คืนยอดจอง
  perform public.qr_reserve_order_stock(v_order_id, p_store_id, p_organization_id);

  return v_order_id;
end;
$$;

CREATE OR REPLACE FUNCTION public.close_pos_order_payment(p_order_id uuid, p_store_id uuid, p_processed_by_user_id uuid, p_method text, p_amount numeric, p_received_amount numeric DEFAULT NULL::numeric, p_change_amount numeric DEFAULT NULL::numeric, p_reference text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
          or v_variant.stock_quantity::bigint - coalesce(v_variant.reserved_quantity, 0) < v_stock.requested_quantity then
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
$function$;

CREATE OR REPLACE FUNCTION public.cancel_qr_order_by_customer(p_store_id uuid, p_table_id uuid, p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- ออเดอร์ที่ยังจองสต๊อกอยู่: ไม่มีอะไรถูกตัดจริง → เปลี่ยนสถานะอย่างเดียว
  -- trigger qr_order_stock_lifecycle คืนยอดจองให้ใน transaction เดียวกัน
  if v_order.stock_state = 'reserved' then
    update public.orders
    set status = 'cancelled',
        updated_at = now()
    where id = p_order_id;
    return;
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
$function$;

CREATE OR REPLACE FUNCTION public.void_qr_order_item(p_store_id uuid, p_order_id uuid, p_item_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_flag boolean;
  v_status text;
  v_qr boolean;
  v_variant uuid;
  v_qty integer;
  v_remaining integer;
  v_subtotal numeric;
  v_outcome jsonb;
  v_operation_key text;
  v_pool_managed boolean := false;
  v_request_hash text;
  v_stock_state text;
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  -- gating: อ่าน flag ของร้านก่อนเลือกเส้นทาง
  select organization_id, coalesce(unified_pos_enabled, false)
    into v_org, v_flag
    from stores
   where id = p_store_id;
  if not found then
    raise exception 'ไม่พบออเดอร์';
  end if;

  -- ---------- เส้นทาง canonical (ร้านเปิด unified_pos_enabled) ----------
  if v_flag then
    v_operation_key := 'legacy_void:' || p_item_id::text;
    v_request_hash := md5(
      'void_item:' || p_store_id::text || ':' || p_order_id::text || ':' ||
      p_item_id::text || ':' || coalesce(p_reason, '') || ':' || v_actor::text
    );
    v_outcome := public.unified_pos_reject_order_item(
      v_org, p_store_id, p_order_id, p_item_id,
      v_operation_key, v_request_hash, v_actor, p_reason
    );
    case v_outcome ->> 'status'
      when 'executed' then
        return;
      when 'replayed' then
        -- retry ของคำขอ void เดิม (same key + same hash) → ถือว่าสำเร็จแบบ idempotent
        return;
      when 'hash_conflict' then
        raise exception 'คำขอยกเลิกรายการขัดแย้งกัน กรุณารีเฟรชหน้าจอ';
      else
        raise exception '%', coalesce(v_outcome ->> 'message', 'ยกเลิกรายการไม่สำเร็จ');
    end case;
  end if;

  -- ---------- เส้นทาง legacy (ร้านปิด flag — body เดิมจาก 20260701000002) ----------
  select organization_id, status, qr_order_source, stock_state
    into v_org, v_status, v_qr, v_stock_state
    from orders
   where id = p_order_id and store_id = p_store_id
   for update;
  if not found then
    raise exception 'ไม่พบออเดอร์';
  end if;
  if not auth_user_role_in_store(v_org, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์จัดการออเดอร์';
  end if;
  if not coalesce(v_qr, false) then
    raise exception 'เฉพาะออเดอร์ที่สั่งผ่าน QR';
  end if;
  if v_status <> 'open' then
    raise exception 'ออเดอร์นี้แก้ไขไม่ได้';
  end if;

  select variant_id, quantity
    into v_variant, v_qty
    from order_items
   where id = p_item_id and order_id = p_order_id and voided = false;
  if not found then
    raise exception 'ไม่พบรายการ';
  end if;

  if v_stock_state = 'reserved' then
    -- ครัวยังไม่รับ: สต๊อกยังไม่ถูกตัดจริง → คืนเฉพาะยอดจองของบรรทัดนี้
    perform public.qr_release_order_stock(p_order_id, p_store_id, v_org, p_item_id);
  else
    -- Stock Pool มาก่อน: รายการที่ผูก Pool ห้ามคืน Variant stock (จะคืนซ้ำ)
    v_pool_managed := public.restore_voided_order_item_stock_pool(
      p_order_id, p_item_id, p_store_id, v_org, p_reason, v_actor
    );

    -- Restore the stock deducted at order creation.
    if v_variant is not null and not v_pool_managed then
      update product_variants
         set stock_quantity = coalesce(stock_quantity, 0) + v_qty
       where id = v_variant and track_stock = true;
    end if;
  end if;

  update order_items
     set voided = true, voided_reason = p_reason
   where id = p_item_id;

  -- Recompute order totals from the remaining (non-voided) lines.
  select count(*), coalesce(sum(total_price), 0)
    into v_remaining, v_subtotal
    from order_items
   where order_id = p_order_id and voided = false;

  update orders
     set subtotal = round(v_subtotal, 2),
         total = round(v_subtotal, 2),
         updated_at = now()
   where id = p_order_id;

  -- Nothing left to make — cancel the whole order.
  if v_remaining = 0 then
    update orders set status = 'cancelled', updated_at = now() where id = p_order_id;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- หน้าลูกค้า QR: ขาย variant ที่ผูก Stock Pool ได้อีกกี่ชิ้น (หักยอดจองแล้ว)
-- ลูกค้า (anon) อ่านตาราง Pool ตรงไม่ได้ — คืนเฉพาะตัวเลขของเมนู QR ที่เปิดขายอยู่
-- ไม่คืนชื่อ/ยอด Pool
-- ---------------------------------------------------------------------------
create or replace function public.qr_menu_pool_availability(p_store_id uuid)
returns table (variant_id uuid, sellable_units integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    l.variant_id,
    greatest(0, floor((sp.quantity - sp.reserved_units)::numeric / l.consumption_quantity))::integer
  from public.variant_stock_links l
  join public.stock_pools sp on sp.id = l.stock_pool_id
  join public.product_variants pv on pv.id = l.variant_id
  join public.products p on p.id = pv.product_id
  join public.stores s on s.id = p.store_id
  where p.store_id = p_store_id
    and sp.store_id = p_store_id
    and s.is_active = true
    and s.qr_ordering_enabled = true
    and p.is_active = true
    and p.available_for_qr = true
    and pv.is_active = true
    and l.consumption_quantity > 0;
$$;

revoke all on function public.qr_menu_pool_availability(uuid) from public;
grant execute on function public.qr_menu_pool_availability(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- ครัวปฏิเสธทั้งออเดอร์ใน transaction เดียว — ปฏิเสธทุกรายการผ่าน void_qr_order_item
-- (คืนยอดจอง/สต๊อกตามสถานะ + recompute + ยกเลิกออเดอร์เมื่อไม่เหลือรายการ)
-- รายการไหนล้ม = ย้อนทั้งหมด ไม่มีปฏิเสธครึ่งออเดอร์ · ออเดอร์ที่ยกเลิกแล้ว = สำเร็จ (retry ได้)
-- ---------------------------------------------------------------------------
create or replace function public.reject_qr_order(
  p_store_id uuid,
  p_order_id uuid,
  p_reason text default null
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and store_id = p_store_id
  for update;
  if not found then
    raise exception 'ไม่พบออเดอร์';
  end if;
  if not public.auth_user_role_in_store(v_order.organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์จัดการออเดอร์';
  end if;
  if v_order.status = 'cancelled' then
    return 0;
  end if;
  if not coalesce(v_order.qr_order_source, false) or v_order.status <> 'open' then
    raise exception 'ออเดอร์นี้ปฏิเสธไม่ได้';
  end if;

  for v_item in
    select id from public.order_items
    where order_id = p_order_id and coalesce(voided, false) = false
    order by id
  loop
    perform public.void_qr_order_item(p_store_id, p_order_id, v_item.id, p_reason);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.reject_qr_order(uuid, uuid, text) from public, anon;
grant execute on function public.reject_qr_order(uuid, uuid, text) to authenticated;
