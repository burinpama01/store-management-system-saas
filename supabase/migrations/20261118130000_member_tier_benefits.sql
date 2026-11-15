-- ระดับสมาชิก · P2b — สิทธิ์ตามระดับเป็น "โค้ดพิเศษรายเดือน" แบบ Shopee Rewards
--
-- - member_tier_benefits: เจ้าของตั้งสิทธิ์ต่อระดับ (ระดับขั้นต่ำ, ลดเป็นบาท/เปอร์เซ็นต์, ยอดขั้นต่ำ, ใช้ได้กี่ครั้งต่อเดือน)
-- - ทุกเดือน ระบบสร้างคูปองจริงในตาราง coupons ให้ทุกสาขา (รหัสสุ่ม ใช้ได้เฉพาะเดือนนั้น,
--   max_redemptions_per_customer = จำนวนครั้งต่อเดือน) → ใช้ทางคิดส่วนลดคูปองเดิมทั้งหมด ไม่แตะการคิดราคา
-- - บังคับในฐานข้อมูล (ทุกช่องทาง POS): ใช้คูปองระดับได้เฉพาะ
--     (1) สมาชิกที่ระดับถึง และร้านเปิดใช้ระดับอยู่
--     (2) มีผลยืนยันรหัสสมาชิก 5 นาทีที่ยังไม่หมดอายุในสาขานั้น (T3)
-- - ข้อจำกัด v1: คูปองเปอร์เซ็นต์ยังไม่มีเพดานส่วนลด (ระบบคูปองเดิมไม่มี) และยังไม่มีตัวคูณแต้ม/ของขวัญวันเกิด

create table if not exists public.member_tier_benefits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  min_rank integer not null check (min_rank between 1 and 5),
  name text not null check (length(trim(name)) between 1 and 80),
  discount_type text not null check (discount_type in ('amount', 'percentage')),
  discount_value numeric(12,2) not null check (discount_value > 0),
  min_subtotal numeric(12,2) not null default 0 check (min_subtotal >= 0),
  uses_per_month integer not null default 1 check (uses_per_month between 1 and 31),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discount_type <> 'percentage' or discount_value <= 100)
);

create index if not exists member_tier_benefits_org_idx on public.member_tier_benefits (organization_id, is_active);

