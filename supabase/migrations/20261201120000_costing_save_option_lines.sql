-- ============================================================
-- บันทึกวัตถุดิบของตัวเลือกเสริม จากหน้าแก้เมนู (/catalog)
--
-- costing_save_option_lines(option, lines, apply_same_name):
--   แทนที่บรรทัดสูตรของตัวเลือกนี้ทั้งหมด (recipe_lines.modifier_option_id = option)
--   apply_same_name = true → ใช้ชุดเดียวกันกับทุกเมนูในสาขาที่มีตัวเลือกชื่อเดียวกันในกลุ่มชื่อเดียวกัน
--   (เช่น "ประเภท: ปั่น" ของเครื่องดื่ม 20 เมนู) เฉพาะเมนู/ตัวเลือกที่เปิดอยู่ — ไม่แตะสูตรหลักหรือบรรทัดของ variant
-- security invoker → RLS recipe_lines (manager + with check ข้ามเมนู/ข้ามร้าน) บังคับทุกแถว
-- ============================================================

create or replace function public.costing_save_option_lines(
  p_option_id uuid,
  p_lines jsonb,
  p_apply_same_name boolean
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_store uuid;
  v_org uuid;
  v_group_name text;
  v_option_name text;
  v_count integer := 0;
  v_target record;
begin
  select p.store_id, s.organization_id, g.name, o.name
    into v_store, v_org, v_group_name, v_option_name
    from modifier_options o
    join modifier_groups g on g.id = o.modifier_group_id
    join products p on p.id = g.product_id
    join stores s on s.id = p.store_id
   where o.id = p_option_id;
  if v_store is null then
    raise exception 'option not found' using errcode = 'P0002';
  end if;
  if not auth_user_role_in_store(v_org, v_store, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- null ต้องปฏิเสธ (null <> 'array' เป็น null → จะลบบรรทัดทิ้งหมดโดยไม่ตั้งใจ)
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 30 then
    raise exception 'invalid lines' using errcode = '22023';
  end if;

  for v_target in
    select o2.id as option_id, g2.product_id
      from modifier_options o2
      join modifier_groups g2 on g2.id = o2.modifier_group_id
      join products p2 on p2.id = g2.product_id
     where p2.store_id = v_store
       and (
         o2.id = p_option_id
         or (
           coalesce(p_apply_same_name, false)
           and p2.is_active
           and o2.is_active
           and lower(btrim(g2.name)) = lower(btrim(v_group_name))
           and lower(btrim(o2.name)) = lower(btrim(v_option_name))
         )
       )
  loop
    delete from recipe_lines where store_id = v_store and modifier_option_id = v_target.option_id;
    insert into recipe_lines (organization_id, store_id, product_id, variant_id, modifier_option_id, ingredient_id, quantity)
    select v_org, v_store, v_target.product_id, null, v_target.option_id,
           (el->>'ingredientId')::uuid,
           (el->>'quantity')::numeric
      from jsonb_array_elements(p_lines) el;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.costing_save_option_lines(uuid, jsonb, boolean) from public, anon;
grant execute on function public.costing_save_option_lines(uuid, jsonb, boolean) to authenticated;
