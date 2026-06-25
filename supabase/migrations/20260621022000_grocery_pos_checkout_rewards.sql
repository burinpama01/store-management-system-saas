-- Atomic grocery POS checkout reservation for coupons and redeemed loyalty points.
-- Earning points belongs to payment-success flow. Point redemption is intentionally
-- disabled in this phase until a trusted redemption conversion policy is defined.

create or replace function create_grocery_pos_order_with_rewards(
  p_organization_id uuid,
  p_store_id uuid,
  p_order_number text,
  p_cashier_id uuid default null,
  p_customer_id uuid default null,
  p_coupon_id uuid default null,
  p_coupon_discount_amount numeric default 0,
  p_subtotal numeric default 0,
  p_discount numeric default 0,
  p_discount_note text default null,
  p_total numeric default 0,
  p_note text default null,
  p_items jsonb default '[]'::jsonb,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_coupon coupons%rowtype;
  v_coupon_redemption_count integer := 0;
  v_customer_coupon_count integer := 0;
  v_manual_discount numeric := 0;
  v_coupon_base numeric := 0;
  v_expected_coupon_discount numeric := 0;
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
begin
  if v_idempotency_key is null then
    raise exception 'ต้องมี idempotency key สำหรับ grocery checkout';
  end if;

  if p_customer_id is not null and not exists (
    select 1 from customers
    where id = p_customer_id
      and organization_id = p_organization_id
      and store_id = p_store_id
      and is_active = true
  ) then
    raise exception 'ลูกค้าไม่ถูกต้อง';
  end if;

  v_order_id := create_pos_order_with_items(
    p_organization_id,
    p_store_id,
    p_order_number,
    null,
    null,
    p_cashier_id,
    p_subtotal,
    p_discount,
    p_discount_note,
    p_total,
    p_note,
    p_items
  );

  update orders
     set customer_id = p_customer_id
   where id = v_order_id
     and store_id = p_store_id;

  if p_coupon_id is not null then
    select *
      into v_coupon
      from coupons
     where id = p_coupon_id
       and organization_id = p_organization_id
       and store_id = p_store_id
     for update;

    if not found then
      raise exception 'คูปองไม่ถูกต้อง';
    end if;
    if v_coupon.is_active is not true then
      raise exception 'คูปองนี้ปิดใช้งานแล้ว';
    end if;
    if v_coupon.starts_at is not null and now() < v_coupon.starts_at then
      raise exception 'คูปองนี้ยังไม่เริ่มใช้งาน';
    end if;
    if v_coupon.ends_at is not null and now() > v_coupon.ends_at then
      raise exception 'คูปองนี้หมดอายุแล้ว';
    end if;
    if p_subtotal < v_coupon.min_subtotal then
      raise exception 'ยอดซื้อยังไม่ถึงขั้นต่ำของคูปอง';
    end if;

    v_manual_discount := round(coalesce(p_discount, 0) - coalesce(p_coupon_discount_amount, 0), 2);
    if v_manual_discount < 0 then
      raise exception 'ยอดส่วนลดคูปองไม่ถูกต้อง';
    end if;
    if v_manual_discount > 0 and v_coupon.stackable_with_manual_discount is not true then
      raise exception 'คูปองนี้ใช้ร่วมกับส่วนลดท้ายบิลไม่ได้';
    end if;
    v_coupon_base := greatest(0, p_subtotal - v_manual_discount);
    if v_coupon.discount_type = 'percentage' then
      if v_coupon.discount_value > 100 then
        raise exception 'มูลค่าคูปองไม่ถูกต้อง';
      end if;
      v_expected_coupon_discount := round(least(v_coupon_base, v_coupon_base * (v_coupon.discount_value / 100)), 2);
    elsif v_coupon.discount_type = 'amount' then
      v_expected_coupon_discount := round(least(v_coupon_base, v_coupon.discount_value), 2);
    else
      raise exception 'ประเภทคูปองไม่ถูกต้อง';
    end if;

    if p_coupon_discount_amount <= 0
      or p_coupon_discount_amount > p_discount
      or round(p_coupon_discount_amount, 2) is distinct from v_expected_coupon_discount then
      raise exception 'ยอดส่วนลดคูปองไม่ถูกต้อง';
    end if;
    if array_length(v_coupon.customer_ids, 1) is not null
      and (p_customer_id is null or not (p_customer_id = any(v_coupon.customer_ids))) then
      raise exception 'คูปองนี้ใช้ได้เฉพาะลูกค้าที่กำหนด';
    end if;

    select count(*)
      into v_coupon_redemption_count
      from coupon_redemptions
     where coupon_id = p_coupon_id
       and store_id = p_store_id
       and voided_at is null;
    if v_coupon.max_redemptions is not null
      and v_coupon_redemption_count >= v_coupon.max_redemptions then
      raise exception 'คูปองนี้ถูกใช้ครบจำนวนแล้ว';
    end if;

    if p_customer_id is not null then
      select count(*)
        into v_customer_coupon_count
        from coupon_redemptions
       where coupon_id = p_coupon_id
         and customer_id = p_customer_id
         and store_id = p_store_id
         and voided_at is null;
      if v_coupon.max_redemptions_per_customer is not null
        and v_customer_coupon_count >= v_coupon.max_redemptions_per_customer then
        raise exception 'ลูกค้าคนนี้ใช้คูปองครบจำนวนแล้ว';
      end if;
    end if;

    insert into coupon_redemptions (
      organization_id,
      store_id,
      coupon_id,
      customer_id,
      order_id,
      discount_amount,
      idempotency_key
    )
    values (
      p_organization_id,
      p_store_id,
      p_coupon_id,
      p_customer_id,
      v_order_id,
      p_coupon_discount_amount,
      v_idempotency_key || ':coupon'
    );

    update orders
       set coupon_id = p_coupon_id,
           coupon_discount_amount = p_coupon_discount_amount
     where id = v_order_id
       and store_id = p_store_id;
  end if;

  return v_order_id;
end;
$$;

revoke execute on function create_grocery_pos_order_with_rewards(
  uuid, uuid, text, uuid, uuid, uuid, numeric, numeric, numeric, text, numeric, text, jsonb, text
) from public;
revoke execute on function create_grocery_pos_order_with_rewards(
  uuid, uuid, text, uuid, uuid, uuid, numeric, numeric, numeric, text, numeric, text, jsonb, text
) from anon;
grant execute on function create_grocery_pos_order_with_rewards(
  uuid, uuid, text, uuid, uuid, uuid, numeric, numeric, numeric, text, numeric, text, jsonb, text
) to authenticated;

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
  v_points integer := 0;
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

      v_points := floor(v_order.total * v_points_per_currency)::integer;
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

create or replace function void_grocery_pos_order_with_rewards(
  p_order_id uuid,
  p_store_id uuid,
  p_voided_by_user_id uuid,
  p_reason text default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_entry loyalty_ledger%rowtype;
  v_reversal_id uuid;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
begin
  select *
    into v_order
    from orders
   where id = p_order_id
     and store_id = p_store_id
     and status in ('pending_payment', 'open')
   for update;

  if not found then
    raise exception 'ไม่สามารถยกเลิกออร์เดอร์นี้ได้';
  end if;

  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนยกเลิกออร์เดอร์';
  end if;

  if p_voided_by_user_id <> auth.uid() then
    raise exception 'ผู้ยกเลิกออร์เดอร์ไม่ถูกต้อง';
  end if;

  if not auth_user_role_in_store(v_order.organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์ยกเลิกออร์เดอร์นี้';
  end if;

  update coupon_redemptions
     set voided_at = now()
   where order_id = p_order_id
     and store_id = p_store_id
     and voided_at is null;

  for v_entry in
    select *
      from loyalty_ledger
     where order_id = p_order_id
       and store_id = p_store_id
       and type in ('earn', 'redeem')
  loop
    v_reversal_id := null;
    insert into loyalty_ledger (
      organization_id,
      store_id,
      account_id,
      customer_id,
      order_id,
      type,
      points_delta,
      reason,
      reversed_entry_id,
      idempotency_key
    )
    values (
      v_entry.organization_id,
      v_entry.store_id,
      v_entry.account_id,
      v_entry.customer_id,
      v_entry.order_id,
      'reversal',
      -v_entry.points_delta,
      coalesce(v_reason, 'void_order'),
      v_entry.id,
      coalesce(v_idempotency_key, p_order_id::text || ':void') || ':' || v_entry.id::text || ':reversal'
    )
    on conflict (store_id, idempotency_key) do nothing
    returning id into v_reversal_id;

    if v_reversal_id is not null then
      update loyalty_accounts
         set points_balance = greatest(0, points_balance - v_entry.points_delta),
             updated_at = now()
       where id = v_entry.account_id
         and store_id = p_store_id;
    end if;
  end loop;

  update orders
     set status = 'voided',
         voided_at = now(),
         void_reason = coalesce(v_reason, 'void_order'),
         voided_by_user_id = p_voided_by_user_id
   where id = p_order_id
     and store_id = p_store_id;

  return p_order_id;
end;
$$;

revoke execute on function void_grocery_pos_order_with_rewards(uuid, uuid, uuid, text, text) from public;
revoke execute on function void_grocery_pos_order_with_rewards(uuid, uuid, uuid, text, text) from anon;
grant execute on function void_grocery_pos_order_with_rewards(uuid, uuid, uuid, text, text) to authenticated;