create table if not exists public.member_tier_benefit_coupons (
  benefit_id uuid not null references public.member_tier_benefits(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  month_start date not null,
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (benefit_id, store_id, month_start)
);

alter table public.coupons
  add column if not exists member_tier_benefit_id uuid references public.member_tier_benefits(id) on delete set null;

-- trigger ตรวจผลยืนยันรหัสตอนใช้คูปองระดับ (ไม่สนว่าถูกใช้กับแพ็กแล้วหรือยัง)
create index if not exists member_verifications_customer_store_active_idx
  on public.member_verifications (customer_id, store_id, expires_at desc);

create index if not exists coupons_member_tier_benefit_idx on public.coupons (member_tier_benefit_id) where member_tier_benefit_id is not null;

alter table public.member_tier_benefits enable row level security;
alter table public.member_tier_benefit_coupons enable row level security;
revoke all on table public.member_tier_benefits from anon, authenticated;
revoke all on table public.member_tier_benefit_coupons from anon, authenticated;
grant select on table public.member_tier_benefits to authenticated;
grant select on table public.member_tier_benefit_coupons to authenticated;

drop policy if exists "member_tier_benefits: org member can read" on public.member_tier_benefits;
create policy "member_tier_benefits: org member can read" on public.member_tier_benefits for select
  using (organization_id in (select s.organization_id from public.stores s where s.id in (select auth_user_store_ids())));
drop policy if exists "member_tier_benefit_coupons: store member can read" on public.member_tier_benefit_coupons;
create policy "member_tier_benefit_coupons: store member can read" on public.member_tier_benefit_coupons for select
  using (store_id in (select auth_user_store_ids()));

-- ---------------------------------------------------------------------------
-- สร้างคูปองของเดือนปัจจุบันให้ทุกสาขา (idempotent) — cron ทุกวัน + หลังบันทึกสิทธิ์
-- ---------------------------------------------------------------------------
create or replace function public.ensure_member_tier_coupons(p_org uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'Asia/Bangkok')::date;
  v_starts timestamptz := (date_trunc('month', now() at time zone 'Asia/Bangkok')) at time zone 'Asia/Bangkok';
  v_ends timestamptz := ((date_trunc('month', now() at time zone 'Asia/Bangkok') + interval '1 month') at time zone 'Asia/Bangkok') - interval '1 microsecond';
  v_row record;
  v_coupon_id uuid;
  v_code text;
  v_count integer := 0;
begin
  for v_row in
    select b.*, s.id as store_id
      from public.member_tier_benefits b
      join public.member_tier_programs p on p.organization_id = b.organization_id and p.is_enabled and p.initialized_at is not null
      join public.stores s on s.organization_id = b.organization_id and s.is_active
     where b.is_active
       and (p_org is null or b.organization_id = p_org)
       and not exists (
         select 1 from public.member_tier_benefit_coupons bc
          where bc.benefit_id = b.id and bc.store_id = s.id and bc.month_start = v_month
       )
  loop
    -- กัน cron กับการบันทึกสิทธิ์สร้างคูปองซ้ำพร้อมกัน (จะเหลือคูปองกำพร้าที่ใช้ได้นอกโควตา)
    perform pg_advisory_xact_lock(hashtextextended(v_row.id::text || ':' || v_row.store_id::text || ':' || v_month::text, 0));
    if exists (
      select 1 from public.member_tier_benefit_coupons bc
       where bc.benefit_id = v_row.id and bc.store_id = v_row.store_id and bc.month_start = v_month
    ) then
      continue;
    end if;
    -- รหัสสุ่ม 8 ตัว (ไม่ใช้รูปแบบเดาง่ายเช่น GOLD-2611)
    v_code := 'TR' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
    insert into public.coupons (
      organization_id, store_id, code, name, discount_type, discount_value, min_subtotal,
      starts_at, ends_at, max_redemptions, max_redemptions_per_customer, customer_ids,
      stackable_with_manual_discount, is_active, member_tier_benefit_id
    ) values (
      v_row.organization_id, v_row.store_id, v_code,
      '[ระดับสมาชิก] ' || v_row.name || ' · ' || to_char(v_month, 'YYYY-MM'),
      v_row.discount_type, v_row.discount_value, v_row.min_subtotal,
      v_starts, v_ends, null, v_row.uses_per_month, '{}'::uuid[],
      false, true, v_row.id
    )
    returning id into v_coupon_id;

    insert into public.member_tier_benefit_coupons (benefit_id, store_id, month_start, coupon_id)
    values (v_row.id, v_row.store_id, v_month, v_coupon_id);
    v_count := v_count + 1;
  end loop;

  -- สิทธิ์ที่ปิดแล้ว → ปิดคูปองเดือนนี้ด้วย
  update public.coupons c
     set is_active = false, updated_at = now()
    from public.member_tier_benefits b
   where c.member_tier_benefit_id = b.id
     and (p_org is null or b.organization_id = p_org)
     and not b.is_active
     and c.is_active;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- บันทึกสิทธิ์ทั้งชุด (owner/admin)
-- p_benefits: [{ "id": null|uuid, "min_rank": 1, "name": "...", "discount_type": "amount", "discount_value": 20,
--                "min_subtotal": 100, "uses_per_month": 1, "is_active": true }]
-- สิทธิ์ที่แก้มูลค่า → ปิดคูปองเดือนนี้ของสิทธิ์นั้นแล้วสร้างใหม่ (คนที่ใช้ไปแล้วยังนับ ไม่ได้สิทธิ์เพิ่ม — ยอมรับได้)
-- ---------------------------------------------------------------------------
create or replace function public.save_member_tier_benefits(p_store_id uuid, p_benefits jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_item jsonb;
  v_id uuid;
  v_old public.member_tier_benefits%rowtype;
  v_keep uuid[] := '{}';
  v_max_rank integer;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or auth.uid() is null or not auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'เฉพาะเจ้าของหรือแอดมินที่ตั้งสิทธิ์ตามระดับได้';
  end if;
  if jsonb_array_length(coalesce(p_benefits, '[]'::jsonb)) > 30 then
    raise exception 'ตั้งสิทธิ์ได้สูงสุด 30 รายการ';
  end if;
  select max(rank) into v_max_rank from public.member_tiers where organization_id = v_org;
  if v_max_rank is null then raise exception 'ตั้งค่าระดับสมาชิกก่อน'; end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_benefits, '[]'::jsonb))
  loop
    if (v_item ->> 'min_rank')::int < 1 or (v_item ->> 'min_rank')::int > v_max_rank then
      raise exception 'ระดับของสิทธิ์ "%" ไม่มีอยู่', v_item ->> 'name';
    end if;
    v_id := nullif(v_item ->> 'id', '')::uuid;
    if v_id is not null then
      select * into v_old from public.member_tier_benefits where id = v_id and organization_id = v_org for update;
      if not found then raise exception 'ไม่พบสิทธิ์ที่จะแก้'; end if;
      update public.member_tier_benefits
         set min_rank = (v_item ->> 'min_rank')::int,
             name = trim(v_item ->> 'name'),
             discount_type = v_item ->> 'discount_type',
             discount_value = (v_item ->> 'discount_value')::numeric,
             min_subtotal = coalesce((v_item ->> 'min_subtotal')::numeric, 0),
             uses_per_month = coalesce((v_item ->> 'uses_per_month')::int, 1),
             is_active = coalesce((v_item ->> 'is_active')::boolean, true),
             updated_at = now()
       where id = v_id;
      if v_old.discount_type is distinct from v_item ->> 'discount_type'
         or v_old.discount_value is distinct from (v_item ->> 'discount_value')::numeric
         or v_old.min_subtotal is distinct from coalesce((v_item ->> 'min_subtotal')::numeric, 0)
         or v_old.uses_per_month is distinct from coalesce((v_item ->> 'uses_per_month')::int, 1)
         or v_old.name is distinct from trim(v_item ->> 'name') then
        update public.coupons set is_active = false, updated_at = now()
         where member_tier_benefit_id = v_id and is_active;
        delete from public.member_tier_benefit_coupons
         where benefit_id = v_id and month_start = date_trunc('month', now() at time zone 'Asia/Bangkok')::date;
      end if;
    else
      insert into public.member_tier_benefits (organization_id, min_rank, name, discount_type, discount_value, min_subtotal, uses_per_month, is_active)
      values (
        v_org, (v_item ->> 'min_rank')::int, trim(v_item ->> 'name'), v_item ->> 'discount_type',
        (v_item ->> 'discount_value')::numeric, coalesce((v_item ->> 'min_subtotal')::numeric, 0),
        coalesce((v_item ->> 'uses_per_month')::int, 1), coalesce((v_item ->> 'is_active')::boolean, true)
      )
      returning id into v_id;
    end if;
    v_keep := v_keep || v_id;
  end loop;

  -- สิทธิ์ที่เอาออกจากรายการ = ปิด (ไม่ลบ เพื่อเก็บประวัติคูปองที่ใช้ไปแล้ว)
  update public.member_tier_benefits set is_active = false, updated_at = now()
   where organization_id = v_org and not (id = any(v_keep)) and is_active;

  perform public.ensure_member_tier_coupons(v_org);
