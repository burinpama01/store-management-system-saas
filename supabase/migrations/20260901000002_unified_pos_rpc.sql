-- ============================================================
-- Task U4 (v0.35.4) — Atomic QR submit + staff add-items (Unified POS RPC v2)
-- ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U4)
--
-- เนื้อหา:
--   a) user_has_permission_in_store — เวอร์ชัน "ระบุ user id ได้" ของ
--      auth_user_has_permission (เดิมอ่าน auth.uid() เท่านั้น) เพื่อให้ RPC v2
--      ที่เรียกผ่าน service_role ตรวจสิทธิ์ pos.use ของ actor ได้
--      (auth_user_has_permission ถูก rewrite ให้ delegate — พฤติกรรมเดิมครบ)
--   b) unified_pos_validate_order_items — กฎ validate สินค้า/variant/modifier/ราคา
--      คัดลอกตรงจาก RPC v1 (20260701000000_fix_qr_order_rpc.sql) ใช้ร่วมทั้งสอง RPC
--   c) unified_pos_submit_table_order — engine เดียวของสองเส้นทาง:
--        p_source = 'qr'    → create_qr_order_with_items_v2 (qr_order_source=true,
--                             หักสต๊อกตอนสร้าง ตาม convention 20260607000006)
--        p_source = 'staff' → add_items_to_table_v2 (qr_order_source=false,
--                             ห้ามหักสต๊อกตอนสร้าง — close_pos_order_payment จะหัก
--                             ตอนชำระตาม convention เดียวกัน มิฉะนั้นหักซ้ำ)
--      Atomic ทั้งก้อนใน transaction เดียว:
--        advisory lock (store,operation_key) → receipt (replay/conflict) →
--        store flags → lock table row → table session (auto-open ตาม policy) →
--        validate items → stock → insert order + items → receipt → audit
--        (exception ใดๆ กลางทาง → rollback ทั้งหมด ไม่เหลือร่องรอย)
--   d) RPC wrappers: create_qr_order_with_items_v2 / add_items_to_table_v2
--      (RPC v1 เดิมไม่แตะ — ยังใช้โดย flow เดิมจนกว่า flag cutover)
--   e) grants ตาม convention เดิมของ repo (service_role only สำหรับ v2)
--
-- Idempotency (แผน: same key + same hash → replay / same key + new hash → conflict):
--   - pg_advisory_xact_lock('unified_pos:' || store_id || ':' || operation_key)
--     ทำให้ concurrent same-key serialize (20 ยิงพร้อมกัน → executed 1 + replayed 19)
--   - receipt เขียน "ใน transaction เดียวกับ commit สุดท้าย" และ unique
--     (store_id, operation_key) เป็น backstop — replay ระหว่าง concurrent เป็นไปไม่ได้
--   - replay/conflict ต้องไม่ mutate อะไรเลย (เช็คก่อน validation/state เสมอ
--     เพื่อให้ retry ของคำขอเดิมได้ผลเดิมแม้สถานะร้านเปลี่ยน เช่น flag ถูกปิดภายหลัง)
-- ============================================================

-- ------------------------------------------------------------
-- (a) Permission helper ที่ระบุ user id ได้ (U4 — service context)
-- ------------------------------------------------------------
create or replace function public.user_has_permission_in_store(
  p_user_id uuid,
  p_organization_id uuid,
  p_store_id uuid,
  p_permission_key text
)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_membership memberships%rowtype;
  v_has_permission boolean := false;
  v_override_granted boolean;
