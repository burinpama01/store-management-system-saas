-- แพ็กซื้อล่วงหน้า · P1a (Plan/Prepaid Pass and Member Tiers Implementation Plan v1.html)
--
-- แนวคิด
-- - แบบแพ็ก (prepaid_pass_plans) ผูกกับ "สินค้าขายแพ็ก" 1 ตัวในเมนูของสาขา → การขายแพ็กใช้ตะกร้า/ชำระ/
--   ใบเสร็จ/รายงานเดิมทั้งหมด เมื่อออเดอร์เป็น paid trigger จะออกแพ็กให้ลูกค้าในบิล (ต้องมีเบอร์)
-- - ใช้แพ็ก: POS จองสิทธิ์ (reserve) หลังยืนยันรหัสสมาชิก 5 นาที → บรรทัดในบิลราคา ฿0 → แนบกับออเดอร์
--   สร้างออเดอร์ไม่สำเร็จ = คืนสิทธิ์ (release); void บิล = คืนสิทธิ์ (trigger)
-- - บิลที่ใช้แพ็กอย่างเดียว (ยอด ฿0) ปิดด้วย close_pos_order_zero_total (ไม่มีแถว payments เพราะ amount > 0)
-- - ไม่คืนเงินแพ็ก: void บิลขายแพ็กได้เฉพาะเมื่อแพ็กยังไม่ถูกใช้เลย (แพ็กถูกยกเลิก)
-- - เงินขายแพ็ก = รายได้รับล่วงหน้า; มูลค่าต่อสิทธิ์ (unit_value) เก็บไว้ทุกเหตุการณ์เพื่อรายงาน P3

-- ---------------------------------------------------------------------------
-- ตาราง
-- ---------------------------------------------------------------------------
create table if not exists public.prepaid_pass_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  sale_product_id uuid not null unique references public.products on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  credits integer not null check (credits between 1 and 1000),
  price numeric(12,2) not null check (price > 0),
  valid_days integer check (valid_days is null or valid_days between 1 and 3650),
  redeem_scope text not null default 'store' check (redeem_scope in ('store', 'org')),
  terms text not null check (length(trim(terms)) between 20 and 5000),
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prepaid_pass_plans_store_idx on public.prepaid_pass_plans (store_id, is_active);

-- ผลยืนยันรหัส 1 ครั้ง = บิลเดียว: ผูกกับ idempotency key ของการกดจ่ายครั้งแรกที่จองสิทธิ์
-- (จองหลายเมนูในบิลเดียวใช้ key เดียวกันได้; บิลอื่น/เครื่องอื่นใช้ซ้ำไม่ได้)
alter table public.member_verifications add column if not exists checkout_key text;

create table if not exists public.prepaid_pass_plan_products (
  plan_id uuid not null references public.prepaid_pass_plans(id) on delete cascade,
  product_id uuid not null references public.products on delete cascade,
  primary key (plan_id, product_id)
);

create table if not exists public.prepaid_passes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid not null references public.prepaid_pass_plans(id) on delete restrict,
  member_identity_id uuid not null references public.member_identities(id) on delete restrict,
  issued_store_id uuid not null references public.stores(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  order_item_id uuid references public.order_items(id) on delete set null,
  -- ลำดับแพ็กในบรรทัดเดียวกัน (ซื้อ 2 แพ็ก = 2 แถว) กันออกซ้ำ
  order_item_seq integer not null default 1,
  plan_name text not null,
  credits_total integer not null check (credits_total > 0),
  credits_remaining integer not null check (credits_remaining >= 0),
  unit_value numeric(12,4) not null check (unit_value >= 0),
  price_paid numeric(12,2) not null check (price_paid >= 0),
  redeem_scope text not null check (redeem_scope in ('store', 'org')),
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'voided', 'expired')),
  terms_snapshot text not null,
  accepted_at timestamptz not null default now(),
  accepted_channel text not null check (accepted_channel in ('pos', 'online')),
  accepted_by uuid,
  created_at timestamptz not null default now(),
  check (credits_remaining <= credits_total),
  unique (order_item_id, order_item_seq)
);

create index if not exists prepaid_passes_identity_idx
  on public.prepaid_passes (member_identity_id, status, expires_at);
