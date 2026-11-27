-- แผน "ลงโฆษณาบนจอร้านผ่าน QR" v1 · เฟส A1
-- ร้านเปิดรับโฆษณา + ตั้งแพ็ก/เงื่อนไข (store_ad_offers) และเก็บคำสั่งลงโฆษณาของลูกค้า (store_ad_orders)
-- เงินค่าโฆษณาเข้าบัญชีร้านโดยตรง (Beam ของร้าน / สลิป) — ตารางนี้เก็บแค่สถานะและหลักฐาน
-- ฝั่งผู้ลงโฆษณา (ไม่ล็อกอิน) เขียนผ่าน service role เท่านั้น: ไม่มี insert policy ให้ anon/authenticated

-- ── เงื่อนไขและแพ็กของร้าน (1 แถวต่อร้าน) ─────────────────────────────────────
create table if not exists public.store_ad_offers (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  -- สวิตช์ปิดทุกร้านเป็นค่าเริ่มต้น
  enabled boolean not null default false,
  -- true = จ่ายแล้วขึ้นจอทันที (ค่าเริ่มต้นตามที่ผู้ใช้เลือก) · false = ร้านต้องอนุมัติก่อน
  auto_publish boolean not null default true,
  -- ช่องที่ขาย: any = หมุนในทุกช่องที่เปิด, top/bottom = เฉพาะช่องนั้น (โหมดแบ่งครึ่ง)
  slot text not null default 'any' check (slot in ('any', 'top', 'bottom')),
  max_concurrent integer not null default 3 check (max_concurrent between 1 and 12),
  max_video_seconds integer not null default 60 check (max_video_seconds between 5 and 600),
  allow_video boolean not null default true,
  allow_image boolean not null default true,
  terms text not null default 'ห้ามเนื้อหาผิดกฎหมาย ลามก การพนัน หรือโจมตีผู้อื่น ร้านมีสิทธิ์ถอดโฆษณาที่ผิดเงื่อนไข',
  -- [{ id, name, days, price }] — ค่าเริ่มต้นพร้อมขายทันที ร้านแก้ได้
  packages jsonb not null default '[
    {"id":"d1","name":"1 วัน","days":1,"price":59},
    {"id":"d7","name":"7 วัน","days":7,"price":199},
    {"id":"d30","name":"30 วัน","days":30,"price":499}
  ]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id),
  check (allow_video or allow_image),
  check (jsonb_typeof(packages) = 'array')
);

alter table public.store_ad_offers enable row level security;

drop policy if exists "store_ad_offers: store member can read" on public.store_ad_offers;
create policy "store_ad_offers: store member can read"
  on public.store_ad_offers for select
  using (
    exists (
      select 1 from public.stores
      where stores.id = store_ad_offers.store_id
        and stores.organization_id = store_ad_offers.organization_id
    )
    and (
      store_id in (select auth_user_store_ids())
      or auth_user_role_in_org(organization_id, 'owner')
    )
  );

drop policy if exists "store_ad_offers: settings managers can write" on public.store_ad_offers;
create policy "store_ad_offers: settings managers can write"
  on public.store_ad_offers for all
  using (
    exists (
      select 1 from public.stores
      where stores.id = store_ad_offers.store_id
        and stores.organization_id = store_ad_offers.organization_id
    )
    and auth_user_has_permission(organization_id, store_id, 'settings.manage_store')
  )
  with check (
    exists (
      select 1 from public.stores
      where stores.id = store_ad_offers.store_id
        and stores.organization_id = store_ad_offers.organization_id
    )
    and auth_user_has_permission(organization_id, store_id, 'settings.manage_store')
  );

drop trigger if exists set_updated_at on public.store_ad_offers;
create trigger set_updated_at before update on public.store_ad_offers
  for each row execute function set_updated_at();

-- ── คำสั่งลงโฆษณาของลูกค้า ──────────────────────────────────────────────────
create table if not exists public.store_ad_orders (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  -- แพ็กที่ซื้อ (คัดลอกไว้ — ร้านแก้แพ็กทีหลังไม่กระทบคำสั่งเดิม)
  package_id text not null,
  package_name text not null,
  days integer not null check (days between 1 and 365),
  amount numeric(12, 2) not null check (amount > 0),
  advertiser_name text not null check (char_length(advertiser_name) between 1 and 80),
  advertiser_phone text not null check (char_length(advertiser_phone) between 9 and 20),
  media_type text check (media_type in ('image', 'video')),
  media_path text,
  media_url text,
  media_duration_seconds numeric(8, 2),
  slot text not null default 'any' check (slot in ('any', 'top', 'bottom')),
  status text not null default 'pending_payment' check (status in (
    'pending_payment', -- สร้างแล้ว รอจ่าย (หมดอายุถ้าไม่จ่ายใน 30 นาที — เฟส A4)
    'pending_review',  -- จ่ายแล้ว รอร้านอนุมัติ (เมื่อ auto_publish = false)
    'active',          -- ขึ้นจอ (กรองวันหมดอายุตอนอ่านด้วย ends_at)
    'rejected',        -- ร้านไม่อนุมัติ (คืนเงินนอกระบบ)
    'removed',         -- ร้านถอดระหว่างแสดง
    'expired',         -- หมดเวลาแล้ว (เก็บกวาดเฟส A4)
    'cancelled'        -- ไม่จ่าย/ยกเลิก
  )),
  payment_method text check (payment_method in ('beam', 'slip')),
  paid_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  removed_reason text,
  -- hash ของ IP ผู้ลง (จำกัดจำนวนคำสั่ง/กันสแปม) — ไม่เก็บ IP ดิบ
  client_ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index if not exists store_ad_orders_store_status_idx
  on public.store_ad_orders (store_id, status, ends_at);
create index if not exists store_ad_orders_ip_recent_idx
  on public.store_ad_orders (client_ip_hash, created_at desc)
  where client_ip_hash is not null;

alter table public.store_ad_orders enable row level security;

-- มีชื่อ/เบอร์ผู้ลงโฆษณา → อ่านได้เฉพาะคนจัดการร้าน; จอลูกค้าอ่านสื่อผ่าน server (service role) หลังตรวจสิทธิ์
drop policy if exists "store_ad_orders: settings managers can read" on public.store_ad_orders;
create policy "store_ad_orders: settings managers can read"
  on public.store_ad_orders for select
  using (
    exists (
      select 1 from public.stores
      where stores.id = store_ad_orders.store_id
        and stores.organization_id = store_ad_orders.organization_id
    )
    and auth_user_has_permission(organization_id, store_id, 'settings.manage_store')
  );

-- ร้านอนุมัติ/ถอดได้ (เปลี่ยนสถานะ) — insert/delete ทำผ่าน service role เท่านั้น
drop policy if exists "store_ad_orders: settings managers can update" on public.store_ad_orders;
create policy "store_ad_orders: settings managers can update"
  on public.store_ad_orders for update
  using (
    exists (
      select 1 from public.stores
      where stores.id = store_ad_orders.store_id
        and stores.organization_id = store_ad_orders.organization_id
    )
    and auth_user_has_permission(organization_id, store_id, 'settings.manage_store')
  )
  with check (
    exists (
      select 1 from public.stores
      where stores.id = store_ad_orders.store_id
        and stores.organization_id = store_ad_orders.organization_id
    )
    and auth_user_has_permission(organization_id, store_id, 'settings.manage_store')
  );

drop trigger if exists set_updated_at on public.store_ad_orders;
create trigger set_updated_at before update on public.store_ad_orders
  for each row execute function set_updated_at();
