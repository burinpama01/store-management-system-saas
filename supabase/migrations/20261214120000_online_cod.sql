-- R3 แผน Online Delivery v3: เก็บเงินปลายทาง (COD) สำหรับออนไลน์ส่งถึงบ้าน — สวิตช์ปิดทุกร้าน

alter table public.store_online_order_settings
  add column if not exists cod_enabled boolean not null default false,
  add column if not exists cod_max_per_bill numeric(10,2) not null default 500
    check (cod_max_per_bill >= 0 and cod_max_per_bill <= 100000),
  -- เพดานตามระดับสมาชิก {"<rank>": ยอดสูงสุด} — ระดับที่ไม่ตั้ง/ไม่ใช่สมาชิก ใช้ cod_max_per_bill
  add column if not exists cod_tier_caps jsonb not null default '{}'::jsonb,
  add column if not exists cod_require_otp boolean not null default true;

alter table public.online_orders
  add column if not exists payment_method text not null default 'beam'
    check (payment_method in ('beam', 'cod')),
  add column if not exists cod_collected_method text
    check (cod_collected_method is null or cod_collected_method in ('cash', 'bank_transfer', 'beam')),
  add column if not exists cod_cash_held numeric(12,2) check (cod_cash_held is null or cod_cash_held >= 0),
  add column if not exists cod_settled_at timestamptz,
  add column if not exists cod_settled_by uuid references auth.users(id) on delete set null,
  add column if not exists failure_reason text check (failure_reason is null or char_length(failure_reason) <= 200),
  -- เวลาที่ส่งไม่สำเร็จจริง (นับประวัติไม่รับของ 90 วัน)
  add column if not exists failed_at timestamptz;

-- สถานะใหม่: cod_pending (เก็บปลายทาง รอร้านรับ) · delivery_failed (ส่งไม่สำเร็จ/ร้านปฏิเสธ COD)
alter table public.online_orders drop constraint if exists online_orders_status_check;
alter table public.online_orders add constraint online_orders_status_check check (status in (
  'awaiting_payment', 'paid', 'accepted', 'preparing', 'ready', 'out_for_delivery',
  'completed', 'expired', 'refund_pending', 'refunded', 'cod_pending', 'delivery_failed'
));

-- เงินสดค้างที่คนส่ง (ยังไม่คืนร้าน) ค้นเร็ว
create index if not exists online_orders_cod_cash_held_idx on public.online_orders (store_id)
  where payment_method = 'cod' and cod_collected_method = 'cash' and cod_settled_at is null;

-- OTP ยืนยันเบอร์ก่อนสั่งเก็บเงินปลายทาง — service role เท่านั้น
create table if not exists public.online_order_otps (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  phone text not null check (char_length(phone) between 9 and 15),
  code_hash text,
  channel text not null check (channel in ('campaigns', 'otp_v2')),
  ip_hash text,
  attempts int not null default 0,
  expires_at timestamptz not null,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists online_order_otps_phone_idx on public.online_order_otps (store_id, phone, created_at desc);
create index if not exists online_order_otps_ip_idx on public.online_order_otps (ip_hash, created_at desc);
alter table public.online_order_otps enable row level security;
revoke all on public.online_order_otps from anon, authenticated;
