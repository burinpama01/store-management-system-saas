-- หน้าสต็อกแบบง่าย: "ตัดสต็อกจาก [สินค้าอื่น] × จำนวน" และปุ่มลบออกจากรายการสต็อก
-- ร้านไม่ต้องรู้จักคำว่า Stock Pool — ระบบสร้าง Pool ให้เองเบื้องหลัง
--
-- 1) link_variant_to_source_variant(target, source, qty)
--    - source ยังไม่มี Pool → สร้าง Pool ชื่อ "<สินค้า> <ตัวเลือก>" ยอดเริ่ม = stock_quantity เดิมของ source
--      (ลง stock_movements แบบ 'migration'), ผูก source ตัดครั้งละ 1
--    - source มี Pool แล้ว (ต้องเป็นตัวที่ตัดครั้งละ 1) → ใช้ Pool เดิม
--    - ผูก target ตัดครั้งละ qty; ทั้งหมดอยู่ในธุรกรรมเดียว
-- 2) remove_variant_from_stock(variant)
--    - ถอดออกจาก Pool (ถ้ามี) + track_stock = false → กลับไปขายได้ไม่จำกัด ไม่ลบเมนู
--    - Pool ที่ไม่เหลือใครผูก → ปิดใช้งาน (เก็บประวัติ movement ไว้)

