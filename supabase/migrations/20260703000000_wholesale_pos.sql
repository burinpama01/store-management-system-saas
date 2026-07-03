-- Wholesale POS: customer price tiers + multi-unit pack pricing (โหล/แพ็ค/ลัง)
-- + unit-aware stock deduction + optional VAT-included receipt breakdown.

-- ============================================================
-- 1) Customer price tier (ปลีก/ส่ง/ตัวแทน/ลูกค้าประจำ)
-- ============================================================

alter table customers add column if not exists price_tier text not null default 'retail';

alter table customers drop constraint if exists customers_price_tier_check;
alter table customers add constraint customers_price_tier_check
  check (price_tier in ('retail', 'wholesale', 'agent', 'regular'));

-- ============================================================
-- 2) Product base-unit label + per-tier prices (null = ใช้ราคาปลีก)
-- ============================================================

alter table products add column if not exists unit_label text;
alter table products add column if not exists price_wholesale numeric(12,2) check (price_wholesale is null or price_wholesale >= 0);
alter table products add column if not exists price_agent numeric(12,2) check (price_agent is null or price_agent >= 0);
alter table products add column if not exists price_regular numeric(12,2) check (price_regular is null or price_regular >= 0);

-- ============================================================
-- 3) Pack units (โหล = 12 ชิ้น ราคาเหมา) with per-tier prices
-- ============================================================

create table if not exists product_units (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  product_id      uuid not null references products(id) on delete cascade,
  name            text not null,
  quantity        integer not null check (quantity >= 2),
  price           numeric(12,2) not null check (price >= 0),
  price_wholesale numeric(12,2) check (price_wholesale is null or price_wholesale >= 0),
  price_agent     numeric(12,2) check (price_agent is null or price_agent >= 0),
  price_regular   numeric(12,2) check (price_regular is null or price_regular >= 0),
  barcode         text,
  sort_order      int not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists product_units_product_id_idx on product_units(product_id);
create index if not exists product_units_store_id_idx on product_units(store_id);
create unique index if not exists product_units_store_barcode_active_idx
  on product_units (store_id, lower(barcode))
  where barcode is not null and is_active;

-- Keep org/store denormalization consistent with the owning product.
create or replace function set_product_unit_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select p.organization_id, p.store_id
    into new.organization_id, new.store_id
    from products p
   where p.id = new.product_id;

  if new.store_id is null then
    raise exception 'product unit requires a valid product_id';
  end if;

  return new;
end;
$$;

drop trigger if exists product_units_set_scope on product_units;
create trigger product_units_set_scope
before insert or update of product_id
on product_units
for each row
execute function set_product_unit_scope();

alter table product_units enable row level security;

drop policy if exists "product_units: store member can read" on product_units;
create policy "product_units: store member can read"
  on product_units for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "product_units: manager+ can write" on product_units;
create policy "product_units: manager+ can write"
  on product_units for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- ============================================================
-- 4) Order items remember the sold unit (ชื่อหน่วย + ตัวคูณสต๊อก)
-- ============================================================

alter table order_items add column if not exists unit_id uuid references product_units(id) on delete set null;
alter table order_items add column if not exists unit_name text;
alter table order_items add column if not exists unit_quantity integer not null default 1;

alter table order_items drop constraint if exists order_items_unit_quantity_check;
alter table order_items add constraint order_items_unit_quantity_check check (unit_quantity > 0);

-- ============================================================
-- 5) Receipt: optional VAT-included breakdown (display-only)
-- ============================================================

alter table receipt_settings add column if not exists show_vat_breakdown boolean not null default false;
alter table receipt_settings add column if not exists vat_rate numeric(5,2) not null default 7
  check (vat_rate >= 0 and vat_rate <= 100);

