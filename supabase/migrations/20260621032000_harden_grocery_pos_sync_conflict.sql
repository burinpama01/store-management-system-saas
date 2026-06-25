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
    set device_id = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.device_id
          else excluded.device_id
        end,
        status = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.status
          else 'conflict'
        end,
        catalog_version = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.catalog_version
          else excluded.catalog_version
        end,
        payload = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.payload
          else excluded.payload
        end,
        error_message = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.error_message
          else excluded.error_message
        end,
        attempt_count = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.attempt_count
          else pos_sync_operations.attempt_count + 1
        end,
        last_attempt_at = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.last_attempt_at
          else now()
        end,
        updated_at = case
          when pos_sync_operations.status = 'succeeded' then pos_sync_operations.updated_at
          else now()
        end
  returning id into v_operation_id;

  return v_operation_id;
end;
$$;

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
