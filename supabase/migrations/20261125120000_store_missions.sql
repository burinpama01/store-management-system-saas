-- ภารกิจสะสม (Missions) · M1
--
-- ลูกค้ากด "รับภารกิจ" ในหน้าสมาชิก → ซื้อสินค้าตามขอบเขตที่ร้าน → นับอัตโนมัติตอนบิลจ่ายสำเร็จ
-- → ครบเป้า → ได้คูปองรางวัล (ใช้ระบบคูปองแลกแต้มเดิม: loyalty_reward_redemptions แบบ 0 แต้ม)
--
-- ข้อกำหนดจากผู้ใช้ (2026-11-17):
--   1) นับเฉพาะบิลที่จ่ายหลังกดรับภารกิจ
--   2) นับชิ้น · ร้านตั้งเพดานต่อบิลได้ต่อภารกิจ (max_per_order)
--   3) ครบแล้วเริ่มรอบใหม่ได้ถ้าร้านเปิด (repeatable) แต่ลูกค้าต้องกดรับเอง (ไม่ต่ออัตโนมัติ)
--   4) ไม่แตะการคิดแต้ม
--   6) Enterprise (ตรวจฝั่งแอป) + สวิตช์ต่อสาขา stores.missions_enabled (ปิดทุกร้าน)
--
-- รางวัล: ของรางวัลซ่อน (loyalty_rewards.mission_only = true, is_active = false)
--   - is_active = false ⇒ แลกด้วยแต้มผ่าน redeem_loyalty_reward ไม่ได้ และไม่ขึ้นในแคตตาล็อกแต้ม
--   - POS ใช้คูปองรางวัลได้ตามเดิม (findProductRewardVoucher/คูปองส่วนลดผูกลูกค้า ไม่ดู is_active)
--   - ใช้คูปองรางวัลภารกิจต้องยืนยันรหัสสมาชิก 5 นาทีในสาขานั้น (บังคับใน DB)
-- M1 ภารกิจเป็นรายสาขา: นับและใช้รางวัลในสาขาที่สร้าง

-- ---------------------------------------------------------------------------
-- คอลัมน์เสริมในตารางเดิม
-- ---------------------------------------------------------------------------
alter table public.stores
  add column if not exists missions_enabled boolean not null default false;
comment on column public.stores.missions_enabled is
  'เปิดภารกิจสะสมของสาขา (หน้าสมาชิกแสดงภารกิจ + นับตอนจ่ายบิล) — Enterprise เท่านั้น';

alter table public.loyalty_rewards
  add column if not exists mission_only boolean not null default false;

-- ---------------------------------------------------------------------------
-- ตารางภารกิจ
-- ---------------------------------------------------------------------------
create table if not exists public.store_missions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  description text check (description is null or length(description) <= 300),
  scope text not null default 'all' check (scope in ('all', 'categories', 'products')),
  category_ids uuid[] not null default '{}',
  product_ids uuid[] not null default '{}',
  target_count integer not null check (target_count between 1 and 100),
  max_per_order integer check (max_per_order is null or max_per_order between 1 and 100),
  duration_days integer check (duration_days is null or duration_days between 1 and 365),
  join_starts_at timestamptz not null default now(),
  join_ends_at timestamptz,
  repeatable boolean not null default false,
  max_participants integer check (max_participants is null or max_participants between 1 and 100000),
  reward_type text not null check (reward_type in ('product', 'discount')),
  -- ไม่ทำ FK ไป products (เทสต์ catalog ห้าม) — save_store_mission ตรวจว่าสินค้าอยู่ในสาขาเอง
  reward_product_id uuid,
  reward_discount_kind text check (reward_discount_kind is null or reward_discount_kind in ('amount', 'percentage')),
  reward_discount_value numeric(12,2) check (reward_discount_value is null or reward_discount_value > 0),
  reward_min_subtotal numeric(12,2) not null default 0 check (reward_min_subtotal >= 0),
  reward_valid_days integer not null default 30 check (reward_valid_days between 1 and 365),
  reward_id uuid references public.loyalty_rewards(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'ended')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scope <> 'categories' or cardinality(category_ids) > 0),
  check (scope <> 'products' or cardinality(product_ids) > 0),
  check (reward_type <> 'discount' or (reward_discount_kind is not null and reward_discount_value is not null)),
  check (reward_discount_kind is distinct from 'percentage' or reward_discount_value <= 100),
  check (join_ends_at is null or join_ends_at > join_starts_at),
  -- ต้องมีวันจบอย่างน้อยหนึ่งแบบ ไม่ให้รอบค้างตลอดไป
  check (duration_days is not null or join_ends_at is not null)
);

