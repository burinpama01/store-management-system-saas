-- คูปองในหน้าสั่งออนไลน์ — ใช้คูปองตัวเดิมของร้าน (coupons) นับสิทธิ์รวมกับ POS ใน coupon_redemptions
-- จองสิทธิ์ตอนสร้างคำสั่งซื้อ (ยังไม่มีบิล POS) → ผูกบิลตอนร้านรับออเดอร์ → คืนสิทธิ์เองเมื่อหมดเวลา/ยกเลิก

-- 1) สวิตช์ร้าน (ค่าเริ่มต้นปิดทุกร้าน)
alter table public.store_online_order_settings
  add column if not exists coupons_enabled boolean not null default false;

-- 2) คูปองแต่ละใบเลือกได้ว่าใช้สั่งออนไลน์ได้ไหม (ค่าเริ่มต้นได้ — มีผลเมื่อร้านเปิดสวิตช์ข้อ 1 เท่านั้น)
alter table public.coupons
  add column if not exists allow_online boolean not null default true;

-- 3) คำสั่งซื้อออนไลน์เก็บคูปองที่ใช้ (total = subtotal - discount + delivery_fee)
alter table public.online_orders
  add column if not exists coupon_id uuid references public.coupons(id) on delete set null,
  add column if not exists coupon_code text check (coupon_code is null or char_length(coupon_code) <= 40),
  add column if not exists discount numeric(12,2) not null default 0 check (discount >= 0);

-- 4) การใช้คูปองผูกกับคำสั่งซื้อออนไลน์ได้ (บิล POS ตามมาตอนรับออเดอร์)
alter table public.coupon_redemptions alter column order_id drop not null;
alter table public.coupon_redemptions
  add column if not exists online_order_id uuid references public.online_orders(id) on delete cascade;
create unique index if not exists coupon_redemptions_online_order_idx
  on public.coupon_redemptions (online_order_id) where online_order_id is not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'coupon_redemptions_order_or_online_check') then
    alter table public.coupon_redemptions
      add constraint coupon_redemptions_order_or_online_check
      check (order_id is not null or online_order_id is not null);
  end if;
end $$;

-- 5) ด่านเดาโค้ด: แยกช่องทาง online/pos + นับต่อ IP (ไม่ให้คนนอกยิงหน้าเว็บจนแคชเชียร์โดนล็อก)
alter table public.pos_coupon_code_attempts
  add column if not exists channel text not null default 'pos' check (channel in ('pos', 'online')),
  add column if not exists ip_hash text;
create index if not exists pos_coupon_code_attempts_online_ip_idx
  on public.pos_coupon_code_attempts (store_id, ip_hash, created_at desc) where channel = 'online';

