-- ปุ่มแก้ไขข้อความแจ้งเตือน (custom template ต่อร้าน/ต่อประเภท)
-- + คอลัมน์กันแจ้ง "บุฟเฟต์ใกล้หมดเวลา" ซ้ำต่อรอบเปิดโต๊ะเดียวกัน

create table if not exists notification_templates (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  notification_type text not null check (
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
      'attendance_clock_in',
      'attendance_clock_out',
      'test'
    )
  ),
  title text,
  message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, notification_type)
);

create index if not exists notification_templates_store_id_idx
  on notification_templates(store_id);

alter table notification_templates enable row level security;

create policy "notification_templates: store member can read"
  on notification_templates for select
  using (
    exists (
      select 1 from stores
      where stores.id = notification_templates.store_id
        and stores.organization_id = notification_templates.organization_id
    )
    and (
      store_id in (select auth_user_store_ids())
      or auth_user_role_in_org(organization_id, 'owner')
    )
  );

create policy "notification_templates: manager+ can write"
  on notification_templates for all
  using (
    exists (
      select 1 from stores
      where stores.id = notification_templates.store_id
        and stores.organization_id = notification_templates.organization_id
    )
    and auth_user_role_in_store(organization_id, store_id, 'manager')
  )
  with check (
    exists (
      select 1 from stores
      where stores.id = notification_templates.store_id
        and stores.organization_id = notification_templates.organization_id
    )
    and auth_user_role_in_store(organization_id, store_id, 'manager')
  );

create trigger set_updated_at before update on notification_templates
  for each row execute function set_updated_at();

-- กันแจ้งบุฟเฟต์ใกล้หมดเวลาซ้ำ: cron เซ็ตค่านี้เมื่อแจ้งแล้ว
-- เปิดโต๊ะรอบใหม่ session_started_at จะใหม่กว่าค่านี้ → cron แจ้งได้อีกครั้งเองโดยไม่ต้อง reset
alter table tables
  add column if not exists buffet_expiry_notified_at timestamptz;
