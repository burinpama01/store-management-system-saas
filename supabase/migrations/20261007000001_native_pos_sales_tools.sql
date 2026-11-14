-- Additive native wrapper. Legacy checkout/cancellation retain their signatures.
create or replace function public.create_native_pos_rewards_order(
  p_store_id uuid, p_key text, p_actor_id uuid, p_order_number text,
  p_total numeric, p_items jsonb, p_subtotal numeric, p_discount numeric,
  p_discount_note text, p_customer_id uuid, p_coupon_id uuid, p_coupon_discount_amount numeric
)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_id uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  v_org := assert_native_pos_operation(p_store_id, p_key, p_actor_id);
  perform pg_advisory_xact_lock(hashtext(p_store_id::text || ':' || p_key));
  if exists (select 1 from native_pos_cancelled_operations where store_id = p_store_id and operation_key = p_key)
    then raise exception 'native_operation_cancelled'; end if;
  if p_total <= 0 or p_discount < 0 or p_coupon_discount_amount < 0
    or round(p_subtotal - p_discount, 2) is distinct from round(p_total, 2)
    then raise exception 'invalid_native_totals'; end if;
  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_actor_id, 'role', 'authenticated')::text, true);
  v_id := create_pos_order_with_customer_rewards(
    p_organization_id => v_org, p_store_id => p_store_id, p_order_number => p_order_number,
    p_cashier_id => p_actor_id, p_subtotal => p_subtotal, p_discount => p_discount,
    p_discount_note => p_discount_note, p_total => p_total, p_items => p_items,
    p_customer_id => p_customer_id, p_coupon_id => p_coupon_id,
    p_coupon_discount_amount => p_coupon_discount_amount, p_idempotency_key => p_key
  );
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_id;
end; $$;
revoke all on function public.create_native_pos_rewards_order(uuid,text,uuid,text,numeric,jsonb,numeric,numeric,text,uuid,uuid,numeric) from public,anon,authenticated;
grant execute on function public.create_native_pos_rewards_order(uuid,text,uuid,text,numeric,jsonb,numeric,numeric,text,uuid,uuid,numeric) to service_role;