-- ============================================================
-- 6) create_pos_order_with_items — accept unit lines and validate
--    unit prices against configured tier prices.
-- ============================================================

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
      unit_id uuid,
      unit_name text,
      unit_quantity integer,
      modifiers jsonb,
      quantity integer,
      unit_price numeric,
      total_price numeric,
      discount_amount numeric,
      discount_type text,
      discount_value numeric,
      discount_note text,
      note text
    )
    join products on products.id = item.product_id
    left join product_variants on product_variants.id = item.variant_id
    left join product_units on product_units.id = item.unit_id
    where item.product_id is not null
      and item.product_name is not null
      and item.quantity > 0
      and item.unit_price >= 0
      and item.total_price >= 0
      and coalesce(item.discount_amount, 0) >= 0
      and coalesce(item.discount_amount, 0) <= item.unit_price * item.quantity
      and (item.discount_type is null or item.discount_type in ('amount', 'percentage'))
      and (
        item.discount_type is distinct from 'percentage'
        or (
          item.discount_value between 0 and 100
          and round(coalesce(item.discount_amount, 0), 2) = round(item.unit_price * item.quantity * (item.discount_value / 100), 2)
        )
      )
      and (
        item.discount_type is distinct from 'amount'
        or (
          item.discount_value >= 0
          and round(coalesce(item.discount_amount, 0), 2) = round(coalesce(item.discount_value, 0), 2)
        )
      )
      and round(item.total_price, 2) = round(item.unit_price * item.quantity - coalesce(item.discount_amount, 0), 2)
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
      -- Price integrity: base-unit lines must match a configured product tier
      -- price (+variant/modifiers); pack-unit lines must match a configured
      -- pack tier price exactly and carry the pack's stock multiplier.
      and (
        (
          item.unit_id is null
          and coalesce(item.unit_quantity, 1) = 1
          and item.unit_price
            - coalesce(product_variants.price_adjustment, 0)
            - coalesce((
                select sum(modifier_options.price_adjustment)
                from jsonb_array_elements(coalesce(item.modifiers, '[]'::jsonb)) as selected_modifier
                join modifier_options
                  on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
                join modifier_groups
                  on modifier_groups.id = modifier_options.modifier_group_id
                where modifier_groups.product_id = products.id
                  and modifier_options.is_active = true
              ), 0)
            in (products.base_price, products.price_wholesale, products.price_agent, products.price_regular)
        )
        or (
          item.unit_id is not null
          and product_units.product_id = products.id
          and product_units.is_active = true
          and coalesce(item.unit_quantity, 0) = product_units.quantity
          and jsonb_array_length(coalesce(item.modifiers, '[]'::jsonb)) = 0
          and item.unit_price in (
            product_units.price,
            product_units.price_wholesale,
            product_units.price_agent,
            product_units.price_regular
          )
        )
      )
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
    unit_id,
    unit_name,
    unit_quantity,
    modifiers,
    quantity,
    unit_price,
    total_price,
    discount_amount,
    discount_type,
    discount_value,
    discount_note,
    note
  )
  select
    v_order_id,
    item.product_id,
    products.name,
    item.variant_id,
    product_variants.name,
    item.unit_id,
    product_units.name,
    coalesce(product_units.quantity, 1),
    coalesce(item.modifiers, '[]'::jsonb),
    item.quantity,
    item.unit_price,
    item.total_price,
    coalesce(item.discount_amount, 0),
    item.discount_type,
    item.discount_value,
    item.discount_note,
    item.note
  from jsonb_to_recordset(p_items) as item(
    product_id uuid,
    product_name text,
    variant_id uuid,
    variant_name text,
    unit_id uuid,
    unit_name text,
    unit_quantity integer,
    modifiers jsonb,
    quantity integer,
    unit_price numeric,
    total_price numeric,
    discount_amount numeric,
    discount_type text,
    discount_value numeric,
    discount_note text,
    note text
  )
  join products on products.id = item.product_id
  left join product_variants on product_variants.id = item.variant_id
  left join product_units on product_units.id = item.unit_id;

  return v_order_id;
end;
$$;

