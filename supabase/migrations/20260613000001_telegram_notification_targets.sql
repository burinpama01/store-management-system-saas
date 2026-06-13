-- Tenant-owned notification targets. Chat IDs are tenant scoped; tokens stay in env.

create table if not exists notification_targets (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  channel text not null check (channel in ('telegram')),
  telegram_chat_id text not null check (telegram_chat_id ~ '^-?[0-9]{5,32}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, channel)
);

create index if not exists notification_targets_organization_id_idx
  on notification_targets(organization_id);

alter table notification_targets enable row level security;

create policy "notification_targets: owner can read"
  on notification_targets for select
  using (auth_user_role_in_org(organization_id, 'owner'));

create policy "notification_targets: owner can write"
  on notification_targets for all
  using (auth_user_role_in_org(organization_id, 'owner'))
  with check (auth_user_role_in_org(organization_id, 'owner'));

create trigger set_updated_at before update on notification_targets
  for each row execute function set_updated_at();

alter table notification_settings
  drop constraint if exists notification_settings_notification_type_check;

alter table notification_settings
  add constraint notification_settings_notification_type_check check (
    notification_type in (
      'payment',
      'new_table',
      'new_pos_order',
      'new_qr_order',
      'new_buffet_order',
      'kitchen_order',
      'buffet_expiring',
      'stock_alert',
      'order_cancelled',
      'approval',
      'service_request',
      'test'
    )
  );

create or replace function create_buffet_session_with_table(
  p_organization_id uuid,
  p_store_id uuid,
  p_table_id uuid,
  p_package_name text,
  p_price_per_guest numeric,
  p_guest_count integer
)
returns buffet_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session buffet_sessions;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;
  if not auth_user_role_in_store(p_organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์เปิดบุฟเฟต์';
  end if;
  if p_table_id is not null and not exists (
    select 1
      from tables
     where id = p_table_id
       and store_id = p_store_id
       and organization_id = p_organization_id
       and is_active = true
  ) then
    raise exception 'ไม่พบโต๊ะนี้ในร้านค้า';
  end if;

  insert into buffet_sessions (
    organization_id,
    store_id,
    table_id,
    package_name,
    price_per_guest,
    guest_count,
    status
  )
  values (
    p_organization_id,
    p_store_id,
    p_table_id,
    p_package_name,
    p_price_per_guest,
    p_guest_count,
    'open'
  )
  returning * into v_session;

  if p_table_id is not null then
    update tables
       set current_session_id = v_session.id,
           updated_at = now()
     where id = p_table_id
       and store_id = p_store_id
       and organization_id = p_organization_id;
  end if;

  return v_session;
end;
$$;

create or replace function close_buffet_session_with_table(
  p_session_id uuid,
  p_store_id uuid
)
returns buffet_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session buffet_sessions;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  select * into v_session
    from buffet_sessions
   where id = p_session_id
     and store_id = p_store_id
     and status = 'open'
   for update;
  if not found then
    raise exception 'ไม่พบเซสชันที่เปิดอยู่';
  end if;

  if not auth_user_role_in_store(v_session.organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์ปิดบุฟเฟต์';
  end if;

  update buffet_sessions
     set status = 'closed',
         ended_at = now(),
         updated_at = now()
   where id = p_session_id
     and store_id = p_store_id
  returning * into v_session;

  if v_session.table_id is not null then
    update tables
       set current_session_id = null,
           updated_at = now()
     where id = v_session.table_id
       and store_id = p_store_id
       and current_session_id = v_session.id;
  end if;

  return v_session;
end;
$$;

revoke execute on function create_buffet_session_with_table(uuid, uuid, uuid, text, numeric, integer) from public, anon;
grant execute on function create_buffet_session_with_table(uuid, uuid, uuid, text, numeric, integer) to authenticated;
revoke execute on function close_buffet_session_with_table(uuid, uuid) from public, anon;
grant execute on function close_buffet_session_with_table(uuid, uuid) to authenticated;