begin
  if p_user_id is null then
    return false;
  end if;

  select *
    into v_membership
    from memberships m
    where m.user_id = p_user_id
      and m.organization_id = p_organization_id
      and (m.store_id = p_store_id or m.store_id is null)
      and m.joined_at is not null
    order by case when m.store_id = p_store_id then 0 else 1 end
    limit 1;

  if not found then
    return false;
  end if;

  -- คัดลอก role → default permission set ตรงจาก auth_user_has_permission
  -- (20260623000001_cash_session_net_cash_and_pos_gate.sql)
  v_has_permission := case v_membership.role
    when 'super_admin' then p_permission_key = any(array[
      'dashboard.view', 'pos.use', 'pos.discount', 'pos.refund', 'pos.delete_bill',
      'orders.manage_qr', 'catalog.view', 'catalog.manage', 'stock.manage',
      'cashflow.view', 'cashflow.record', 'cashflow.manage', 'reports.view',
      'attendance.clock', 'attendance.manage', 'settings.view', 'settings.manage_printer',
      'settings.manage_store', 'users.manage', 'permissions.manage', 'notifications.manage',
      'organizations.manage', 'billing.manage', 'system.manage'
    ])
    when 'owner' then p_permission_key = any(array[
      'dashboard.view', 'pos.use', 'pos.discount', 'pos.refund', 'pos.delete_bill',
      'orders.manage_qr', 'catalog.view', 'catalog.manage', 'stock.manage',
      'cashflow.view', 'cashflow.record', 'cashflow.manage', 'reports.view',
      'attendance.clock', 'attendance.manage', 'settings.view', 'settings.manage_printer',
      'settings.manage_store', 'users.manage', 'permissions.manage', 'notifications.manage',
      'billing.manage'
    ])
    when 'admin' then p_permission_key = any(array[
      'dashboard.view', 'pos.use', 'pos.discount', 'pos.refund', 'pos.delete_bill',
      'orders.manage_qr', 'catalog.view', 'catalog.manage', 'stock.manage',
      'cashflow.view', 'cashflow.record', 'cashflow.manage', 'reports.view',
      'attendance.clock', 'attendance.manage', 'settings.view', 'settings.manage_printer',
      'settings.manage_store', 'users.manage', 'notifications.manage'
    ])
    when 'manager' then p_permission_key = any(array[
      'dashboard.view', 'pos.use', 'pos.discount', 'pos.refund',
      'catalog.view', 'catalog.manage', 'stock.manage',
      'cashflow.view', 'cashflow.record', 'reports.view',
      'attendance.clock', 'attendance.manage', 'settings.view', 'settings.manage_printer',
      'orders.manage_qr'
    ])
    when 'cashier' then p_permission_key = any(array[
      'pos.use', 'pos.discount', 'cashflow.view', 'cashflow.record',
      'attendance.clock', 'settings.view', 'settings.manage_printer', 'orders.manage_qr'
    ])
    when 'staff' then p_permission_key = any(array[
      'pos.use', 'cashflow.view', 'cashflow.record',
      'attendance.clock', 'settings.view', 'settings.manage_printer'
    ])
    else false
  end;

  select mpo.granted
    into v_override_granted
    from membership_permission_overrides mpo
    where mpo.membership_id = v_membership.id
      and mpo.permission_key = p_permission_key
    limit 1;

  if found then
    v_has_permission := v_override_granted;
  end if;

  -- Keep DB behavior aligned with the app resolver's locked role permissions.
  if v_membership.role in ('cashier', 'staff')
     and p_permission_key in ('catalog.view', 'catalog.manage') then
    return false;
  end if;

  return v_has_permission;
end;
$$;

-- auth_user_has_permission เดิม → delegate (พฤติกรรมเท่าเดิมทุกอย่าง)
create or replace function public.auth_user_has_permission(
  p_organization_id uuid,
  p_store_id uuid,
  p_permission_key text
)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  return public.user_has_permission_in_store(auth.uid(), p_organization_id, p_store_id, p_permission_key);
end;
$$;

