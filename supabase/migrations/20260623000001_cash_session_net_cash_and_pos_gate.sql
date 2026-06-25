-- Cash session reconciliation should count real cash kept in drawer.
-- For cash POS payments with received/change values, net drawer cash is received - change.

create or replace function auth_user_has_permission(
  p_organization_id uuid,
  p_store_id uuid,
  p_permission_key text
)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_membership memberships%rowtype;
  v_has_permission boolean := false;
  v_override_granted boolean;
begin
  if auth.uid() is null then
    return false;
  end if;

  select *
    into v_membership
    from memberships m
    where m.user_id = auth.uid()
      and m.organization_id = p_organization_id
      and (m.store_id = p_store_id or m.store_id is null)
      and m.joined_at is not null
    order by case when m.store_id = p_store_id then 0 else 1 end
    limit 1;

  if not found then
    return false;
  end if;

  v_has_permission := case v_membership.role
    when 'super_admin' then p_permission_key = any(array[
      'dashboard.view',
      'pos.use',
      'pos.discount',
      'pos.refund',
      'pos.delete_bill',
      'orders.manage_qr',
      'catalog.view',
      'catalog.manage',
      'stock.manage',
      'cashflow.view',
      'cashflow.record',
      'cashflow.manage',
      'reports.view',
      'attendance.clock',
      'attendance.manage',
      'settings.view',
      'settings.manage_printer',
      'settings.manage_store',
      'users.manage',
      'permissions.manage',
      'notifications.manage',
      'organizations.manage',
      'billing.manage',
      'system.manage'
    ])
    when 'owner' then p_permission_key = any(array[
      'dashboard.view',
      'pos.use',
      'pos.discount',
      'pos.refund',
      'pos.delete_bill',
      'orders.manage_qr',
      'catalog.view',
      'catalog.manage',
      'stock.manage',
      'cashflow.view',
      'cashflow.record',
      'cashflow.manage',
      'reports.view',
      'attendance.clock',
      'attendance.manage',
      'settings.view',
      'settings.manage_printer',
      'settings.manage_store',
      'users.manage',
      'permissions.manage',
      'notifications.manage',
      'billing.manage'
    ])
    when 'admin' then p_permission_key = any(array[
      'dashboard.view',
      'pos.use',
      'pos.discount',
      'pos.refund',
      'pos.delete_bill',
      'orders.manage_qr',
      'catalog.view',
      'catalog.manage',
      'stock.manage',
      'cashflow.view',
      'cashflow.record',
      'cashflow.manage',
      'reports.view',
      'attendance.clock',
      'attendance.manage',
      'settings.view',
      'settings.manage_printer',
      'settings.manage_store',
      'users.manage',
      'notifications.manage'
    ])
    when 'manager' then p_permission_key = any(array[
      'dashboard.view',
      'pos.use',
      'pos.discount',
      'pos.refund',
      'catalog.view',
      'catalog.manage',
      'stock.manage',
      'cashflow.view',
      'cashflow.record',
      'reports.view',
      'attendance.clock',
      'attendance.manage',
      'settings.view',
      'settings.manage_printer',
      'orders.manage_qr'
    ])
    when 'cashier' then p_permission_key = any(array[
      'pos.use',
      'pos.discount',
      'cashflow.view',
      'cashflow.record',
      'attendance.clock',
      'settings.view',
      'settings.manage_printer',
      'orders.manage_qr'
    ])
    when 'staff' then p_permission_key = any(array[
      'pos.use',
      'cashflow.view',
      'cashflow.record',
      'attendance.clock',
      'settings.view',
      'settings.manage_printer'
    ])
    else false
  end;

  select mpo.granted
    into v_override_granted
    from membership_permission_overrides mpo
    where mpo.membership_id = v_membership.id
      and mpo.permission_key = p_permission_key
    limit 1;

  if found then
    v_has_permission := v_override_granted;
  end if;

  -- Keep DB behavior aligned with the app resolver's locked role permissions.
  if v_membership.role in ('cashier', 'staff')
     and p_permission_key in ('catalog.view', 'catalog.manage') then
    return false;
  end if;

  return v_has_permission;
