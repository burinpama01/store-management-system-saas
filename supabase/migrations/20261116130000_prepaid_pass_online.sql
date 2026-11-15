-- แพ็กซื้อล่วงหน้า · P1b — ลูกค้าซื้อเองจากหน้าสมาชิกผ่าน Beam + ปิดแพ็กหมดอายุอัตโนมัติ
--
-- - prepaid_pass_purchases: คำสั่งซื้อออนไลน์ 1 แถว = 1 แพ็ก เก็บ snapshot แบบแพ็ก + เงื่อนไขที่ลูกค้าติ๊กยอมรับ
-- - gateway_payments.prepaid_pass_purchase_id (1:1) + trigger BEFORE UPDATE → PAID (จุดเดียวทั้ง webhook/lookup):
--     ยอดตรง → ออกแพ็ก (accepted_channel = 'online') และปิดคำสั่งซื้อเป็น paid
--     ยอดไม่ตรง → REVIEW_REQUIRED ให้ร้านตรวจ
--     เงินเข้าหลังคำสั่งซื้อหมดอายุ/ยกเลิก (webhook/lookup ตั้งเป็น LATE_PAID) → ยังออกแพ็กให้ และเปลี่ยนเป็น PAID
--     (ลูกค้าจ่ายเงินจริงตามเงื่อนไขที่ยอมรับแล้ว ไม่ต้องให้ร้านคืนเงิน)
-- - expire_prepaid_passes(): pg_cron ทุกวัน 00:10 เวลาไทย ปิดแพ็กที่เลยวันหมดอายุ (สิทธิ์ที่เหลือถูกยกเลิก ไม่คืนเงิน)
-- - หมายเหตุบัญชี: ขายออนไลน์ยังไม่ลง transactions (เงินเข้าพร้อมเพย์ร้านผ่าน Beam) — รายงาน P3 อ่านจาก prepaid_pass_events

