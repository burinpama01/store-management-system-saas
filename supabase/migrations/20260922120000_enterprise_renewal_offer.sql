-- ข้อเสนอต่ออายุ Enterprise รายบัญชี (ซุปเปอร์แอดมินเป็นคนตั้งราคาและอายุ)
--
-- ที่มา: สิทธิ์ทดลอง Enterprise 30 วันหมดแล้ว ร้านยังถือ plan='enterprise'
-- แต่ hasBillingAccess() เป็น false จึงถูกเด้งไปหน้าแพ็กเกจ ซึ่งเดิมเสนอได้แค่
-- starter/standard/premium/business = บังคับดาวน์เกรด แอดมินจึงต้อง override ให้ฟรี
-- ทุกครั้ง ตารางนี้ทำให้ "ตกลงราคากันเป็นรายร้านแล้วให้ร้านจ่ายเอง" เป็นไปได้
--
-- ไม่มีข้อเสนอ = พฤติกรรมเดิมทุกอย่าง (ไม่มีแถว = ไม่มีอะไรเปลี่ยน)

create table if not exists public.organization_enterprise_offers (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  amount     numeric(12,2) not null check (amount > 0),
  -- days  = จ่ายแล้วได้เพิ่ม N วัน สะสมจากวันหมดอายุเดิมถ้ายังไม่หมด
  -- until = จ่ายแล้วใช้ได้ถึงวันที่ระบุตายตัว
  term_kind  text not null check (term_kind in ('days', 'until')),
  term_days  integer check (term_days between 1 and 3650),
  ends_at    timestamptz,
  active     boolean not null default true,
  note       text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_enterprise_offers_term_shape check (
    (term_kind = 'days'  and term_days is not null and ends_at is null) or
    (term_kind = 'until' and ends_at   is not null and term_days is null)
  )
);

comment on table public.organization_enterprise_offers is
  'ข้อเสนอต่ออายุ Enterprise ที่ซุปเปอร์แอดมินตั้งให้แต่ละองค์กร — ราคาและอายุไม่เท่ากันได้';

-- อ่าน/เขียนผ่าน service client เท่านั้น (หน้าแอดมินและเส้นทางชำระเงิน)
alter table public.organization_enterprise_offers enable row level security;
revoke all on public.organization_enterprise_offers from anon, authenticated;
grant all on public.organization_enterprise_offers to service_role;

-- ── ปลดล็อกให้ 'enterprise' ชำระเงินได้ ───────────────────────────────
-- เดิม check กันไว้เพราะ enterprise ซื้อเองไม่ได้ ตอนนี้ซื้อได้เมื่อมีข้อเสนอ
-- duration 'custom' = อายุมาจากข้อเสนอ ไม่ใช่ 30 วัน/1 ปีมาตรฐาน

alter table public.payment_submissions
  drop constraint if exists payment_submissions_plan_check;
alter table public.payment_submissions
  add constraint payment_submissions_plan_check
  check (plan in ('starter', 'standard', 'premium', 'business', 'enterprise'));

alter table public.payment_submissions
  drop constraint if exists payment_submissions_duration_check;
alter table public.payment_submissions
  add constraint payment_submissions_duration_check
  check (duration in ('30d', '1y', 'custom'));

alter table public.platform_billing_orders
  drop constraint if exists platform_billing_orders_plan_check;
alter table public.platform_billing_orders
  add constraint platform_billing_orders_plan_check
  check (plan in ('starter', 'standard', 'premium', 'business', 'enterprise'));

alter table public.platform_billing_orders
  drop constraint if exists platform_billing_orders_duration_check;
alter table public.platform_billing_orders
  add constraint platform_billing_orders_duration_check
  check (duration in ('30d', '1y', 'custom'));

-- อายุที่ตกลงไว้ ติดไปกับรายการชำระเงิน เพื่อให้ RPC ที่ตัดสิทธิ์รู้ว่าต้องต่อถึงเมื่อไร
-- null ทั้งคู่ = แพ็กเกจปกติ ใช้ duration เหมือนเดิม
alter table public.platform_billing_orders
  add column if not exists term_days integer,
  add column if not exists term_ends_at timestamptz;

