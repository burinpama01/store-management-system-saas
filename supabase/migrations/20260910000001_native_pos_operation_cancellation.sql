-- Native POS: serialize creation and cancellation of an unknown operation.
-- Deployment prerequisite: review and apply in staging before native checkout.
create table if not exists public.native_pos_cancelled_operations (
  store_id uuid not null references public.stores(id),
  user_id uuid not null references auth.users(id),
  operation_key text not null,
  cancelled_at timestamptz not null default now(),
  primary key (store_id, operation_key)
);
alter table public.native_pos_cancelled_operations enable row level security;
revoke all on public.native_pos_cancelled_operations from public, anon, authenticated;

create or replace function public.assert_native_pos_operation(p_store_id uuid, p_key text, p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_user uuid := p_actor_id; v_prefix text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server_only'; end if;
  if v_user is null then raise exception 'unauthorized'; end if;
  v_prefix := 'native:' || p_store_id::text || ':' || v_user::text || ':';
  if p_key is null or left(p_key, length(v_prefix)) <> v_prefix
    or substring(p_key from length(v_prefix) + 1) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then raise exception 'invalid_native_operation'; end if;
  select s.organization_id into v_org from stores s
  where s.id = p_store_id and s.is_active = true and exists (
    select 1 from memberships m where m.user_id = v_user and m.organization_id = s.organization_id
      and (m.store_id is null or m.store_id = s.id) and m.joined_at is not null
  );
  if v_org is null then raise exception 'no_store_access'; end if;
  return v_org;
end; $$;
revoke all on function public.assert_native_pos_operation(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.create_native_pos_order(
  p_store_id uuid, p_key text, p_actor_id uuid, p_order_number text, p_total numeric, p_items jsonb
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
  -- Server-only entry: the API verified this actor, permissions, billing and
  -- retail choices. Give legacy validation its verified actor for this call.
  -- Transaction-local settings are restored and never returned to the client.
  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_actor_id, 'role', 'authenticated')::text, true);
  v_id := create_pos_order_with_customer_rewards(
    p_organization_id => v_org, p_store_id => p_store_id,
    p_order_number => p_order_number, p_cashier_id => p_actor_id,
    p_subtotal => p_total, p_total => p_total,
    p_items => p_items, p_idempotency_key => p_key
  );
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_id;
end; $$;
revoke all on function public.create_native_pos_order(uuid, text, uuid, text, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.create_native_pos_order(uuid, text, uuid, text, numeric, jsonb) to service_role;

create or replace function public.cancel_native_pos_operation(p_store_id uuid, p_key text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_id uuid; v_cashier uuid;
begin
  v_org := assert_native_pos_operation(p_store_id, p_key, p_actor_id);
  perform pg_advisory_xact_lock(hashtext(p_store_id::text || ':' || p_key));
  select k.order_id, o.cashier_id into v_id, v_cashier
  from pos_order_idempotency_keys k join orders o on o.id = k.order_id
  where k.store_id = p_store_id and k.organization_id = v_org and k.idempotency_key = p_key
    and o.store_id = p_store_id and o.organization_id = v_org;
  if v_id is not null then
    if v_cashier is distinct from p_actor_id then raise exception 'wrong_operation_owner'; end if;
    return jsonb_build_object('outcome', 'existing', 'orderId', v_id);
  end if;
  -- A durable tombstone prevents a delayed request from creating the order
  -- after the cashier has safely unlocked the local draft. Never deletes a sale.
  insert into native_pos_cancelled_operations(store_id, user_id, operation_key)
    values(p_store_id, p_actor_id, p_key) on conflict (store_id, operation_key) do nothing;
  return jsonb_build_object('outcome', 'not_created');
end; $$;
revoke all on function public.cancel_native_pos_operation(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.cancel_native_pos_operation(uuid, text, uuid) to service_role;
