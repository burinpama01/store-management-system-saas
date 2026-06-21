-- Preserve failed offline replay attempts in pos_sync_operations.
-- The first Phase 4 function raised after updating status='failed', which rolls
-- back the whole transaction. Returning null lets the server route surface a
-- replay error while keeping the operation log for retry/debugging.

create or replace function replay_grocery_pos_create_order_with_sync(
  p_organization_id uuid,
  p_store_id uuid,
  p_device_key text,
  p_catalog_version text,
  p_operation_payload jsonb,
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
  v_device_key text := nullif(trim(coalesce(p_device_key, '')), '');
  v_catalog_version text := nullif(trim(coalesce(p_catalog_version, '')), '');
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_device_id uuid;
  v_operation_id uuid;
  v_order_id uuid;
  v_existing_order_id uuid;
  v_existing_status text;
begin
  if not auth_user_role_in_store(p_organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์ sync offline POS';
  end if;
  if v_device_key is null then
    raise exception 'ต้องมี POS device id สำหรับ offline sync';
  end if;
  if v_catalog_version is null then
    raise exception 'ต้องมี catalog version สำหรับ offline sync';
  end if;
  if v_idempotency_key is null then
    raise exception 'ต้องมี idempotency key สำหรับ offline sync';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text || ':' || v_idempotency_key, 0));

  insert into pos_devices (
    organization_id,
    store_id,
    device_key,
    label,
    last_seen_at
  )
  values (
    p_organization_id,
    p_store_id,
    v_device_key,
    'Grocery POS',
    now()
  )
  on conflict (store_id, device_key) do update
    set last_seen_at = excluded.last_seen_at
  returning id into v_device_id;

  select result_order_id, status
    into v_existing_order_id, v_existing_status
    from pos_sync_operations
   where store_id = p_store_id
     and idempotency_key = v_idempotency_key
   for update;

  if v_existing_status = 'succeeded' and v_existing_order_id is not null then
    return v_existing_order_id;
  end if;

  insert into pos_sync_operations (
    organization_id,
    store_id,
    device_id,
    operation_type,
    status,
    idempotency_key,
    catalog_version,
    payload,
    attempt_count,
    last_attempt_at
  )
  values (
    p_organization_id,
    p_store_id,
    v_device_id,
    'create_order',
    'processing',
    v_idempotency_key,
    v_catalog_version,
    coalesce(p_operation_payload, '{}'::jsonb),
    1,
    now()
  )
  on conflict (store_id, idempotency_key) do update
    set device_id = excluded.device_id,
        status = 'processing',
        catalog_version = excluded.catalog_version,
        payload = excluded.payload,
        error_message = null,
        attempt_count = pos_sync_operations.attempt_count + 1,
        last_attempt_at = now(),
        updated_at = now()
  returning id into v_operation_id;

  begin
    v_order_id := create_grocery_pos_order_with_rewards(
      p_organization_id,
      p_store_id,
      p_order_number,
      p_cashier_id,
      p_customer_id,
      p_coupon_id,
      p_coupon_discount_amount,
      p_subtotal,
      p_discount,
      p_discount_note,
      p_total,
      p_note,
      p_items,
      v_idempotency_key
    );

    update pos_sync_operations
       set status = 'succeeded',
           result_order_id = v_order_id,
           error_message = null,
           updated_at = now()
     where id = v_operation_id;

    return v_order_id;
  exception when others then
    update pos_sync_operations
       set status = 'failed',
           error_message = sqlerrm,
           updated_at = now()
     where id = v_operation_id;
    return null;
  end;
end;
$$;

create or replace function record_grocery_pos_sync_conflict(
  p_organization_id uuid,
  p_store_id uuid,
  p_device_key text,
  p_catalog_version text,
  p_operation_payload jsonb,
  p_idempotency_key text,
  p_error_message text default 'catalog_conflict'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_key text := nullif(trim(coalesce(p_device_key, '')), '');
  v_catalog_version text := nullif(trim(coalesce(p_catalog_version, '')), '');
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_device_id uuid;
  v_operation_id uuid;
begin
  if not auth_user_role_in_store(p_organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์ sync offline POS';
  end if;
  if v_device_key is null then
    raise exception 'ต้องมี POS device id สำหรับ offline sync';
  end if;
  if v_catalog_version is null then
    raise exception 'ต้องมี catalog version สำหรับ offline sync';
  end if;
  if v_idempotency_key is null then
    raise exception 'ต้องมี idempotency key สำหรับ offline sync';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text || ':' || v_idempotency_key, 0));

  insert into pos_devices (
    organization_id,
    store_id,
    device_key,
    label,
    last_seen_at
  )
  values (
    p_organization_id,
    p_store_id,
    v_device_key,
    'Grocery POS',
    now()
  )
  on conflict (store_id, device_key) do update
    set last_seen_at = excluded.last_seen_at
  returning id into v_device_id;

  insert into pos_sync_operations (
    organization_id,
    store_id,
    device_id,
    operation_type,
    status,
    idempotency_key,
    catalog_version,
    payload,
    error_message,
    attempt_count,
    last_attempt_at
  )
  values (
    p_organization_id,
    p_store_id,
    v_device_id,
    'create_order',
    'conflict',
    v_idempotency_key,
    v_catalog_version,
    coalesce(p_operation_payload, '{}'::jsonb),
    coalesce(nullif(trim(p_error_message), ''), 'catalog_conflict'),
    1,
    now()
  )
  on conflict (store_id, idempotency_key) do update
    set device_id = excluded.device_id,
        status = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.status
          else 'conflict'
        end,
        catalog_version = excluded.catalog_version,
        payload = excluded.payload,
        error_message = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.error_message
          else excluded.error_message
        end,
        attempt_count = pos_sync_operations.attempt_count + 1,
        last_attempt_at = now(),
        updated_at = now()
  returning id into v_operation_id;

  return v_operation_id;
end;
$$;

drop policy if exists "pos_devices: cashier+ can write" on pos_devices;
drop policy if exists "pos_sync_operations: cashier+ can write" on pos_sync_operations;

revoke insert, update, delete on pos_devices from public;
revoke insert, update, delete on pos_devices from anon;
revoke insert, update, delete on pos_devices from authenticated;

revoke insert, update, delete on pos_sync_operations from public;
revoke insert, update, delete on pos_sync_operations from anon;
revoke insert, update, delete on pos_sync_operations from authenticated;

revoke execute on function replay_grocery_pos_create_order_with_sync(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  text,
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  text,
  jsonb,
  text
) from public;

revoke execute on function replay_grocery_pos_create_order_with_sync(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  text,
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  text,
  jsonb,
  text
) from anon;

grant execute on function replay_grocery_pos_create_order_with_sync(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  text,
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  text,
  jsonb,
  text
) to authenticated;

revoke execute on function record_grocery_pos_sync_conflict(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  text,
  text
) from public;

revoke execute on function record_grocery_pos_sync_conflict(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  text,
  text
) from anon;

grant execute on function record_grocery_pos_sync_conflict(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  text,
  text
) to authenticated;
