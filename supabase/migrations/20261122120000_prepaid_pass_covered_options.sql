-- ============================================================
-- แพ็กล่วงหน้าครอบคลุม "ตัวเลือก" ด้วย
--
-- ตัวอย่างผู้ใช้: อเมริกาโน่เย็น 10 แก้ว 350 บาท — เมนูราคาเริ่มต้น 35 (ร้อน) เย็นต้องกดตัวเลือก +5
-- เดิมแพ็กลดแค่ราคาเมนู (บรรทัด ฿0 ไม่มีตัวเลือก) → ร้านเลือกได้แล้วว่าตัวเลือก/ขนาดไหน "รวมในแพ็ก"
--   ตัวเลือกที่รวม = ลูกค้าไม่จ่ายเพิ่ม · ตัวเลือกที่ไม่รวม (เช่น เพิ่มช็อต +10) = จ่ายส่วนต่างตามปกติ
--
-- prepaid_pass_plan_modifier_options / prepaid_pass_plan_variants — ตัวเลือกของเมนูในแพ็ก
-- save_prepaid_pass_plan  — เพิ่มพารามิเตอร์ตัวเลือก/ขนาด (ตรวจว่าเป็นของเมนูที่เลือกในแพ็ก)
-- prepaid_pass_covered_options(pass, store, product) — ตัวเลือกของเมนูสาขานี้ที่แพ็กครอบคลุม
--   ข้ามสาขา (redeem_scope = 'org' + เมนูผูก menu_link_id) เทียบชื่อกลุ่ม+ชื่อตัวเลือก / ชื่อขนาด
-- list_prepaid_passes_for_verification — ส่งตัวเลือกที่ครอบคลุมให้ POS คิดราคา
-- ราคาจริงคิดใหม่ฝั่ง server ตอนสร้างออเดอร์เสมอ (ไม่เชื่อราคาจาก POS)
-- additive
-- ============================================================

create table if not exists public.prepaid_pass_plan_modifier_options (
  plan_id uuid not null references public.prepaid_pass_plans(id) on delete cascade,
  modifier_option_id uuid not null references public.modifier_options(id) on delete cascade,
  primary key (plan_id, modifier_option_id)
);

