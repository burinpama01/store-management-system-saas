-- ============================================================
-- QR Ordering: Music Request (Enterprise) + QR session mode.
--
-- Adds two store-level capabilities:
--   1. qr_ordering_mode  — 'table_bound' (permanent table QR) vs
--      'session_printed' (temporary QR printed when a table is opened;
--      expires once the session is cleared / the bill is settled).
--   2. Music Request      — customers request songs from the QR page.
--      Enterprise plan + approved license + store toggle required.
--
-- Customer writes go through the SECURITY DEFINER RPC create_music_request,
-- which enforces the Enterprise/license/session gate server-side. Staff
-- decisions go through decide_music_request (cashier+). Direct client
-- inserts are denied; staff reads/updates are RLS-scoped to their store.
-- ============================================================

-- 1. Store flags ------------------------------------------------------------
alter table stores
  add column if not exists qr_ordering_mode text not null default 'table_bound'
    check (qr_ordering_mode in ('table_bound', 'session_printed')),
  add column if not exists music_request_enabled boolean not null default false,
  add column if not exists music_license_status text not null default 'not_requested'
    check (music_license_status in ('not_requested', 'pending', 'approved', 'rejected', 'expired')),
  add column if not exists music_license_approved_at timestamptz,
  add column if not exists music_license_note text;

-- 2. Music request tables ---------------------------------------------------
create table if not exists music_requests (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  table_id uuid references tables(id) on delete set null,
  table_number text,
  session_id uuid,
  requester_label text,
  song_title text not null,
  artist_name text,
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'played', 'rejected', 'skipped', 'expired')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  played_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists music_requests_store_status_created_idx
  on music_requests(store_id, status, requested_at desc);

create table if not exists music_request_audit_logs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  music_request_id uuid references music_requests(id) on delete set null,
  actor_user_id uuid references auth.users(id),
  actor_type text not null check (actor_type in ('customer', 'staff', 'system')),
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists music_request_audit_logs_store_created_idx
  on music_request_audit_logs(store_id, created_at desc);

-- 3. RLS --------------------------------------------------------------------
alter table music_requests enable row level security;
alter table music_request_audit_logs enable row level security;

-- Staff: read requests for stores they belong to.
create policy "music_requests: store member can read"
  on music_requests for select
  using (store_id in (select auth_user_store_ids()));

-- Customers insert only through the SECURITY DEFINER RPC; deny direct insert.
create policy "music_requests: deny client insert"
  on music_requests for insert with check (false);

-- Staff: cashier+ can update queue status (also done via decide_music_request).
create policy "music_requests: cashier+ can update"
  on music_requests for update
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'))
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

-- Audit logs: store members read; writes go through RPCs only.
create policy "music_request_audit_logs: store member can read"
  on music_request_audit_logs for select
  using (store_id in (select auth_user_store_ids()));

create policy "music_request_audit_logs: deny client insert"
  on music_request_audit_logs for insert with check (false);