create index if not exists prepaid_passes_order_idx on public.prepaid_passes (order_id);
create index if not exists prepaid_passes_plan_idx on public.prepaid_passes (plan_id, status);
-- โหมดแพ็กค้าง (O1): ถามทุกครั้งที่เปิด POS/หน้าสมาชิกของร้านที่ไม่ใช่ Enterprise
create index if not exists prepaid_passes_org_active_idx
  on public.prepaid_passes (organization_id, expires_at)
  where status = 'active' and credits_remaining > 0;

create table if not exists public.prepaid_pass_redemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pass_id uuid not null references public.prepaid_passes(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  verification_id uuid not null references public.member_verifications(id) on delete restrict,
  product_id uuid not null references public.products on delete restrict,
  quantity integer not null check (quantity between 1 and 50),
  unit_value numeric(12,4) not null,
  status text not null default 'reserved' check (status in ('reserved', 'committed', 'released', 'reversed')),
  order_id uuid references public.orders(id) on delete set null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create index if not exists prepaid_pass_redemptions_order_idx on public.prepaid_pass_redemptions (order_id) where order_id is not null;
create index if not exists prepaid_pass_redemptions_pass_idx on public.prepaid_pass_redemptions (pass_id, created_at desc);

-- append-only: ใช้ทำประวัติให้ลูกค้า/เจ้าของ และรับรู้รายได้ต่อสิทธิ์ (P3)
create table if not exists public.prepaid_pass_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pass_id uuid not null references public.prepaid_passes(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  type text not null check (type in ('issue', 'redeem', 'release', 'reverse', 'void', 'expire', 'adjust')),
  credits_delta integer not null,
  value_delta numeric(12,2) not null default 0,
  order_id uuid,
  redemption_id uuid,
  actor_user_id uuid,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists prepaid_pass_events_pass_idx on public.prepaid_pass_events (pass_id, created_at desc);
create index if not exists prepaid_pass_events_store_idx on public.prepaid_pass_events (store_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — อ่านได้เฉพาะคนในองค์กร; เขียนผ่าน RPC/trigger เท่านั้น
-- ---------------------------------------------------------------------------
alter table public.prepaid_pass_plans enable row level security;
alter table public.prepaid_pass_plan_products enable row level security;
alter table public.prepaid_passes enable row level security;
alter table public.prepaid_pass_redemptions enable row level security;
alter table public.prepaid_pass_events enable row level security;

revoke all on table public.prepaid_pass_plans from anon, authenticated;
revoke all on table public.prepaid_pass_plan_products from anon, authenticated;
revoke all on table public.prepaid_passes from anon, authenticated;
revoke all on table public.prepaid_pass_redemptions from anon, authenticated;
revoke all on table public.prepaid_pass_events from anon, authenticated;
grant select on table public.prepaid_pass_plans to authenticated;
grant select on table public.prepaid_pass_plan_products to authenticated;
grant select on table public.prepaid_passes to authenticated;
grant select on table public.prepaid_pass_redemptions to authenticated;
grant select on table public.prepaid_pass_events to authenticated;

drop policy if exists "prepaid_pass_plans: org member can read" on public.prepaid_pass_plans;
create policy "prepaid_pass_plans: org member can read"
  on public.prepaid_pass_plans for select
  using (organization_id in (select s.organization_id from public.stores s where s.id in (select auth_user_store_ids())));

drop policy if exists "prepaid_pass_plan_products: org member can read" on public.prepaid_pass_plan_products;
create policy "prepaid_pass_plan_products: org member can read"
  on public.prepaid_pass_plan_products for select
  using (plan_id in (select id from public.prepaid_pass_plans));

drop policy if exists "prepaid_passes: org member can read" on public.prepaid_passes;
create policy "prepaid_passes: org member can read"
  on public.prepaid_passes for select
  using (organization_id in (select s.organization_id from public.stores s where s.id in (select auth_user_store_ids())));

drop policy if exists "prepaid_pass_redemptions: org member can read" on public.prepaid_pass_redemptions;
create policy "prepaid_pass_redemptions: org member can read"
  on public.prepaid_pass_redemptions for select
  using (organization_id in (select s.organization_id from public.stores s where s.id in (select auth_user_store_ids())));

drop policy if exists "prepaid_pass_events: org member can read" on public.prepaid_pass_events;
create policy "prepaid_pass_events: org member can read"
  on public.prepaid_pass_events for select
  using (organization_id in (select s.organization_id from public.stores s where s.id in (select auth_user_store_ids())));

-- ---------------------------------------------------------------------------
-- บันทึกแบบแพ็ก (สร้าง/แก้ "สินค้าขายแพ็ก" ให้อัตโนมัติ) — owner/admin
-- ---------------------------------------------------------------------------
create or replace function public.save_prepaid_pass_plan(
  p_store_id uuid,
  p_plan_id uuid,
  p_name text,
  p_credits integer,
  p_price numeric,
  p_valid_days integer,
  p_redeem_scope text,
  p_terms text,
  p_product_ids uuid[],
  p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store public.stores%rowtype;
  v_plan public.prepaid_pass_plans%rowtype;
  v_category_id uuid;
  v_product_id uuid;
  v_plan_id uuid;
  v_bad integer;
begin
  select * into v_store from public.stores where id = p_store_id and is_active;
  if not found then raise exception 'ไม่พบสาขา'; end if;
  if auth.uid() is null or not auth_user_role_in_store(v_store.organization_id, p_store_id, 'admin') then
    raise exception 'เฉพาะเจ้าของหรือแอดมินที่ตั้งค่าแพ็กได้';
  end if;
  if p_product_ids is null or cardinality(p_product_ids) = 0 then
    raise exception 'ต้องเลือกเมนูที่ใช้แพ็กได้อย่างน้อย 1 รายการ';
  end if;
  select count(*) into v_bad
    from unnest(p_product_ids) pid
   where not exists (select 1 from public.products p where p.id = pid and p.store_id = p_store_id);
  if v_bad > 0 then raise exception 'เมนูที่เลือกไม่อยู่ในสาขานี้'; end if;

  if p_plan_id is not null then
    select * into v_plan from public.prepaid_pass_plans where id = p_plan_id and store_id = p_store_id for update;
    if not found then raise exception 'ไม่พบแบบแพ็ก'; end if;
  end if;

  if p_plan_id is null then
    select id into v_category_id
      from public.categories
     where store_id = p_store_id and name = 'แพ็กล่วงหน้า'
     order by created_at limit 1;
    if v_category_id is null then
      insert into public.categories (organization_id, store_id, name, sort_order, is_active)
      values (v_store.organization_id, p_store_id, 'แพ็กล่วงหน้า', 999, true)
      returning id into v_category_id;
    end if;

    insert into public.products (
      organization_id, store_id, category_id, name, base_price, is_active,
      available_for_pos, available_for_qr, available_for_delivery, sort_order
    ) values (
      v_store.organization_id, p_store_id, v_category_id, trim(p_name), p_price, coalesce(p_is_active, true),
      true, false, false, 0
    )
    returning id into v_product_id;

    insert into public.prepaid_pass_plans (
      organization_id, store_id, sale_product_id, name, credits, price, valid_days, redeem_scope, terms, is_active, created_by
    ) values (
      v_store.organization_id, p_store_id, v_product_id, trim(p_name), p_credits, p_price, p_valid_days,
      coalesce(p_redeem_scope, 'store'), trim(p_terms), coalesce(p_is_active, true), auth.uid()
    )
    returning id into v_plan_id;
  else
    v_plan_id := v_plan.id;
    update public.prepaid_pass_plans
       set name = trim(p_name), credits = p_credits, price = p_price, valid_days = p_valid_days,
           redeem_scope = coalesce(p_redeem_scope, 'store'), terms = trim(p_terms),
           is_active = coalesce(p_is_active, true), updated_at = now()
     where id = v_plan_id;
    -- แพ็กที่ขายไปแล้วไม่เปลี่ยน (เก็บ snapshot ไว้ที่ prepaid_passes) — เปลี่ยนแค่การขายครั้งถัดไป
    update public.products
       set name = trim(p_name), base_price = p_price, is_active = coalesce(p_is_active, true),
           available_for_pos = true, available_for_qr = false, available_for_delivery = false, updated_at = now()
     where id = v_plan.sale_product_id;
  end if;

  delete from public.prepaid_pass_plan_products where plan_id = v_plan_id;
  insert into public.prepaid_pass_plan_products (plan_id, product_id)
  select distinct v_plan_id, pid from unnest(p_product_ids) pid;

  return v_plan_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- เมนูของสาขานี้ใช้แพ็กนี้ได้ไหม (ข้ามสาขาเทียบด้วย menu_link_id)
-- ---------------------------------------------------------------------------
create or replace function public.prepaid_pass_covers_product(p_pass_id uuid, p_store_id uuid, p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.prepaid_passes ps
      join public.prepaid_pass_plan_products pp on pp.plan_id = ps.plan_id
      join public.products src on src.id = pp.product_id
      join public.products dst on dst.id = p_product_id and dst.store_id = p_store_id
     where ps.id = p_pass_id
       and (
         (ps.issued_store_id = p_store_id and src.id = dst.id)
         or (
           ps.redeem_scope = 'org'
           and dst.organization_id = ps.organization_id
           and (src.id = dst.id or (src.menu_link_id is not null and src.menu_link_id = dst.menu_link_id))
         )
       )
  )
$$;

-- ---------------------------------------------------------------------------
-- รายการแพ็กของสมาชิกที่ยืนยันรหัสแล้ว (POS)
-- ---------------------------------------------------------------------------
create or replace function public.list_prepaid_passes_for_verification(p_store_id uuid, p_verification_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ver public.member_verifications%rowtype;
begin
  select * into v_ver from public.member_verifications
   where id = p_verification_id and store_id = p_store_id;
  if not found then raise exception 'ไม่พบผลยืนยันสมาชิก'; end if;
  if auth.uid() is null or not auth_user_has_permission(v_ver.organization_id, p_store_id, 'pos.use') then
    raise exception 'ไม่มีสิทธิ์ใช้งาน POS';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', ps.id,
      'plan_name', ps.plan_name,
      'credits_total', ps.credits_total,
      'credits_remaining', ps.credits_remaining,
      'expires_at', ps.expires_at,
      'issued_store_id', ps.issued_store_id,
      'usable_here', ps.issued_store_id = p_store_id or ps.redeem_scope = 'org',
      'product_ids', coalesce((
        select jsonb_agg(p.id)
          from public.products p
         where p.store_id = p_store_id
           and p.is_active
           and public.prepaid_pass_covers_product(ps.id, p_store_id, p.id)
      ), '[]'::jsonb)
    ) order by ps.expires_at nulls last, ps.created_at)
      from public.prepaid_passes ps
     where ps.member_identity_id = v_ver.member_identity_id
       and ps.status = 'active'
       and ps.credits_remaining > 0
       and (ps.expires_at is null or ps.expires_at > now())
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- จองสิทธิ์ (ก่อนสร้างออเดอร์)
-- ---------------------------------------------------------------------------
create or replace function public.reserve_prepaid_pass_redemption(
  p_store_id uuid,
  p_verification_id uuid,
  p_pass_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_checkout_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ver public.member_verifications%rowtype;
  v_pass public.prepaid_passes%rowtype;
  v_id uuid;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 50 then
    raise exception 'จำนวนที่ใช้แพ็กไม่ถูกต้อง';
  end if;

  if nullif(trim(coalesce(p_checkout_key, '')), '') is null then
    raise exception 'ต้องมี idempotency key สำหรับการใช้แพ็ก';
  end if;

  -- ล็อกผลยืนยันกันสองเครื่อง/สองบิลจองพร้อมกันด้วยรหัสเดียว
  select * into v_ver from public.member_verifications
   where id = p_verification_id and store_id = p_store_id
   for update;
  if not found then raise exception 'ต้องยืนยันรหัสสมาชิกก่อนใช้แพ็ก'; end if;
  if auth.uid() is null or not auth_user_has_permission(v_ver.organization_id, p_store_id, 'pos.use') then
    raise exception 'ไม่มีสิทธิ์ใช้งาน POS';
  end if;
  if v_ver.expires_at <= now() then
    raise exception 'ผลยืนยันสมาชิกหมดอายุ ให้ลูกค้าขอรหัสใหม่';
  end if;
  if v_ver.consumed_at is not null
     or (v_ver.checkout_key is not null and v_ver.checkout_key <> trim(p_checkout_key)) then
    raise exception 'รหัสสมาชิกนี้ใช้กับบิลอื่นแล้ว ให้ลูกค้าขอรหัสใหม่';
  end if;
  if v_ver.checkout_key is null then
    update public.member_verifications set checkout_key = trim(p_checkout_key) where id = v_ver.id;
  end if;

  select * into v_pass from public.prepaid_passes where id = p_pass_id for update;
  if not found or v_pass.member_identity_id <> v_ver.member_identity_id then
    raise exception 'แพ็กนี้ไม่ใช่ของสมาชิกที่ยืนยัน';
  end if;
  if v_pass.status <> 'active' then raise exception 'แพ็กนี้ใช้ไม่ได้แล้ว'; end if;
  if v_pass.expires_at is not null and v_pass.expires_at <= now() then raise exception 'แพ็กหมดอายุแล้ว'; end if;
  if not public.prepaid_pass_covers_product(p_pass_id, p_store_id, p_product_id) then
    raise exception 'เมนูนี้ใช้แพ็กนี้ไม่ได้ที่สาขานี้';
  end if;
  if v_pass.credits_remaining < p_quantity then
    raise exception 'สิทธิ์ในแพ็กเหลือไม่พอ (เหลือ % สิทธิ์)', v_pass.credits_remaining;
  end if;

  update public.prepaid_passes set credits_remaining = credits_remaining - p_quantity where id = p_pass_id;

  insert into public.prepaid_pass_redemptions (
    organization_id, pass_id, store_id, verification_id, product_id, quantity, unit_value, created_by
  ) values (
    v_pass.organization_id, p_pass_id, p_store_id, p_verification_id, p_product_id, p_quantity, v_pass.unit_value, auth.uid()
  )
  returning id into v_id;

  insert into public.prepaid_pass_events (organization_id, pass_id, store_id, type, credits_delta, value_delta, redemption_id, actor_user_id)
  values (v_pass.organization_id, p_pass_id, p_store_id, 'redeem', -p_quantity, round(v_pass.unit_value * p_quantity, 2), v_id, auth.uid());

  return jsonb_build_object(
    'redemption_id', v_id,
    'customer_id', v_ver.customer_id,
    'credits_remaining', v_pass.credits_remaining - p_quantity,
    'plan_name', v_pass.plan_name
  );
end;
$$;

-- ส่งบิลซ้ำด้วย idempotency key เดิม (เน็ตหลุดหลังสร้างออเดอร์สำเร็จ): ออเดอร์มีอยู่แล้ว
-- → POS ข้ามการจองสิทธิ์ ไม่ตัดแพ็กซ้ำ และไม่ติด "รหัสใช้กับบิลอื่นแล้ว"
create or replace function public.find_pos_order_by_idempotency_key(p_store_id uuid, p_idempotency_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_order_id uuid;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or auth.uid() is null or not auth_user_has_permission(v_org, p_store_id, 'pos.use') then
    raise exception 'ไม่มีสิทธิ์ใช้งาน POS';
  end if;
  select order_id into v_order_id
    from public.pos_order_idempotency_keys
   where store_id = p_store_id and idempotency_key = nullif(trim(coalesce(p_idempotency_key, '')), '');
  return v_order_id;
end;
$$;

-- คืนสิทธิ์ที่จองไว้ (สร้างออเดอร์ไม่สำเร็จ)
create or replace function public.release_prepaid_pass_redemption(p_store_id uuid, p_redemption_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_red public.prepaid_pass_redemptions%rowtype;
begin
  select * into v_red from public.prepaid_pass_redemptions
   where id = p_redemption_id and store_id = p_store_id for update;
  if not found then return; end if;
  if auth.uid() is null or not auth_user_has_permission(v_red.organization_id, p_store_id, 'pos.use') then
    raise exception 'ไม่มีสิทธิ์ใช้งาน POS';
  end if;
  if v_red.status <> 'reserved' or v_red.order_id is not null then return; end if;

  update public.prepaid_pass_redemptions set status = 'released', settled_at = now() where id = v_red.id;
  update public.prepaid_passes set credits_remaining = credits_remaining + v_red.quantity where id = v_red.pass_id and status = 'active';
  insert into public.prepaid_pass_events (organization_id, pass_id, store_id, type, credits_delta, value_delta, redemption_id, actor_user_id)
  values (v_red.organization_id, v_red.pass_id, p_store_id, 'release', v_red.quantity, -round(v_red.unit_value * v_red.quantity, 2), v_red.id, auth.uid());

  -- บิลล้มทั้งหมด → ปลดรหัสให้ลองจ่ายใหม่ได้ (ถ้ายังไม่หมดอายุ)
  update public.member_verifications
     set checkout_key = null
   where id = v_red.verification_id
     and consumed_at is null
     and not exists (
       select 1 from public.prepaid_pass_redemptions r
        where r.verification_id = v_red.verification_id and r.status in ('reserved', 'committed')
     );
end;
$$;

-- แนบสิทธิ์ที่จองกับออเดอร์ที่สร้างแล้ว + ปิดผลยืนยันสมาชิก (ใช้ได้กับบิลเดียว)
-- คืนค่า 'attached' หรือ 'already_attached' (ส่งซ้ำด้วย idempotency key เดิม → ได้ออเดอร์เดิม:
-- สิทธิ์ที่จองรอบใหม่ถูกคืน ไม่ตัดซ้ำ)
create or replace function public.attach_prepaid_pass_redemptions(p_store_id uuid, p_order_id uuid, p_redemption_ids uuid[])
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_count integer;
  v_red record;
begin
  select * into v_order from public.orders where id = p_order_id and store_id = p_store_id for update;
  if not found then raise exception 'ไม่พบออเดอร์'; end if;
  if auth.uid() is null or not auth_user_has_permission(v_order.organization_id, p_store_id, 'pos.use') then
    raise exception 'ไม่มีสิทธิ์ใช้งาน POS';
  end if;

  if exists (select 1 from public.prepaid_pass_redemptions where order_id = p_order_id and status = 'committed') then
    for v_red in
      select * from public.prepaid_pass_redemptions
       where id = any(p_redemption_ids) and store_id = p_store_id and status = 'reserved' and order_id is null
       for update
    loop
      update public.prepaid_pass_redemptions set status = 'released', settled_at = now() where id = v_red.id;
      update public.prepaid_passes set credits_remaining = credits_remaining + v_red.quantity where id = v_red.pass_id and status = 'active';
      insert into public.prepaid_pass_events (organization_id, pass_id, store_id, type, credits_delta, value_delta, redemption_id, actor_user_id, note)
      values (v_red.organization_id, v_red.pass_id, p_store_id, 'release', v_red.quantity,
              -round(v_red.unit_value * v_red.quantity, 2), v_red.id, auth.uid(), 'ส่งบิลซ้ำ — ออเดอร์นี้ตัดแพ็กไปแล้ว');
    end loop;
    return 'already_attached';
  end if;

  update public.prepaid_pass_redemptions
     set status = 'committed', order_id = p_order_id, settled_at = now()
   where id = any(p_redemption_ids) and store_id = p_store_id and status = 'reserved' and order_id is null;
  get diagnostics v_count = row_count;
  if v_count <> cardinality(p_redemption_ids) then
    raise exception 'แนบสิทธิ์แพ็กกับออเดอร์ไม่ครบ (ได้ % จาก % รายการ)', v_count, cardinality(p_redemption_ids);
  end if;

  update public.prepaid_pass_events set order_id = p_order_id
   where redemption_id = any(p_redemption_ids) and type = 'redeem';

  update public.member_verifications
     set consumed_at = now(), consumed_order_id = p_order_id
   where id in (select distinct verification_id from public.prepaid_pass_redemptions where id = any(p_redemption_ids))
     and consumed_at is null;
  return 'attached';
end;
$$;

-- ---------------------------------------------------------------------------
-- ปิดบิลยอด ฿0 ที่ใช้แพ็กทั้งบิล — ตัดสต็อกแบบเดียวกับ close_pos_order_payment
-- (20260918030000) แต่ไม่มี payments/transactions/cash ledger เพราะไม่มีเงินเข้า
-- *** ถ้าแก้ส่วนตัดสต็อกใน close_pos_order_payment ต้องแก้ที่นี่ด้วย ***
-- ---------------------------------------------------------------------------
create or replace function public.close_pos_order_zero_total(
  p_order_id uuid,
  p_store_id uuid,
  p_processed_by_user_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.orders%rowtype;
  v_stock record;
  v_variant public.product_variants%rowtype;
begin
  select * into v_order
    from public.orders
   where id = p_order_id and store_id = p_store_id and status in ('pending_payment', 'open')
   for update;
  if not found then raise exception 'ออร์เดอร์นี้ไม่สามารถชำระได้'; end if;
  if auth.uid() is null then raise exception 'ต้องเข้าสู่ระบบก่อนชำระเงิน'; end if;
  if p_processed_by_user_id is distinct from auth.uid() then raise exception 'ผู้ชำระเงินไม่ถูกต้อง'; end if;
  if not public.auth_user_has_permission(v_order.organization_id, p_store_id, 'pos.use') then
    raise exception 'ไม่มีสิทธิ์ชำระเงินออร์เดอร์นี้';
  end if;
  if v_order.total <> 0 then raise exception 'บิลนี้มียอดที่ต้องชำระ'; end if;
  if v_order.coupon_id is not null then raise exception 'บิลยอด ฿0 ใช้คูปองร่วมไม่ได้'; end if;
  if not exists (
    select 1 from public.prepaid_pass_redemptions where order_id = p_order_id and status = 'committed'
  ) then
    raise exception 'บิลยอด ฿0 ปิดได้เฉพาะบิลที่ใช้แพ็กล่วงหน้า';
  end if;

  if not coalesce(v_order.qr_order_source, false) then
    perform public.snapshot_order_item_stock_pools(p_order_id, p_store_id, v_order.organization_id);

    for v_stock in
      select oi.variant_id,
             sum(oi.quantity::bigint * coalesce(oi.unit_quantity, 1)::bigint) as requested_quantity
        from public.order_items oi
       where oi.order_id = p_order_id
         and oi.variant_id is not null
         and oi.stock_pool_id is null
         and coalesce(oi.voided, false) = false
       group by oi.variant_id
       order by oi.variant_id
    loop
      if v_stock.requested_quantity <= 0 or v_stock.requested_quantity > 2147483647 then
        raise exception 'จำนวนสินค้าที่ต้องตัดเกินช่วงที่รองรับ';
      end if;
      select pv.* into v_variant
        from public.product_variants pv
        join public.products p on p.id = pv.product_id
       where pv.id = v_stock.variant_id
         and p.organization_id = v_order.organization_id
         and p.store_id = p_store_id
       for update of pv;
      if not found then raise exception 'สินค้าไม่ถูกต้อง'; end if;
      if v_variant.track_stock then
        if v_variant.stock_quantity is null
          or v_variant.stock_quantity::bigint - coalesce(v_variant.reserved_quantity, 0) < v_stock.requested_quantity then
          raise exception 'สินค้าเหลือไม่พอ';
        end if;
        update public.product_variants
           set stock_quantity = (stock_quantity::bigint - v_stock.requested_quantity)::integer
         where id = v_stock.variant_id;
      end if;
    end loop;

    perform public.deduct_order_stock_pools(p_order_id, p_store_id, v_order.organization_id, p_processed_by_user_id);
  end if;

  update public.orders set status = 'paid', paid_at = now() where id = p_order_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- trigger: ออเดอร์เป็น paid → ออกแพ็กให้ลูกค้าในบิล
--          ออเดอร์ถูก void/cancel/refund → คืนสิทธิ์ที่ใช้ + ยกเลิกแพ็กที่ขาย (ถ้ายังไม่ถูกใช้)
-- ---------------------------------------------------------------------------
create or replace function public.prepaid_passes_on_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_identity uuid;
  v_seq integer;
  v_pass_id uuid;
  v_red record;
  v_pass record;
  v_actor uuid := auth.uid();
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- ขายแพ็ก
  if new.status = 'paid' then
    for v_item in
      -- total_price ของบรรทัดหักส่วนลดบรรทัดแล้ว (cart.ts) — ส่วนลดท้ายบิล/คูปองไม่กระจายมาที่แพ็ก
      select oi.id as order_item_id, oi.quantity, oi.total_price,
             pl.id, pl.name, pl.credits, pl.valid_days, pl.redeem_scope, pl.terms
        from public.order_items oi
        join public.prepaid_pass_plans pl on pl.sale_product_id = oi.product_id
       where oi.order_id = new.id
         and coalesce(oi.voided, false) = false
    loop
      if new.customer_id is null then
        raise exception 'ขายแพ็กล่วงหน้าต้องผูกสมาชิกที่มีเบอร์โทรในบิล';
      end if;
      select member_identity_id into v_identity from public.customers where id = new.customer_id;
      if v_identity is null then
        raise exception 'สมาชิกในบิลต้องมีเบอร์โทรจึงจะซื้อแพ็กได้';
      end if;
      for v_seq in 1..greatest(v_item.quantity, 1) loop
        v_pass_id := null;
        insert into public.prepaid_passes (
          organization_id, plan_id, member_identity_id, issued_store_id, customer_id, order_id, order_item_id,
          order_item_seq, plan_name, credits_total, credits_remaining, unit_value, price_paid, redeem_scope,
          expires_at, terms_snapshot, accepted_channel, accepted_by
        ) values (
          new.organization_id, v_item.id, v_identity, new.store_id, new.customer_id, new.id, v_item.order_item_id,
          v_seq, v_item.name, v_item.credits, v_item.credits,
          round((v_item.total_price / greatest(v_item.quantity, 1)) / v_item.credits, 4),
          round(v_item.total_price / greatest(v_item.quantity, 1), 2),
          v_item.redeem_scope,
          case when v_item.valid_days is null then null else now() + make_interval(days => v_item.valid_days) end,
          v_item.terms, 'pos', v_actor
        )
        on conflict (order_item_id, order_item_seq) do nothing
        returning id into v_pass_id;
        if v_pass_id is not null then
          insert into public.prepaid_pass_events (organization_id, pass_id, store_id, type, credits_delta, value_delta, order_id, actor_user_id)
          values (new.organization_id, v_pass_id, new.store_id, 'issue', v_item.credits,
                  round(v_item.total_price / greatest(v_item.quantity, 1), 2),
                  new.id, v_actor);
        end if;
      end loop;
    end loop;
  end if;

  if new.status in ('voided', 'cancelled', 'refunded') then
    -- ยกเลิกแพ็กที่ขายในบิลนี้: ได้เฉพาะเมื่อยังไม่ถูกใช้เลย (ไม่คืนเงินแพ็กที่ใช้แล้ว)
    for v_pass in
      select * from public.prepaid_passes where order_id = new.id and status = 'active' for update
    loop
      if v_pass.credits_remaining <> v_pass.credits_total then
        raise exception 'ยกเลิกบิลนี้ไม่ได้ เพราะแพ็ก "%" ถูกใช้ไปแล้ว', v_pass.plan_name;
      end if;
      update public.prepaid_passes set status = 'voided', credits_remaining = 0 where id = v_pass.id;
      insert into public.prepaid_pass_events (organization_id, pass_id, store_id, type, credits_delta, value_delta, order_id, actor_user_id, note)
      values (v_pass.organization_id, v_pass.id, new.store_id, 'void', -v_pass.credits_total, -v_pass.price_paid, new.id, v_actor, 'ยกเลิกบิลขายแพ็ก');
    end loop;

    -- คืนสิทธิ์ที่ใช้ในบิลนี้
    for v_red in
      select * from public.prepaid_pass_redemptions where order_id = new.id and status = 'committed' for update
    loop
      update public.prepaid_pass_redemptions set status = 'reversed', settled_at = now() where id = v_red.id;
      update public.prepaid_passes set credits_remaining = credits_remaining + v_red.quantity
       where id = v_red.pass_id and status = 'active';
      insert into public.prepaid_pass_events (organization_id, pass_id, store_id, type, credits_delta, value_delta, order_id, redemption_id, actor_user_id)
      values (v_red.organization_id, v_red.pass_id, new.store_id, 'reverse', v_red.quantity,
              -round(v_red.unit_value * v_red.quantity, 2), new.id, v_red.id, v_actor);
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists prepaid_passes_on_order_status on public.orders;
create trigger prepaid_passes_on_order_status
  after update of status on public.orders
  for each row execute function public.prepaid_passes_on_order_status();

-- ---------------------------------------------------------------------------
-- สิทธิ์เรียกฟังก์ชัน
-- ---------------------------------------------------------------------------
revoke all on function public.save_prepaid_pass_plan(uuid, uuid, text, integer, numeric, integer, text, text, uuid[], boolean) from public, anon;
revoke all on function public.prepaid_pass_covers_product(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_prepaid_passes_for_verification(uuid, uuid) from public, anon;
revoke all on function public.reserve_prepaid_pass_redemption(uuid, uuid, uuid, uuid, integer, text) from public, anon;
revoke all on function public.release_prepaid_pass_redemption(uuid, uuid) from public, anon;
revoke all on function public.find_pos_order_by_idempotency_key(uuid, text) from public, anon;
revoke all on function public.attach_prepaid_pass_redemptions(uuid, uuid, uuid[]) from public, anon;
revoke all on function public.close_pos_order_zero_total(uuid, uuid, uuid) from public, anon;
revoke all on function public.prepaid_passes_on_order_status() from public, anon, authenticated;

grant execute on function public.save_prepaid_pass_plan(uuid, uuid, text, integer, numeric, integer, text, text, uuid[], boolean) to authenticated;
grant execute on function public.list_prepaid_passes_for_verification(uuid, uuid) to authenticated;
grant execute on function public.reserve_prepaid_pass_redemption(uuid, uuid, uuid, uuid, integer, text) to authenticated;
grant execute on function public.release_prepaid_pass_redemption(uuid, uuid) to authenticated;
grant execute on function public.find_pos_order_by_idempotency_key(uuid, text) to authenticated;
grant execute on function public.attach_prepaid_pass_redemptions(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.close_pos_order_zero_total(uuid, uuid, uuid) to authenticated;