-- ------------------------------------------------------------
-- (b) Item validation ร่วม (กฎเดิมของ RPC v1 คัดลอกตรง)
--     คืน NULL = ผ่าน; ไม่งั้นคืน error jsonb {status,code,message} ตาม contracts
-- ------------------------------------------------------------
create or replace function public.unified_pos_validate_order_items(
  p_organization_id uuid,
  p_store_id uuid,
  p_items jsonb,
  p_subtotal numeric,
  p_source text
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_item_count integer;
  v_items_subtotal numeric;
  v_invalid_required_modifier_count integer;
  v_invalid_max_modifier_count integer;
  v_invalid_single_modifier_count integer;
  v_duplicate_modifier_count integer;
  v_invalid_station_count integer;
begin
  if p_items is null
    or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','ไม่มีรายการในออร์เดอร์');
  end if;

  if p_subtotal is null or p_subtotal < 0 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','ยอดออร์เดอร์ไม่ถูกต้อง');
  end if;

  -- ราคา/สินค้า/variant/modifier ต้องตรงตาม DB (unit_price = base + variant adj + modifier adj)
  select count(*), coalesce(sum(item.total_price), 0)
    into v_item_count, v_items_subtotal
    from jsonb_to_recordset(p_items) as item(
      product_id uuid,
      product_name text,
      variant_id uuid,
      variant_name text,
      modifiers jsonb,
      quantity integer,
      unit_price numeric,
      total_price numeric,
      note text
    )
    join products on products.id = item.product_id
    left join product_variants on product_variants.id = item.variant_id
    where item.product_id is not null
      and item.product_name is not null
      and item.quantity > 0
      and item.unit_price >= 0
      and item.total_price >= 0
      and round(item.total_price, 2) = round(item.unit_price * item.quantity, 2)
      and products.organization_id = p_organization_id
      and products.store_id = p_store_id
      and products.is_active = true
      and products.available_for_qr = true
      and (
        item.variant_id is null
        or (
          product_variants.product_id = products.id
          and product_variants.is_active = true
        )
      )
      and round(item.unit_price, 2) = round(products.base_price
        + coalesce(product_variants.price_adjustment, 0)
        + coalesce((
          select sum(modifier_options.price_adjustment)
          from jsonb_array_elements(coalesce(item.modifiers, '[]'::jsonb)) as selected_modifier
          join modifier_options
            on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
          join modifier_groups
            on modifier_groups.id = modifier_options.modifier_group_id
          where modifier_groups.product_id = products.id
            and modifier_options.is_active = true
        ), 0), 2)
      and jsonb_array_length(coalesce(item.modifiers, '[]'::jsonb)) = (
        select count(*)
        from jsonb_array_elements(coalesce(item.modifiers, '[]'::jsonb)) as selected_modifier
        join modifier_options
          on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
        join modifier_groups
          on modifier_groups.id = modifier_options.modifier_group_id
        where modifier_groups.product_id = products.id
          and modifier_options.is_active = true
      );

  if v_item_count is distinct from jsonb_array_length(p_items) then
    return jsonb_build_object('status','error','code','up_invalid_item','message','รายการออร์เดอร์ไม่ถูกต้อง');
  end if;

  if round(p_subtotal, 2) is distinct from round(v_items_subtotal, 2) then
    return jsonb_build_object('status','error','code','up_invalid_item','message','ยอดรวมสินค้าไม่ตรงกับรายการ');
  end if;

  -- duplicate modifier option (pattern เดิมของ v1 หลังแก้ WITH ORDINALITY)
  with item_rows as (
    select item.*, item_ordinality as line_number
    from jsonb_array_elements(p_items) with ordinality as _elems(elem, item_ordinality)
    cross join lateral jsonb_to_recordset(jsonb_build_array(_elems.elem)) as item(
      product_id uuid,
      modifiers jsonb
    )
  ),
  selected as (
    select
      item_rows.line_number,
      item_rows.product_id,
      modifier_groups.id as modifier_group_id,
      modifier_options.id as option_id
    from item_rows
    cross join lateral jsonb_array_elements(coalesce(item_rows.modifiers, '[]'::jsonb)) as selected_modifier
    join modifier_options
      on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
    join modifier_groups
      on modifier_groups.id = modifier_options.modifier_group_id
    where modifier_groups.product_id = item_rows.product_id
      and modifier_options.is_active = true
  )
  select count(*)
    into v_duplicate_modifier_count
    from (
      select line_number, product_id, option_id, count(*) as selected_count
      from selected
      group by line_number, product_id, option_id
      having count(*) > 1
    ) duplicate_options;

  if v_duplicate_modifier_count > 0 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','duplicate modifier option');
  end if;

  -- required/min selections
  with item_rows as (
    select _elems.item_ordinality as line_number, item.product_id, item.modifiers
    from jsonb_array_elements(p_items) with ordinality as _elems(elem, item_ordinality)
    cross join lateral jsonb_to_recordset(jsonb_build_array(_elems.elem)) as item(
      product_id uuid,
      modifiers jsonb
    )
  ),
  selected_counts as (
    select
      item_rows.line_number,
      item_rows.product_id,
      modifier_groups.id as modifier_group_id,
      count(modifier_options.id) as selected_count
    from item_rows
    join modifier_groups on modifier_groups.product_id = item_rows.product_id
    left join lateral jsonb_array_elements(coalesce(item_rows.modifiers, '[]'::jsonb)) as selected_modifier on true
    left join modifier_options
      on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
      and modifier_options.modifier_group_id = modifier_groups.id
      and modifier_options.is_active = true
    group by item_rows.line_number, item_rows.product_id, modifier_groups.id
  )
  select count(*)
    into v_invalid_required_modifier_count
    from selected_counts
    join modifier_groups on modifier_groups.id = selected_counts.modifier_group_id
    where selected_counts.selected_count < case
      when modifier_groups.is_required then greatest(1, modifier_groups.min_selections)
      else modifier_groups.min_selections
    end;

  if v_invalid_required_modifier_count > 0 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','missing required modifier');
  end if;

  -- max/single selections
  with item_rows as (
    select _elems.item_ordinality as line_number, item.product_id, item.modifiers
    from jsonb_array_elements(p_items) with ordinality as _elems(elem, item_ordinality)
    cross join lateral jsonb_to_recordset(jsonb_build_array(_elems.elem)) as item(
      product_id uuid,
      modifiers jsonb
    )
  ),
  selected_counts as (
    select
      item_rows.line_number,
      item_rows.product_id,
      modifier_groups.id as modifier_group_id,
      modifier_groups.selection_type,
      modifier_groups.max_selections,
      count(modifier_options.id) as selected_count
    from item_rows
    join modifier_groups on modifier_groups.product_id = item_rows.product_id
    left join lateral jsonb_array_elements(coalesce(item_rows.modifiers, '[]'::jsonb)) as selected_modifier on true
    left join modifier_options
      on modifier_options.id = ((selected_modifier.value -> 'option' ->> 'id')::uuid)
      and modifier_options.modifier_group_id = modifier_groups.id
      and modifier_options.is_active = true
    group by item_rows.line_number, item_rows.product_id, modifier_groups.id, modifier_groups.selection_type, modifier_groups.max_selections
  )
  select
    count(*) filter (where selected_count > max_selections),
    count(*) filter (where selection_type = 'single' and selected_count > 1)
    into v_invalid_max_modifier_count, v_invalid_single_modifier_count
    from selected_counts;

  if v_invalid_max_modifier_count > 0 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','too many modifier selections');
  end if;

  if v_invalid_single_modifier_count > 0 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','invalid single-choice modifier selection');
  end if;

  -- QR เท่านั้น: ทุก product ต้องมี active kitchen station (กฎเดิมของ repo —
  -- staff add-items เป็น qr_order_source=false จึงไม่บังคับ ตรงกับ trigger เดิม)
  if p_source = 'qr' then
    select count(distinct item.product_id)
      into v_invalid_station_count
      from jsonb_to_recordset(p_items) as item(product_id uuid)
      where not qr_product_has_active_kitchen_station(item.product_id, p_store_id);

    if v_invalid_station_count > 0 then
      return jsonb_build_object('status','error','code','up_invalid_item','message','QR menu item must be assigned to a kitchen station');
    end if;
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- (c) Engine กลาง — atomic submit ของทั้ง QR และ staff add-items
-- ------------------------------------------------------------
create or replace function public.unified_pos_submit_table_order(
  p_organization_id uuid,
  p_store_id uuid,
  p_table_id uuid,
  p_order_number text,
  p_operation_key text,
  p_request_hash text,
  p_subtotal numeric,
  p_items jsonb,
  p_source text,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_system_account_id uuid;
  v_table_number text;
  v_error jsonb;
  v_receipt unified_pos_operation_receipts%rowtype;
  v_result jsonb;
  v_now timestamptz := now();
  -- store
  v_store_is_active boolean;
  v_store_qr_enabled boolean;
  v_store_flag_enabled boolean;
  v_mode text;
  v_policy text;
  v_minutes integer;
  -- table session
  v_session_started_at timestamptz;
  v_session_expires_at timestamptz;
  v_session_active boolean;
  -- stock
  v_stock record;
  v_variant product_variants%rowtype;
begin
  -- p_source เฉพาะค่าที่กำหนด
  if p_source not in ('qr', 'staff') then
    raise exception 'p_source ไม่ถูกต้อง';
  end if;

  -- ---------- 0) ความถูกต้องของ envelope ----------
  if p_operation_key is null or length(p_operation_key) < 8 or length(p_operation_key) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','operation key ไม่ถูกต้อง');
  end if;
  if p_request_hash is null or length(p_request_hash) < 16 or length(p_request_hash) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','request hash ไม่ถูกต้อง');
  end if;
  if p_order_number is null or length(trim(p_order_number)) = 0 or length(p_order_number) > 100 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','เลขที่ออร์เดอร์ไม่ถูกต้อง');
  end if;

  -- ---------- 1) Serialize concurrent same-key (20 concurrent → executed 1) ----------
  perform pg_advisory_xact_lock(
    hashtextextended('unified_pos:' || p_store_id::text || ':' || p_operation_key, 0)
  );

  -- ---------- 2) Idempotency: เช็ค receipt ก่อนทำอะไร (ห้าม mutate ทั้งคู่) ----------
  select *
    into v_receipt
    from unified_pos_operation_receipts
    where store_id = p_store_id
      and operation_key = p_operation_key;

  if found then
    if v_receipt.request_hash = p_request_hash then
      -- replay: คืน result เดิม (result อาจเป็น null หลัง purge 30 วัน —
      -- tombstone ยังกัน execute ซ้ำเสมอ) โดยไม่ mutate อะไรเลย
      return jsonb_build_object('status','replayed','result', v_receipt.result);
    end if;
    -- key เดิมแต่ payload ต่าง → ห้าม execute เด็ดขาด
    return jsonb_build_object('status','hash_conflict');
  end if;

  -- ---------- 3) Store + flag ----------
  select is_active, qr_ordering_enabled, unified_pos_enabled,
         qr_ordering_mode, table_open_policy, dine_in_duration_minutes
    into v_store_is_active, v_store_qr_enabled, v_store_flag_enabled,
         v_mode, v_policy, v_minutes
    from stores
    where id = p_store_id
      and organization_id = p_organization_id;

  if not found then
    return jsonb_build_object('status','error','code','up_not_found','message','ร้านไม่พร้อมรับ QR order');
  end if;
  if not v_store_is_active or not v_store_qr_enabled then
    return jsonb_build_object('status','error','code','up_not_found','message','ร้านไม่พร้อมรับ QR order');
  end if;
  if not v_store_flag_enabled then
    return jsonb_build_object('status','error','code','up_store_flag_disabled','message','ระบบ Unified POS ยังปิดอยู่สำหรับร้านนี้');
  end if;

  -- ---------- 4) Lock table row → session ----------
  select number, session_started_at, session_expires_at
    into v_table_number, v_session_started_at, v_session_expires_at
    from tables
    where id = p_table_id
      and organization_id = p_organization_id
      and store_id = p_store_id
      and is_active = true
      and qr_enabled = true
    for update;

  if not found then
    return jsonb_build_object('status','error','code','up_not_found','message','โต๊ะไม่ถูกต้อง');
  end if;

  -- กฎเดิมของ repo (submitQrOrderAction + open_table_session_self):
  --   "ไม่จับเวลา" = session_started_at ถูกเซ็ตแต่ session_expires_at เป็น null → เปิดตลอด
  v_session_active :=
    (v_session_expires_at is not null and v_session_expires_at > v_now)
    or (v_session_started_at is not null and v_session_expires_at is null);

  if not v_session_active then
    -- auto-open ได้เฉพาะ table_bound + customer_self (กฎเดิม) — ทำใน transaction เดียวกัน
    -- เพื่อกัน TOCTOU ของ flow เดิม (เปิด session แยก แล้วค่อยสร้าง order)
    if v_mode = 'table_bound' and v_policy = 'customer_self' then
      update tables
         set status = 'occupied',
             session_started_at = v_now,
             session_expires_at = v_now + make_interval(mins => coalesce(v_minutes, 120)),
             updated_at = v_now
       where id = p_table_id and store_id = p_store_id;
    else
      return jsonb_build_object('status','error','code','up_session_not_active','message','หมดเวลาสั่งอาหารของโต๊ะนี้แล้ว กรุณาแจ้งพนักงาน');
    end if;
  end if;

  -- ---------- 5) Validate items (กฎเดิมของ v1) ----------
  v_error := public.unified_pos_validate_order_items(p_organization_id, p_store_id, p_items, p_subtotal, p_source);
  if v_error is not null then
    return v_error;
  end if;

  -- ---------- 6) Stock: ล็อกตามลำดับ variant_id (กัน deadlock) ----------
  --   qr    → หักตอนสร้าง (convention 20260607000006)
  --   staff → ตรวจเท่านั้น ไม่หัก (qr_order_source=false → close_pos_order_payment หักตอนชำระ
  --           การหักซ้ำที่นี่จะทำให้สต๊อกถูกตัดสองรอบ)
  for v_stock in
    select item.variant_id, sum(item.quantity)::integer as requested_quantity
    from jsonb_to_recordset(p_items) as item(
      product_id uuid,
      variant_id uuid,
      quantity integer
    )
    where item.variant_id is not null
    group by item.variant_id
    order by item.variant_id
  loop
    select pv.*
      into v_variant
      from product_variants pv
      join products on products.id = pv.product_id
      where pv.id = v_stock.variant_id
        and products.organization_id = p_organization_id
        and products.store_id = p_store_id
      for update;

    if not found then
      return jsonb_build_object('status','error','code','up_invalid_item','message','สินค้าไม่ถูกต้อง');
    end if;

    if v_variant.track_stock then
      if v_variant.stock_quantity is null or v_variant.stock_quantity < v_stock.requested_quantity then
        return jsonb_build_object('status','error','code','up_stock_insufficient','message','สินค้าเหลือไม่พอ');
      end if;

      if p_source = 'qr' then
        update product_variants
           set stock_quantity = stock_quantity - v_stock.requested_quantity
         where id = v_stock.variant_id;
      end if;
    end if;
  end loop;

  -- ---------- 7) System account (QR attribution เหมือน v1) ----------
  if p_source = 'qr' then
    insert into system_accounts (
      organization_id, store_id, kind, display_name
    )
    values (p_organization_id, p_store_id, 'qr_order', 'QR Ordering')
    on conflict (store_id, kind)
    do update set display_name = excluded.display_name
    returning id into v_system_account_id;
  end if;

  -- ---------- 8) Create order + items ----------
  insert into orders (
    organization_id,
    store_id,
    order_number,
    status,
    table_id,
    table_number,
    cashier_id,
    system_account_id,
    subtotal,
    discount,
    total,
    qr_order_source
  )
  values (
    p_organization_id,
    p_store_id,
    p_order_number,
    'open',
    p_table_id,
    v_table_number,
    case when p_source = 'staff' then p_actor_user_id else null end,
    case when p_source = 'qr' then v_system_account_id else null end,
    round(p_subtotal, 2),
    0,
    round(p_subtotal, 2),
    p_source = 'qr'
  )
  returning id into v_order_id;

  insert into order_items (
    order_id,
    product_id,
    product_name,
    variant_id,
    variant_name,
    modifiers,
    quantity,
    unit_price,
    total_price,
    note
  )
  select
    v_order_id,
    item.product_id,
    products.name,
    item.variant_id,
    product_variants.name,
    coalesce(item.modifiers, '[]'::jsonb),
    item.quantity,
    round(item.unit_price, 2),
    round(item.total_price, 2),
    item.note
  from jsonb_to_recordset(p_items) as item(
    product_id uuid,
    product_name text,
    variant_id uuid,
    variant_name text,
    modifiers jsonb,
    quantity integer,
    unit_price numeric,
    total_price numeric,
    note text
  )
  join products on products.id = item.product_id
  left join product_variants on product_variants.id = item.variant_id;

  -- ---------- 9) Receipt (idempotency tombstone — commit พร้อมทุกอย่างข้างบน) ----------
  v_result := jsonb_build_object(
    'order_id', v_order_id,
    'order_number', p_order_number,
    'table_id', p_table_id,
    'table_number', v_table_number,
    'subtotal', round(p_subtotal, 2),
    'revision', (select revision from orders where id = v_order_id)
  );

  begin
    insert into unified_pos_operation_receipts (
      organization_id,
      store_id,
      operation_type,
      operation_key,
      request_hash,
      result,
      targets,
      payload
    )
    values (
      p_organization_id,
      p_store_id,
      case when p_source = 'qr' then 'qr_submit' else 'add_items' end,
      p_operation_key,
      p_request_hash,
      v_result,
      jsonb_build_array(jsonb_build_object('type','order','id',v_order_id)),
      p_items
    );
  exception
    when unique_violation then
      -- เกิดได้ยากมาก (advisory lock กันไว้แล้ว) — ประมวลผลซ้ำแบบ replay เพื่อ atomicity
      select *
        into v_receipt
        from unified_pos_operation_receipts
        where store_id = p_store_id
          and operation_key = p_operation_key;
      if found and v_receipt.request_hash = p_request_hash then
        return jsonb_build_object('status','replayed','result', v_receipt.result);
      end if;
      return jsonb_build_object('status','hash_conflict');
  end;

  -- ---------- 10) Audit (convention ของ repo: audit_logs append-only) ----------
  insert into audit_logs (
    organization_id,
    store_id,
    actor_user_id,
    action,
    after,
    request_id
  )
  values (
    p_organization_id,
    p_store_id,
    -- QR path ไม่มี actor: attribute ไปที่ org owner (auth.users จริง — FK ของ
    -- audit_logs.actor_user_id ไม่รับ system_accounts.id; ดู after.source ว่าเป็น qr)
    coalesce(
      p_actor_user_id,
      (select o.owner_id from public.organizations o where o.id = p_organization_id)
    ),
    case when p_source = 'qr' then 'unified_pos.qr_submit' else 'unified_pos.staff_add_items' end,
    jsonb_build_object(
      'order_id', v_order_id,
      'order_number', p_order_number,
      'table_id', p_table_id,
      'source', p_source,
      'subtotal', round(p_subtotal, 2)
    ),
    p_operation_key
  );

  return jsonb_build_object('status','executed','result', v_result);
