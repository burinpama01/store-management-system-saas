-- บิลรวมโต๊ะ: 1 โต๊ะ = 1 บิล = 1 การจ่าย (แผน QR Order Table Ticket Plan v4 — PR B)
--
-- 1) เปิดโต๊ะที่ POS แล้วเปิดตั๋วของโต๊ะรอไว้ (stores.table_open_auto_ticket)
--    ตั๋วอัตโนมัติ 1 ใบต่อโต๊ะ บังคับด้วย unique index + RPC ensure_table_auto_ticket (atomic)
-- 2) consolidate_table_bill: รวมทุกออเดอร์ QR ที่เปิดอยู่ของโต๊ะ + ออเดอร์ POS จากตั๋ว
--    เป็นออเดอร์เดียว แล้วชำระผ่านหน้าจ่ายเงินปกติของ POS (Beam/เงินสด 1 การจ่าย : 1 ออเดอร์)
--    - ห้ามรวมถ้ามีออเดอร์ที่ครัวยังไม่รับ (stock_state = reserved)
--    - รายการจากตั๋วตัดสต๊อกตอนรวมบิล (ออเดอร์บิลรวมเป็น qr_order_source → จ่ายแล้วไม่ตัดซ้ำ)
--    - ย้าย order_items ไปที่ออเดอร์บิลรวม; ไม่แก้ ledger — sale movement ยังอ้างออเดอร์ต้นทาง
--      (ออเดอร์ต้นทาง → cancelled + merged_into_order_id) provenance การคืน Stock Pool
--      ตามผ่าน order_stock_reference_ids()
-- additive ทั้งหมด

alter table public.stores
  add column if not exists table_open_auto_ticket boolean not null default true;

alter table public.pos_saved_tickets
  add column if not exists ticket_source text not null default 'manual';
alter table public.pos_saved_tickets
  drop constraint if exists pos_saved_tickets_ticket_source_check;
alter table public.pos_saved_tickets
  add constraint pos_saved_tickets_ticket_source_check check (ticket_source in ('manual', 'table_auto'));
create unique index if not exists pos_saved_tickets_one_table_auto
  on public.pos_saved_tickets (store_id, table_id)
  where ticket_source = 'table_auto';

alter table public.orders
  add column if not exists merged_into_order_id uuid references public.orders(id) on delete set null;
alter table public.orders
  add column if not exists table_bill_key text;
create unique index if not exists orders_table_bill_key_unique
  on public.orders (store_id, table_bill_key)
  where table_bill_key is not null;
create index if not exists orders_merged_into_order_id_idx
  on public.orders (merged_into_order_id)
  where merged_into_order_id is not null;

-- ---------------------------------------------------------------------------
-- ตั๋วอัตโนมัติของโต๊ะ: สร้างถ้ายังไม่มี / คืนใบเดิม — ปลอดภัยเมื่อเปิดโต๊ะพร้อมกันหลายเครื่อง
-- security invoker: ใช้ RLS เดิมของ pos_saved_tickets (cashier+ สร้างได้)
-- ---------------------------------------------------------------------------
create or replace function public.ensure_table_auto_ticket(
  p_ticket_id uuid,
  p_organization_id uuid,
  p_store_id uuid,
  p_table_id uuid,
  p_ticket_number text,
  p_label text,
  p_table_number text,
  p_cart jsonb
) returns setof public.pos_saved_tickets
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  insert into public.pos_saved_tickets (
    id, organization_id, store_id, ticket_number, label, cart_snapshot,
    created_by_user_id, updated_by_user_id, table_id, table_number, ticket_source
  ) values (
    p_ticket_id, p_organization_id, p_store_id, p_ticket_number, p_label, p_cart,
    auth.uid(), auth.uid(), p_table_id, p_table_number, 'table_auto'
  )
  on conflict (store_id, table_id) where ticket_source = 'table_auto' do nothing;

  return query
    select t.*
    from public.pos_saved_tickets t
    where t.store_id = p_store_id
      and t.table_id = p_table_id
      and t.ticket_source = 'table_auto';
end;
$$;

