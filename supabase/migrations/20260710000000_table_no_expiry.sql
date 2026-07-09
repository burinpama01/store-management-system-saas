-- เปิดโต๊ะแบบไม่จับเวลา (2026-07-10)
-- open_table_session รับ p_minutes = null → เปิดโต๊ะโดยไม่ตั้งเวลาหมดอายุ
-- (session_expires_at = null แต่ session_started_at ถูกเซ็ต + status='occupied')
-- ด่านเช็คของ QR ฝั่งแอปจะตีความว่า "เปิดอยู่" เมื่อ session_started_at ไม่ null และ
-- (session_expires_at เป็น null หรือ ยังไม่ถึงเวลาหมด)

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
  -- p_minutes null = ไม่จับเวลา; ถ้ามีค่าต้องอยู่ในช่วง 15–600 นาที
  if p_minutes is not null and (p_minutes < 15 or p_minutes > 600) then
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

  v_expires := case
    when p_minutes is null then null
    else now() + make_interval(mins => p_minutes)
  end;

  update tables
     set status = 'occupied',
         session_started_at = now(),
         session_expires_at = v_expires,
         updated_at = now()
   where id = p_table_id and store_id = p_store_id;

  return v_expires;
end;
$$;

revoke execute on function open_table_session(uuid, uuid, integer) from public, anon;
grant execute on function open_table_session(uuid, uuid, integer) to authenticated;

-- ค่าเริ่มต้นระดับร้าน: เปิดโต๊ะแบบไม่จับเวลาโดยดีฟอลต์
alter table stores
  add column if not exists dine_in_no_expiry boolean not null default false;