end;
$$;

-- ------------------------------------------------------------
-- (d) RPC wrappers (ตรงกับ UnifiedPosOperationOutcome ใน contracts)
--     คืน jsonb:
--       { status:'executed'|'replayed', result:{order_id,order_number,...} }
--       { status:'hash_conflict' }
--       { status:'error', code:'up_*', message:'...' }
-- ------------------------------------------------------------
create or replace function public.create_qr_order_with_items_v2(
  p_organization_id uuid,
  p_store_id uuid,
  p_table_id uuid,
  p_order_number text,
  p_operation_key text,
  p_request_hash text,
  p_subtotal numeric,
  p_items jsonb
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.unified_pos_submit_table_order(
    p_organization_id, p_store_id, p_table_id, p_order_number,
    p_operation_key, p_request_hash, p_subtotal, p_items, 'qr', null::uuid
  );
$$;

create or replace function public.add_items_to_table_v2(
  p_organization_id uuid,
  p_store_id uuid,
  p_table_id uuid,
  p_actor_user_id uuid,
  p_order_number text,
  p_operation_key text,
  p_request_hash text,
  p_subtotal numeric,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- สิทธิ์ pos.use ตรวจที่ชั้น RPC ด้วย (action ตรวจซ้ำอีกชั้นด้วย requirePermission)
  if not public.user_has_permission_in_store(p_actor_user_id, p_organization_id, p_store_id, 'pos.use') then
    return jsonb_build_object('status','error','code','up_forbidden','message','ไม่มีสิทธิ์เพิ่มรายการเข้าโต๊ะ');
  end if;

  return public.unified_pos_submit_table_order(
    p_organization_id, p_store_id, p_table_id, p_order_number,
    p_operation_key, p_request_hash, p_subtotal, p_items, 'staff', p_actor_user_id
  );
end;
$$;

-- ------------------------------------------------------------
-- (e) Grants — v2 สำหรับ service_role เท่านั้น (v1 เดิมไม่แตะ)
-- ------------------------------------------------------------
revoke execute on function public.unified_pos_validate_order_items(uuid, uuid, jsonb, numeric, text) from public;
revoke execute on function public.unified_pos_validate_order_items(uuid, uuid, jsonb, numeric, text) from anon;
revoke execute on function public.unified_pos_validate_order_items(uuid, uuid, jsonb, numeric, text) from authenticated;

revoke execute on function public.unified_pos_submit_table_order(uuid, uuid, uuid, text, text, text, numeric, jsonb, text, uuid) from public;
revoke execute on function public.unified_pos_submit_table_order(uuid, uuid, uuid, text, text, text, numeric, jsonb, text, uuid) from anon;
revoke execute on function public.unified_pos_submit_table_order(uuid, uuid, uuid, text, text, text, numeric, jsonb, text, uuid) from authenticated;
grant execute on function public.unified_pos_submit_table_order(uuid, uuid, uuid, text, text, text, numeric, jsonb, text, uuid) to service_role;

revoke execute on function public.create_qr_order_with_items_v2(uuid, uuid, uuid, text, text, text, numeric, jsonb) from public;
revoke execute on function public.create_qr_order_with_items_v2(uuid, uuid, uuid, text, text, text, numeric, jsonb) from anon;
revoke execute on function public.create_qr_order_with_items_v2(uuid, uuid, uuid, text, text, text, numeric, jsonb) from authenticated;
grant execute on function public.create_qr_order_with_items_v2(uuid, uuid, uuid, text, text, text, numeric, jsonb) to service_role;

revoke execute on function public.add_items_to_table_v2(uuid, uuid, uuid, uuid, text, text, text, numeric, jsonb) from public;
revoke execute on function public.add_items_to_table_v2(uuid, uuid, uuid, uuid, text, text, text, numeric, jsonb) from anon;
revoke execute on function public.add_items_to_table_v2(uuid, uuid, uuid, uuid, text, text, text, numeric, jsonb) from authenticated;
grant execute on function public.add_items_to_table_v2(uuid, uuid, uuid, uuid, text, text, text, numeric, jsonb) to service_role;

revoke execute on function public.user_has_permission_in_store(uuid, uuid, uuid, text) from public;
revoke execute on function public.user_has_permission_in_store(uuid, uuid, uuid, text) from anon;
grant execute on function public.user_has_permission_in_store(uuid, uuid, uuid, text) to authenticated, service_role;