end;
$$;

-- ---------------------------------------------------------------------------
-- บังคับเงื่อนไขตอนใช้คูปองระดับ (ทุกเส้นทางที่ insert coupon_redemptions)
-- ---------------------------------------------------------------------------
create or replace function public.enforce_member_tier_coupon()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_benefit public.member_tier_benefits%rowtype;
  v_identity uuid;
  v_rank integer;
begin
  select b.* into v_benefit
    from public.coupons c
    join public.member_tier_benefits b on b.id = c.member_tier_benefit_id
   where c.id = new.coupon_id;
  if not found then
    return new; -- คูปองธรรมดา
  end if;

  if new.customer_id is null then
    raise exception 'โค้ดสิทธิ์ระดับสมาชิกต้องผูกสมาชิกในบิล';
  end if;
  if not exists (
    select 1 from public.member_tier_programs
     where organization_id = v_benefit.organization_id and is_enabled and initialized_at is not null
  ) then
    raise exception 'ร้านปิดระบบระดับสมาชิกแล้ว';
  end if;
  -- T3: ต้องยืนยันรหัสสมาชิก 5 นาทีในสาขานี้ก่อน (ผลยืนยันยังไม่หมดอายุ)
  if not exists (
    select 1 from public.member_verifications v
     where v.customer_id = new.customer_id and v.store_id = new.store_id and v.expires_at > now()
  ) then
    raise exception 'ต้องยืนยันรหัสสมาชิกก่อนใช้โค้ดสิทธิ์ระดับ';
  end if;

  select member_identity_id into v_identity from public.customers where id = new.customer_id;
  perform public.member_tier_rollover(v_identity);
  select tier_rank into v_rank from public.member_tier_status where member_identity_id = v_identity;
  if coalesce(v_rank, 0) < v_benefit.min_rank then
    raise exception 'ระดับสมาชิกยังไม่ถึงสิทธิ์นี้';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_member_tier_coupon on public.coupon_redemptions;
create trigger enforce_member_tier_coupon
  before insert on public.coupon_redemptions
  for each row execute function public.enforce_member_tier_coupon();

-- เปิดใช้ระดับครั้งแรก/เปิดใหม่ → สร้างคูปองเดือนนี้ทันที
create or replace function public.member_tier_program_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_enabled and new.initialized_at is not null then
    perform public.ensure_member_tier_coupons(new.organization_id);
  end if;
  return new;
end;
$$;

drop trigger if exists member_tier_program_after_change on public.member_tier_programs;
create trigger member_tier_program_after_change
  after insert or update of is_enabled, initialized_at on public.member_tier_programs
  for each row execute function public.member_tier_program_after_change();

revoke all on function public.ensure_member_tier_coupons(uuid) from public, anon, authenticated;
revoke all on function public.enforce_member_tier_coupon() from public, anon, authenticated;
revoke all on function public.member_tier_program_after_change() from public, anon, authenticated;
revoke all on function public.save_member_tier_benefits(uuid, jsonb) from public, anon;
grant execute on function public.save_member_tier_benefits(uuid, jsonb) to authenticated;
grant execute on function public.ensure_member_tier_coupons(uuid) to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'ensure-member-tier-coupons') then
    perform cron.unschedule('ensure-member-tier-coupons');
  end if;
end $$;
-- 17:20 UTC = 00:20 เวลาไทย (หลัง rollover 00:15) — วันที่ 1 จะได้คูปองเดือนใหม่
select cron.schedule('ensure-member-tier-coupons', '20 17 * * *', $job$ select public.ensure_member_tier_coupons(null); $job$);
