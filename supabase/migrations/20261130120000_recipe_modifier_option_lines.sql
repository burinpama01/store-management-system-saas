-- ============================================================
-- สูตรเพิ่มตามตัวเลือกเสริม (modifier option) — เช่น ร้อน/เย็น/ปั่น, วิปครีม, ไข่ดาว
--
-- recipe_lines.modifier_option_id:
--   null  = บรรทัดสูตรหลัก (ใช้ทุกครั้งที่ขายเมนูนี้)
--   uuid  = บวกเพิ่มเฉพาะเมื่อลูกค้าเลือกตัวเลือกนั้น (เพิ่มอย่างเดียว ไม่ได้แทนที่บรรทัดหลัก)
-- บรรทัดหนึ่งผูกได้อย่างใดอย่างหนึ่ง: variant หรือ modifier option (ไม่ผูกทั้งสอง)
--
-- ต้นทุนตอนขาย (order_item_costs): อ่าน option id จาก order_items.modifiers
--   รูปแบบ [{ modifierGroupId, modifierGroupName, option: { id, name, priceAdjustment } }]
--   ช่องทางที่ไม่มี option.id (เช่น Connect/เดลิเวอรี) → นับเฉพาะสูตรหลัก
-- ============================================================

alter table public.recipe_lines
  add column if not exists modifier_option_id uuid
  references public.modifier_options(id) on delete cascade;

do $$
begin
  alter table public.recipe_lines
    add constraint recipe_lines_variant_or_option
    check (variant_id is null or modifier_option_id is null);
exception when duplicate_object then null;
end $$;

create index if not exists recipe_lines_modifier_option_idx
  on public.recipe_lines (modifier_option_id) where modifier_option_id is not null;

-- กันซ้ำ: วัตถุดิบเดียวกันในขอบเขตเดียวกัน (สูตรหลัก / ตัวเลือกสินค้า / ตัวเลือกเสริม) มีได้บรรทัดเดียว
drop index if exists public.recipe_lines_unique_ingredient_idx;
create unique index if not exists recipe_lines_unique_ingredient_idx
  on public.recipe_lines (
    store_id,
    product_id,
    coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(modifier_option_id, '00000000-0000-0000-0000-000000000000'::uuid),
    ingredient_id
  );

-- RLS: ตัวเลือกเสริมต้องเป็นของเมนูนี้ (กันผูกข้ามเมนู/ข้ามร้าน)
drop policy if exists "recipe_lines_manager" on public.recipe_lines;
create policy "recipe_lines_manager" on public.recipe_lines for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (
    auth_user_role_in_store(organization_id, store_id, 'manager')
    and exists (select 1 from public.products p where p.id = product_id and p.store_id = recipe_lines.store_id)
    and exists (select 1 from public.ingredients i where i.id = ingredient_id and i.store_id = recipe_lines.store_id)
    and (variant_id is null or exists (
      select 1 from public.product_variants v where v.id = variant_id and v.product_id = recipe_lines.product_id
    ))
    and (modifier_option_id is null or exists (
      select 1
        from public.modifier_options o
        join public.modifier_groups g on g.id = o.modifier_group_id
       where o.id = modifier_option_id and g.product_id = recipe_lines.product_id
    ))
  );

-- ------------------------------------------------------------
-- ต้นทุนต่อหน่วย = สูตรหลัก + บรรทัดของ variant ที่ขาย + บรรทัดของตัวเลือกเสริมที่ลูกค้าเลือก
-- สูตรเดียวกับ src/modules/costing/math.ts plateIngredientCost (parity test)
-- ------------------------------------------------------------
create or replace function public.costing_plate_cost(p_product_id uuid, p_variant_id uuid, p_option_ids uuid[])
returns table (unit_cost numeric, packaging_cost numeric)
language sql
stable
set search_path = public
as $$
  with lines as (
    select rl.quantity * (i.purchase_price / i.usage_per_purchase / (i.yield_pct / 100)) as line_cost
      from recipe_lines rl
      join ingredients i on i.id = rl.ingredient_id
     where rl.product_id = p_product_id
       and (rl.variant_id is null or rl.variant_id = p_variant_id)
       and (rl.modifier_option_id is null or rl.modifier_option_id = any(coalesce(p_option_ids, '{}'::uuid[])))
  )
  select
    (select round(sum(line_cost), 4) from lines) as unit_cost,
    (select pcs.packaging_cost from product_cost_settings pcs where pcs.product_id = p_product_id) as packaging_cost;
$$;

revoke all on function public.costing_plate_cost(uuid, uuid, uuid[]) from public, anon, authenticated;