end;
$$;

create or replace function open_cash_session(
  p_store_id uuid,
  p_opening_float numeric,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_session_id uuid;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  select organization_id
    into v_org_id
    from stores
    where id = p_store_id
      and is_active = true;
  if not found then
    raise exception 'ไม่พบร้านค้า';
  end if;

  if not auth_user_has_permission(v_org_id, p_store_id, 'cashflow.record') then
    raise exception 'ไม่มีสิทธิ์เปิดรอบเงินสด';
  end if;

  if p_opening_float is null or p_opening_float < 0 then
    raise exception 'ยอดเงินเปิดร้านไม่ถูกต้อง';
  end if;

  -- Serialize per store to avoid two concurrent opens racing the unique index.
  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 1));

  if exists (
    select 1 from cash_sessions
    where store_id = p_store_id and status = 'open'
  ) then
    raise exception 'มีรอบเงินสดที่เปิดอยู่แล้ว';
  end if;

  insert into cash_sessions (
    organization_id,
    store_id,
    status,
    opening_float,
    opened_by_user_id,
    open_note
  )
  values (
    v_org_id,
    p_store_id,
    'open',
    round(p_opening_float, 2),
    auth.uid(),
    nullif(btrim(coalesce(p_note, '')), '')
  )
  returning id into v_session_id;

  return v_session_id;
end;
$$;

create or replace function close_cash_session(
  p_session_id uuid,
  p_store_id uuid,
  p_closing_count numeric,
  p_note text default null
)
returns cash_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session cash_sessions%rowtype;
  v_cash_sales numeric := 0;
  v_expected numeric;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  if p_closing_count is null or p_closing_count < 0 then
    raise exception 'ยอดเงินนับจริงไม่ถูกต้อง';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 0));

  select *
    into v_session
    from cash_sessions
    where id = p_session_id
      and store_id = p_store_id
    for update;
  if not found then
    raise exception 'ไม่พบรอบเงินสด';
  end if;

  if v_session.status <> 'open' then
    raise exception 'รอบเงินสดนี้ปิดไปแล้ว';
  end if;

  if not auth_user_has_permission(v_session.organization_id, p_store_id, 'cashflow.record') then
    raise exception 'ไม่มีสิทธิ์ปิดรอบเงินสด';
  end if;

  select coalesce(sum(
    case
      when p.received_amount is not null and p.change_amount is not null
        then p.received_amount - p.change_amount
      else p.amount
    end
  ), 0)
    into v_cash_sales
    from payments p
    join orders o on o.id = p.order_id
    where o.store_id = p_store_id
      and p.method = 'cash'
      and p.status = 'completed'
      and p.processed_at >= v_session.opened_at
      and p.processed_at <= now();

  v_expected := round(v_session.opening_float + v_cash_sales, 2);

  update cash_sessions
     set status        = 'closed',
         closing_count = round(p_closing_count, 2),
         cash_sales    = round(v_cash_sales, 2),
         expected_cash = v_expected,
         variance      = round(p_closing_count, 2) - v_expected,
         closed_by_user_id = auth.uid(),
         closed_at     = now(),
         close_note    = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at    = now()
   where id = p_session_id
   returning * into v_session;

  return v_session;
end;
$$;

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

revoke execute on function auth_user_has_permission(uuid, uuid, text) from public, anon;
grant execute on function auth_user_has_permission(uuid, uuid, text) to authenticated;

revoke execute on function open_cash_session(uuid, numeric, text) from public, anon;
grant execute on function open_cash_session(uuid, numeric, text) to authenticated;

revoke execute on function close_cash_session(uuid, uuid, numeric, text) from public, anon;
grant execute on function close_cash_session(uuid, uuid, numeric, text) to authenticated;

revoke execute on function close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) from public, anon;
grant execute on function close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) to authenticated;
