-- ภารกิจสะสม · M3 (ผู้ใช้สั่ง 2026-11-18 อ้างภาพแอปสะสมแต้มภายนอก — ใช้เป็นแนวคิดเท่านั้น)
--
-- 1) วิธีนับใหม่: นับยอดซื้อเป็นบาท ("สะสมยอดครบ ฿4,400") และนับบิลที่ยอดถึงขั้นต่ำ ("ซื้อ ฿120/ใบเสร็จ")
--    — ยอดคิดเฉพาะบรรทัดในขอบเขตสินค้าที่จ่ายเงินจริง (ไม่นับ ฿0/สินค้าขายแพ็ก) · snapshot วิธีนับไว้ในรอบตอนกดรับ
-- 2) รางวัลแต้ม: ครบแล้วบวกแต้มโบนัสเข้าบัญชีสมาชิกสาขานั้นทันที (loyalty_ledger type adjustment)
--    void/cancel/refund หลังได้แต้ม → หักแต้มคืน (ไม่ติดลบ) แล้วกลับไปทำต่อ
--    SMS "ได้รับรางวัล" ส่งได้ด้วย (คิว reward ที่ไม่มีคูปอง)
-- 3) สวิตช์ "ขายออนไลน์" ต่อสินค้า (products.online_enabled, ค่าเริ่มต้นเปิด) — ปิด = ไม่ขึ้นหน้าสั่งออนไลน์ แต่ขายหน้าร้าน/QR ได้

alter table public.products
  add column if not exists online_enabled boolean not null default true;
comment on column public.products.online_enabled is 'ขายในหน้าสั่งออนไลน์ของเว็บร้าน (ปิด = ยังขายหน้าร้าน/QR ได้)';

alter table public.store_missions
  add column if not exists count_mode text not null default 'items',
  add column if not exists min_order_total numeric(12,2) not null default 0,
  add column if not exists reward_points numeric(12,2);
alter table public.store_missions drop constraint if exists store_missions_count_mode_check;
alter table public.store_missions add constraint store_missions_count_mode_check check (count_mode in ('items', 'spend', 'orders'));
alter table public.store_missions drop constraint if exists store_missions_min_order_total_check;
alter table public.store_missions add constraint store_missions_min_order_total_check check (min_order_total >= 0);
alter table public.store_missions drop constraint if exists store_missions_reward_points_check;
alter table public.store_missions add constraint store_missions_reward_points_check
  check (reward_points is null or (reward_points > 0 and reward_points <= 100000));
alter table public.store_missions drop constraint if exists store_missions_reward_type_check;
alter table public.store_missions add constraint store_missions_reward_type_check check (reward_type in ('product', 'discount', 'points'));
alter table public.store_missions drop constraint if exists store_missions_points_reward_check;
alter table public.store_missions add constraint store_missions_points_reward_check check (reward_type <> 'points' or reward_points is not null);
-- นับยอดเงินเป้าเป็นบาท → ขยายเพดานเป้า
alter table public.store_missions drop constraint if exists store_missions_target_count_check;
alter table public.store_missions add constraint store_missions_target_count_check check (target_count between 1 and 1000000);

alter table public.store_mission_enrollments
  add column if not exists count_mode text not null default 'items',
  add column if not exists min_order_total numeric(12,2) not null default 0,
  add column if not exists reward_points_awarded numeric(12,2) not null default 0;

-- คิว SMS รางวัลแต้ม (ไม่มีคูปอง) — ส่งครั้งเดียวต่อรอบ
create unique index if not exists store_mission_sms_queue_reward_points_uidx
  on public.store_mission_sms_queue (enrollment_id)
  where kind = 'reward' and redemption_id is null and status in ('queued', 'sending', 'sent');

