-- QR order full cycle (#6): kitchen prep status, customer service requests, realtime.

-- Kitchen/fulfillment progress, independent of the payment status machine.
alter table orders
  add column if not exists prep_status text not null default 'new'
    check (prep_status in ('new','preparing','served','done'));

-- Customer "call staff" / "request bill" signals from a table.
create table if not exists service_requests (
  id                 uuid primary key default uuid_generate_v4(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  store_id           uuid not null references stores(id) on delete cascade,
  table_id           uuid not null references tables(id) on delete cascade,
  table_number       text not null,
  type               text not null check (type in ('call_staff','request_bill')),
  status             text not null default 'pending' check (status in ('pending','resolved')),
  note               text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by_user_id uuid
);
create index service_requests_store_status_idx on service_requests(store_id, status);
create index service_requests_created_at_idx on service_requests(created_at desc);

-- At most one pending request of a given type per table at a time.
create unique index service_requests_one_pending_per_table_type
  on service_requests(table_id, type)
  where status = 'pending';

alter table service_requests enable row level security;

create policy "service_requests: store member can read"
  on service_requests for select
  using (store_id in (select auth_user_store_ids()));

-- Inserts come from anonymous customers via SECURITY DEFINER RPC; deny direct client insert.
create policy "service_requests: deny client insert"
  on service_requests for insert with check (false);

create policy "service_requests: cashier+ can update"
  on service_requests for update
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'))
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

-- Anonymous customer raises a service request for an active QR table.
create or replace function create_service_request(
  p_store_id uuid,
  p_table_id uuid,
  p_type text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_table_number text;
  v_request_id uuid;
begin
  if p_type not in ('call_staff','request_bill') then
    raise exception 'ประเภทคำขอไม่ถูกต้อง';
  end if;

  select organization_id
    into v_org_id
    from stores
    where id = p_store_id
      and is_active = true
      and qr_ordering_enabled = true;
  if not found then
    raise exception 'ร้านไม่พร้อมรับคำขอ';
  end if;

  select number
    into v_table_number
    from tables
    where id = p_table_id
      and organization_id = v_org_id
      and store_id = p_store_id
      and is_active = true
      and qr_enabled = true;
  if not found then
    raise exception 'โต๊ะไม่ถูกต้อง';
  end if;

  -- Collapse onto an existing pending request of the same type (idempotent tap).
  insert into service_requests (
    organization_id,
    store_id,
    table_id,
    table_number,
    type,
    note
  )
  values (
    v_org_id,
    p_store_id,
    p_table_id,
    v_table_number,
    p_type,
    nullif(btrim(coalesce(p_note, '')), '')
  )
  on conflict (table_id, type) where (status = 'pending')
  do update set created_at = now(), note = excluded.note
  returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke execute on function create_service_request(uuid, uuid, text, text) from public;
grant execute on function create_service_request(uuid, uuid, text, text) to anon, authenticated, service_role;

-- Enable realtime so the restaurant board reacts to new QR orders / service requests.
do $$
begin
  begin
    alter publication supabase_realtime add table orders;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table service_requests;
  exception when duplicate_object then null;
  end;
end $$;
