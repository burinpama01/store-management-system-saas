-- Create POS orders and items atomically.

create or replace function create_pos_order_with_items(
  p_organization_id uuid,
  p_store_id uuid,
  p_order_number text,
  p_table_id uuid default null,
  p_table_number text default null,
  p_cashier_id uuid default null,
  p_subtotal numeric default 0,
  p_discount numeric default 0,
  p_discount_note text default null,
  p_total numeric default 0,
  p_note text default null,
  p_items jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_item_count integer;
  v_items_subtotal numeric;
  v_table_number text := p_table_number;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนสร้างออร์เดอร์';
  end if;

  if p_cashier_id is distinct from auth.uid() then
    raise exception 'ผู้สร้างออร์เดอร์ไม่ถูกต้อง';
  end if;

  if not auth_user_role_in_store(p_organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์สร้างออร์เดอร์';
  end if;

  if p_items is null
    or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'ไม่มีรายการในออร์เดอร์';
  end if;

  if p_subtotal is null or p_discount is null or p_total is null
    or p_subtotal < 0 or p_discount < 0 or p_total < 0 then
    raise exception 'ยอดออร์เดอร์ไม่ถูกต้อง';
  end if;

  if p_total is distinct from p_subtotal - p_discount then
    raise exception 'ยอดรวมออร์เดอร์ไม่ถูกต้อง';
  end if;

  if p_table_id is not null then
    select number
      into v_table_number
      from tables
      where id = p_table_id
        and organization_id = p_organization_id
        and store_id = p_store_id
        and is_active = true;

    if not found then
      raise exception 'โต๊ะไม่ถูกต้อง';
    end if;
  elsif p_table_number is not null then
    raise exception 'เลขโต๊ะต้องมาจากระบบ';
  end if;

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
    join products on products.id = item.product_id
    left join product_variants on product_variants.id = item.variant_id
    where item.product_id is not null
      and item.product_name is not null
      and item.quantity > 0
      and item.unit_price >= 0
      and item.total_price >= 0
      and item.total_price = item.unit_price * item.quantity
      and products.organization_id = p_organization_id
      and products.store_id = p_store_id
      and products.is_active = true
      and products.available_for_pos = true
      and (
        item.variant_id is null
        or (
          product_variants.product_id = products.id
          and product_variants.is_active = true
        )
      )
      and item.unit_price = products.base_price
        + coalesce(product_variants.price_adjustment, 0)
        + coalesce((
          select sum(modifier_options.price_adjustment)
          from jsonb_array_elements(coalesce(item.modifiers, '[]'::jsonb)) as selected_modifier
          join modifier_options
            on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
          join modifier_groups
            on modifier_groups.id = modifier_options.modifier_group_id
          where modifier_groups.product_id = products.id
            and modifier_options.is_active = true
        ), 0)
      and jsonb_array_length(coalesce(item.modifiers, '[]'::jsonb)) = (
        select count(*)
        from jsonb_array_elements(coalesce(item.modifiers, '[]'::jsonb)) as selected_modifier
        join modifier_options
          on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
        join modifier_groups
          on modifier_groups.id = modifier_options.modifier_group_id
        where modifier_groups.product_id = products.id
          and modifier_options.is_active = true
      );

  if v_item_count is distinct from jsonb_array_length(p_items) then
    raise exception 'รายการออร์เดอร์ไม่ถูกต้อง';
  end if;

  if p_subtotal is distinct from v_items_subtotal then
    raise exception 'ยอดรวมสินค้าไม่ตรงกับรายการ';
  end if;

  insert into orders (
    organization_id,
    store_id,
    order_number,
    status,
    table_id,
    table_number,
    cashier_id,
    subtotal,
    discount,
    discount_note,
    total,
    note,
    qr_order_source
  )
  values (
    p_organization_id,
    p_store_id,
    p_order_number,
    'pending_payment',
    p_table_id,
    v_table_number,
    p_cashier_id,
    p_subtotal,
    p_discount,
    p_discount_note,
    p_total,
    p_note,
    false
  )
  returning id into v_order_id;

  insert into order_items (
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
    item.unit_price,
    item.total_price,
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
  join products on products.id = item.product_id
  left join product_variants on product_variants.id = item.variant_id;

  return v_order_id;
end;
$$;

revoke execute on function create_pos_order_with_items(uuid, uuid, text, uuid, text, uuid, numeric, numeric, text, numeric, text, jsonb) from public;
revoke execute on function create_pos_order_with_items(uuid, uuid, text, uuid, text, uuid, numeric, numeric, text, numeric, text, jsonb) from anon;
grant execute on function create_pos_order_with_items(uuid, uuid, text, uuid, text, uuid, numeric, numeric, text, numeric, text, jsonb) to authenticated;