create or replace function public.link_variant_to_source_variant(
  p_target_variant_id uuid,
  p_source_variant_id uuid,
  p_consumption_quantity integer
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target record;
  v_source record;
  v_source_link public.variant_stock_links%rowtype;
  v_pool public.stock_pools%rowtype;
  v_initial integer;
begin
  if p_consumption_quantity is null or p_consumption_quantity <= 0 then
    raise exception 'จำนวนที่ตัดต้องเป็นจำนวนเต็มมากกว่า 0';
  end if;
  if p_target_variant_id = p_source_variant_id then
    raise exception 'เลือกสินค้าต้นทางเป็นตัวเดียวกันไม่ได้';
  end if;

  -- ล็อกตามลำดับ id เพื่อกัน deadlock เมื่อสองคนผูกคู่เดียวกันสลับทิศ
  perform 1 from public.product_variants
  where id in (p_target_variant_id, p_source_variant_id)
  order by id
  for update;

  select pv.id, pv.name, pv.stock_quantity, p.name as product_name, p.store_id, p.organization_id
  into v_target
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = p_target_variant_id and pv.is_active = true and p.is_active = true;
  if not found then
    raise exception 'ไม่พบสินค้าที่จะตั้งค่า';
  end if;

  select pv.id, pv.name, pv.stock_quantity, pv.reserved_quantity, p.name as product_name, p.store_id, p.organization_id
  into v_source
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = p_source_variant_id and pv.is_active = true and p.is_active = true;
  if not found then
    raise exception 'ไม่พบสินค้าต้นทาง';
  end if;

  if v_target.store_id is distinct from v_source.store_id then
    raise exception 'สินค้าทั้งสองต้องอยู่ร้านเดียวกัน';
  end if;

  if auth.uid() is null
    or not public.auth_user_has_permission(v_target.organization_id, v_target.store_id, 'stock.manage')
    or not public.organization_has_stock_management(v_target.organization_id) then
    raise exception 'ต้องมีสิทธิ์จัดการสต๊อกและแพ็กเกจที่รองรับ';
  end if;

  perform 1 from public.variant_stock_links where variant_id = p_target_variant_id;
  if found then
    raise exception 'สินค้านี้ตั้งตัดสต็อกจากสินค้าอื่นไว้แล้ว — ลบออกก่อนแล้วตั้งใหม่';
  end if;

  select * into v_source_link from public.variant_stock_links where variant_id = p_source_variant_id for update;
  if found then
    if v_source_link.consumption_quantity <> 1 then
      raise exception 'สินค้าต้นทางตัดสต็อกจากสินค้าอื่นอยู่ — เลือกสินค้าหลักที่ขายทีละ 1';
    end if;
    select * into v_pool from public.stock_pools where id = v_source_link.stock_pool_id for update;
    if not v_pool.is_active then
      update public.stock_pools set is_active = true where id = v_pool.id returning * into v_pool;
    end if;
  else
    -- ออร์เดอร์ QR ที่จองไว้ก่อนผูก จะตัดจาก stock_quantity ของ variant ตามเส้นทางเดิม
    -- จึงหักยอดจองออกก่อนตั้งยอดกลาง ไม่งั้นยอดกลางจะเกินของจริง
    v_initial := greatest(coalesce(v_source.stock_quantity, 0) - coalesce(v_source.reserved_quantity, 0), 0);
    insert into public.stock_pools (
      organization_id, store_id, name, unit_label, quantity, low_stock_threshold
    ) values (
      v_source.organization_id, v_source.store_id,
      left(btrim(v_source.product_name || ' ' || coalesce(v_source.name, '')), 200),
      'หน่วย', v_initial, 0
    ) returning * into v_pool;

    if v_initial > 0 then
      insert into public.stock_movements (
        stock_pool_id, movement_type, quantity_delta, before_quantity, after_quantity, reason, actor_id
      ) values (
        v_pool.id, 'migration', v_initial, 0, v_initial,
        'เริ่มใช้สต็อกร่วม (ยอดเดิมของ ' || v_source.product_name || ')', auth.uid()
      );
    end if;

    insert into public.variant_stock_links (variant_id, stock_pool_id, consumption_quantity)
    values (p_source_variant_id, v_pool.id, 1);
    update public.product_variants set track_stock = true where id = p_source_variant_id;
  end if;

  insert into public.variant_stock_links (variant_id, stock_pool_id, consumption_quantity)
  values (p_target_variant_id, v_pool.id, p_consumption_quantity);
  update public.product_variants set track_stock = true where id = p_target_variant_id;

  return v_pool.id;
end;
$$;

revoke all on function public.link_variant_to_source_variant(uuid, uuid, integer) from public;
revoke execute on function public.link_variant_to_source_variant(uuid, uuid, integer) from anon;
grant execute on function public.link_variant_to_source_variant(uuid, uuid, integer) to authenticated;
grant execute on function public.link_variant_to_source_variant(uuid, uuid, integer) to service_role;

create or replace function public.remove_variant_from_stock(p_variant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_variant record;
  v_link public.variant_stock_links%rowtype;
  v_dependents text;
begin
  select pv.id, p.store_id, p.organization_id
  into v_variant
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id
  for update of pv;
  if not found then
    raise exception 'ไม่พบสินค้า';
  end if;

  if auth.uid() is null
    or not public.auth_user_has_permission(v_variant.organization_id, v_variant.store_id, 'stock.manage')
    or not public.organization_has_stock_management(v_variant.organization_id) then
    raise exception 'ต้องมีสิทธิ์จัดการสต๊อกและแพ็กเกจที่รองรับ';
  end if;

  select * into v_link from public.variant_stock_links where variant_id = p_variant_id for update;
  if found and v_link.consumption_quantity = 1 then
    select string_agg(btrim(p.name || ' ' || coalesce(pv.name, '')), ', ') into v_dependents
    from public.variant_stock_links l
    join public.product_variants pv on pv.id = l.variant_id
    join public.products p on p.id = pv.product_id
    where l.stock_pool_id = v_link.stock_pool_id and l.consumption_quantity > 1;
    if v_dependents is not null then
      raise exception 'ยังมีรายการที่ตัดสต็อกจากสินค้านี้: % — ลบรายการเหล่านั้นก่อน', v_dependents;
    end if;
  end if;

  delete from public.variant_stock_links where variant_id = p_variant_id returning * into v_link;
  if v_link.stock_pool_id is not null then
    update public.stock_pools sp
    set is_active = false
    where sp.id = v_link.stock_pool_id
      and not exists (select 1 from public.variant_stock_links l where l.stock_pool_id = sp.id);
  end if;

  update public.product_variants set track_stock = false where id = p_variant_id;
end;
$$;

revoke all on function public.remove_variant_from_stock(uuid) from public;
revoke execute on function public.remove_variant_from_stock(uuid) from anon;
grant execute on function public.remove_variant_from_stock(uuid) to authenticated;
grant execute on function public.remove_variant_from_stock(uuid) to service_role;

-- ตั้งยอดคงเหลือ (set_balance) ต่ำกว่ายอดที่ QR จองไว้ไม่ได้ — ไม่งั้นตอนครัวรับ/ชำระ
-- quantity - reserved ติดลบ ชน check constraint แล้วออร์เดอร์ล้ม (หน้าสต็อกแบบง่ายเรียกเส้นนี้บ่อยขึ้น)
-- เนื้อฟังก์ชันคัดจาก prod ปัจจุบัน + เพิ่มเงื่อนไข reserved_units เท่านั้น
create or replace function public.adjust_stock_pool(
  p_pool_id uuid,
  p_mode text,
  p_quantity integer,
  p_reason text default null
)
returns public.stock_pools
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pool public.stock_pools%rowtype;
  v_before integer;
  v_after integer;
  v_after_bigint bigint;
  v_reason text;
begin
  select * into v_pool
  from public.stock_pools
  where id = p_pool_id
  for update;

  if not found then
    raise exception 'stock pool not found';
  end if;

  if auth.uid() is null
    or not public.auth_user_has_permission(v_pool.organization_id, v_pool.store_id, 'stock.manage')
    or not public.organization_has_stock_management(v_pool.organization_id) then
    raise exception 'stock pool adjustment requires stock.manage and stockManagement access';
  end if;

  if p_mode not in ('receive', 'set_balance') then
    raise exception 'invalid stock pool adjustment mode';
  end if;

  if p_quantity is null or p_quantity < 0 then
    raise exception 'stock pool quantity must be a nonnegative integer';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if p_mode = 'receive' and p_quantity <= 0 then
    raise exception 'received quantity must be greater than zero';
  end if;
  if p_mode = 'set_balance' and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'set balance requires a reason';
  end if;
  if p_mode = 'set_balance' and p_quantity < coalesce(v_pool.reserved_units, 0) then
    raise exception 'ตั้งยอดต่ำกว่ายอดที่ลูกค้าสั่งจองไว้ (% หน่วย) ไม่ได้', v_pool.reserved_units;
  end if;

  v_before := v_pool.quantity;
  if p_mode = 'receive' then
    v_after_bigint := v_before::bigint + p_quantity::bigint;
  else
    v_after_bigint := p_quantity::bigint;
  end if;

  if v_after_bigint < 0 or v_after_bigint > 2147483647 then
    raise exception 'stock pool quantity exceeds integer range';
  end if;
  v_after := v_after_bigint::integer;

  update public.stock_pools
  set quantity = v_after
  where id = v_pool.id
  returning * into v_pool;

  insert into public.stock_movements (
    stock_pool_id,
    movement_type,
    quantity_delta,
    before_quantity,
    after_quantity,
    reason,
    actor_id
  ) values (
    v_pool.id,
    p_mode,
    v_after - v_before,
    v_before,
    v_after,
    v_reason,
    auth.uid()
  );

  return v_pool;
end;
$$;