-- ── RPC ตัดสิทธิ์: รองรับอายุที่แอดมินกำหนด + กันสัญญาไม่มีวันหมดอายุ ──
--
-- อันตรายที่แก้ตรงนี้: ของเดิมไม่แตะ enterprise_limited ซึ่ง default เป็น false
-- ถ้า plan กลายเป็น 'enterprise' โดยที่ธงยัง false ระบบจะอ่านว่าเป็นสัญญาไม่มี
-- วันหมดอายุ (isExpiringState) = จ่ายครั้งเดียวใช้ฟรีตลอดชีพ
create or replace function public.settle_platform_billing_order(p_order_id uuid, p_method text, p_ref text, p_amount numeric)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.platform_billing_orders%rowtype;
  expiry timestamptz;
begin
  select * into o from public.platform_billing_orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(o.organization_id::text, 21092026));
  select * into o from public.platform_billing_orders where id = p_order_id for update;
  if o.status in ('paid','test_paid') then
    return jsonb_build_object('status', o.status, 'new_expiry', o.new_expiry);
  end if;
  if o.method <> p_method or p_amount <> o.amount or p_amount is null or nullif(btrim(p_ref),'') is null then
    raise exception 'evidence_mismatch';
  end if;
  if p_method = 'beam' and (o.charge_id is null or o.charge_id <> p_ref) then raise exception 'charge_mismatch'; end if;
  if p_method = 'slip' and o.status <> 'pending' then raise exception 'slip_order_closed'; end if;
  if o.environment = 'test' then
    update public.platform_billing_orders set status = 'test_paid', paid_at = now() where id = o.id;
    return jsonb_build_object('status','test_paid','new_expiry',null);
  end if;
  -- A late successful Beam charge is still real money; fulfil it even after FAILED.
  -- Ref namespace separates Beam charges from bank slip identifiers.
  insert into public.payment_submissions(organization_id, plan, duration, amount_expected, verified_amount,
    slip_ref, status, submitted_by, discount_code_id, discount_amount, business_seats, business_stores, business_features, verified_at)
  values (o.organization_id,o.plan,o.duration,o.amount,p_amount,
    case when p_method='beam' then 'beam:'||p_ref else p_ref end,'verified',o.submitted_by,
    o.discount_code_id,o.discount_amount,o.business_seats,o.business_stores,o.business_features,now());
  select current_period_end into expiry from public.subscriptions where organization_id=o.organization_id for update;
  expiry := case
    when o.term_ends_at is not null then o.term_ends_at
    when o.term_days is not null then greatest(coalesce(expiry,now()),now()) + make_interval(days => o.term_days)
    when o.duration = '1y' then greatest(coalesce(expiry,now()),now()) + interval '365 days'
    else greatest(coalesce(expiry,now()),now()) + interval '30 days'
  end;
  insert into public.subscriptions(organization_id,plan,status,current_period_start,current_period_end,cancel_at_period_end,
    trial_end,promo_trial_code,enterprise_limited,business_seats,business_stores,business_features,updated_at)
  values (o.organization_id,o.plan,'active',now(),expiry,false,null,o.plan='enterprise',o.business_seats,o.business_stores,o.business_features,now())
  on conflict(organization_id) do update set plan=excluded.plan,status='active',current_period_start=excluded.current_period_start,
    current_period_end=excluded.current_period_end,cancel_at_period_end=false,trial_end=null,promo_trial_code=null,
    enterprise_limited=excluded.enterprise_limited,
    business_seats=excluded.business_seats,business_stores=excluded.business_stores,business_features=excluded.business_features,updated_at=now();
  -- ข้อเสนอแบบ "ถึงวันที่" ใช้ได้ครั้งเดียว — จ่ายซ้ำแล้วได้วันเดิมคือเก็บเงินฟรี
  update public.organization_enterprise_offers
     set active = false, updated_at = now()
   where organization_id = o.organization_id and o.plan = 'enterprise' and term_kind = 'until';
  update public.platform_billing_orders set status='paid',paid_at=now(),new_expiry=expiry where id=o.id;
  insert into public.audit_logs(organization_id,actor_user_id,action,reason)
  values(o.organization_id,o.submitted_by,'subscription.payment_verified',p_method||' order '||o.id::text);
  return jsonb_build_object('status','paid','new_expiry',expiry);
end $$;
revoke all on function public.settle_platform_billing_order(uuid,text,text,numeric) from public,anon,authenticated;
grant execute on function public.settle_platform_billing_order(uuid,text,text,numeric) to service_role;
