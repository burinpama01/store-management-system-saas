-- โควตา AI แบบรวมทุกฟีเจอร์ + เติมเงินซื้อโทเคนเพิ่ม (2026-09-05)
--   * โควตาฟรีนับ "ต่อเดือน ต่อองค์กร" รวมทุกฟีเจอร์ (aiVision / aiAssistant / aiVoiceIntent)
--   * เมื่อโควตาเดือนหมด ระบบจะหักจากเครดิตที่เติมเงินซื้อไว้ (ไม่หมดอายุรายเดือน)
--   * การหักเครดิตเกิดใน RPC เดิมที่ล็อกด้วย advisory lock อยู่แล้ว = ไม่มีทางใช้เกิน

-- แยกว่า reservation นี้กินโควตาฟรีรายเดือน หรือกินเครดิตที่ซื้อไว้
alter table public.ai_quota_reservations
  add column if not exists source text not null default 'monthly'
  check (source in ('monthly', 'credit'));

-- ยอดเครดิตโทเคนคงเหลือต่อองค์กร (ยอดสะสม ไม่รีเซ็ตรายเดือน)
create table if not exists public.ai_credit_balances (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  tokens_remaining bigint not null default 0 check (tokens_remaining >= 0),
  tokens_purchased bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- แพ็กโทเคนที่ขาย (super-admin แก้ราคา/ปิดขายได้จากตารางนี้)
create table if not exists public.ai_credit_packs (
  id text primary key,
  name text not null,
  tokens int not null check (tokens > 0),
  price_thb numeric(10,2) not null check (price_thb > 0),
  sort_order int not null default 0,
  is_active boolean not null default true
);

insert into public.ai_credit_packs (id, name, tokens, price_thb, sort_order)
values
  ('ai_small', 'เติม 50,000 โทเคน', 50000, 49, 1),
  ('ai_medium', 'เติม 200,000 โทเคน', 200000, 149, 2),
  ('ai_large', 'เติม 600,000 โทเคน', 600000, 349, 3)
on conflict (id) do nothing;

-- ใบเติมเงิน: สลิปที่ผ่านการตรวจแล้วเท่านั้นที่จองเลขอ้างอิงได้ (กันสลิปซ้ำแบบ atomic)
create table if not exists public.ai_credit_topups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pack_id text not null,
  tokens int not null,
  amount_expected numeric(10,2) not null,
  verified_amount numeric(10,2),
  slip_ref text,
  slip2go_raw jsonb,
  status text not null check (status in ('verified', 'rejected', 'duplicate')),
  reason text,
  submitted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists ai_credit_topups_slip_ref_verified_idx
  on public.ai_credit_topups (slip_ref)
  where status = 'verified' and slip_ref is not null;

create index if not exists ai_credit_topups_org_created_idx
  on public.ai_credit_topups (organization_id, created_at desc);

alter table public.ai_credit_balances enable row level security;
alter table public.ai_credit_packs enable row level security;
alter table public.ai_credit_topups enable row level security;

-- อ่านได้เฉพาะองค์กรตัวเอง; การเขียนทั้งหมดผ่าน service role ฝั่ง server เท่านั้น
drop policy if exists "org members read own ai credit balance" on public.ai_credit_balances;
create policy "org members read own ai credit balance"
  on public.ai_credit_balances for select
  to authenticated
  using (organization_id in (select organization_id from public.memberships where user_id = auth.uid()));

drop policy if exists "org members read own ai topups" on public.ai_credit_topups;
create policy "org members read own ai topups"
  on public.ai_credit_topups for select
  to authenticated
  using (organization_id in (select organization_id from public.memberships where user_id = auth.uid()));

drop policy if exists "authenticated read ai credit packs" on public.ai_credit_packs;
create policy "authenticated read ai credit packs"
  on public.ai_credit_packs for select
  to authenticated
  using (is_active);

-- เพิ่มเครดิตหลังสลิปผ่าน (server เท่านั้น — ไม่ grant ให้ authenticated)
create or replace function public.add_ai_credit(
  p_organization_id uuid,
  p_tokens bigint
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_remaining bigint;
begin
  if p_tokens is null or p_tokens <= 0 then
    raise exception 'invalid token amount';
  end if;
  insert into public.ai_credit_balances (organization_id, tokens_remaining, tokens_purchased, updated_at)
  values (p_organization_id, p_tokens, p_tokens, now())
  on conflict (organization_id) do update
    set tokens_remaining = public.ai_credit_balances.tokens_remaining + excluded.tokens_remaining,
        tokens_purchased = public.ai_credit_balances.tokens_purchased + excluded.tokens_purchased,
        updated_at = now()
  returning tokens_remaining into v_remaining;
  return v_remaining;
end;
$$;

revoke execute on function public.add_ai_credit(uuid, bigint) from public;

-- โควตารวมทุกฟีเจอร์: โควตาฟรีรายเดือนก่อน แล้วค่อยหักเครดิตที่ซื้อไว้
create or replace function public.reserve_ai_quota(
  p_organization_id uuid,
  p_request_id text,
  p_feature text,
  p_max_tokens int,
  p_monthly_budget int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
  v_credit_left bigint;
begin
  if p_max_tokens is null or p_max_tokens <= 0 or p_monthly_budget is null or p_monthly_budget <= 0 then
    return jsonb_build_object('granted', false, 'reason', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text));

  if exists (
    select 1 from public.ai_quota_reservations
    where organization_id = p_organization_id and request_id = p_request_id
  ) then
    return jsonb_build_object('granted', true, 'reason', 'idempotent');
  end if;

  -- โควตาฟรีของเดือนนี้ = ยอดจองทุกฟีเจอร์รวมกัน (ไม่นับส่วนที่หักเครดิตไปแล้ว)
  select coalesce(sum(tokens_reserved), 0) into v_used
  from public.ai_quota_reservations
  where organization_id = p_organization_id
    and source = 'monthly'
    and date_trunc('month', created_at) = date_trunc('month', now());

  if v_used + p_max_tokens <= p_monthly_budget then
    insert into public.ai_quota_reservations (organization_id, request_id, feature, tokens_reserved, source)
    values (p_organization_id, p_request_id, p_feature, p_max_tokens, 'monthly');
    return jsonb_build_object('granted', true, 'source', 'monthly');
  end if;

  -- โควตาฟรีหมด → หักจากเครดิตที่เติมเงินไว้ (หักได้ก็ต่อเมื่อยอดพอทั้งก้อน)
  update public.ai_credit_balances
    set tokens_remaining = tokens_remaining - p_max_tokens,
        updated_at = now()
  where organization_id = p_organization_id
    and tokens_remaining >= p_max_tokens
  returning tokens_remaining into v_credit_left;

  if v_credit_left is not null then
    insert into public.ai_quota_reservations (organization_id, request_id, feature, tokens_reserved, source)
    values (p_organization_id, p_request_id, p_feature, p_max_tokens, 'credit');
    return jsonb_build_object('granted', true, 'source', 'credit', 'creditRemaining', v_credit_left);
  end if;

  insert into public.ai_usage_logs (organization_id, feature, model, tokens, status, request_hash)
  values (p_organization_id, p_feature, 'none', 0, 'denied', md5(p_request_id));
  return jsonb_build_object('granted', false, 'reason', 'budget_exceeded', 'used', v_used, 'budget', p_monthly_budget);
end;
$$;

grant execute on function public.reserve_ai_quota(uuid, text, text, int, int) to authenticated;
