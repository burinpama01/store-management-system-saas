-- ฟีเจอร์ชุดใหม่ (2026-07-09):
--  3+4) ศูนย์แจ้งเตือนในแอป: เก็บทุกอีเวนต์แจ้งเตือนลงตาราง notifications (ใหม่/รับเรื่องแล้ว)
--  2)   ปุ่มเรียกบริการปรับแต่งได้ (เรียกพนักงาน/ขอน้ำ/ขอน้ำจิ้ม/เช็คบิล) + เจ้าของแก้ข้อความ/เปิด-ปิด
--  5)   สินค้า "ของหมด" (out_of_stock) สำหรับปิดขายชั่วคราวหน้าร้าน/QR

-- ─── 3+4) ศูนย์แจ้งเตือนในแอป ────────────────────────────────────────────
create table if not exists notifications (
  id                 uuid primary key default uuid_generate_v4(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  store_id           uuid references stores(id) on delete cascade,
  type               text not null,
  title              text,
  message            text not null,
  metadata           jsonb not null default '{}'::jsonb,
  status             text not null default 'new' check (status in ('new','acknowledged')),
  acknowledged_by    uuid,
  acknowledged_at    timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists notifications_store_status_created_idx
  on notifications(store_id, status, created_at desc);
create index if not exists notifications_org_created_idx
  on notifications(organization_id, created_at desc);

alter table notifications enable row level security;

-- อ่านได้เฉพาะผู้จัดการขึ้นไป (manager/admin/owner) ของร้านนั้น
create policy "notifications: manager+ can read"
  on notifications for select
  using (
    store_id is not null
    and auth_user_role_in_store(organization_id, store_id, 'manager')
  );

-- อัปเดตสถานะ (รับเรื่อง) ได้เฉพาะผู้จัดการขึ้นไป
create policy "notifications: manager+ can update"
  on notifications for update
  using (
    store_id is not null
    and auth_user_role_in_store(organization_id, store_id, 'manager')
  )
  with check (
    store_id is not null
    and auth_user_role_in_store(organization_id, store_id, 'manager')
  );

-- การเขียนบันทึกมาจาก service role (dispatcher) เท่านั้น — ปิดการ insert จาก client
create policy "notifications: deny client insert"
  on notifications for insert with check (false);

-- เปิด realtime เพื่อให้ศูนย์แจ้งเตือนอัปเดตทันทีเมื่อมีอีเวนต์ใหม่
do $$
begin
  begin
    alter publication supabase_realtime add table notifications;
  exception when duplicate_object then null;
  end;
end $$;

-- ─── 2) ปุ่มเรียกบริการปรับแต่งได้ ────────────────────────────────────────
-- ขยายประเภทคำขอบริการให้รองรับ "ขอน้ำ" และ "ขอน้ำจิ้ม"
alter table service_requests drop constraint if exists service_requests_type_check;
alter table service_requests
  add constraint service_requests_type_check
  check (type in ('call_staff','request_water','request_condiment','request_bill'));

-- ปุ่มบริการที่ร้านปรับแต่งได้ (ข้อความ + เปิด/ปิด) — เก็บเป็น JSON ต่อร้าน
alter table stores
  add column if not exists qr_service_buttons jsonb not null default
    '[{"key":"call_staff","label":"เรียกพนักงาน","enabled":true},{"key":"request_water","label":"ขอน้ำเพิ่ม","enabled":true},{"key":"request_condiment","label":"ขอน้ำจิ้มเพิ่ม","enabled":true},{"key":"request_bill","label":"ขอเช็คบิล","enabled":true}]'::jsonb;

-- อัปเดตตัวตรวจประเภทใน RPC ให้รับประเภทใหม่
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
  if p_type not in ('call_staff','request_water','request_condiment','request_bill') then
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

-- ─── 5) สินค้า "ของหมด" (ปิดขายชั่วคราว) ─────────────────────────────────
alter table products
  add column if not exists out_of_stock boolean not null default false;
