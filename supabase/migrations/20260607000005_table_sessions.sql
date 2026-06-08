-- Timed table sessions: opening a table (buffet or à la carte) grants a QR valid for a limited time.

-- Per-table open-session window. Customer QR ordering is gated on session_expires_at > now().
alter table tables
  add column if not exists session_started_at timestamptz,
  add column if not exists session_expires_at timestamptz;

-- Store-level default ordering window for à la carte table opens (buffet uses the package duration).
alter table stores
  add column if not exists dine_in_duration_minutes integer not null default 120
    check (dine_in_duration_minutes between 15 and 600);

-- Open a table session for a fixed number of minutes (cashier+). Sets the QR validity window.
create or replace function open_table_session(
  p_store_id uuid,
  p_table_id uuid,
  p_minutes integer
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;
  if p_minutes is null or p_minutes < 15 or p_minutes > 600 then
    raise exception 'ระยะเวลาไม่ถูกต้อง (15–600 นาที)';
  end if;

  select organization_id into v_org_id
    from tables
    where id = p_table_id and store_id = p_store_id and is_active = true;
  if not found then
    raise exception 'ไม่พบโต๊ะ';
  end if;

  if not auth_user_role_in_store(v_org_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์เปิดโต๊ะ';
  end if;

  v_expires := now() + make_interval(mins => p_minutes);

  update tables
     set status = 'occupied',
         session_started_at = now(),
         session_expires_at = v_expires,
         updated_at = now()
   where id = p_table_id and store_id = p_store_id;

  return v_expires;
end;
$$;

-- Close a table session (clears the QR window, frees the table).
create or replace function close_table_session(
  p_store_id uuid,
  p_table_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  select organization_id into v_org_id
    from tables
    where id = p_table_id and store_id = p_store_id;
  if not found then
    raise exception 'ไม่พบโต๊ะ';
  end if;

  if not auth_user_role_in_store(v_org_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์ปิดโต๊ะ';
  end if;

  update tables
     set status = 'available',
         session_started_at = null,
         session_expires_at = null,
         updated_at = now()
   where id = p_table_id and store_id = p_store_id;
end;
$$;

revoke execute on function open_table_session(uuid, uuid, integer) from public, anon;
grant execute on function open_table_session(uuid, uuid, integer) to authenticated;
revoke execute on function close_table_session(uuid, uuid) from public, anon;
grant execute on function close_table_session(uuid, uuid) to authenticated;