-- ---------------------------------------------------------------------------
-- บันทึกภารกิจ: + วิธีนับ / ยอดขั้นต่ำต่อบิล / รางวัลแต้ม
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
  v_mode text := coalesce(nullif(p_payload ->> 'count_mode', ''), 'items');
  v_min_order numeric := coalesce(nullif(p_payload ->> 'min_order_total', '')::numeric, 0);
  v_points numeric := nullif(p_payload ->> 'reward_points', '')::numeric;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or auth.uid() is null or not auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'เฉพาะเจ้าของหรือแอดมินที่ตั้งภารกิจได้';
  end if;
  if v_name = '' then raise exception 'ตั้งชื่อภารกิจก่อน'; end if;
  if v_scope not in ('all', 'categories', 'products') then raise exception 'ขอบเขตสินค้าไม่ถูกต้อง'; end if;
  if v_mode not in ('items', 'spend', 'orders') then raise exception 'วิธีนับไม่ถูกต้อง'; end if;
  if v_min_order < 0 then raise exception 'ยอดขั้นต่ำต่อบิลไม่ถูกต้อง'; end if;
  if v_mode <> 'orders' then v_min_order := 0; end if;
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
  elsif v_reward_type = 'points' then
    v_reward_product := null; v_kind := null; v_value := null; v_min := 0;
    if v_points is null or v_points <= 0 or v_points > 100000 then raise exception 'ตั้งแต้มรางวัล 1–100,000 แต้ม'; end if;
  else
    raise exception 'เลือกชนิดรางวัล';
  end if;
  if v_reward_type <> 'points' then v_points := null; end if;

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

  -- รางวัลแต้มไม่ต้องมีของรางวัลซ่อน (บวกแต้มเข้าบัญชีตรง)
  if v_reward_type = 'points' then
    v_reward_id := null;
  elsif v_reward_changed then
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
      reward_discount_kind, reward_discount_value, reward_min_subtotal, reward_valid_days, reward_id, status, created_by,
      count_mode, min_order_total, reward_points
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
      coalesce(nullif(p_payload ->> 'status', ''), 'active'), auth.uid(),
      v_mode, v_min_order, v_points
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
      count_mode = v_mode, min_order_total = v_min_order, reward_points = v_points,
      status = coalesce(nullif(p_payload ->> 'status', ''), v_old.status),
      updated_at = now()
     where id = v_id;
  end if;
  -- เพดานต่อบิลใช้กับการนับชิ้นเท่านั้น
  if v_mode <> 'items' then
    update public.store_missions set max_per_order = null where id = v_id and max_per_order is not null;
  end if;
  return v_id;
end;
$$;

-- กดรับ: snapshot วิธีนับลงรอบ
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
    target_count, max_per_order, joined_at, expires_at, sms_opt_in, count_mode, min_order_total
  ) values (
    v_mission.organization_id, v_mission.store_id, v_mission.id, v_customer.member_identity_id, v_customer.id, v_round + 1,
    v_mission.target_count, v_mission.max_per_order, v_now,
    public.store_mission_round_expiry(v_mission.duration_days, v_mission.join_ends_at, v_now),
    coalesce(p_sms_opt_in, true), v_mission.count_mode, v_mission.min_order_total
  )
  returning * into v_enrollment;

  return jsonb_build_object('enrollment_id', v_enrollment.id, 'round', v_enrollment.round, 'already', false);
end;
$$;

-- ออกรางวัล: + รางวัลแต้ม
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
  v_balance numeric;
