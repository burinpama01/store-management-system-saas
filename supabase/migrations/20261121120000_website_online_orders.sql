-- ============================================================
-- เว็บไซต์ของร้าน S2: สั่งออนไลน์ (รับที่ร้าน + ร้านส่งเอง) จ่ายด้วย Beam QR
--
-- store_online_order_settings  ตั้งค่าต่อร้าน (ค่าเริ่มต้นปิด)
-- online_orders                คำสั่งซื้อจากเว็บร้าน — สร้างตอนลูกค้ากดจ่าย (รอจ่าย)
--                              ออเดอร์จริง (orders) สร้างตอนร้านกด "รับออเดอร์" แล้วปิดบิลด้วยเงิน Beam
-- gateway_payments.online_order_id + trigger (BEFORE UPDATE → PAID) — จุดเดียวไม่ว่า PAID
--   มาจาก webhook หรือถาม Beam API:
--     รอจ่าย + ยอดตรง → online_orders.status = 'paid'
--     หมดอายุ/ยกเลิกไปแล้ว → LATE_PAID (ร้านคืนเงิน)
--     ยอดไม่ตรง → REVIEW_REQUIRED
-- ทุกตารางใช้ผ่าน service client หลัง server action ตรวจสิทธิ์ (revoke anon/authenticated)
-- additive
-- ============================================================

create table if not exists public.store_online_order_settings (
  store_id uuid primary key references public.stores(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  pickup_enabled boolean not null default true,
  delivery_enabled boolean not null default false,
  origin_lat double precision,
  origin_lng double precision,
  delivery_radius_km numeric(6,2) not null default 5 check (delivery_radius_km > 0 and delivery_radius_km <= 50),
  delivery_base_fee numeric(10,2) not null default 20 check (delivery_base_fee >= 0),
  delivery_fee_per_km numeric(10,2) not null default 10 check (delivery_fee_per_km >= 0),
  delivery_free_over numeric(10,2) check (delivery_free_over is null or delivery_free_over >= 0),
  min_order numeric(10,2) not null default 0 check (min_order >= 0),
  prep_minutes integer not null default 20 check (prep_minutes between 0 and 240),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((origin_lat is null) = (origin_lng is null)),
  check (origin_lat is null or (origin_lat between -90 and 90 and origin_lng between -180 and 180))
);

create table if not exists public.online_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  public_token text not null unique check (char_length(public_token) >= 32),
  client_request_id text not null check (char_length(client_request_id) between 8 and 80),
  order_code text not null,
  fulfillment text not null check (fulfillment in ('pickup', 'delivery')),
  status text not null default 'awaiting_payment' check (status in (
    'awaiting_payment', 'paid', 'accepted', 'preparing', 'ready', 'out_for_delivery',
    'completed', 'expired', 'refund_pending', 'refunded'
  )),
  customer_name text not null check (char_length(customer_name) between 1 and 80),
  customer_phone text not null check (customer_phone ~ '^0[0-9]{8,9}$'),
  address text check (address is null or char_length(address) <= 300),
  address_note text check (address_note is null or char_length(address_note) <= 200),
  lat double precision,
  lng double precision,
  distance_km numeric(6,2),
  pickup_at timestamptz,
  note text check (note is null or char_length(note) <= 300),
  items jsonb not null default '[]'::jsonb,
  subtotal numeric(12,2) not null check (subtotal >= 0),
  delivery_fee numeric(12,2) not null default 0 check (delivery_fee >= 0),
  total numeric(12,2) not null check (total >= 1),
  gateway_payment_id uuid,
  order_id uuid references public.orders(id) on delete set null,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 200),
  expires_at timestamptz not null,
  paid_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  refunded_at timestamptz,
  notified_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, client_request_id),
  check (fulfillment = 'pickup' or address is not null)
);

create index if not exists online_orders_store_status_idx
  on public.online_orders (store_id, status, created_at desc);
create index if not exists online_orders_store_phone_idx
  on public.online_orders (store_id, customer_phone, created_at desc);

alter table public.gateway_payments
  add column if not exists online_order_id uuid references public.online_orders(id) on delete set null;

create unique index if not exists gateway_payments_online_order_unique
  on public.gateway_payments (online_order_id)
  where online_order_id is not null;

alter table public.store_online_order_settings enable row level security;
alter table public.online_orders enable row level security;
revoke all on table public.store_online_order_settings from anon, authenticated;
revoke all on table public.online_orders from anon, authenticated;

-- ---------- PAID → คำสั่งซื้อจ่ายแล้ว ----------
drop trigger if exists promote_online_order_on_gateway_paid on public.gateway_payments;

create or replace function public.promote_online_order_on_gateway_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.online_orders%rowtype;
begin
  select *
  into v_order
  from public.online_orders
  where id = new.online_order_id
    and store_id = new.store_id
  for update;

  if not found then
    new.status := 'REVIEW_REQUIRED';
    new.failure_message := 'ไม่พบคำสั่งซื้อออนไลน์ของรายการชำระนี้ — ตรวจสอบแล้วคืนเงิน';
    return new;
  end if;

  -- จ่ายแล้ว/ดำเนินการต่อไปแล้ว (PAID ซ้ำจาก webhook + lookup) → ไม่แตะ
  if v_order.status in ('paid', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'completed') then
    return new;
  end if;

  if v_order.status is distinct from 'awaiting_payment' then
    new.status := 'LATE_PAID';
    new.failure_message := 'เงินเข้าหลังคำสั่งซื้อออนไลน์หมดอายุ/ถูกยกเลิก — ตรวจแล้วคืนเงินลูกค้า';
    return new;
  end if;

  if round(v_order.total, 2) is distinct from round(new.amount, 2) then
    new.status := 'REVIEW_REQUIRED';
    new.failure_message := 'ยอดที่จ่ายไม่ตรงกับคำสั่งซื้อออนไลน์ — ตรวจสอบก่อนรับออเดอร์';
    return new;
  end if;

  update public.online_orders
  set status = 'paid',
      paid_at = now(),
      updated_at = now()
  where id = v_order.id;

  return new;
end;
$$;

revoke all on function public.promote_online_order_on_gateway_paid() from public;
revoke execute on function public.promote_online_order_on_gateway_paid() from anon, authenticated;

create trigger promote_online_order_on_gateway_paid
  before update of status on public.gateway_payments
  for each row
  when (new.online_order_id is not null and new.status = 'PAID' and old.status is distinct from 'PAID')
  execute function public.promote_online_order_on_gateway_paid();
