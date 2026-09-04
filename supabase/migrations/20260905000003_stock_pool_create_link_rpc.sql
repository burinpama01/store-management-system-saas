-- A new pool and its first Variant link must be all-or-nothing. Keeping both
-- writes inside this function prevents an orphan pool when the unique
-- variant_stock_links.variant_id constraint loses a concurrent race.
create or replace function public.create_stock_pool_and_link_variant(
  p_variant_id uuid,
  p_store_id uuid,
  p_name text,
  p_unit_label text,
  p_low_stock_threshold integer,
  p_consumption_quantity integer
) returns public.stock_pools
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_variant record;
  v_pool public.stock_pools%rowtype;
begin
  select pv.id, p.store_id, p.organization_id
  into v_variant
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id
    and pv.is_active = true
    and p.is_active = true
  for update of pv;

  if not found then
    raise exception 'active variant not found';
  end if;
  if v_variant.store_id <> p_store_id then
    raise exception 'variant does not belong to the active store';
  end if;
  if auth.uid() is null
    or not public.auth_user_has_permission(v_variant.organization_id, v_variant.store_id, 'stock.manage')
    or not public.organization_has_stock_management(v_variant.organization_id) then
    raise exception 'stock pool creation requires stock.manage and stockManagement access';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null
    or nullif(btrim(coalesce(p_unit_label, '')), '') is null then
    raise exception 'stock pool name and unit are required';
  end if;
  if p_low_stock_threshold is null or p_low_stock_threshold < 0 then
    raise exception 'low stock threshold must be a nonnegative integer';
  end if;
  if p_consumption_quantity is null or p_consumption_quantity <= 0 then
    raise exception 'consumption quantity must be a positive integer';
  end if;

  perform 1 from public.variant_stock_links
  where variant_id = p_variant_id
  for update;
  if found then
    raise exception 'variant already linked to a stock pool';
  end if;

  insert into public.stock_pools (
    organization_id, store_id, name, unit_label, quantity, low_stock_threshold
  ) values (
    v_variant.organization_id, v_variant.store_id, btrim(p_name), btrim(p_unit_label), 0, p_low_stock_threshold
  ) returning * into v_pool;

  insert into public.variant_stock_links (variant_id, stock_pool_id, consumption_quantity)
  values (p_variant_id, v_pool.id, p_consumption_quantity);

  return v_pool;
end;
$$;

revoke all on function public.create_stock_pool_and_link_variant(uuid, uuid, text, text, integer, integer) from public;
revoke execute on function public.create_stock_pool_and_link_variant(uuid, uuid, text, text, integer, integer) from anon;
grant execute on function public.create_stock_pool_and_link_variant(uuid, uuid, text, text, integer, integer) to authenticated;
grant execute on function public.create_stock_pool_and_link_variant(uuid, uuid, text, text, integer, integer) to service_role;

-- Linking to an existing pool must validate and mutate under one lock order:
-- Variant, Product, then Stock Pool. The Variant lock also serializes competing
-- attempts for the one-link-per-Variant invariant.
create or replace function public.link_variant_to_stock_pool(
  p_variant_id uuid,
  p_pool_id uuid,
  p_store_id uuid,
  p_consumption_quantity integer
) returns public.variant_stock_links
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_id uuid;
  v_product record;
  v_pool record;
  v_link public.variant_stock_links%rowtype;
begin
  if p_consumption_quantity is null or p_consumption_quantity <= 0 then
    raise exception 'จำนวนที่ตัดต้องเป็นจำนวนเต็มมากกว่า 0';
  end if;

  select pv.product_id
  into v_product_id
  from public.product_variants pv
  where pv.id = p_variant_id
    and pv.is_active = true
  for update;

  if not found then
    raise exception 'ไม่พบ Variant ที่เปิดใช้งาน';
  end if;

  select p.organization_id, p.store_id
  into v_product
  from public.products p
  where p.id = v_product_id
    and p.is_active = true
  for update;

  if not found then
    raise exception 'ไม่พบสินค้าที่เปิดใช้งาน';
  end if;
  if p_store_id is null or v_product.store_id is distinct from p_store_id then
    raise exception 'Variant ไม่ได้อยู่ในร้านปัจจุบัน';
  end if;
  if auth.uid() is null
    or not public.auth_user_has_permission(v_product.organization_id, v_product.store_id, 'stock.manage')
    or not public.organization_has_stock_management(v_product.organization_id) then
    raise exception 'ต้องมีสิทธิ์จัดการสต๊อกและแพ็กเกจที่รองรับ Stock Pool';
  end if;

  select sp.organization_id, sp.store_id
  into v_pool
  from public.stock_pools sp
  where sp.id = p_pool_id
    and sp.is_active = true
  for update;

  if not found then
    raise exception 'ไม่พบ Stock Pool ที่เปิดใช้งาน';
  end if;
  if v_pool.store_id is distinct from p_store_id
    or v_pool.store_id is distinct from v_product.store_id
    or v_pool.organization_id is distinct from v_product.organization_id then
    raise exception 'Stock Pool ไม่ได้อยู่ในร้านและองค์กรเดียวกับ Variant';
  end if;

  perform 1
  from public.variant_stock_links
  where variant_id = p_variant_id
  for update;
  if found then
    raise exception 'Variant นี้เชื่อมกับ Stock Pool แล้ว';
  end if;

  insert into public.variant_stock_links (
    variant_id, stock_pool_id, consumption_quantity
  ) values (
    p_variant_id, p_pool_id, p_consumption_quantity
  ) returning * into v_link;

  return v_link;
end;
$$;

-- ต้อง revoke delete ด้วย ไม่งั้น manager ยิง PostgREST ลบ link ตรงได้ = ตัดสายสต๊อก
-- โดยไม่มี ledger และทำให้ออเดอร์ที่ถือ snapshot ค้างอยู่ชี้ Pool ที่ variant ไม่ผูกแล้ว
revoke insert, update, delete on table public.variant_stock_links from authenticated;
revoke all on function public.link_variant_to_stock_pool(uuid, uuid, uuid, integer) from public;
revoke execute on function public.link_variant_to_stock_pool(uuid, uuid, uuid, integer) from anon;
grant execute on function public.link_variant_to_stock_pool(uuid, uuid, uuid, integer) to authenticated;
grant execute on function public.link_variant_to_stock_pool(uuid, uuid, uuid, integer) to service_role;