-- 6) จองสิทธิ์คูปอง — ล็อกแถวคูปองก่อนนับ กันสองคนใช้ใบสุดท้ายพร้อมกัน
--    คืน null = สำเร็จ, ข้อความ = ไม่สำเร็จ (ผู้เรียกลบคำสั่งซื้อที่เพิ่งสร้าง)
create or replace function public.reserve_online_order_coupon(
  p_online_order_id uuid,
  p_coupon_id uuid,
  p_customer_id uuid,
  p_discount numeric
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.online_orders%rowtype;
  v_coupon public.coupons%rowtype;
  v_used integer;
  v_used_by_customer integer;
begin
  if p_discount is null or p_discount <= 0 then
    return 'ส่วนลดคูปองไม่ถูกต้อง';
  end if;

  select * into v_order from public.online_orders where id = p_online_order_id;
  if not found then
    return 'ไม่พบคำสั่งซื้อ';
  end if;

  select * into v_coupon
  from public.coupons
  where id = p_coupon_id and store_id = v_order.store_id
  for update;
  if not found or not v_coupon.is_active then
    return 'คูปองนี้ใช้ไม่ได้แล้ว';
  end if;
  -- โค้ดสิทธิ์ระดับสมาชิก/รางวัลภารกิจ ต้องให้พนักงานยืนยันสมาชิกที่หน้าร้าน (trigger เดิมบังคับอยู่)
  if not v_coupon.allow_online
    or v_coupon.member_tier_benefit_id is not null
    or v_coupon.store_mission_id is not null then
    return 'คูปองนี้ใช้ได้ที่หน้าร้านเท่านั้น';
  end if;
  if v_coupon.starts_at is not null and now() < v_coupon.starts_at then
    return 'คูปองนี้ยังไม่เริ่มใช้';
  end if;
  if v_coupon.ends_at is not null and now() > v_coupon.ends_at then
    return 'คูปองนี้หมดอายุแล้ว';
  end if;
  if array_length(v_coupon.customer_ids, 1) is not null
    and (p_customer_id is null or not (p_customer_id = any(v_coupon.customer_ids))) then
    return 'คูปองนี้ใช้ได้เฉพาะลูกค้าที่ร้านกำหนด';
  end if;

  select count(*) into v_used
  from public.coupon_redemptions
  where coupon_id = p_coupon_id and store_id = v_order.store_id and voided_at is null;
  if v_coupon.max_redemptions is not null and v_used >= v_coupon.max_redemptions then
    return 'คูปองนี้ถูกใช้ครบจำนวนแล้ว';
  end if;

  if v_coupon.max_redemptions_per_customer is not null then
    if p_customer_id is null then
      return 'คูปองนี้ใช้ได้เฉพาะสมาชิก — สั่งผ่านหน้าสมาชิกของร้าน';
    end if;
    select count(*) into v_used_by_customer
    from public.coupon_redemptions
    where coupon_id = p_coupon_id and store_id = v_order.store_id
      and customer_id = p_customer_id and voided_at is null;
    if v_used_by_customer >= v_coupon.max_redemptions_per_customer then
      return 'คุณใช้คูปองนี้ครบจำนวนแล้ว';
    end if;
  end if;

  insert into public.coupon_redemptions (
    organization_id, store_id, coupon_id, customer_id, order_id, online_order_id, discount_amount, idempotency_key
  ) values (
    v_order.organization_id, v_order.store_id, p_coupon_id, p_customer_id, null, p_online_order_id,
    round(p_discount, 2), 'online:' || p_online_order_id::text
  )
  on conflict (store_id, idempotency_key) do nothing;

  return null;
end;
$$;

revoke all on function public.reserve_online_order_coupon(uuid, uuid, uuid, numeric) from public;
revoke all on function public.reserve_online_order_coupon(uuid, uuid, uuid, numeric) from anon;
revoke all on function public.reserve_online_order_coupon(uuid, uuid, uuid, numeric) from authenticated;
grant execute on function public.reserve_online_order_coupon(uuid, uuid, uuid, numeric) to service_role;

-- 7) คืนสิทธิ์คูปองเมื่อคำสั่งซื้อจบแบบไม่ได้ขาย (หมดเวลาจ่าย/ยกเลิก/คืนเงิน/ส่งไม่สำเร็จ)
--    ถ้าเพิ่มสถานะยกเลิก/ล้มเหลวใหม่ใน online_orders ต้องเพิ่มในเงื่อนไข when ด้านล่างด้วย
create or replace function public.void_online_order_coupon_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.coupon_redemptions
  set voided_at = now()
  where online_order_id = new.id
    and voided_at is null;
  return new;
end;
$$;

revoke all on function public.void_online_order_coupon_on_cancel() from public;

drop trigger if exists void_online_order_coupon_on_cancel on public.online_orders;
create trigger void_online_order_coupon_on_cancel
  after update of status on public.online_orders
  for each row
  when (
    new.coupon_id is not null
    and new.status in ('expired', 'refund_pending', 'refunded', 'delivery_failed')
    and old.status is distinct from new.status
  )
  execute function public.void_online_order_coupon_on_cancel();
