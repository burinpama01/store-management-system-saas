-- Guarantee that every POS payment creates an income transaction, even for
-- stores that do not yet have the "ยอดขาย POS" category.

-- Keep manual income/expense categories aligned with permission overrides and
-- prevent duplicate category names within the same store/type.
with ranked_categories as (
  select
    id,
    first_value(id) over (
      partition by store_id, type, lower(btrim(name))
      order by is_default desc, sort_order, created_at, id
    ) as keeper_id,
    first_value(name) over (
      partition by store_id, type, lower(btrim(name))
      order by is_default desc, sort_order, created_at, id
    ) as keeper_name,
    row_number() over (
      partition by store_id, type, lower(btrim(name))
      order by is_default desc, sort_order, created_at, id
    ) as duplicate_rank
  from accounting_categories
)
update transactions
   set category_id = ranked_categories.keeper_id,
       category_name = ranked_categories.keeper_name,
       updated_at = now()
  from ranked_categories
 where transactions.category_id = ranked_categories.id
   and ranked_categories.duplicate_rank > 1;

with ranked_categories as (
  select
    id,
    row_number() over (
      partition by store_id, type, lower(btrim(name))
      order by is_default desc, sort_order, created_at, id
    ) as duplicate_rank
  from accounting_categories
)
delete from accounting_categories
 using ranked_categories
 where accounting_categories.id = ranked_categories.id
   and ranked_categories.duplicate_rank > 1;

create unique index if not exists accounting_categories_store_type_name_unique_idx
  on accounting_categories (store_id, type, lower(btrim(name)));

drop policy if exists "accounting_categories: manager+ can write" on accounting_categories;

create policy "accounting_categories: cashflow.manage can write"
  on accounting_categories for all
  to authenticated
  using (auth_user_has_permission(organization_id, store_id, 'cashflow.manage'))
  with check (auth_user_has_permission(organization_id, store_id, 'cashflow.manage'));

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
      select variant_id, sum(quantity)::integer as requested_quantity
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
