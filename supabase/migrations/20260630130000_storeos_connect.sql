-- StoreOS Connect — bridge ระหว่าง StoreOS (POS) กับช่องทางเดลิเวอรีภายนอก (เริ่มที่ JDC)
-- โมเดล LINE MAN x Wongnai POS: เมนูต้นทางที่ StoreOS ดันไป JDC, ออเดอร์จาก JDC ไหลเข้า POS,
-- สถานะ sync สองทาง. ทุกตาราง connect_* เข้าถึงผ่าน service_role (server actions/route) เท่านั้น
-- จึงใช้ RLS deny-by-default แบบเดียวกับ api_keys (revoke all + enable RLS + ไม่มี policy).

-- ── products: เลือกสินค้าที่จะขึ้นเดลิเวอรี + ราคาเดลิเวอรีแยกจากหน้าร้าน ──────────────
alter table products add column if not exists available_for_delivery boolean not null default false;
alter table products add column if not exists delivery_price numeric(12,2);  -- null = ใช้ base_price

-- ── 1) การผูกร้าน StoreOS <-> ช่องทางขายภายนอก (MVP: ผูกด้วยมือ) ─────────────────────
create table if not exists connect_channel_links (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references organizations(id) on delete cascade,
  store_id               uuid not null references stores(id) on delete cascade,
  channel                text not null default 'jdc',
  external_merchant_id   text not null,                 -- profiles.id ฝั่ง JDC
  status                 text not null default 'active'
                           check (status in ('active','paused','disconnected')),
  webhook_secret         text not null,                 -- shared HMAC secret (ทั้งขาเข้า/ออก)
  jdc_functions_base_url text not null,                 -- ปลายทาง Edge Functions ฝั่ง JDC
  auto_accept            boolean not null default false,
  config                 jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (store_id, channel)
);
create index if not exists connect_links_org_idx on connect_channel_links(organization_id);

-- ── 2) แผนที่สินค้า StoreOS <-> เมนูปลายทาง ─────────────────────────────────────────
create table if not exists connect_menu_map (
  id               uuid primary key default gen_random_uuid(),
  link_id          uuid not null references connect_channel_links(id) on delete cascade,
  product_id       uuid not null references products(id) on delete cascade,
  external_item_id text,                                -- menu_items.id ฝั่ง JDC (เติมหลัง sync)
  sync_hash        text,                                -- hash ของ field ที่ดันไป กันดันซ้ำ
  last_synced_at   timestamptz,
  last_error       text,
  unique (link_id, product_id)
);

-- ── 3) ออเดอร์ที่รับเข้ามาจากช่องทางภายนอก (idempotency + สถานะ fulfillment) ───────────
create table if not exists connect_orders (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  link_id            uuid not null references connect_channel_links(id) on delete cascade,
  external_order_id  text not null,                     -- bookings.id ฝั่ง JDC
  internal_order_id  uuid references orders(id) on delete set null,
  channel            text not null default 'jdc',
  fulfillment_status text not null default 'received'
                       check (fulfillment_status in
                         ('received','accepted','preparing','ready','completed','cancelled')),
  last_status_origin text,                              -- 'jdc' | 'storeos' (กัน loop)
  raw_payload        jsonb not null,
  received_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (link_id, external_order_id)
);
create index if not exists connect_orders_org_idx on connect_orders(organization_id);
create index if not exists connect_orders_internal_idx on connect_orders(internal_order_id);

-- ── 4) คิว event สองทาง (outbox/inbox) + retry + audit ───────────────────────────────
create table if not exists connect_events (
  id            uuid primary key default gen_random_uuid(),
  link_id       uuid not null references connect_channel_links(id) on delete cascade,
  direction     text not null check (direction in ('outbound','inbound')),
  topic         text not null,                          -- menu.upsert|order.created|order.status|shop.status
  payload       jsonb not null,
  status        text not null default 'pending'
                  check (status in ('pending','sent','failed','dead')),
  attempts      int not null default 0,
  next_retry_at timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);
create index if not exists connect_events_link_status_idx on connect_events(link_id, status);

-- ── RLS: deny-by-default (เข้าถึงผ่าน service_role เท่านั้น) ──────────────────────────
alter table connect_channel_links enable row level security;
alter table connect_menu_map      enable row level security;
alter table connect_orders        enable row level security;
alter table connect_events        enable row level security;
revoke all on connect_channel_links from public, anon, authenticated;
revoke all on connect_menu_map      from public, anon, authenticated;
revoke all on connect_orders        from public, anon, authenticated;
revoke all on connect_events        from public, anon, authenticated;