begin
  select * into v_e from public.store_mission_enrollments where id = p_enrollment_id for update;
  select * into v_m from public.store_missions where id = v_e.mission_id;
  -- รางวัลแต้ม: บวกแต้มเข้าบัญชีสมาชิกของสาขานี้ทันที (ไม่มีคูปอง)
  if v_m.reward_type = 'points' then
    if coalesce(v_e.reward_points_awarded, 0) > 0 then return null; end if;
    insert into public.loyalty_accounts (organization_id, store_id, customer_id)
    values (v_e.organization_id, v_e.store_id, v_e.customer_id)
    on conflict (store_id, customer_id) do update set updated_at = now()
    returning id into v_account_id;
    update public.loyalty_accounts set points_balance = points_balance + v_m.reward_points, updated_at = now()
     where id = v_account_id returning points_balance into v_balance;
    insert into public.loyalty_ledger (organization_id, store_id, account_id, customer_id, type, points_delta, reason, idempotency_key)
    values (v_e.organization_id, v_e.store_id, v_account_id, v_e.customer_id, 'adjustment', v_m.reward_points,
            'โบนัสภารกิจ: ' || v_m.name, 'mission-points:' || v_e.id::text || ':' || v_e.round::text || ':' || coalesce(v_e.completed_at, now())::text);
    update public.store_mission_enrollments set reward_points_awarded = v_m.reward_points, updated_at = now() where id = v_e.id;
    return null;
  end if;

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

-- นับ/หักคืน: + นับยอดเงิน/นับบิล + หักแต้มโบนัสคืนเมื่อ void
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
  v_spend numeric;
  v_take numeric;
  v_account uuid;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'paid' and new.customer_id is not null then
    select member_identity_id into v_identity from public.customers where id = new.customer_id;
    if v_identity is null then return new; end if;
    v_paid_at := coalesce(new.paid_at, now());

    for v_e in
      select e.id, e.progress, e.target_count, e.max_per_order, e.count_mode, e.min_order_total, m.scope, m.category_ids, m.product_ids
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
      select coalesce(sum(oi.quantity), 0)::int, coalesce(sum(oi.total_price), 0) into v_qty, v_spend
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
      -- วิธีนับ: ชิ้น (เพดานต่อบิล) · ยอดซื้อเป็นบาท (ปัดลง) · จำนวนบิลที่ยอดถึงขั้นต่ำ
      if v_e.count_mode = 'spend' then
        v_qty := floor(v_spend)::int;
      elsif v_e.count_mode = 'orders' then
        v_qty := case when v_spend > 0 and v_spend >= coalesce(v_e.min_order_total, 0) then 1 else 0 end;
      elsif v_e.max_per_order is not null then
        v_qty := least(v_qty, v_e.max_per_order);
      end if;
      if v_qty <= 0 then continue; end if;
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
      select p.enrollment_id, p.quantity, e.status, e.progress, e.reward_redemption_id, e.mission_id, e.member_identity_id, e.expires_at,
             e.reward_points_awarded, e.customer_id, e.store_id, e.organization_id
        from public.store_mission_progress p
        join public.store_mission_enrollments e on e.id = p.enrollment_id
       where p.order_id = new.id and p.kind = 'earn'
         and not exists (select 1 from public.store_mission_progress r
                          where r.enrollment_id = p.enrollment_id and r.order_id = p.order_id and r.kind = 'reverse')
       for update of e
    loop
      insert into public.store_mission_progress (organization_id, enrollment_id, order_id, kind, quantity)
      values (new.organization_id, v_p.enrollment_id, new.id, 'reverse', -v_p.quantity);

      if v_p.status = 'completed' and coalesce(v_p.reward_points_awarded, 0) > 0 then
        -- รางวัลแต้ม: หักแต้มโบนัสคืน (ไม่ให้ติดลบ) แล้วกลับไปทำต่อ
        v_account := null;
        select id, least(points_balance, v_p.reward_points_awarded) into v_account, v_take
          from public.loyalty_accounts where store_id = v_p.store_id and customer_id = v_p.customer_id for update;
        if v_account is not null and v_take > 0 then
          update public.loyalty_accounts set points_balance = points_balance - v_take, updated_at = now() where id = v_account;
          insert into public.loyalty_ledger (organization_id, store_id, account_id, customer_id, order_id, type, points_delta, reason, idempotency_key)
          values (v_p.organization_id, v_p.store_id, v_account, v_p.customer_id, new.id, 'adjustment', -v_take,
                  'ยกเลิกบิล: หักโบนัสภารกิจคืน', 'mission-points-reverse:' || v_p.enrollment_id::text || ':' || new.id::text);
        end if;
        update public.store_mission_enrollments
           set progress = greatest(v_p.progress - v_p.quantity, 0),
               status = case when exists (
                 select 1 from public.store_mission_enrollments o
                  where o.mission_id = v_p.mission_id and o.member_identity_id = v_p.member_identity_id
                    and o.status = 'active' and o.id <> v_p.enrollment_id) then 'cancelled'
                 when v_p.expires_at is not null and v_p.expires_at <= now() then 'expired'
                 else 'active' end,
               completed_at = null, reward_points_awarded = 0, updated_at = now()
         where id = v_p.enrollment_id;
      elsif v_p.status = 'completed' then
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

