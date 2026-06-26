-- Loyalty points become 2-decimal so small/fractional accruals are kept and shown.
-- Before: earn = floor(total * rate)::integer → ฿101 × 0.01 = 1 (lost 0.01), and any order
-- under ฿100 earned 0 (nothing saved/shown). After: earn = round(total * rate, 2) = 1.01.

alter table loyalty_accounts alter column points_balance type numeric(12,2);
alter table loyalty_ledger   alter column points_delta   type numeric(12,2);
alter table orders alter column loyalty_points_earned   type numeric(12,2);
alter table orders alter column loyalty_points_redeemed type numeric(12,2);

-- Earn points on payment success, rounded to 2 decimals (keeps fractional points).
create or replace function close_grocery_pos_order_payment_with_rewards(
  p_order_id uuid,
  p_store_id uuid,
  p_processed_by_user_id uuid,
  p_method text,
  p_amount numeric,
  p_received_amount numeric default null,
  p_change_amount numeric default null,
  p_reference text default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_id uuid;
  v_order orders%rowtype;
  v_account loyalty_accounts%rowtype;
  v_loyalty_settings loyalty_settings%rowtype;
  v_points_per_currency numeric := 0;
  v_points numeric := 0;
  v_ledger_id uuid;
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
begin
  v_payment_id := close_pos_order_payment(
    p_order_id,
    p_store_id,
    p_processed_by_user_id,
    p_method,
    p_amount,
    p_received_amount,
    p_change_amount,
    p_reference
  );

  select *
    into v_order
    from orders
   where id = p_order_id
     and store_id = p_store_id
   for update;

  if found and v_order.customer_id is not null then
    select *
      into v_loyalty_settings
      from loyalty_settings
     where organization_id = v_order.organization_id
       and store_id = p_store_id;

    if found then
      v_points_per_currency := case
        when v_loyalty_settings.earn_enabled is true then v_loyalty_settings.points_per_currency
        else 0
      end;
    else
      v_points_per_currency := 0.0100;
    end if;

    if v_points_per_currency > 0 then
      if v_idempotency_key is null then
        raise exception 'ต้องมี idempotency key สำหรับแต้มสะสม';
      end if;

      insert into loyalty_accounts (
        organization_id,
        store_id,
        customer_id
      )
      values (
        v_order.organization_id,
        p_store_id,
        v_order.customer_id
      )
      on conflict (store_id, customer_id) do update
        set updated_at = loyalty_accounts.updated_at
      returning * into v_account;

      v_points := round(v_order.total * v_points_per_currency, 2);
      if v_points > 0 then
        insert into loyalty_ledger (
          organization_id,
          store_id,
          account_id,
          customer_id,
          order_id,
          type,
          points_delta,
          reason,
          idempotency_key
        )
        values (
          v_order.organization_id,
          p_store_id,
          v_account.id,
          v_order.customer_id,
          p_order_id,
          'earn',
          v_points,
          'payment_success',
          v_idempotency_key || ':loyalty_earn'
        )
        on conflict (store_id, idempotency_key) do nothing
        returning id into v_ledger_id;

        if v_ledger_id is not null then
          update loyalty_accounts
             set points_balance = points_balance + v_points,
                 updated_at = now()
           where id = v_account.id
             and store_id = p_store_id;

          update orders
             set loyalty_points_earned = v_points
           where id = p_order_id
             and store_id = p_store_id;
        end if;
      end if;
    end if;
  end if;

  return v_payment_id;
end;
$$;

revoke execute on function close_grocery_pos_order_payment_with_rewards(
  uuid, uuid, uuid, text, numeric, numeric, numeric, text, text
) from public;
revoke execute on function close_grocery_pos_order_payment_with_rewards(
  uuid, uuid, uuid, text, numeric, numeric, numeric, text, text
) from anon;
grant execute on function close_grocery_pos_order_payment_with_rewards(
  uuid, uuid, uuid, text, numeric, numeric, numeric, text, text
) to authenticated;

-- Manual point adjustment now accepts decimal deltas. The parameter type changes from integer to
-- numeric, which is a new signature, so the old one must be dropped to avoid an ambiguous overload.
drop function if exists adjust_customer_loyalty_points(uuid, uuid, uuid, integer, text, text);

create or replace function adjust_customer_loyalty_points(
  p_organization_id uuid,
  p_store_id uuid,
  p_customer_id uuid,
  p_points_delta numeric,
  p_reason text default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account loyalty_accounts%rowtype;
  v_ledger_id uuid;
  v_delta numeric := round(p_points_delta, 2);
  v_idempotency_key text := coalesce(p_idempotency_key, 'manual:' || gen_random_uuid()::text);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'ไม่มีสิทธิ์ปรับแต้มลูกค้า';
  end if;
  if v_delta = 0 then
    raise exception 'จำนวนแต้มต้องไม่เป็น 0';
  end if;
  if not exists (
    select 1 from customers
     where id = p_customer_id
       and organization_id = p_organization_id
       and store_id = p_store_id
       and is_active = true
  ) then
    raise exception 'ไม่พบลูกค้าที่ใช้งาน';
  end if;

  insert into loyalty_accounts (organization_id, store_id, customer_id)
  values (p_organization_id, p_store_id, p_customer_id)
  on conflict (store_id, customer_id) do update
    set updated_at = now()
  returning * into v_account;

  select *
    into v_account
    from loyalty_accounts
   where id = v_account.id
   for update;

  if v_account.points_balance + v_delta < 0 then
    raise exception 'แต้มคงเหลือไม่พอ';
  end if;

  update loyalty_accounts
     set points_balance = points_balance + v_delta,
         updated_at = now()
   where id = v_account.id;

  insert into loyalty_ledger (
    organization_id,
    store_id,
    account_id,
    customer_id,
    type,
    points_delta,
    reason,
    idempotency_key
  )
  values (
    p_organization_id,
    p_store_id,
    v_account.id,
    p_customer_id,
    'adjustment',
    v_delta,
    nullif(trim(coalesce(p_reason, '')), ''),
    v_idempotency_key
  )
  returning id into v_ledger_id;

  return v_ledger_id;
end;
$$;

revoke execute on function adjust_customer_loyalty_points(uuid, uuid, uuid, numeric, text, text) from public;
revoke execute on function adjust_customer_loyalty_points(uuid, uuid, uuid, numeric, text, text) from anon;
revoke execute on function adjust_customer_loyalty_points(uuid, uuid, uuid, numeric, text, text) from authenticated;
grant execute on function adjust_customer_loyalty_points(uuid, uuid, uuid, numeric, text, text) to service_role;