-- option id ที่ลูกค้าเลือก จาก order_items.modifiers — ข้ามค่าที่ไม่ใช่ uuid (ห้ามทำให้ cast ล้ม)
create or replace function public.costing_modifier_option_ids(p_modifiers jsonb)
returns uuid[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(distinct (m->'option'->>'id')::uuid), '{}'::uuid[])
    from jsonb_array_elements(case when jsonb_typeof(p_modifiers) = 'array' then p_modifiers else '[]'::jsonb end) m
   where jsonb_typeof(m) = 'object'
     and jsonb_typeof(m->'option') = 'object'
     and (m->'option'->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

revoke all on function public.costing_modifier_option_ids(jsonb) from public, anon, authenticated;

create or replace function public.costing_snapshot_order_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit_cost numeric;
  v_packaging numeric;
  v_org uuid;
  v_store uuid;
begin
  if new.product_id is null then
    return null;
  end if;
  begin
    select c.unit_cost, c.packaging_cost into v_unit_cost, v_packaging
      from costing_plate_cost(new.product_id, new.variant_id, costing_modifier_option_ids(new.modifiers)) c;
    if v_unit_cost is null and coalesce(v_packaging, 0) = 0 then
      return null;  -- ยังไม่มีสูตรและไม่มีค่าบรรจุภัณฑ์: ไม่บันทึก (รายงานนับเป็น "ยังไม่มีสูตร")
    end if;
    select o.organization_id, o.store_id into v_org, v_store
      from orders o where o.id = new.order_id;
    if v_store is null then
      return null;
    end if;
    insert into order_item_costs (
      order_item_id, order_id, organization_id, store_id, product_id, variant_id, unit_cost, packaging_cost
    ) values (
      new.id, new.order_id, v_org, v_store, new.product_id, new.variant_id, v_unit_cost, coalesce(v_packaging, 0)
    )
    on conflict (order_item_id) do nothing;
  exception when others then
    raise warning 'costing snapshot failed for order_item %: %', new.id, sqlerrm;
    begin
      insert into system_event_logs (level, source, action, message, error_code, store_id, context, fingerprint)
      values (
        'error', 'costing.snapshot', 'costing_snapshot_order_item',
        'บันทึกต้นทุนตอนขายไม่สำเร็จ (การขายยังสำเร็จ)', sqlstate, v_store,
        jsonb_build_object('orderItemId', new.id, 'productId', new.product_id),
        'costing.snapshot:' || sqlstate
      );
    exception when others then
      null;
    end;
  end;
  return null;
end;
$$;

revoke all on function public.costing_snapshot_order_item() from public, anon, authenticated;

-- ตัวเก่า 2 อาร์กิวเมนต์ไม่มีผู้เรียกแล้ว (trigger ใช้ตัวใหม่)
drop function if exists public.costing_plate_cost(uuid, uuid);

-- ------------------------------------------------------------
-- บันทึกสูตร: รับ modifierOptionId เพิ่ม ("" = ไม่ผูกตัวเลือกเสริม)
-- ------------------------------------------------------------
create or replace function public.costing_save_menu(
  p_product_id uuid,
  p_lines jsonb,
  p_packaging_cost numeric,
  p_target_food_cost_pct numeric
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_store uuid;
  v_org uuid;
begin
  select p.store_id, s.organization_id into v_store, v_org
    from products p
    join stores s on s.id = p.store_id
   where p.id = p_product_id;
  if v_store is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if not auth_user_role_in_store(v_org, v_store, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- p_lines null ต้องปฏิเสธ (null <> 'array' เป็น null → ไม่ raise แล้วจะลบสูตรทิ้งหมด)
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 120 then
    raise exception 'invalid lines' using errcode = '22023';
  end if;

  delete from recipe_lines where store_id = v_store and product_id = p_product_id;
  insert into recipe_lines (organization_id, store_id, product_id, variant_id, modifier_option_id, ingredient_id, quantity)
  select v_org, v_store, p_product_id,
         nullif(el->>'variantId', '')::uuid,
         nullif(coalesce(el->>'modifierOptionId', ''), '')::uuid,
         (el->>'ingredientId')::uuid,
         (el->>'quantity')::numeric
    from jsonb_array_elements(p_lines) el;

  insert into product_cost_settings (product_id, organization_id, store_id, packaging_cost, target_food_cost_pct, updated_at)
  values (p_product_id, v_org, v_store, coalesce(p_packaging_cost, 0), p_target_food_cost_pct, now())
  on conflict (product_id) do update
    set packaging_cost = excluded.packaging_cost,
        target_food_cost_pct = excluded.target_food_cost_pct,
        updated_at = now();
end;
$$;

revoke all on function public.costing_save_menu(uuid, jsonb, numeric, numeric) from public, anon;
grant execute on function public.costing_save_menu(uuid, jsonb, numeric, numeric) to authenticated;