-- ออกรางวัลซ้ำ: ไม่แตะรอบที่ได้แต้มไปแล้ว
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
     where status = 'completed' and reward_redemption_id is null and reward_points_awarded = 0
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

-- SMS: ใกล้ครบเฉพาะนับชิ้น/บิล + แจ้งรางวัลแต้ม
create or replace function public.store_mission_enrollment_sms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ใกล้ครบ: เฉพาะนับชิ้น/นับบิล (นับยอดเงินไม่มีจังหวะ "เหลือ 1")
  if new.status = 'active' and new.count_mode in ('items', 'orders') and new.progress > old.progress
     and new.target_count - new.progress = 1 and new.target_count > 1 then
    perform public.enqueue_store_mission_sms('near', new.id, null);
  end if;
  if new.reward_redemption_id is not null and old.reward_redemption_id is distinct from new.reward_redemption_id then
    perform public.enqueue_store_mission_sms('reward', new.id, new.reward_redemption_id);
  end if;
  if coalesce(new.reward_points_awarded, 0) > 0 and coalesce(old.reward_points_awarded, 0) = 0 then
    perform public.enqueue_store_mission_sms('reward', new.id, null);
  end if;
  return new;
end;
$$;

drop trigger if exists store_mission_enrollment_sms on public.store_mission_enrollments;
create trigger store_mission_enrollment_sms
  after update of progress, reward_redemption_id, reward_points_awarded on public.store_mission_enrollments
  for each row execute function public.store_mission_enrollment_sms();

