-- Customer self-open table (QR ordering v2): a store can let customers open the
-- table session themselves by placing the first order, instead of staff opening it.
--
-- Note: customer_self only applies to qr_ordering_mode = 'table_bound'. The
-- session_printed mode is staff-driven (staff prints the QR carrying ?s=) so it
-- stays staff_only. The à la carte session is just the timed window on the table
-- row (session_expires_at) — we do NOT set tables.current_session_id (that column
-- is an FK to buffet_sessions and is only used for buffet/session_printed flows).

alter table stores
  add column if not exists table_open_policy text not null default 'staff_only'
    check (table_open_policy in ('staff_only', 'customer_self'));

-- Open a timed session for the table on behalf of the customer. Enforces the
-- store policy/mode at the DB level, is idempotent (reuses an active session),
-- and is callable only by the server (service_role) — never by anon/customers
-- directly. Returns the session expiry timestamp.
create or replace function open_table_session_self(
  p_store_id uuid,
  p_table_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_minutes integer;
  v_mode text;
  v_policy text;
  v_is_active boolean;
  v_expires timestamptz;
begin
  select dine_in_duration_minutes, qr_ordering_mode, table_open_policy, is_active
    into v_minutes, v_mode, v_policy, v_is_active
    from stores
   where id = p_store_id;
  if not found then
    raise exception 'ไม่พบร้าน';
  end if;
  if not v_is_active then
    raise exception 'ร้านปิดอยู่';
  end if;
  if v_mode <> 'table_bound' or v_policy <> 'customer_self' then
    raise exception 'ร้านนี้ไม่อนุญาตให้ลูกค้าเปิดโต๊ะเอง';
  end if;

  -- Lock the table row to serialise concurrent first-orders.
  select session_expires_at
    into v_expires
    from tables
   where id = p_table_id and store_id = p_store_id and is_active = true and qr_enabled = true
     for update;
  if not found then
    raise exception 'ไม่พบโต๊ะ';
  end if;

  -- Reuse a still-valid session (idempotent — two simultaneous orders share one).
  if v_expires is not null and v_expires > now() then
    return v_expires;
  end if;

  v_expires := now() + make_interval(mins => coalesce(v_minutes, 120));
  update tables
     set status = 'occupied',
         session_started_at = now(),
         session_expires_at = v_expires,
         updated_at = now()
   where id = p_table_id and store_id = p_store_id;

  return v_expires;
end;
$$;

revoke execute on function open_table_session_self(uuid, uuid) from public, anon, authenticated;
grant execute on function open_table_session_self(uuid, uuid) to service_role;
