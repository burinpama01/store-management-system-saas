-- ล็อกอินเครื่องร้านด้วย QR + รหัสพนักงาน (แผน POS Launcher Direct IP Printing v2 — เฟส D2b)
--
-- ขั้นตอน: เครื่องร้าน (StoreOS POS) ขอคำขอ → แสดง QR (มีแค่ id คำขอ + รหัสสั้น)
--          → พนักงานสแกนด้วยมือถือที่ล็อกอินอยู่ กรอกรหัสพนักงานของตัวเอง → อนุมัติ
--          → เครื่องร้านถามด้วยรหัสลับของเครื่อง (ไม่อยู่ใน QR) ได้ตั๋วครั้งเดียว → แลกเป็น session
--
-- ตารางนี้อ่าน/เขียนผ่าน service role จาก API เท่านั้น (เปิด RLS ไม่มี policy = client แตะไม่ได้)

create table if not exists public.device_login_requests (
  id                 uuid primary key default gen_random_uuid(),
  short_code         text not null check (short_code ~ '^[A-Z0-9]{3}-[A-Z0-9]{3}$'),
  device_secret_hash text not null check (length(device_secret_hash) = 64),
  device_label       text check (device_label is null or length(device_label) <= 80),
  user_agent         text check (user_agent is null or length(user_agent) <= 300),
  status             text not null default 'pending'
                       check (status in ('pending', 'approved', 'completed', 'cancelled', 'expired')),
  failed_attempts    int not null default 0 check (failed_attempts >= 0),
  approved_by        uuid references auth.users(id) on delete cascade,
  approved_store_id  uuid references public.stores(id) on delete set null,
  approved_at        timestamptz,
  ticket_hash        text check (ticket_hash is null or length(ticket_hash) = 64),
  ticket_expires_at  timestamptz,
  completed_at       timestamptz,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  constraint device_login_approved_has_user check (status not in ('approved', 'completed') or approved_by is not null)
);

comment on table public.device_login_requests is
  'คำขอเข้าใช้เครื่องร้านด้วย QR (StoreOS POS) — service role เท่านั้น; QR มีแค่ id + รหัสสั้น รหัสลับเครื่องเก็บเป็น sha256';

create index if not exists device_login_requests_expires_idx on public.device_login_requests (expires_at);
create index if not exists device_login_requests_approver_idx on public.device_login_requests (approved_by, approved_at desc)
  where approved_by is not null;

alter table public.device_login_requests enable row level security;
revoke all on public.device_login_requests from anon, authenticated;