-- 4. Customer submit RPC ----------------------------------------------------
-- Enforces Enterprise plan + approved license + store toggle + QR session gate.
create or replace function create_music_request(
  p_store_id uuid,
  p_table_id uuid,
  p_session_id uuid,
  p_song_title text,
  p_artist_name text default null,
  p_requester_label text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_qr_mode text;
  v_music_enabled boolean;
  v_license_status text;
  v_plan text;
  v_sub_status text;
  v_table_number text;
  v_current_session_id uuid;
  v_session_expires_at timestamptz;
  v_song text;
  v_artist text;
  v_requester text;
  v_note text;
  v_request_id uuid;
begin
  -- Resolve store + music config.
  select organization_id, qr_ordering_mode, music_request_enabled, music_license_status
    into v_org_id, v_qr_mode, v_music_enabled, v_license_status
    from stores
    where id = p_store_id
      and is_active = true
      and qr_ordering_enabled = true;
  if not found then
    raise exception 'ร้านไม่พร้อมรับคำขอ';
  end if;

  -- Enterprise plan gate (active / trialing / past_due grace).
  select plan, status
    into v_plan, v_sub_status
    from subscriptions
    where organization_id = v_org_id
    order by created_at desc
    limit 1;
  if v_plan is distinct from 'enterprise'
     or v_sub_status not in ('active', 'trialing', 'past_due') then
    raise exception 'ฟีเจอร์ขอเพลงสำหรับแพ็กเกจ Enterprise เท่านั้น';
  end if;

  -- License + store toggle gate.
  if v_music_enabled is not true or v_license_status <> 'approved' then
    raise exception 'ร้านนี้ยังไม่เปิดให้ขอเพลง';
  end if;

  -- Resolve table + session window.
  select number, current_session_id, session_expires_at
    into v_table_number, v_current_session_id, v_session_expires_at
    from tables
    where id = p_table_id
      and organization_id = v_org_id
      and store_id = p_store_id
      and is_active = true
      and qr_enabled = true;
  if not found then
    raise exception 'โต๊ะไม่ถูกต้อง';
  end if;

  -- QR session gate. table_bound: always allowed (even after checkout).
  -- session_printed: query session must match the active session.
  if v_qr_mode = 'session_printed' then
    if v_current_session_id is null
       or p_session_id is null
       or p_session_id <> v_current_session_id
       or (v_session_expires_at is not null and v_session_expires_at <= now()) then
      raise exception 'QR หมดอายุแล้ว กรุณาขอ QR ใหม่จากพนักงาน';
    end if;
  end if;

  -- Validate + normalize input.
  v_song := btrim(coalesce(p_song_title, ''));
  if char_length(v_song) < 1 or char_length(v_song) > 120 then
    raise exception 'ชื่อเพลงต้องมีความยาว 1-120 ตัวอักษร';
  end if;
  v_artist := nullif(btrim(coalesce(p_artist_name, '')), '');
  if v_artist is not null and char_length(v_artist) > 120 then
    raise exception 'ชื่อศิลปินยาวเกินไป';
  end if;
  v_requester := nullif(btrim(coalesce(p_requester_label, '')), '');
  if v_requester is not null and char_length(v_requester) > 60 then
    raise exception 'ชื่อผู้ขอยาวเกินไป';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 240 then
    raise exception 'หมายเหตุยาวเกินไป';
  end if;

  insert into music_requests (
    store_id, organization_id, table_id, table_number, session_id,
    requester_label, song_title, artist_name, note
  )
  values (
    p_store_id, v_org_id, p_table_id, v_table_number, v_current_session_id,
    v_requester, v_song, v_artist, v_note
  )
  returning id into v_request_id;

  insert into music_request_audit_logs (
    store_id, music_request_id, actor_user_id, actor_type, action, details
  )
  values (
    p_store_id, v_request_id, null, 'customer', 'submitted',
    jsonb_build_object('table_id', p_table_id, 'qr_mode', v_qr_mode)
  );

  return v_request_id;
end;
$$;

revoke execute on function create_music_request(uuid, uuid, uuid, text, text, text, text) from public;
grant execute on function create_music_request(uuid, uuid, uuid, text, text, text, text)
  to anon, authenticated, service_role;

-- 5. Staff decision RPC -----------------------------------------------------
-- approve / reject / play / skip — cashier+ in the request's store. Audited.
create or replace function decide_music_request(
  p_request_id uuid,
  p_action text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_org_id uuid;
  v_new_status text;
begin
  select store_id, organization_id
    into v_store_id, v_org_id
    from music_requests
    where id = p_request_id;
  if not found then
    raise exception 'ไม่พบคำขอเพลง';
  end if;

  if not auth_user_role_in_store(v_org_id, v_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์จัดการคิวเพลง';
  end if;

  v_new_status := case p_action
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'play' then 'played'
    when 'skip' then 'skipped'
    else null
  end;
  if v_new_status is null then
    raise exception 'การกระทำไม่ถูกต้อง';
  end if;

  update music_requests
    set status = v_new_status,
        decided_at = now(),
        decided_by = auth.uid(),
        played_at = case when v_new_status = 'played' then now() else played_at end,
        updated_at = now()
    where id = p_request_id;

  insert into music_request_audit_logs (
    store_id, music_request_id, actor_user_id, actor_type, action, details
  )
  values (
    v_store_id, p_request_id, auth.uid(), 'staff', p_action,
    jsonb_build_object('status', v_new_status)
  );
end;
$$;

revoke execute on function decide_music_request(uuid, text) from public, anon;
grant execute on function decide_music_request(uuid, text) to authenticated, service_role;

-- 6. Realtime ---------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table music_requests;
  exception when duplicate_object then null;
  end;
end $$;
