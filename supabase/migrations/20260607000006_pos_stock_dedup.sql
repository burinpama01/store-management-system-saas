-- #8 fix: avoid double stock deduction. QR orders already decrement stock at creation
-- (create_qr_order_with_items); when such an order is later settled via close_pos_order_payment
-- it must NOT decrement again. POS orders (qr_order_source = false) still decrement here at payment.

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

  if not auth_user_role_in_store(v_order.organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์ชำระเงินออร์เดอร์นี้';
  end if;

  if p_amount <= 0 then
    raise exception 'ยอดชำระไม่ถูกต้อง';
  end if;

  if p_amount <> v_order.total then
    raise exception 'ยอดชำระไม่ตรงกับยอดออร์เดอร์';
  end if;

  if p_method = 'cash' then
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

  select *
    into v_category
    from accounting_categories
    where store_id = p_store_id
      and type = 'income'
      and (name = 'ยอดขาย POS' or is_default = true)
    order by
      case
        when name = 'ยอดขาย POS' then 0
        when is_default = true then 1
        else 2
      end,
      sort_order,
      name
    limit 1;

  if found then
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
  end if;

  if p_method = 'cash' then
    perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 0));

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

revoke execute on function close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) from public;
revoke execute on function close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) from anon;
grant execute on function close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) to authenticated;