-- จองคิว SMS: คืนแต้มรางวัล (เปลี่ยนชนิดผลลัพธ์ → drop ก่อน)
drop function if exists public.claim_store_mission_sms(integer);
create or replace function public.claim_store_mission_sms(p_limit integer default 50)
returns table (
  id uuid, kind text, phone text, store_name text, store_slug text,
  mission_name text, reward_name text, voucher_expires_at timestamptz, reward_points numeric
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_hour integer := extract(hour from now() at time zone 'Asia/Bangkok');
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok';
  v_q record;
  v_store_sent integer;
  v_customer_sent integer;
  v_reason text;
begin
  -- หมดอายุคิวเก่า + คืนแถวที่ค้าง sending เกิน 10 นาที (API ล้มกลางทาง)
  update public.store_mission_sms_queue set status = 'expired'
   where status = 'queued' and created_at < now() - interval '3 days';
  update public.store_mission_sms_queue set status = 'queued'
   where status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts < 3;
  update public.store_mission_sms_queue set status = 'failed', error = coalesce(error, 'ส่งไม่สำเร็จ 3 ครั้ง')
   where status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts >= 3;

  if v_hour < 9 or v_hour >= 20 then
    return; -- นอกเวลาส่ง: คิวรอรอบถัดไป
  end if;

  for v_q in
    select q.*, c.phone as c_phone, c.mission_sms_opt_out, e.sms_opt_in, s.name as s_name, s.slug as s_slug,
           s.mission_sms_monthly_limit, s.missions_enabled, m.name as m_name, e.reward_points_awarded as e_points,
           r.status as r_status, r.used_at as r_used_at, r.expires_at as r_expires_at, lr.name as lr_name
      from public.store_mission_sms_queue q
      join public.customers c on c.id = q.customer_id
      join public.stores s on s.id = q.store_id
      left join public.store_mission_enrollments e on e.id = q.enrollment_id
      left join public.store_missions m on m.id = e.mission_id
      left join public.loyalty_reward_redemptions r on r.id = q.redemption_id
      left join public.loyalty_rewards lr on lr.id = r.reward_id
     where q.status = 'queued'
     order by q.created_at
     limit greatest(least(p_limit, 200), 1)
     for update of q skip locked
  loop
    v_reason := null;
    if not v_q.missions_enabled then v_reason := 'ร้านปิดภารกิจ';
    elsif v_q.c_phone is null then v_reason := 'ไม่มีเบอร์';
    elsif v_q.mission_sms_opt_out or v_q.sms_opt_in is false then v_reason := 'ลูกค้าไม่รับ SMS';
    elsif v_q.kind = 'near' and exists (
      select 1 from public.store_mission_enrollments e2 where e2.id = v_q.enrollment_id and (e2.status <> 'active' or e2.target_count - e2.progress <> 1)
    ) then v_reason := 'สถานะเปลี่ยนแล้ว';
    elsif v_q.kind = 'reward' and v_q.redemption_id is null and coalesce(v_q.e_points, 0) <= 0 then
      v_reason := 'แต้มโบนัสถูกยกเลิกแล้ว';
    elsif v_q.kind in ('reward', 'expiring') and v_q.redemption_id is not null
          and (v_q.r_status is distinct from 'pending' or v_q.r_used_at is not null) then
      v_reason := 'คูปองถูกใช้/ยกเลิกแล้ว';
    end if;

    if v_reason is null then
      select count(*) into v_store_sent from public.store_mission_sms_queue
       where store_id = v_q.store_id and status in ('sent', 'sending') and coalesce(sent_at, claimed_at) >= v_month_start;
      if v_store_sent >= v_q.mission_sms_monthly_limit then v_reason := 'เกินโควตา SMS ของร้านเดือนนี้'; end if;
    end if;
    if v_reason is null then
      select count(*) into v_customer_sent from public.store_mission_sms_queue
       where customer_id = v_q.customer_id and status in ('sent', 'sending') and coalesce(sent_at, claimed_at) >= now() - interval '7 days';
      if v_customer_sent >= 3 then v_reason := 'ครบ 3 ข้อความ/สัปดาห์'; end if;
    end if;

    if v_reason is not null then
      update public.store_mission_sms_queue set status = 'skipped', skip_reason = v_reason where store_mission_sms_queue.id = v_q.id;
      continue;
    end if;

    update public.store_mission_sms_queue
       set status = 'sending', claimed_at = now(), attempts = attempts + 1
     where store_mission_sms_queue.id = v_q.id;
    id := v_q.id; kind := v_q.kind; phone := v_q.c_phone; store_name := v_q.s_name; store_slug := v_q.s_slug;
    mission_name := v_q.m_name; reward_name := v_q.lr_name; voucher_expires_at := v_q.r_expires_at;
    reward_points := case when v_q.redemption_id is null then v_q.e_points else null end;
    return next;
  end loop;
end;
$$;

revoke all on function public.save_store_mission(uuid, jsonb) from public, anon;
grant execute on function public.save_store_mission(uuid, jsonb) to authenticated;
revoke all on function public.join_store_mission(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.join_store_mission(uuid, uuid, boolean) to service_role;
revoke all on function public.store_mission_issue_reward(uuid) from public, anon, authenticated;
revoke all on function public.store_missions_on_order_status() from public, anon, authenticated;
revoke all on function public.retry_store_mission_rewards() from public, anon, authenticated;
grant execute on function public.retry_store_mission_rewards() to service_role;
revoke all on function public.store_mission_enrollment_sms() from public, anon, authenticated;
revoke all on function public.claim_store_mission_sms(integer) from public, anon, authenticated;
grant execute on function public.claim_store_mission_sms(integer) to service_role;
