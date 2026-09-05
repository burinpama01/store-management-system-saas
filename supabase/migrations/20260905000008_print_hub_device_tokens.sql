-- Print Hub auto-provision (v0.44.11) — token รายเครื่อง แทน token เดียวต่อร้าน
--
-- ปัญหาเดิม: stores.print_hub_token_hash มีช่องเดียวต่อร้าน การสร้าง token ใหม่
-- จึงทำให้ "ทุกเครื่องที่เหลือ" ใช้ไม่ได้ทันที เครื่องร้านที่เจอ 401 จึงแก้เองไม่ได้:
-- ถ้าให้ Launcher rotate อัตโนมัติ เครื่อง A จะเตะเครื่อง B หลุด แล้ว B ก็ rotate
-- กลับมาเตะ A หลุดอีก วนไม่จบ (ping-pong)
--
-- ทางแก้: แต่ละเครื่องถือ token ของตัวเอง ผูกกับ device_id ที่เสถียรของเครื่องนั้น
--   * เครื่องใหม่ provision ได้โดยไม่กระทบเครื่องเดิม
--   * เครื่องที่ token เพี้ยน provision ใหม่ได้เอง โดยเครื่องอื่นไม่รู้สึกอะไร
--   * ยกเลิกทีละเครื่องได้ (revoked_at) โดยไม่ต้องไปยุ่งกับเครื่องอื่น
--
-- stores.print_hub_token_hash เดิมยังใช้ได้ต่อ (backward compatible) — เครื่องที่ยัง
-- ถือ token เดิมไม่ต้องทำอะไร จนกว่าจะ provision ใหม่

create table if not exists public.print_hub_device_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  /** ตัวระบุเครื่องที่เสถียร (MachineGuid ของ Windows ผ่าน hash) — ไม่ใช่ข้อมูลส่วนบุคคล */
  device_id text not null check (btrim(device_id) <> '' and length(device_id) <= 128),
  /** ชื่อที่คนอ่านออกไว้ดูในหน้าตั้งค่า เช่น ชื่อเครื่อง */
  device_label text,
  token_hash text not null check (length(token_hash) = 64),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

-- หนึ่งเครื่องมี token ที่ใช้งานอยู่ได้ใบเดียว (ใบเก่าถูก revoke ก่อนออกใบใหม่เสมอ)
create unique index if not exists print_hub_device_tokens_active_unique
  on public.print_hub_device_tokens (store_id, device_id)
  where revoked_at is null;

create index if not exists print_hub_device_tokens_store_idx
  on public.print_hub_device_tokens (store_id)
  where revoked_at is null;

alter table public.print_hub_device_tokens enable row level security;

-- อ่านได้เฉพาะคนในร้าน และห้ามอ่าน token_hash ผ่าน PostgREST โดยตรง
-- (ทุกเส้นทางจริงไปผ่าน service client ใน server action/route เท่านั้น)
revoke all privileges on table public.print_hub_device_tokens from anon, authenticated;

comment on table public.print_hub_device_tokens is
  'Print Hub token รายเครื่อง — provision ใหม่ได้โดยไม่เตะเครื่องอื่นหลุด (แทน stores.print_hub_token_hash ที่มีช่องเดียว)';