create index if not exists store_missions_store_idx on public.store_missions (store_id, status, created_at desc);

create table if not exists public.store_mission_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  mission_id uuid not null references public.store_missions(id) on delete cascade,
  member_identity_id uuid not null references public.member_identities(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  round integer not null default 1 check (round >= 1),
  progress integer not null default 0 check (progress >= 0),
  target_count integer not null check (target_count >= 1),
  max_per_order integer,
  status text not null default 'active' check (status in ('active', 'completed', 'expired', 'cancelled')),
  -- ยินยอมรับ SMS ของรอบนี้ (ติ๊กตอนกดรับ) — บันทึกพร้อม insert ใน join_store_mission (atomic, PDPA)
  sms_opt_in boolean not null default true,
  joined_at timestamptz not null default now(),
  expires_at timestamptz,
  completed_at timestamptz,
  reward_redemption_id uuid references public.loyalty_reward_redemptions(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (mission_id, member_identity_id, round)
);

-- กำลังทำได้ทีละรอบต่อภารกิจต่อคน
create unique index if not exists store_mission_enrollments_one_active_idx
  on public.store_mission_enrollments (mission_id, member_identity_id) where status = 'active';
create index if not exists store_mission_enrollments_identity_idx
  on public.store_mission_enrollments (member_identity_id, store_id, status);
create index if not exists store_mission_enrollments_mission_idx
  on public.store_mission_enrollments (mission_id, status);

create table if not exists public.store_mission_progress (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enrollment_id uuid not null references public.store_mission_enrollments(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('earn', 'reverse')),
  quantity integer not null,
  created_at timestamptz not null default now(),
  unique (enrollment_id, order_id, kind)
);

create index if not exists store_mission_progress_order_idx on public.store_mission_progress (order_id);

-- คูปองรางวัลภารกิจ (ทั้งสินค้าฟรีและส่วนลด) ชี้กลับมาที่รอบภารกิจ
alter table public.loyalty_reward_redemptions
  add column if not exists mission_enrollment_id uuid references public.store_mission_enrollments(id) on delete set null;
create index if not exists loyalty_reward_redemptions_mission_idx
  on public.loyalty_reward_redemptions (mission_enrollment_id) where mission_enrollment_id is not null;

alter table public.loyalty_reward_redemptions drop constraint if exists loyalty_reward_redemptions_points_spent_check;
alter table public.loyalty_reward_redemptions add constraint loyalty_reward_redemptions_points_spent_check
  check (points_spent > 0 or (points_spent = 0 and mission_enrollment_id is not null));

alter table public.coupons
  add column if not exists store_mission_id uuid references public.store_missions(id) on delete set null;
create index if not exists coupons_store_mission_idx on public.coupons (store_mission_id) where store_mission_id is not null;

-- ---------------------------------------------------------------------------
-- RLS: พนักงานในสาขาอ่านได้ · เขียนผ่าน RPC/service role เท่านั้น
-- ---------------------------------------------------------------------------
alter table public.store_missions enable row level security;
alter table public.store_mission_enrollments enable row level security;
alter table public.store_mission_progress enable row level security;
revoke all on table public.store_missions from anon, authenticated;
revoke all on table public.store_mission_enrollments from anon, authenticated;
revoke all on table public.store_mission_progress from anon, authenticated;
grant select on table public.store_missions to authenticated;
grant select on table public.store_mission_enrollments to authenticated;

drop policy if exists "store_missions: store member can read" on public.store_missions;
create policy "store_missions: store member can read" on public.store_missions for select
  using (store_id in (select auth_user_store_ids()));
drop policy if exists "store_mission_enrollments: store member can read" on public.store_mission_enrollments;
create policy "store_mission_enrollments: store member can read" on public.store_mission_enrollments for select
  using (store_id in (select auth_user_store_ids()));

-- ---------------------------------------------------------------------------
-- วันหมดเขตของรอบ = ก่อนสุดระหว่าง (กดรับ + จำนวนวัน) กับ วันปิดรับภารกิจ
-- ---------------------------------------------------------------------------
create or replace function public.store_mission_round_expiry(p_duration_days integer, p_join_ends_at timestamptz, p_joined_at timestamptz)
returns timestamptz
language sql
immutable
as $$
  select case
    when p_duration_days is null then p_join_ends_at
    when p_join_ends_at is null then p_joined_at + make_interval(days => p_duration_days)
    else least(p_joined_at + make_interval(days => p_duration_days), p_join_ends_at)
  end;
$$;

-- ---------------------------------------------------------------------------
-- บันทึกภารกิจ (owner/admin)
-- p_payload: { id?, name, description?, scope, category_ids[], product_ids[], target_count, max_per_order?,
--              duration_days?, join_starts_at?, join_ends_at?, repeatable, max_participants?,
--              reward_type, reward_product_id?, reward_discount_kind?, reward_discount_value?,
--              reward_min_subtotal?, reward_valid_days?, status? }
-- เปลี่ยนเป้า/เพดานมีผลกับรอบที่กดรับใหม่เท่านั้น (รอบเดิมเก็บค่าไว้ตอนกดรับ)
-- เปลี่ยนรางวัล → สร้างของรางวัลซ่อนแถวใหม่ (คูปองที่ออกไปแล้วยังได้รางวัลเดิม)
-- ---------------------------------------------------------------------------
create or replace function public.save_store_mission(p_store_id uuid, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_id uuid := nullif(p_payload ->> 'id', '')::uuid;
  v_old public.store_missions%rowtype;
  v_name text := trim(coalesce(p_payload ->> 'name', ''));
  v_scope text := coalesce(p_payload ->> 'scope', 'all');
  v_categories uuid[] := coalesce(array(select jsonb_array_elements_text(coalesce(p_payload -> 'category_ids', '[]'::jsonb))::uuid), '{}');
  v_products uuid[] := coalesce(array(select jsonb_array_elements_text(coalesce(p_payload -> 'product_ids', '[]'::jsonb))::uuid), '{}');
  v_reward_type text := p_payload ->> 'reward_type';
  v_reward_product uuid := nullif(p_payload ->> 'reward_product_id', '')::uuid;
  v_kind text := nullif(p_payload ->> 'reward_discount_kind', '');
  v_value numeric := nullif(p_payload ->> 'reward_discount_value', '')::numeric;
  v_min numeric := coalesce(nullif(p_payload ->> 'reward_min_subtotal', '')::numeric, 0);
  v_reward_id uuid;
  v_reward_changed boolean := true;
  v_product_name text;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or auth.uid() is null or not auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'เฉพาะเจ้าของหรือแอดมินที่ตั้งภารกิจได้';
  end if;
  if v_name = '' then raise exception 'ตั้งชื่อภารกิจก่อน'; end if;
  if v_scope not in ('all', 'categories', 'products') then raise exception 'ขอบเขตสินค้าไม่ถูกต้อง'; end if;
  if v_scope = 'categories' then
    v_products := '{}';
    if cardinality(v_categories) = 0 then raise exception 'เลือกหมวดที่นับอย่างน้อย 1 หมวด'; end if;
    if exists (select 1 from unnest(v_categories) c(id) where not exists (
      select 1 from public.categories k where k.id = c.id and k.store_id = p_store_id)) then
      raise exception 'มีหมวดที่ไม่อยู่ในสาขานี้';
    end if;
  elsif v_scope = 'products' then
    v_categories := '{}';
    if cardinality(v_products) = 0 then raise exception 'เลือกสินค้าที่นับอย่างน้อย 1 รายการ'; end if;
    if exists (select 1 from unnest(v_products) p(id) where not exists (
      select 1 from public.products x where x.id = p.id and x.store_id = p_store_id)) then
      raise exception 'มีสินค้าที่ไม่อยู่ในสาขานี้';
    end if;
  else
    v_categories := '{}';
    v_products := '{}';
  end if;

  if v_reward_type = 'product' then
    select name into v_product_name from public.products where id = v_reward_product and store_id = p_store_id;
    if v_product_name is null then raise exception 'เลือกสินค้าที่เป็นรางวัล'; end if;
    v_kind := null; v_value := null; v_min := 0;
  elsif v_reward_type = 'discount' then
    v_reward_product := null;
    if v_kind not in ('amount', 'percentage') or v_value is null or v_value <= 0 then
      raise exception 'ตั้งส่วนลดของรางวัลให้ถูกต้อง';
    end if;
    if v_kind = 'percentage' and v_value > 100 then raise exception 'ส่วนลดเปอร์เซ็นต์ต้องไม่เกิน 100'; end if;
  else
    raise exception 'เลือกชนิดรางวัล';
  end if;

  if v_id is not null then
    select * into v_old from public.store_missions where id = v_id and store_id = p_store_id for update;
    if not found then raise exception 'ไม่พบภารกิจที่จะแก้'; end if;
    v_reward_changed := v_old.reward_id is null
      or v_old.reward_type is distinct from v_reward_type
      or v_old.reward_product_id is distinct from v_reward_product
      or v_old.reward_discount_kind is distinct from v_kind
      or v_old.reward_discount_value is distinct from v_value
      or v_old.reward_min_subtotal is distinct from v_min
      or v_old.name is distinct from v_name;
    v_reward_id := v_old.reward_id;
  end if;

  if v_reward_changed then
    insert into public.loyalty_rewards (
      organization_id, store_id, name, description, points_cost, is_active, mission_only,
      reward_type, discount_kind, discount_value, reward_product_id
    ) values (
      v_org, p_store_id, 'ภารกิจ: ' || v_name,
      case when v_reward_type = 'product' then 'รางวัลภารกิจ — ' || v_product_name else 'รางวัลภารกิจ' end,
      1, false, true, v_reward_type, v_kind, v_value, v_reward_product
    )
    returning id into v_reward_id;
  end if;

  if v_id is null then
    insert into public.store_missions (
      organization_id, store_id, name, description, scope, category_ids, product_ids, target_count, max_per_order,
      duration_days, join_starts_at, join_ends_at, repeatable, max_participants, reward_type, reward_product_id,
      reward_discount_kind, reward_discount_value, reward_min_subtotal, reward_valid_days, reward_id, status, created_by
    ) values (
      v_org, p_store_id, v_name, nullif(trim(coalesce(p_payload ->> 'description', '')), ''), v_scope, v_categories, v_products,
      (p_payload ->> 'target_count')::int, nullif(p_payload ->> 'max_per_order', '')::int,
      nullif(p_payload ->> 'duration_days', '')::int,
      coalesce(nullif(p_payload ->> 'join_starts_at', '')::timestamptz, now()),
      nullif(p_payload ->> 'join_ends_at', '')::timestamptz,
      coalesce((p_payload ->> 'repeatable')::boolean, false),
      nullif(p_payload ->> 'max_participants', '')::int,
      v_reward_type, v_reward_product, v_kind, v_value, v_min,
      coalesce(nullif(p_payload ->> 'reward_valid_days', '')::int, 30), v_reward_id,
      coalesce(nullif(p_payload ->> 'status', ''), 'active'), auth.uid()
    )
    returning id into v_id;
  else
    update public.store_missions set
      name = v_name,
      description = nullif(trim(coalesce(p_payload ->> 'description', '')), ''),
      scope = v_scope, category_ids = v_categories, product_ids = v_products,
      target_count = (p_payload ->> 'target_count')::int,
      max_per_order = nullif(p_payload ->> 'max_per_order', '')::int,
      duration_days = nullif(p_payload ->> 'duration_days', '')::int,
      join_starts_at = coalesce(nullif(p_payload ->> 'join_starts_at', '')::timestamptz, v_old.join_starts_at),
      join_ends_at = nullif(p_payload ->> 'join_ends_at', '')::timestamptz,
      repeatable = coalesce((p_payload ->> 'repeatable')::boolean, false),
      max_participants = nullif(p_payload ->> 'max_participants', '')::int,
      reward_type = v_reward_type, reward_product_id = v_reward_product,
      reward_discount_kind = v_kind, reward_discount_value = v_value, reward_min_subtotal = v_min,
      reward_valid_days = coalesce(nullif(p_payload ->> 'reward_valid_days', '')::int, 30),
      reward_id = v_reward_id,
      status = coalesce(nullif(p_payload ->> 'status', ''), v_old.status),
      updated_at = now()
     where id = v_id;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้ากดรับภารกิจ (เรียกจาก server หลังตรวจเซสชันสมาชิกแล้ว — service role เท่านั้น)
-- ---------------------------------------------------------------------------
create or replace function public.join_store_mission(p_customer_id uuid, p_mission_id uuid, p_sms_opt_in boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer public.customers%rowtype;
  v_mission public.store_missions%rowtype;
  v_existing public.store_mission_enrollments%rowtype;
  v_round integer;
  v_joined integer;
  v_now timestamptz := now();
  v_enrollment public.store_mission_enrollments%rowtype;
begin
  select * into v_customer from public.customers where id = p_customer_id and is_active;
  if not found then raise exception 'ไม่พบสมาชิก'; end if;
  if v_customer.member_identity_id is null then raise exception 'สมาชิกต้องมีเบอร์โทรจึงรับภารกิจได้'; end if;

  select * into v_mission from public.store_missions where id = p_mission_id for update;
  if not found or v_mission.store_id <> v_customer.store_id then raise exception 'ไม่พบภารกิจ'; end if;
  if not exists (select 1 from public.stores where id = v_mission.store_id and missions_enabled) then
    raise exception 'ร้านปิดภารกิจอยู่';
  end if;
  if v_mission.status <> 'active' or v_mission.join_starts_at > v_now
     or (v_mission.join_ends_at is not null and v_mission.join_ends_at <= v_now) then
    raise exception 'ภารกิจนี้ยังไม่เปิดหรือปิดรับแล้ว';
  end if;

  -- กำลังทำอยู่แล้ว = คืนรอบเดิม (กดซ้ำได้)
  select * into v_existing from public.store_mission_enrollments
   where mission_id = p_mission_id and member_identity_id = v_customer.member_identity_id and status = 'active';
  if found then
    if v_existing.expires_at is null or v_existing.expires_at > v_now then
      -- ไม่ยินยอมรอบนี้ = ปิดทันที (ยินยอมเพิ่มไม่ทำย้อนให้ เพื่อเคารพการเลือกเดิม)
      if p_sms_opt_in is false and v_existing.sms_opt_in then
        update public.store_mission_enrollments set sms_opt_in = false, updated_at = v_now where id = v_existing.id;
      end if;
      return jsonb_build_object('enrollment_id', v_existing.id, 'round', v_existing.round, 'already', true);
    end if;
    update public.store_mission_enrollments set status = 'expired', updated_at = v_now where id = v_existing.id;
  end if;

  select coalesce(max(round), 0) into v_round from public.store_mission_enrollments
   where mission_id = p_mission_id and member_identity_id = v_customer.member_identity_id;
  if v_round > 0 and not v_mission.repeatable then
    raise exception 'ภารกิจนี้รับได้ครั้งเดียว';
  end if;

  if v_round = 0 and v_mission.max_participants is not null then
    select count(distinct member_identity_id) into v_joined from public.store_mission_enrollments where mission_id = p_mission_id;
    if v_joined >= v_mission.max_participants then raise exception 'ภารกิจนี้มีผู้รับครบแล้ว'; end if;
  end if;

  insert into public.store_mission_enrollments (
    organization_id, store_id, mission_id, member_identity_id, customer_id, round,
    target_count, max_per_order, joined_at, expires_at, sms_opt_in
  ) values (
    v_mission.organization_id, v_mission.store_id, v_mission.id, v_customer.member_identity_id, v_customer.id, v_round + 1,
    v_mission.target_count, v_mission.max_per_order, v_now,
    public.store_mission_round_expiry(v_mission.duration_days, v_mission.join_ends_at, v_now),
    coalesce(p_sms_opt_in, true)
  )
  returning * into v_enrollment;

  return jsonb_build_object('enrollment_id', v_enrollment.id, 'round', v_enrollment.round, 'already', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- ออกคูปองรางวัลเมื่อครบ (ภายใน trigger)
-- ---------------------------------------------------------------------------
create or replace function public.store_mission_issue_reward(p_enrollment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_e public.store_mission_enrollments%rowtype;
  v_m public.store_missions%rowtype;
  v_reward public.loyalty_rewards%rowtype;
  v_account_id uuid;
  v_code text;
  v_try integer := 0;
  v_expires timestamptz;
  v_coupon_id uuid := null;
  v_redemption_id uuid;
begin
  select * into v_e from public.store_mission_enrollments where id = p_enrollment_id for update;
  select * into v_m from public.store_missions where id = v_e.mission_id;
  select * into v_reward from public.loyalty_rewards where id = v_m.reward_id;
  if v_reward.id is null then
    raise exception 'ภารกิจ "%" ไม่มีของรางวัล', v_m.name;
  end if;
  v_expires := now() + make_interval(days => v_m.reward_valid_days);

  insert into public.loyalty_accounts (organization_id, store_id, customer_id)
  values (v_e.organization_id, v_e.store_id, v_e.customer_id)
  on conflict (store_id, customer_id) do update set updated_at = now()
  returning id into v_account_id;

  loop
    v_try := v_try + 1;
    v_code := 'MS' || gen_loyalty_voucher_token(6);
    exit when not exists (
      select 1 from public.coupons where store_id = v_e.store_id and normalized_code = normalize_coupon_code(v_code)
    ) and not exists (
      select 1 from public.loyalty_reward_redemptions where store_id = v_e.store_id and voucher_code = v_code
    );
    if v_try >= 25 then raise exception 'สร้างรหัสคูปองรางวัลไม่สำเร็จ'; end if;
  end loop;

  if v_reward.reward_type = 'discount' then
    insert into public.coupons (
      organization_id, store_id, code, name, discount_type, discount_value, min_subtotal,
      ends_at, max_redemptions, max_redemptions_per_customer, is_active, customer_ids, store_mission_id
    ) values (
      v_e.organization_id, v_e.store_id, v_code, 'รางวัลภารกิจ: ' || v_m.name,
      v_reward.discount_kind, v_reward.discount_value, v_m.reward_min_subtotal,
      v_expires, 1, 1, true, array[v_e.customer_id], v_m.id
    )
    returning id into v_coupon_id;
  end if;

  insert into public.loyalty_reward_redemptions (
    organization_id, store_id, reward_id, account_id, customer_id, points_spent, idempotency_key,
    voucher_code, coupon_id, expires_at, status, mission_enrollment_id
  ) values (
    v_e.organization_id, v_e.store_id, v_reward.id, v_account_id, v_e.customer_id, 0,
    'mission:' || v_e.id::text || ':' || gen_random_uuid()::text,
    v_code, v_coupon_id, v_expires, 'pending', v_e.id
  )
  returning id into v_redemption_id;

  update public.store_mission_enrollments
     set reward_redemption_id = v_redemption_id, updated_at = now()
   where id = v_e.id;
  return v_redemption_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- trigger: บิลจ่ายแล้ว → นับ · บิลถูก void/cancel/refund → หักคืน
-- ---------------------------------------------------------------------------
create or replace function public.store_missions_on_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_identity uuid;
  v_paid_at timestamptz;
  v_e record;
  v_qty integer;
  v_p record;
  v_red public.loyalty_reward_redemptions%rowtype;
  v_progress integer;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'paid' and new.customer_id is not null then
    select member_identity_id into v_identity from public.customers where id = new.customer_id;
    if v_identity is null then return new; end if;
    v_paid_at := coalesce(new.paid_at, now());

    for v_e in
      select e.id, e.progress, e.target_count, e.max_per_order, m.scope, m.category_ids, m.product_ids
        from public.store_mission_enrollments e
        join public.store_missions m on m.id = e.mission_id
        join public.stores s on s.id = e.store_id and s.missions_enabled
       where e.store_id = new.store_id
         and e.member_identity_id = v_identity
         and e.status = 'active'
         and m.status = 'active'
         and e.joined_at <= v_paid_at
         and (e.expires_at is null or e.expires_at > v_paid_at)
         and not exists (select 1 from public.store_mission_progress p where p.enrollment_id = e.id and p.order_id = new.id)
       for update of e
    loop
      -- นับชิ้นที่จ่ายเงินจริง (ไม่นับบรรทัด ฿0 เช่นคูปองสินค้าฟรี/ใช้แพ็ก และไม่นับสินค้าขายแพ็ก)
      select coalesce(sum(oi.quantity), 0)::int into v_qty
        from public.order_items oi
        join public.products pr on pr.id = oi.product_id
       where oi.order_id = new.id
         and coalesce(oi.voided, false) = false
         and oi.total_price > 0
         and not exists (select 1 from public.prepaid_pass_plans pl where pl.sale_product_id = oi.product_id)
         and (
           v_e.scope = 'all'
           or (v_e.scope = 'categories' and pr.category_id = any(v_e.category_ids))
           or (v_e.scope = 'products' and oi.product_id = any(v_e.product_ids))
         );
      if v_qty <= 0 then continue; end if;
      if v_e.max_per_order is not null then v_qty := least(v_qty, v_e.max_per_order); end if;
      v_qty := least(v_qty, v_e.target_count - v_e.progress);
      if v_qty <= 0 then continue; end if;

      insert into public.store_mission_progress (organization_id, enrollment_id, order_id, kind, quantity)
      values (new.organization_id, v_e.id, new.id, 'earn', v_qty);

      v_progress := v_e.progress + v_qty;
      if v_progress >= v_e.target_count then
        update public.store_mission_enrollments
           set progress = v_progress, status = 'completed', completed_at = now(), updated_at = now()
         where id = v_e.id;
        -- ออกคูปองพลาดต้องไม่ทำให้การจ่ายบิลล้ม — บันทึก log แล้วให้ cron ออกซ้ำ (reward_redemption_id ยังว่าง)
        begin
          perform public.store_mission_issue_reward(v_e.id);
        exception when others then
          insert into public.system_event_logs (level, source, action, message, error_code, organization_id, store_id, context)
          values ('error', 'missions.trigger', 'issueReward', left('ออกคูปองรางวัลภารกิจไม่สำเร็จ: ' || sqlerrm, 500), sqlstate,
                  new.organization_id, new.store_id, jsonb_build_object('enrollmentId', v_e.id, 'orderId', new.id));
        end;
      else
        update public.store_mission_enrollments set progress = v_progress, updated_at = now() where id = v_e.id;
      end if;
    end loop;
  end if;

  if new.status in ('voided', 'cancelled', 'refunded') then
    for v_p in
      select p.enrollment_id, p.quantity, e.status, e.progress, e.reward_redemption_id, e.mission_id, e.member_identity_id, e.expires_at
        from public.store_mission_progress p
        join public.store_mission_enrollments e on e.id = p.enrollment_id
       where p.order_id = new.id and p.kind = 'earn'
         and not exists (select 1 from public.store_mission_progress r
                          where r.enrollment_id = p.enrollment_id and r.order_id = p.order_id and r.kind = 'reverse')
       for update of e
    loop
      insert into public.store_mission_progress (organization_id, enrollment_id, order_id, kind, quantity)
      values (new.organization_id, v_p.enrollment_id, new.id, 'reverse', -v_p.quantity);

      if v_p.status = 'completed' then
        select * into v_red from public.loyalty_reward_redemptions where id = v_p.reward_redemption_id for update;
        if v_red.id is not null and v_red.used_at is null and v_red.status = 'pending' then
          -- คูปองยังไม่ถูกใช้ → ยกเลิกคูปองแล้วกลับไปทำต่อ (ถ้ามีรอบใหม่กำลังทำอยู่แล้ว ปิดรอบนี้แทน)
          update public.loyalty_reward_redemptions set status = 'cancelled' where id = v_red.id;
          if v_red.coupon_id is not null then
            update public.coupons set is_active = false, updated_at = now() where id = v_red.coupon_id;
          end if;
          update public.store_mission_enrollments
             set progress = greatest(v_p.progress - v_p.quantity, 0),
                 status = case when exists (
                   select 1 from public.store_mission_enrollments o
                    where o.mission_id = v_p.mission_id and o.member_identity_id = v_p.member_identity_id
                      and o.status = 'active' and o.id <> v_p.enrollment_id) then 'cancelled'
                   when v_p.expires_at is not null and v_p.expires_at <= now() then 'expired'
                   else 'active' end,
                 completed_at = null, reward_redemption_id = null, updated_at = now()
           where id = v_p.enrollment_id;
        end if;
        -- คูปองถูกใช้ไปแล้ว: ไม่ยกเลิกย้อนหลัง (บันทึก reverse ไว้เป็นหลักฐาน)
      else
        update public.store_mission_enrollments
           set progress = greatest(v_p.progress - v_p.quantity, 0), updated_at = now()
         where id = v_p.enrollment_id;
      end if;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists store_missions_on_order_status on public.orders;
create trigger store_missions_on_order_status
  after update of status on public.orders
  for each row execute function public.store_missions_on_order_status();

-- ---------------------------------------------------------------------------
-- ใช้คูปองรางวัลภารกิจต้องยืนยันรหัสสมาชิก 5 นาทีในสาขานั้น (ทุกเส้นทาง)
-- ---------------------------------------------------------------------------
create or replace function public.enforce_mission_voucher_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.mission_enrollment_id is not null and old.used_at is null and new.used_at is not null then
    if not exists (
      select 1 from public.member_verifications v
       where v.customer_id = new.customer_id and v.store_id = new.store_id and v.expires_at > now()
    ) then
      raise exception 'ต้องยืนยันรหัสสมาชิกก่อนใช้คูปองรางวัลภารกิจ';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_mission_voucher_verification on public.loyalty_reward_redemptions;
create trigger enforce_mission_voucher_verification
  before update of used_at on public.loyalty_reward_redemptions
  for each row execute function public.enforce_mission_voucher_verification();

create or replace function public.enforce_mission_coupon_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.coupons c where c.id = new.coupon_id and c.store_mission_id is not null) then
    if new.customer_id is null or not exists (
      select 1 from public.member_verifications v
       where v.customer_id = new.customer_id and v.store_id = new.store_id and v.expires_at > now()
    ) then
      raise exception 'ต้องยืนยันรหัสสมาชิกก่อนใช้คูปองรางวัลภารกิจ';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_mission_coupon_verification on public.coupon_redemptions;
create trigger enforce_mission_coupon_verification
  before insert on public.coupon_redemptions
  for each row execute function public.enforce_mission_coupon_verification();

-- ---------------------------------------------------------------------------
-- หมดเขตรอบที่ค้าง (การนับเช็กวันหมดเขตอยู่แล้ว — cron นี้ให้สถานะในหน้าจอถูกต้อง)
-- ---------------------------------------------------------------------------
create or replace function public.expire_store_mission_enrollments()
returns integer
language sql
security definer
set search_path = public
as $$
  with x as (
    update public.store_mission_enrollments
       set status = 'expired', updated_at = now()
     where status = 'active' and expires_at is not null and expires_at <= now()
    returning 1
  )
  select count(*)::int from x;
$$;

-- ออกคูปองซ้ำให้รอบที่ครบแล้วแต่ออกคูปองพลาด (เช่นรหัสชน) — ทีละรอบ พลาดอีกก็ข้าม
create or replace function public.retry_store_mission_rewards()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select id from public.store_mission_enrollments
     where status = 'completed' and reward_redemption_id is null
       and completed_at < now() - interval '2 minutes'
     limit 200
  loop
    begin
      perform public.store_mission_issue_reward(v_id);
      v_count := v_count + 1;
    exception when others then
      insert into public.system_event_logs (level, source, action, message, error_code, context)
      values ('error', 'missions.cron', 'retryReward', left('ออกคูปองรางวัลซ้ำไม่สำเร็จ: ' || sqlerrm, 500), sqlstate,
              jsonb_build_object('enrollmentId', v_id));
    end;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- สิทธิ์เรียกฟังก์ชัน
-- ---------------------------------------------------------------------------
revoke all on function public.save_store_mission(uuid, jsonb) from public, anon;
grant execute on function public.save_store_mission(uuid, jsonb) to authenticated;
revoke all on function public.join_store_mission(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.join_store_mission(uuid, uuid, boolean) to service_role;
revoke all on function public.store_mission_issue_reward(uuid) from public, anon, authenticated;
revoke all on function public.store_missions_on_order_status() from public, anon, authenticated;
revoke all on function public.enforce_mission_voucher_verification() from public, anon, authenticated;
revoke all on function public.enforce_mission_coupon_verification() from public, anon, authenticated;
revoke all on function public.expire_store_mission_enrollments() from public, anon, authenticated;
grant execute on function public.expire_store_mission_enrollments() to service_role;
revoke all on function public.retry_store_mission_rewards() from public, anon, authenticated;
grant execute on function public.retry_store_mission_rewards() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'expire-store-mission-enrollments') then
    perform cron.unschedule('expire-store-mission-enrollments');
  end if;
end $$;
-- ทุกชั่วโมงนาทีที่ 7
select cron.schedule('expire-store-mission-enrollments', '7 * * * *', $job$ select public.expire_store_mission_enrollments(); select public.retry_store_mission_rewards(); $job$);
