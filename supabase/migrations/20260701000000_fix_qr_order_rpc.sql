-- Fix QR ordering: the create_qr_order_with_items RPC was broken on two counts.
-- (1) It used jsonb_to_recordset(...) WITH ORDINALITY with a column definition list,
--     which Postgres forbids at runtime ("WITH ORDINALITY cannot be used with a column
--     definition list") — so every QR order submission failed. Rewritten to use
--     jsonb_array_elements(...) WITH ORDINALITY + a lateral jsonb_to_recordset.
-- (2) It set orders.cashier_id to the system_accounts id, violating the
--     orders_cashier_id_auth_users_fk added later (migration ...000008). QR orders
--     have no cashier — cashier_id is now nullable and set NULL (attribution lives in
--     system_account_id). No QR orders existed on prod (feature had never worked).

alter table orders alter column cashier_id drop not null;

CREATE OR REPLACE FUNCTION public.create_qr_order_with_items(p_organization_id uuid, p_store_id uuid, p_table_id uuid, p_order_number text, p_subtotal numeric, p_items jsonb DEFAULT '[]'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order_id uuid;
  v_system_account_id uuid;
  v_table_number text;
  v_item_count integer;
  v_items_subtotal numeric;
  v_stock record;
  v_variant product_variants%rowtype;
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
    from stores
    where id = p_store_id
      and organization_id = p_organization_id
      and is_active = true
      and qr_ordering_enabled = true
  ) then
    raise exception 'ร้านไม่พร้อมรับ QR order';
  end if;

  select number
    into v_table_number
    from tables
    where id = p_table_id
      and organization_id = p_organization_id
      and store_id = p_store_id
      and is_active = true
      and qr_enabled = true;

  if not found then
    raise exception 'โต๊ะไม่ถูกต้อง';
  end if;

  insert into system_accounts (
    organization_id,
    store_id,
    kind,
    display_name
  )
  values (
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
    join products on products.id = item.product_id
    left join product_variants on product_variants.id = item.variant_id
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
          join modifier_options
            on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
          join modifier_groups
            on modifier_groups.id = modifier_options.modifier_group_id
          where modifier_groups.product_id = products.id
            and modifier_options.is_active = true
        ), 0), 2)
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
    join modifier_options
      on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
    join modifier_groups
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
    join modifier_groups on modifier_groups.product_id = item_rows.product_id
    left join lateral jsonb_array_elements(coalesce(item_rows.modifiers, '[]'::jsonb)) as selected_modifier on true
    left join modifier_options
      on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
      and modifier_options.modifier_group_id = modifier_groups.id
      and modifier_options.is_active = true
    group by item_rows.line_number, item_rows.product_id, modifier_groups.id
  )
  select count(*)
    into v_invalid_required_modifier_count
    from selected_counts
    join modifier_groups on modifier_groups.id = selected_counts.modifier_group_id
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
    join modifier_groups on modifier_groups.product_id = item_rows.product_id
    left join lateral jsonb_array_elements(coalesce(item_rows.modifiers, '[]'::jsonb)) as selected_modifier on true
    left join modifier_options
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

  for v_stock in
    select item.variant_id, sum(item.quantity)::integer as requested_quantity
    from jsonb_to_recordset(p_items) as item(
      product_id uuid,
      variant_id uuid,
      quantity integer
    )
    where item.variant_id is not null
    group by item.variant_id
    order by item.variant_id
  loop
    select pv.*
      into v_variant
      from product_variants pv
      join products on products.id = pv.product_id
      where pv.id = v_stock.variant_id
        and products.organization_id = p_organization_id
        and products.store_id = p_store_id
      for update;

    if not found then
      raise exception 'สินค้าไม่ถูกต้อง';
    end if;

    if v_variant.track_stock then
      if v_variant.stock_quantity is null or v_variant.stock_quantity < v_stock.requested_quantity then
        raise exception 'สินค้าเหลือไม่พอ';
      end if;

      update product_variants
         set stock_quantity = stock_quantity - v_stock.requested_quantity
       where id = v_stock.variant_id;
    end if;
  end loop;

  insert into orders (
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
  )
  values (
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
  join products on products.id = item.product_id
  left join product_variants on product_variants.id = item.variant_id;

  return v_order_id;
end;
$function$