create table if not exists public.prepaid_pass_purchases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  plan_id uuid not null references public.prepaid_pass_plans(id) on delete restrict,
  member_identity_id uuid not null references public.member_identities(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  plan_name text not null,
  credits integer not null check (credits > 0),
  amount numeric(12,2) not null check (amount >= 1),
  valid_days integer,
  redeem_scope text not null check (redeem_scope in ('store', 'org')),
  terms_snapshot text not null,
  accepted_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  pass_id uuid references public.prepaid_passes(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prepaid_pass_purchases_customer_idx
  on public.prepaid_pass_purchases (customer_id, created_at desc);
create index if not exists prepaid_pass_purchases_pending_idx
  on public.prepaid_pass_purchases (created_at)
  where status = 'pending';

alter table public.prepaid_pass_purchases enable row level security;
revoke all on table public.prepaid_pass_purchases from anon, authenticated;
grant select on table public.prepaid_pass_purchases to authenticated;

drop policy if exists "prepaid_pass_purchases: store member can read" on public.prepaid_pass_purchases;
create policy "prepaid_pass_purchases: store member can read"
  on public.prepaid_pass_purchases for select
  using (store_id in (select auth_user_store_ids()));

alter table public.prepaid_passes
  add column if not exists purchase_id uuid unique references public.prepaid_pass_purchases(id) on delete set null;

alter table public.gateway_payments
  add column if not exists prepaid_pass_purchase_id uuid references public.prepaid_pass_purchases(id) on delete set null;

create unique index if not exists gateway_payments_prepaid_pass_purchase_unique
  on public.gateway_payments (prepaid_pass_purchase_id)
  where prepaid_pass_purchase_id is not null;

-- ---------------------------------------------------------------------------
-- จ่าย Beam สำเร็จ → ออกแพ็ก
-- ---------------------------------------------------------------------------
create or replace function public.issue_prepaid_pass_on_gateway_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pur public.prepaid_pass_purchases%rowtype;
  v_pass_id uuid;
begin
  select * into v_pur
    from public.prepaid_pass_purchases
   where id = new.prepaid_pass_purchase_id and store_id = new.store_id
   for update;

  if not found then
    new.status := 'REVIEW_REQUIRED';
    new.failure_message := 'ไม่พบคำสั่งซื้อแพ็กของรายการชำระนี้ — ตรวจสอบแล้วคืนเงิน';
    return new;
  end if;

  if v_pur.status = 'paid' then
    return new;
  end if;

  if round(v_pur.amount, 2) is distinct from round(new.amount, 2) then
    new.status := 'REVIEW_REQUIRED';
    new.failure_message := 'ยอดที่จ่ายไม่ตรงกับราคาแพ็ก — ตรวจสอบก่อนออกแพ็ก';
    return new;
  end if;

  insert into public.prepaid_passes (
    organization_id, plan_id, member_identity_id, issued_store_id, customer_id, purchase_id,
    plan_name, credits_total, credits_remaining, unit_value, price_paid, redeem_scope,
    expires_at, terms_snapshot, accepted_at, accepted_channel, accepted_by
  ) values (
    v_pur.organization_id, v_pur.plan_id, v_pur.member_identity_id, v_pur.store_id, v_pur.customer_id, v_pur.id,
    v_pur.plan_name, v_pur.credits, v_pur.credits, round(v_pur.amount / v_pur.credits, 4), v_pur.amount, v_pur.redeem_scope,
    case when v_pur.valid_days is null then null else now() + make_interval(days => v_pur.valid_days) end,
    v_pur.terms_snapshot, v_pur.accepted_at, 'online', null
  )
  on conflict (purchase_id) do nothing
  returning id into v_pass_id;

  if v_pass_id is not null then
    insert into public.prepaid_pass_events (organization_id, pass_id, store_id, type, credits_delta, value_delta, note)
    values (v_pur.organization_id, v_pass_id, v_pur.store_id, 'issue', v_pur.credits, v_pur.amount, 'ซื้อออนไลน์ผ่าน Beam ' || new.id::text);
  else
    select id into v_pass_id from public.prepaid_passes where purchase_id = v_pur.id;
  end if;

  update public.prepaid_pass_purchases
     set status = 'paid', pass_id = v_pass_id, updated_at = now()
   where id = v_pur.id;

  -- เงินเข้าช้า (LATE_PAID) แต่ออกแพ็กแล้ว = รายการนี้สมบูรณ์ ไม่ต้องคืนเงิน
  if new.status = 'LATE_PAID' then
    new.status := 'PAID';
    new.failure_message := null;
  end if;

  return new;
end;
$$;

revoke all on function public.issue_prepaid_pass_on_gateway_paid() from public, anon, authenticated;

drop trigger if exists issue_prepaid_pass_on_gateway_paid on public.gateway_payments;
create trigger issue_prepaid_pass_on_gateway_paid
  before update of status on public.gateway_payments
  for each row
  when (
    new.prepaid_pass_purchase_id is not null
    and new.status in ('PAID', 'LATE_PAID')
    and old.status not in ('PAID', 'LATE_PAID')
  )
  execute function public.issue_prepaid_pass_on_gateway_paid();

-- ---------------------------------------------------------------------------
-- ปิดแพ็กหมดอายุ (สิทธิ์ที่เหลือถูกยกเลิกตามเงื่อนไข) — เรียกจาก pg_cron
-- สิทธิ์ที่ "จองอยู่" ในบิลที่ยังไม่จ่ายไม่ถูกแตะ (เป็นของบิลนั้นแล้ว)
-- ---------------------------------------------------------------------------
create or replace function public.expire_prepaid_passes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pass record;
  v_count integer := 0;
begin
  for v_pass in
    select * from public.prepaid_passes
     where status = 'active' and expires_at is not null and expires_at <= now()
     order by expires_at
     limit 5000
     for update skip locked
  loop
    update public.prepaid_passes set status = 'expired', credits_remaining = 0 where id = v_pass.id;
    insert into public.prepaid_pass_events (organization_id, pass_id, store_id, type, credits_delta, value_delta, note)
    values (v_pass.organization_id, v_pass.id, v_pass.issued_store_id, 'expire', -v_pass.credits_remaining,
            -round(v_pass.unit_value * v_pass.credits_remaining, 2), 'แพ็กหมดอายุ — สิทธิ์ที่เหลือถูกยกเลิก');
    v_count := v_count + 1;
  end loop;

  update public.prepaid_pass_purchases
     set status = 'expired', updated_at = now()
   where status = 'pending' and created_at < now() - interval '1 day';

  return v_count;
end;
$$;

revoke all on function public.expire_prepaid_passes() from public, anon, authenticated;
grant execute on function public.expire_prepaid_passes() to service_role;

create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'expire-prepaid-passes') then
    perform cron.unschedule('expire-prepaid-passes');
  end if;
end $$;

-- 17:10 UTC = 00:10 เวลาไทย
select cron.schedule('expire-prepaid-passes', '10 17 * * *', $job$ select public.expire_prepaid_passes(); $job$);