revoke all on function public.ensure_table_auto_ticket(uuid, uuid, uuid, uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.ensure_table_auto_ticket(uuid, uuid, uuid, uuid, text, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- ตัดสต๊อกจริงของออเดอร์ทันที (Variant ที่ไม่ผูก Pool + deduct_order_stock_pools)
-- แยกจากการคืนยอดจอง เพื่อใช้ได้กับออเดอร์ POS ที่ไม่เคยจอง
-- ---------------------------------------------------------------------------
create or replace function public.commit_order_stock_now(
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
begin
  perform public.qr_release_order_stock(p_order_id, p_store_id, p_organization_id, null);
  perform public.commit_order_stock_now(p_order_id, p_store_id, p_organization_id, p_actor_id);
end;
$$;

revoke all on function public.commit_order_stock_now(uuid, uuid, uuid, uuid) from public;
revoke execute on function public.commit_order_stock_now(uuid, uuid, uuid, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- รวมบิลโต๊ะเป็นออเดอร์เดียว (idempotent ด้วย p_table_bill_key)
-- ---------------------------------------------------------------------------
create or replace function public.consolidate_table_bill(
  p_store_id uuid,
  p_table_id uuid,
  p_table_bill_key text,
  p_order_number text,
  p_pos_order_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_table_number text;
  v_existing uuid;
  v_target uuid;
  v_sources uuid[];
  v_qr_sources uuid[];
  v_pos public.orders%rowtype;
  v_prep text;
  v_discount numeric := 0;
  v_subtotal numeric;
  v_rank integer;
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;
  if p_table_bill_key is null or length(p_table_bill_key) < 8 or length(p_table_bill_key) > 120 then
    raise exception 'คำขอรวมบิลไม่ถูกต้อง';
  end if;

  select organization_id into v_org
  from public.stores
  where id = p_store_id and is_active = true;
  if not found then
    raise exception 'ไม่พบร้าน';
  end if;
  if not public.auth_user_has_permission(v_org, p_store_id, 'pos.use') then
    raise exception 'ไม่มีสิทธิ์เช็คบิล';
  end if;

  -- replay ของคำขอเดิม
  select id into v_existing
  from public.orders
  where store_id = p_store_id and table_bill_key = p_table_bill_key;
  if found then
    return v_existing;
  end if;

  select number into v_table_number
  from public.tables
  where id = p_table_id and store_id = p_store_id
  for update;
  if not found then
    raise exception 'โต๊ะไม่ถูกต้อง';
  end if;

  -- ออเดอร์ QR ที่เปิดอยู่ของโต๊ะ (ล็อกไว้กันลูกค้าสั่ง/ยกเลิกแทรก)
  select coalesce(array_agg(o.id order by o.created_at), '{}')
  into v_qr_sources
  from (
    select id, created_at
    from public.orders
    where store_id = p_store_id
      and table_id = p_table_id
      and status = 'open'
      and qr_order_source = true
      and merged_into_order_id is null
    for update
  ) o;
  -- หมายเหตุ: บิลรวมที่ยังไม่จ่าย (เช่น พนักงานยกเลิกหน้าจ่ายเงิน) เป็นออเดอร์ QR-source เปิดอยู่
  -- จึงถูกรวมซ้ำได้ — provenance ตามต่อหลายชั้นผ่าน order_stock_reference_ids (recursive)

  if exists (
    select 1 from public.orders
    where id = any(v_qr_sources) and stock_state = 'reserved'
  ) then
    raise exception 'ยังมีออเดอร์ที่ครัวยังไม่รับ — รับหรือปฏิเสธก่อนเช็คบิล';
  end if;

  -- ออเดอร์ QR ยุคก่อน Stock Pool cutover ใช้ provenance แบบ marker ผูกกับออเดอร์เดิม ย้ายไม่ได้
  if exists (
    select 1 from public.order_item_stock_pool_cutover_provenance cp
    where cp.order_id = any(v_qr_sources)
  ) then
    raise exception 'มีออเดอร์เก่าก่อนระบบ Stock Pool — เช็คบิลแยกทีละออเดอร์';
  end if;

  v_sources := v_qr_sources;

  if p_pos_order_id is not null then
    select * into v_pos
    from public.orders
    where id = p_pos_order_id
      and store_id = p_store_id
      and table_id = p_table_id
      and status in ('open', 'pending_payment')
      and coalesce(qr_order_source, false) = false
      and merged_into_order_id is null
    for update;
    if not found then
      raise exception 'ออเดอร์จากตั๋วไม่ถูกต้อง';
    end if;

    -- รายการหน้าร้านตัดสต๊อกตอนรวมบิล (บิลรวมเป็น QR-source → ชำระแล้วไม่ตัดซ้ำ)
    perform public.snapshot_order_item_stock_pools(p_pos_order_id, p_store_id, v_org);
    perform public.commit_order_stock_now(p_pos_order_id, p_store_id, v_org, v_actor);
    v_discount := coalesce(v_pos.discount, 0);
    v_sources := v_sources || p_pos_order_id;
  end if;

  if coalesce(array_length(v_sources, 1), 0) = 0 then
    raise exception 'โต๊ะนี้ไม่มีรายการให้เช็คบิล';
  end if;

  -- สถานะครัวของบิลรวม = ออเดอร์ QR ที่ช้าที่สุด (ไม่มี QR = done)
  select min(case prep_status
      when 'new' then 1 when 'preparing' then 2 when 'ready' then 3
      when 'served' then 4 else 5 end)
  into v_rank
  from public.orders
  where id = any(v_qr_sources);
  v_prep := case coalesce(v_rank, 5)
    when 1 then 'new' when 2 then 'preparing' when 3 then 'ready'
    when 4 then 'served' else 'done' end;

  insert into public.orders (
    organization_id, store_id, order_number, status, table_id, table_number,
    cashier_id, subtotal, discount, total, qr_order_source, stock_state,
    prep_status, table_bill_key
  ) values (
    v_org, p_store_id, p_order_number, 'open', p_table_id, v_table_number,
    v_actor, 0, 0, 0, true, 'committed',
    v_prep, p_table_bill_key
  )
  returning id into v_target;

  update public.order_items
  set order_id = v_target
  where order_id = any(v_sources);

  -- ไม่แก้ ledger: sale movement ยังอ้างออเดอร์ต้นทาง — provenance ของบิลรวมตามผ่าน
  -- merged_into_order_id (order_stock_reference_ids)

  update public.orders
  set status = 'cancelled',
      merged_into_order_id = v_target,
      updated_at = now()
  where id = any(v_sources);

  select coalesce(sum(total_price), 0)
  into v_subtotal
  from public.order_items
  where order_id = v_target and coalesce(voided, false) = false;

  v_discount := least(greatest(v_discount, 0), v_subtotal);

  update public.orders
  set subtotal = round(v_subtotal, 2),
      discount = round(v_discount, 2),
      total = round(v_subtotal - v_discount, 2),
      updated_at = now()
  where id = v_target;

  return v_target;
end;
$$;

revoke all on function public.consolidate_table_bill(uuid, uuid, text, text, uuid) from public, anon;
grant execute on function public.consolidate_table_bill(uuid, uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- ออเดอร์ที่ sale movement ของออเดอร์นี้อาจอ้างถึง: ตัวมันเอง + ออเดอร์ที่ถูกรวมเข้ามา
-- ---------------------------------------------------------------------------
create or replace function public.order_stock_reference_ids(p_order_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with recursive chain(id) as (
    select p_order_id
    union
    select o.id from public.orders o join chain c on o.merged_into_order_id = c.id
  )
  select array_agg(id) from chain;
$fn$;

revoke all on function public.order_stock_reference_ids(uuid) from public;
revoke execute on function public.order_stock_reference_ids(uuid) from anon, authenticated;

-- คืน Stock Pool ของรายการที่ void: บิลรวมมองเห็นยอดตัดของออเดอร์ต้นทาง
CREATE OR REPLACE FUNCTION public.restore_voided_order_item_stock_pool(p_order_id uuid, p_item_id uuid, p_store_id uuid, p_organization_id uuid, p_reason text DEFAULT NULL::text, p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      and sm.reference_id = any(public.order_stock_reference_ids(p_order_id))
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
$function$;

-- ---------------------------------------------------------------------------
-- provenance การคืน Stock Pool: รองรับบิลรวม (ยอดตัดจากหลายออเดอร์ต้นทาง)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_order_stock_pool_restore_provenance(p_order_id uuid, p_pool_id uuid, p_restore_units numeric, p_require_full_restore boolean DEFAULT false, p_order_item_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- บิลรวมโต๊ะ: รายการถูกย้ายมาจากหลายออเดอร์ แต่ sale movement ยังอ้างออเดอร์ต้นทาง
  -- → รวมยอดตัดของออเดอร์นี้ + ออเดอร์ที่ merged_into_order_id ชี้มา
  select sum(-sm.quantity_delta)::numeric
  into v_sale_units
  from public.stock_movements sm
  where sm.stock_pool_id = p_pool_id
    and sm.movement_type = 'sale'
    and sm.reference_type = 'order'
    and sm.reference_id = any(public.order_stock_reference_ids(p_order_id));

  if v_sale_units is not null then
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
$function$;
