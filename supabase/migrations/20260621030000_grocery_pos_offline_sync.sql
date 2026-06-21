-- Grocery POS offline sync foundation.
-- Device-scoped operation logs prevent duplicate replay when the network comes
-- back and give cashiers a visible pending/synced/failed state.

create table if not exists pos_devices (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  device_key      text not null,
  label           text,
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (store_id, device_key)
);

create table if not exists pos_sync_operations (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  device_id       uuid not null references pos_devices(id) on delete cascade,
  operation_type  text not null check (operation_type in ('create_order')),
  status          text not null check (status in ('pending', 'processing', 'succeeded', 'failed', 'conflict')),
  idempotency_key text not null,
  catalog_version text not null,
  payload         jsonb not null default '{}'::jsonb,
  result_order_id uuid references orders(id) on delete set null,
  error_message   text,
  attempt_count   integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (store_id, idempotency_key)
);

create index if not exists pos_devices_store_last_seen_idx
  on pos_devices(store_id, last_seen_at desc);

create index if not exists pos_sync_operations_store_status_idx
  on pos_sync_operations(store_id, status, updated_at desc);

alter table pos_devices enable row level security;
alter table pos_sync_operations enable row level security;

drop policy if exists "pos_devices: store member can read" on pos_devices;
create policy "pos_devices: store member can read"
  on pos_devices for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "pos_devices: cashier+ can write" on pos_devices;
create policy "pos_devices: cashier+ can write"
  on pos_devices for all
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'))
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

drop policy if exists "pos_sync_operations: store member can read" on pos_sync_operations;
create policy "pos_sync_operations: store member can read"
  on pos_sync_operations for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "pos_sync_operations: cashier+ can write" on pos_sync_operations;
create policy "pos_sync_operations: cashier+ can write"
  on pos_sync_operations for all
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'))
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

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
    raise;
  end;
end;
$$;

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