revoke execute on function create_pos_order_with_items(uuid, uuid, text, uuid, text, uuid, numeric, numeric, text, numeric, text, jsonb) from public;
revoke execute on function create_pos_order_with_items(uuid, uuid, text, uuid, text, uuid, numeric, numeric, text, numeric, text, jsonb) from anon;
grant execute on function create_pos_order_with_items(uuid, uuid, text, uuid, text, uuid, numeric, numeric, text, numeric, text, jsonb) to authenticated;

-- ============================================================
-- 7) close_pos_order_payment — deduct stock as quantity × pack size
--    (ขาย 1 โหล = ตัดสต๊อก 12 ชิ้นบน variant เดิม)
-- ============================================================

create or replace function close_pos_order_payment(
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
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_payment_id uuid;
  v_category accounting_categories%rowtype;
  v_transaction_id uuid;
  v_previous_balance numeric := 0;
  v_net_cash numeric;
  v_open_cash_session_id uuid;
  v_now timestamptz := now();
  v_stock record;
  v_variant product_variants%rowtype;
begin
  select *
    into v_order
    from orders
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

  if p_processed_by_user_id <> auth.uid() then
    raise exception 'ผู้ชำระเงินไม่ถูกต้อง';
  end if;

  if not auth_user_has_permission(v_order.organization_id, p_store_id, 'pos.use') then
    raise exception 'ไม่มีสิทธิ์ชำระเงินออร์เดอร์นี้';
  end if;

  if p_amount <= 0 then
    raise exception 'ยอดชำระไม่ถูกต้อง';
  end if;

  if p_amount <> v_order.total then
    raise exception 'ยอดชำระไม่ตรงกับยอดออร์เดอร์';
  end if;

  if p_method = 'cash' then
    if not auth_user_has_permission(v_order.organization_id, p_store_id, 'cashflow.record') then
      raise exception 'ไม่มีสิทธิ์รับเงินสด';
    end if;

    if coalesce(p_received_amount, p_amount) < p_amount then
      raise exception 'เงินสดที่รับไม่พอ';
    end if;

    if coalesce(p_change_amount, 0) < 0 then
      raise exception 'เงินทอนไม่ถูกต้อง';
    end if;

    v_net_cash := coalesce(p_received_amount, p_amount) - coalesce(p_change_amount, 0);

    if v_net_cash <> p_amount then
      raise exception 'ยอดเงินสดไม่ตรงกับยอดขาย';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 0));

    select id
      into v_open_cash_session_id
      from cash_sessions
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

  -- QR orders already decremented stock at creation; only deduct here for POS-created orders.
  if not v_order.qr_order_source then
    for v_stock in
      select variant_id, sum(quantity * coalesce(unit_quantity, 1))::integer as requested_quantity
      from order_items
      where order_id = p_order_id
        and variant_id is not null
      group by variant_id
    loop
      select pv.*
        into v_variant
        from product_variants pv
        join products on products.id = pv.product_id
        where pv.id = v_stock.variant_id
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
  end if;

  update orders
     set status = 'paid',
         paid_at = v_now
   where id = p_order_id;

  insert into payments (
    order_id,
    method,
    amount,
    status,
    received_amount,
    change_amount,
    reference,
    processed_by_user_id
  )
  values (
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
    from accounting_categories
    where store_id = p_store_id
      and type = 'income'
      and name = 'ยอดขาย POS'
    order by sort_order, name
    limit 1;

  if not found then
    insert into accounting_categories (
      organization_id,
      store_id,
      name,
      type,
      is_default,
      sort_order
    )
    values (
      v_order.organization_id,
      p_store_id,
      'ยอดขาย POS',
      'income',
      true,
      0
    )
    returning * into v_category;
  end if;

  insert into transactions (
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
  )
  values (
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
      from cash_ledger_entries
      where store_id = p_store_id
      order by created_at desc
      limit 1;

    insert into cash_ledger_entries (
      organization_id,
      store_id,
      type,
      amount,
      balance_after,
      transaction_id,
      order_id,
      created_by_user_id
    )
    values (
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

revoke execute on function close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) from public, anon;
grant execute on function close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) to authenticated;
