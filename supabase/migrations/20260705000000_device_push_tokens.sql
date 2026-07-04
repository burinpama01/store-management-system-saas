-- Push notification device tokens (mobile app) + เปิด channel 'push' ใน notification_settings

create table if not exists device_push_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid references stores(id) on delete set null,
  platform text not null check (platform in ('android', 'ios')),
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists device_push_tokens_org_idx
  on device_push_tokens(organization_id);
create index if not exists device_push_tokens_user_idx
  on device_push_tokens(user_id);

alter table device_push_tokens enable row level security;

-- เจ้าของ token จัดการ token ของตัวเองเท่านั้น; การส่ง push อ่านผ่าน service role
create policy "device_push_tokens: user manages own"
  on device_push_tokens for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger set_updated_at before update on device_push_tokens
  for each row execute function set_updated_at();

-- ขยาย channel ให้รองรับ push (constraint เดิม inline ไม่มีชื่อ → ชื่ออัตโนมัติ)
alter table notification_settings
  drop constraint if exists notification_settings_channel_check;
alter table notification_settings
  add constraint notification_settings_channel_check
  check (channel in ('line', 'telegram', 'push'));
