-- Voiding an order must give redeemed rewards back to the customer.
-- The rewards-aware void RPC already voids coupon redemptions and reverses
-- loyalty ledger entries, but product reward vouchers (loyalty_reward_redemptions,
-- reserved as fulfilled/used at order creation) stayed consumed forever.
-- This adds the voucher release, and the normal POS void switches to this RPC
-- (it previously did a plain orders-status update that stranded coupons too).

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

  -- Product reward vouchers attached to this order become usable again.
  -- Expiry still applies at next use, so releasing an expired voucher is safe.
  update loyalty_reward_redemptions
     set status = 'pending',
         used_at = null,
         used_order_id = null,
         fulfilled_at = null
   where used_order_id = p_order_id
     and store_id = p_store_id
     and status = 'fulfilled';

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
