-- Cash sessions: opening float / closing count with POS cash reconciliation (#7).

create table if not exists cash_sessions (
  id                 uuid primary key default uuid_generate_v4(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  store_id           uuid not null references stores(id) on delete cascade,
  status             text not null default 'open' check (status in ('open','closed')),
  opening_float      numeric(12,2) not null default 0 check (opening_float >= 0),
  opened_by_user_id  uuid not null,
  opened_at          timestamptz not null default now(),
  open_note          text,
  closing_count      numeric(12,2) check (closing_count >= 0),
  cash_sales         numeric(12,2),
  expected_cash      numeric(12,2),
  variance           numeric(12,2),
  closed_by_user_id  uuid,
  closed_at          timestamptz,
  close_note         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index cash_sessions_store_id_idx on cash_sessions(store_id);
create index cash_sessions_status_idx on cash_sessions(store_id, status);
create index cash_sessions_opened_at_idx on cash_sessions(opened_at desc);

-- Only one open session per store at a time.
create unique index cash_sessions_one_open_per_store
  on cash_sessions(store_id)
  where status = 'open';

alter table cash_sessions enable row level security;

create policy "cash_sessions: store member can read"
  on cash_sessions for select
  using (store_id in (select auth_user_store_ids()));

-- Writes go through SECURITY DEFINER RPCs; deny direct client writes.
create policy "cash_sessions: deny client insert"
  on cash_sessions for insert with check (false);
create policy "cash_sessions: deny client update"
  on cash_sessions for update using (false);
create policy "cash_sessions: deny client delete"
  on cash_sessions for delete using (false);

-- Open a cash session (opening float). Fails if one is already open for the store.
create or replace function open_cash_session(
  p_store_id uuid,
  p_opening_float numeric,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_session_id uuid;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  select organization_id
    into v_org_id
    from stores
    where id = p_store_id
      and is_active = true;
  if not found then
    raise exception 'ไม่พบร้านค้า';
  end if;

  if not auth_user_role_in_store(v_org_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์เปิดรอบเงินสด';
  end if;

  if p_opening_float is null or p_opening_float < 0 then
    raise exception 'ยอดเงินเปิดร้านไม่ถูกต้อง';
  end if;

  -- Serialize per store to avoid two concurrent opens racing the unique index.
  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 1));

  if exists (
    select 1 from cash_sessions
    where store_id = p_store_id and status = 'open'
  ) then
    raise exception 'มีรอบเงินสดที่เปิดอยู่แล้ว';
  end if;

  insert into cash_sessions (
    organization_id,
    store_id,
    status,
    opening_float,
    opened_by_user_id,
    open_note
  )
  values (
    v_org_id,
    p_store_id,
    'open',
    round(p_opening_float, 2),
    auth.uid(),
    nullif(btrim(coalesce(p_note, '')), '')
  )
  returning id into v_session_id;

  return v_session_id;
end;
$$;

-- Close a cash session: reconcile counted cash against opening float + POS cash sales.
create or replace function close_cash_session(
  p_session_id uuid,
  p_store_id uuid,
  p_closing_count numeric,
  p_note text default null
)
returns cash_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session cash_sessions%rowtype;
  v_cash_sales numeric := 0;
  v_expected numeric;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  select *
    into v_session
    from cash_sessions
    where id = p_session_id
      and store_id = p_store_id
    for update;
  if not found then
    raise exception 'ไม่พบรอบเงินสด';
  end if;

  if v_session.status <> 'open' then
    raise exception 'รอบเงินสดนี้ปิดไปแล้ว';
  end if;

  if not auth_user_role_in_store(v_session.organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์ปิดรอบเงินสด';
  end if;

  if p_closing_count is null or p_closing_count < 0 then
    raise exception 'ยอดเงินนับจริงไม่ถูกต้อง';
  end if;

  -- POS cash collected during the session window (net cash into drawer = payments.amount).
  select coalesce(sum(p.amount), 0)
    into v_cash_sales
    from payments p
    join orders o on o.id = p.order_id
    where o.store_id = p_store_id
      and p.method = 'cash'
      and p.status = 'completed'
      and p.processed_at >= v_session.opened_at
      and p.processed_at <= now();

  v_expected := round(v_session.opening_float + v_cash_sales, 2);

  update cash_sessions
     set status        = 'closed',
         closing_count = round(p_closing_count, 2),
         cash_sales    = round(v_cash_sales, 2),
         expected_cash = v_expected,
         variance      = round(p_closing_count, 2) - v_expected,
         closed_by_user_id = auth.uid(),
         closed_at     = now(),
         close_note    = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at    = now()
   where id = p_session_id
   returning * into v_session;

  return v_session;
end;
$$;

revoke execute on function open_cash_session(uuid, numeric, text) from public, anon;
grant execute on function open_cash_session(uuid, numeric, text) to authenticated;
revoke execute on function close_cash_session(uuid, uuid, numeric, text) from public, anon;
grant execute on function close_cash_session(uuid, uuid, numeric, text) to authenticated;