create table if not exists public.prepaid_pass_plan_variants (
  plan_id uuid not null references public.prepaid_pass_plans(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  primary key (plan_id, variant_id)
);

alter table public.prepaid_pass_plan_modifier_options enable row level security;
alter table public.prepaid_pass_plan_variants enable row level security;
revoke all on table public.prepaid_pass_plan_modifier_options from anon, authenticated;
revoke all on table public.prepaid_pass_plan_variants from anon, authenticated;
grant select on table public.prepaid_pass_plan_modifier_options to authenticated;
grant select on table public.prepaid_pass_plan_variants to authenticated;

drop policy if exists "prepaid_pass_plan_modifier_options: org member can read" on public.prepaid_pass_plan_modifier_options;
create policy "prepaid_pass_plan_modifier_options: org member can read"
  on public.prepaid_pass_plan_modifier_options for select
  using (plan_id in (select id from public.prepaid_pass_plans));

drop policy if exists "prepaid_pass_plan_variants: org member can read" on public.prepaid_pass_plan_variants;
create policy "prepaid_pass_plan_variants: org member can read"
  on public.prepaid_pass_plan_variants for select
  using (plan_id in (select id from public.prepaid_pass_plans));

-- ---------- บันทึกแบบแพ็ก (เพิ่มตัวเลือก/ขนาด) ----------
drop function if exists public.save_prepaid_pass_plan(uuid, uuid, text, integer, numeric, integer, text, text, uuid[], boolean);

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
  p_is_active boolean,
  p_modifier_option_ids uuid[] default '{}',
  p_variant_ids uuid[] default '{}'
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

  -- ตัวเลือก/ขนาดที่รวมในแพ็กต้องเป็นของเมนูที่เลือกในแพ็กนี้เท่านั้น
  select count(*) into v_bad
    from unnest(coalesce(p_modifier_option_ids, '{}'::uuid[])) oid
   where not exists (
     select 1
       from public.modifier_options o
       join public.modifier_groups g on g.id = o.modifier_group_id
      where o.id = oid and g.product_id = any (p_product_ids)
   );
  if v_bad > 0 then raise exception 'ตัวเลือกที่รวมในแพ็กต้องเป็นของเมนูที่เลือก'; end if;
  select count(*) into v_bad
    from unnest(coalesce(p_variant_ids, '{}'::uuid[])) vid
   where not exists (select 1 from public.product_variants v where v.id = vid and v.product_id = any (p_product_ids));
  if v_bad > 0 then raise exception 'ขนาดที่รวมในแพ็กต้องเป็นของเมนูที่เลือก'; end if;

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
    update public.products
       set name = trim(p_name), base_price = p_price, is_active = coalesce(p_is_active, true),
           available_for_pos = true, available_for_qr = false, available_for_delivery = false, updated_at = now()
     where id = v_plan.sale_product_id;
  end if;

  delete from public.prepaid_pass_plan_products where plan_id = v_plan_id;
  insert into public.prepaid_pass_plan_products (plan_id, product_id)
  select distinct v_plan_id, pid from unnest(p_product_ids) pid;

  delete from public.prepaid_pass_plan_modifier_options where plan_id = v_plan_id;
  insert into public.prepaid_pass_plan_modifier_options (plan_id, modifier_option_id)
  select distinct v_plan_id, oid from unnest(coalesce(p_modifier_option_ids, '{}'::uuid[])) oid;

  delete from public.prepaid_pass_plan_variants where plan_id = v_plan_id;
  insert into public.prepaid_pass_plan_variants (plan_id, variant_id)
  select distinct v_plan_id, vid from unnest(coalesce(p_variant_ids, '{}'::uuid[])) vid;

  return v_plan_id;
end;
$$;

revoke all on function public.save_prepaid_pass_plan(uuid, uuid, text, integer, numeric, integer, text, text, uuid[], boolean, uuid[], uuid[]) from public, anon;
grant execute on function public.save_prepaid_pass_plan(uuid, uuid, text, integer, numeric, integer, text, text, uuid[], boolean, uuid[], uuid[]) to authenticated;

-- ---------- ตัวเลือกของเมนูสาขานี้ที่แพ็กครอบคลุม ----------
create or replace function public.prepaid_pass_covered_options(p_pass_id uuid, p_store_id uuid, p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  -- ผู้เรียกต้องเป็นสมาชิกของสาขานี้ และแพ็กต้องเป็นขององค์กรเดียวกับสาขา (กันดูข้อมูลแพ็กข้ามองค์กร)
  if auth.uid() is null
     or p_store_id not in (select auth_user_store_ids())
     or not exists (
       select 1
         from public.prepaid_passes pp
         join public.stores s on s.id = p_store_id
        where pp.id = p_pass_id and pp.organization_id = s.organization_id
     ) then
    raise exception 'ไม่มีสิทธิ์ดูข้อมูลแพ็กนี้';
  end if;

  with ps as (
    select * from public.prepaid_passes where id = p_pass_id
  ),
  dp as (
    select p.* from public.products p
     where p.id = p_product_id and p.store_id = p_store_id
       and public.prepaid_pass_covers_product(p_pass_id, p_store_id, p_product_id)
  )
  select jsonb_build_object(
    'modifier_option_ids', coalesce((
      select jsonb_agg(distinct o.id)
        from dp
        join public.modifier_groups g on g.product_id = dp.id
        join public.modifier_options o on o.modifier_group_id = g.id
        cross join ps
       where exists (
         select 1
           from public.prepaid_pass_plan_modifier_options pmo
           join public.modifier_options so on so.id = pmo.modifier_option_id
           join public.modifier_groups sg on sg.id = so.modifier_group_id
           join public.products sp on sp.id = sg.product_id
          where pmo.plan_id = ps.plan_id
            and (
              so.id = o.id
              or (
                ps.redeem_scope = 'org'
                and sp.menu_link_id is not null
                and sp.menu_link_id = dp.menu_link_id
                and lower(trim(sg.name)) = lower(trim(g.name))
                and lower(trim(so.name)) = lower(trim(o.name))
              )
            )
       )
    ), '[]'::jsonb),
    'variant_ids', coalesce((
      select jsonb_agg(distinct v.id)
        from dp
        join public.product_variants v on v.product_id = dp.id
        cross join ps
       where exists (
         select 1
           from public.prepaid_pass_plan_variants ppv
           join public.product_variants sv on sv.id = ppv.variant_id
           join public.products sp on sp.id = sv.product_id
          where ppv.plan_id = ps.plan_id
            and (
              sv.id = v.id
              or (
                ps.redeem_scope = 'org'
                and sp.menu_link_id is not null
                and sp.menu_link_id = dp.menu_link_id
                and lower(trim(sv.name)) = lower(trim(v.name))
              )
            )
       )
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.prepaid_pass_covered_options(uuid, uuid, uuid) from public, anon;
grant execute on function public.prepaid_pass_covered_options(uuid, uuid, uuid) to authenticated;

-- ---------- รายการแพ็กของสมาชิก (POS) + ตัวเลือกที่ครอบคลุม ----------
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
      'product_ids', coalesce(covered.product_ids, '[]'::jsonb),
      'covered_option_ids', coalesce(covered.option_ids, '[]'::jsonb),
      'covered_variant_ids', coalesce(covered.variant_ids, '[]'::jsonb)
    ) order by ps.expires_at nulls last, ps.created_at)
      from public.prepaid_passes ps
      left join lateral (
        -- เรียกตัวเลือกที่ครอบคลุมครั้งเดียวต่อเมนูที่แพ็กใช้ได้ แล้วแตกเป็นรายการตัวเลือก/ขนาด
        select
          coalesce(jsonb_agg(distinct c.pid), '[]'::jsonb) as product_ids,
          coalesce(jsonb_agg(distinct oi.value) filter (where oi.value is not null), '[]'::jsonb) as option_ids,
          coalesce(jsonb_agg(distinct vi.value) filter (where vi.value is not null), '[]'::jsonb) as variant_ids
          from (
            select p.id as pid, public.prepaid_pass_covered_options(ps.id, p_store_id, p.id) as cov
              from public.products p
             where p.store_id = p_store_id
               and p.is_active
               and public.prepaid_pass_covers_product(ps.id, p_store_id, p.id)
          ) c
          left join lateral jsonb_array_elements(c.cov->'modifier_option_ids') oi on true
          left join lateral jsonb_array_elements(c.cov->'variant_ids') vi on true
      ) covered on true
     where ps.member_identity_id = v_ver.member_identity_id
       and ps.status = 'active'
       and ps.credits_remaining > 0
       and (ps.expires_at is null or ps.expires_at > now())
  ), '[]'::jsonb);
end;
$$;
