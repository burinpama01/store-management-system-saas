-- Stock Pool × Unified POS (v0.43.0)
-- 20260905000004 จงใจไม่นิยาม void_qr_order_item ทับ เพราะ 20260901000004 เขียนใหม่
-- เป็น wrapper ของ Unified POS ไปแล้ว migration นี้จึงเป็นที่รวม "ของจริงล่าสุด" ของ
-- ทุกฟังก์ชันฝั่ง Unified POS + Stock Pool:
--   submit  → ตรวจ Pool ก่อนเขียน, snapshot ทุกเส้นทาง, หักเฉพาะ qr
--   settle  → snapshot + ตรวจ + หัก Pool ของบิลพนักงาน (qr หักไปแล้วตอนสร้าง)
--   reject  → คืน Pool รายรายการ (และห้ามคืน variant ซ้ำ)
--   cancel  → คืน Pool ทั้งออเดอร์
--   void_qr_order_item → wrapper เดิม + คืน Pool ในเส้นทาง legacy
-- กติกาข้ามทั้งไฟล์: variant ที่ผูก Pool แล้ว "ห้าม" แตะ product_variants.stock_quantity
-- (Pool เป็นแหล่งความจริงเดียว) รายการที่ไม่ผูก Pool ใช้เส้นทางเดิมทุกอย่าง

-- ------------------------------------------------------------
-- (a) helper: ตรวจว่า Pool พอไหม — คืนชื่อ Pool ตัวแรกที่ไม่พอ (null = พอหมด)
--     ล็อก Pool ด้วย FOR UPDATE ตามลำดับ id เพื่อให้ deduct ที่ตามมาเห็นยอดเดียวกัน
--     และคงลำดับล็อกเดิม (Variant → Product → Pool) ของทั้ง repo
-- ------------------------------------------------------------
create or replace function public.unified_pos_items_stock_pool_shortfall(
  p_store_id uuid,
  p_organization_id uuid,
  p_items jsonb
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_demand record;
  v_pool public.stock_pools%rowtype;
begin
  for v_demand in
    select
      l.stock_pool_id,
      sum(item.quantity::numeric * l.consumption_quantity::numeric) as required_units
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as item(
      variant_id uuid,
      quantity integer
    )
    join public.variant_stock_links l on l.variant_id = item.variant_id
    where item.variant_id is not null
      and item.quantity > 0
    group by l.stock_pool_id
    order by l.stock_pool_id
  loop
    select sp.* into v_pool
    from public.stock_pools sp
    where sp.id = v_demand.stock_pool_id
    for update;

    if not found
      or v_pool.store_id is distinct from p_store_id
      or v_pool.organization_id is distinct from p_organization_id then
      raise exception 'Stock Pool ของรายการไม่ถูกต้อง';
    end if;

    if v_demand.required_units > 2147483647 then
      raise exception 'จำนวน Stock Pool ที่ต้องตัดเกินช่วงที่รองรับ';
    end if;

    if v_pool.quantity::bigint < v_demand.required_units then
      return v_pool.name;
    end if;
  end loop;

  return null;
end;
$fn$;

revoke all on function public.unified_pos_items_stock_pool_shortfall(uuid, uuid, jsonb) from public;
revoke execute on function public.unified_pos_items_stock_pool_shortfall(uuid, uuid, jsonb) from anon, authenticated;

-- ------------------------------------------------------------
-- (b) helper: ตรวจจาก order rows (ใช้ตอน settle — snapshot เขียนแล้ว)
-- ------------------------------------------------------------
create or replace function public.unified_pos_order_stock_pool_shortfall(
  p_order_id uuid
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_demand record;
  v_pool public.stock_pools%rowtype;
begin
  for v_demand in
    select
      oi.stock_pool_id,
      sum(
        oi.quantity::numeric
          * coalesce(oi.unit_quantity, 1)::numeric
          * oi.stock_units_per_item::numeric
      ) as required_units
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.stock_pool_id is not null
      and coalesce(oi.voided, false) = false
    group by oi.stock_pool_id
    order by oi.stock_pool_id
  loop
    select sp.* into v_pool
    from public.stock_pools sp
    where sp.id = v_demand.stock_pool_id
    for update;

    if not found then
      raise exception 'ไม่พบ Stock Pool ของออร์เดอร์';
    end if;
    if v_pool.quantity::bigint < v_demand.required_units then
      return v_pool.name;
    end if;
  end loop;

  return null;
end;
$fn$;

revoke all on function public.unified_pos_order_stock_pool_shortfall(uuid) from public;
revoke execute on function public.unified_pos_order_stock_pool_shortfall(uuid) from anon, authenticated;

-- ------------------------------------------------------------
-- (c) unified_pos_submit_table_order — ของเดิมจาก 20260901000002 + Stock Pool
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
  v_pool_short text;
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
      and not exists (
        select 1 from variant_stock_links l where l.variant_id = item.variant_id
      )
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

  -- ---------- 6b) Stock Pool: ตรวจให้พอก่อนเขียนอะไรลง DB ----------
  --   ตรวจจาก p_items โดยตรง (ยังไม่มี order rows) และล็อก Pool ไว้เลย เพื่อให้
  --   deduct หลัง insert ทำงานบนยอดเดียวกัน — คืน error แบบมีโครงสร้างเหมือน variant
  v_pool_short := public.unified_pos_items_stock_pool_shortfall(
    p_store_id, p_organization_id, p_items
  );
  if v_pool_short is not null then
    return jsonb_build_object(
      'status','error','code','up_stock_insufficient',
      'message', 'สต๊อก ' || v_pool_short || ' เหลือไม่พอ'
    );
  end if;

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

  -- ---------- 8b) Stock Pool: snapshot ทุกเส้นทาง, หักเฉพาะ qr ----------
  --   staff ไม่หักที่นี่ (จะหักตอน settle เหมือน variant stock) แต่ต้อง snapshot ไว้
  --   ตั้งแต่ตอนสร้าง เพื่อให้ยอดที่ตัดตอนชำระผูกกับ Pool/สูตรตัด ณ เวลาที่สั่ง
  perform public.snapshot_order_item_stock_pools(v_order_id, p_store_id, p_organization_id);
  if p_source = 'qr' then
    perform public.deduct_order_stock_pools(
      v_order_id, p_store_id, p_organization_id, p_actor_user_id
    );
  end if;

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
      -- [U8 review fix] backstop นี้ต้อง abort ทั้ง transaction เสมอ: writer ทุกตัวของ
      -- receipts ต้องถือ pg_advisory_xact_lock((store,key)) ก่อน จึงแทบไม่มีทางชนกัน
      -- แต่ถ้าเกิดจริง (writer ใหม่ลืม lock) mutation ที่ทำไว้ก่อน block นี้ต้อง rollback
      -- ทั้งหมด — การ return ปกติจะ commit mutation เหล่านั้นพร้อมตอบ replayed/conflict ลวง
      raise;
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
-- (d) unified_pos_cancel_table_order — ของเดิมจาก 20260901000003 + คืน Pool
-- ------------------------------------------------------------

create or replace function public.unified_pos_cancel_table_order(
  p_organization_id uuid,
  p_store_id uuid,
  p_table_id uuid,
  p_order_id uuid,
  p_operation_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_receipt public.unified_pos_operation_receipts%rowtype;
  v_result jsonb;
  v_prep text;
begin
  -- ---------- 0) envelope ----------
  if p_operation_key is null or length(p_operation_key) < 8 or length(p_operation_key) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','operation key ไม่ถูกต้อง');
  end if;
  if p_request_hash is null or length(p_request_hash) < 16 or length(p_request_hash) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','request hash ไม่ถูกต้อง');
  end if;

  -- ---------- 1) Serialize concurrent same-key ----------
  perform pg_advisory_xact_lock(
    hashtextextended('unified_pos:' || p_store_id::text || ':' || p_operation_key, 0)
  );

  -- ---------- 2) Idempotency: เช็ค receipt ก่อนทำอะไร ----------
  select *
    into v_receipt
    from public.unified_pos_operation_receipts
    where store_id = p_store_id
      and operation_key = p_operation_key;

  if found then
    if v_receipt.request_hash = p_request_hash then
      return jsonb_build_object('status','replayed','result', v_receipt.result);
    end if;
    return jsonb_build_object('status','hash_conflict');
  end if;

  -- ---------- 3) Lock order (scope org+store+table เหมือน legacy cancel) ----------
  select *
    into v_order
    from public.orders
    where id = p_order_id
      and organization_id = p_organization_id
      and store_id = p_store_id
      and table_id = p_table_id
    for update;

  if not found then
    return jsonb_build_object('status','error','code','up_not_found','message','ไม่พบออเดอร์');
  end if;

  -- ---------- 4) canCustomerCancelOrder (qr source guard ตาม contract note) ----------
  if not coalesce(v_order.qr_order_source, false) then
    return jsonb_build_object('status','error','code','up_cancel_not_allowed','message','ยกเลิกได้เฉพาะออเดอร์ที่สั่งผ่าน QR');
  end if;
  if v_order.status <> 'open' then
    return jsonb_build_object('status','error','code','up_cancel_not_allowed','message','ออเดอร์นี้ยกเลิกไม่ได้');
  end if;
  if v_order.paid_at is not null then
    return jsonb_build_object('status','error','code','up_cancel_not_allowed','message','ออเดอร์ชำระเงินแล้ว ยกเลิกไม่ได้');
  end if;

  if exists (
    select 1
      from public.order_items
     where order_id = p_order_id
       and voided = false
       and fulfillment_status <> 'new'
  ) then
    return jsonb_build_object('status','error','code','up_cancel_not_allowed','message','ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้');
  end if;
  if not exists (
    select 1
      from public.order_items
     where order_id = p_order_id
       and voided = false
  ) then
    return jsonb_build_object('status','error','code','up_cancel_not_allowed','message','ไม่มีรายการที่ยกเลิกได้');
  end if;

  -- ---------- 5) คืนสต๊อกเฉพาะ active items (voided ถูกคืนตอน void แล้ว) ----------
  update public.product_variants pv
     set stock_quantity = coalesce(pv.stock_quantity, 0) + oi.qty
  from (
    select variant_id, sum(quantity)::int as qty
      from public.order_items
     where order_id = p_order_id
       and voided = false
       and variant_id is not null
       and stock_pool_id is null
     group by variant_id
  ) oi
  where pv.id = oi.variant_id
    and pv.track_stock = true;

  -- คืนสต๊อกฝั่ง Stock Pool (รายการที่มี snapshot — variant stock ไม่ถูกแตะ)
  perform public.restore_cancelled_order_stock_pools(
    p_order_id, p_store_id, p_organization_id, null
  );

  -- ---------- 6) Cancel + prep derive (cancelled → done ตาม contract) ----------
  update public.orders
     set status = 'cancelled',
         updated_at = now()
   where id = p_order_id;

  v_prep := public.unified_pos_derive_order_prep_status(p_order_id);
  update public.orders
     set prep_status = v_prep
   where id = p_order_id
     and prep_status is distinct from v_prep;

  -- ---------- 7) Receipt ----------
  v_result := jsonb_build_object(
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'status', 'cancelled',
    'order_prep_status', v_prep
  );

  begin
    insert into public.unified_pos_operation_receipts (
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
      'customer_cancel',
      p_operation_key,
      p_request_hash,
      v_result,
      jsonb_build_array(jsonb_build_object('type','order','id',p_order_id)),
      jsonb_build_object('order_id', p_order_id, 'table_id', p_table_id)
    );
  exception
    when unique_violation then
      -- [U8 review fix] backstop นี้ต้อง abort ทั้ง transaction เสมอ: writer ทุกตัวของ
      -- receipts ต้องถือ pg_advisory_xact_lock((store,key)) ก่อน จึงแทบไม่มีทางชนกัน
      -- แต่ถ้าเกิดจริง (writer ใหม่ลืม lock) mutation ที่ทำไว้ก่อน block นี้ต้อง rollback
      -- ทั้งหมด — การ return ปกติจะ commit mutation เหล่านั้นพร้อมตอบ replayed/conflict ลวง
      raise;
  end;

  -- ---------- 8) Audit (customer ไม่มี user id — attribute ไปที่ org owner เหมือน U4 QR path) ----------
  insert into public.audit_logs (
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
    (select o.owner_id from public.organizations o where o.id = p_organization_id),
    'unified_pos.customer_cancel',
    jsonb_build_object(
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'table_id', p_table_id,
      'source', 'customer',
      'order_prep_status', v_prep
    ),
    p_operation_key
  );

  return jsonb_build_object('status','executed','result', v_result);
end;
$$;

-- ------------------------------------------------------------
-- (e) unified_pos_reject_order_item — ของเดิมจาก 20260901000004 + คืน Pool
-- ------------------------------------------------------------

create or replace function public.unified_pos_reject_order_item(
  p_organization_id uuid,
  p_store_id uuid,
  p_order_id uuid,
  p_item_id uuid,
  p_operation_key text,
  p_request_hash text,
  p_actor_user_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_receipt public.unified_pos_operation_receipts%rowtype;
  v_result jsonb;
  v_reason text;
  v_subtotal numeric;
  v_discount numeric;
  v_total numeric;
  v_version bigint;
  v_revision bigint;
  v_prep text;
  v_status text;
  v_active_count integer;
  v_stock_rows integer := 0;
  v_stock_quantity integer := 0;
  v_pool_managed boolean := false;
begin
  -- ---------- 0) envelope + actor ----------
  if p_operation_key is null or length(p_operation_key) < 8 or length(p_operation_key) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','operation key ไม่ถูกต้อง');
  end if;
  if p_request_hash is null or length(p_request_hash) < 16 or length(p_request_hash) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','request hash ไม่ถูกต้อง');
  end if;
  if p_actor_user_id is null then
    return jsonb_build_object('status','error','code','up_forbidden','message','ไม่มีสิทธิ์ยกเลิกรายการ');
  end if;
  v_reason := nullif(left(btrim(coalesce(p_reason, '')), 200), '');

  -- ---------- 1) Serialize concurrent same-key ----------
  perform pg_advisory_xact_lock(
    hashtextextended('unified_pos:' || p_store_id::text || ':' || p_operation_key, 0)
  );

  -- ---------- 2) Idempotency: เช็ค receipt ก่อนทำอะไร (ห้าม mutate ทั้งคู่) ----------
  select *
    into v_receipt
    from public.unified_pos_operation_receipts
   where store_id = p_store_id
     and operation_key = p_operation_key;

  if found then
    if v_receipt.request_hash = p_request_hash then
      -- replay: คืน result เดิมโดยไม่ mutate อะไรเลย (result อาจเป็น null
      -- หลัง purge 30 วัน — tombstone ยังกัน execute ซ้ำเสมอ)
      return jsonb_build_object('status','replayed','result', v_receipt.result);
    end if;
    -- key เดิมแต่ payload ต่าง → ห้าม execute เด็ดขาด
    return jsonb_build_object('status','hash_conflict');
  end if;

  -- ---------- 3) Store + flag (fail closed) ----------
  if not exists (
    select 1
      from public.stores
     where id = p_store_id
       and organization_id = p_organization_id
       and unified_pos_enabled = true
  ) then
    if exists (
      select 1
        from public.stores
       where id = p_store_id
         and organization_id = p_organization_id
    ) then
      return jsonb_build_object('status','error','code','up_store_flag_disabled','message','ระบบ Unified POS ยังปิดอยู่สำหรับร้านนี้');
    end if;
    return jsonb_build_object('status','error','code','up_not_found','message','ไม่พบร้าน');
  end if;

  -- ---------- 4) Permission (ชุดเดียวกับ action voidQrOrderItemAction / U5) ----------
  if not public.user_has_permission_in_store(p_actor_user_id, p_organization_id, p_store_id, 'orders.manage_qr') then
    return jsonb_build_object('status','error','code','up_forbidden','message','ไม่มีสิทธิ์ยกเลิกรายการออเดอร์');
  end if;

  -- ---------- 5) Lock order (scope org+store — ข้ามร้าน = not_found) ----------
  select *
    into v_order
    from public.orders
   where id = p_order_id
     and organization_id = p_organization_id
     and store_id = p_store_id
   for update;

  if not found then
    return jsonb_build_object('status','error','code','up_not_found','message','ไม่พบออเดอร์');
  end if;

  -- ---------- 6) Guard: order ต้อง open + ยังไม่จ่าย (paid/closed reject ไม่ได้) ----------
  if v_order.status <> 'open' or v_order.paid_at is not null then
    return jsonb_build_object('status','error','code','up_invalid_state_transition','message','ออเดอร์ชำระเงินหรือปิดแล้ว ยกเลิกรายการไม่ได้');
  end if;

  -- ---------- 7) Lock item (ใต้ row lock เดียวกับ voided guard → กัน restore ซ้ำ) ----------
  select *
    into v_item
    from public.order_items
   where id = p_item_id
     and order_id = p_order_id
   for update;

  if not found then
    return jsonb_build_object('status','error','code','up_invalid_item','message','รายการไม่อยู่ในออเดอร์นี้');
  end if;

  -- ---------- 8) Voided guard (canonical void — voided ชนะเสมอ) ----------
  if v_item.voided then
    return jsonb_build_object('status','error','code','up_invalid_item','message','รายการนี้ถูกยกเลิกไปแล้ว');
  end if;

  -- ---------- 9) คืนสต๊อก "ครั้งเดียว" เฉพาะ tracked variant ของร้านนี้ ----------
  --   (untracked / ไม่มี variant / variant ของร้านอื่น = ข้าม — เหมือน convention
  --    หักสต๊อกของ submit RPC; item row ถูก FOR UPDATE ล็อคและ voided=false
  --    จึงเข้า branch นี้ได้ครั้งเดียวตลอดชีวิตของ item)
  -- Stock Pool มาก่อน: ถ้ารายการนี้ผูก Pool ห้ามคืน Variant stock (จะคืนซ้ำ)
  v_pool_managed := public.restore_voided_order_item_stock_pool(
    p_order_id, p_item_id, p_store_id, p_organization_id, p_reason, p_actor_user_id
  );

  if v_item.variant_id is not null and not v_pool_managed then
    update public.product_variants pv
       set stock_quantity = coalesce(pv.stock_quantity, 0) + v_item.quantity
      from public.products p
     where pv.id = v_item.variant_id
       and p.id = pv.product_id
       and p.organization_id = p_organization_id
       and p.store_id = p_store_id
       and pv.track_stock = true;
    get diagnostics v_stock_rows = row_count;
    v_stock_quantity := case when v_stock_rows > 0 then v_item.quantity else 0 end;
  end if;

  -- ---------- 10) Void (canonical — boolean เท่านั้น ไม่แตะ fulfillment_status) ----------
  update public.order_items
     set voided = true,
         voided_reason = v_reason
   where id = p_item_id
   returning fulfillment_version into v_version;

  -- ---------- 11) Recalc totals (แหล่งเดียวกับ submit: sum(active.total_price)) ----------
  select round(coalesce(sum(total_price), 0), 2)
    into v_subtotal
    from public.order_items
   where order_id = p_order_id
     and voided = false;

  v_discount := coalesce(v_order.discount, 0);

  -- ไม่เหลือ active item → ปิดออเดอร์เป็น 'cancelled' (legacy parity ของ void เดิม)
  select count(*)
    into v_active_count
    from public.order_items
   where order_id = p_order_id
     and voided = false;

  v_status := case when v_active_count = 0 then 'cancelled' else v_order.status end;

  update public.orders
     set subtotal = v_subtotal,
         total = greatest(round(v_subtotal - v_discount, 2), 0),
         status = v_status,
         updated_at = now()
   where id = p_order_id
   returning revision, total into v_revision, v_total;

  v_prep := public.unified_pos_derive_order_prep_status(p_order_id);

  -- ---------- 12) Receipt (idempotency tombstone — commit พร้อมทุกอย่างข้างบน) ----------
  v_result := jsonb_build_object(
    'order_id', p_order_id,
    'item_id', p_item_id,
    'voided', true,
    'order_status', v_status,
    'order_prep_status', v_prep,
    'order_revision', v_revision,
    'subtotal', v_subtotal,
    'discount', v_discount,
    'total', v_total,
    'stock_restored_quantity', v_stock_quantity
  );

  begin
    insert into public.unified_pos_operation_receipts (
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
      'item_reject',
      p_operation_key,
      p_request_hash,
      v_result,
      jsonb_build_array(
        jsonb_build_object('type','order','id',p_order_id),
        jsonb_build_object('type','order_item','id',p_item_id)
      ),
      jsonb_build_object(
        'order_id', p_order_id,
        'item_id', p_item_id,
        'reason', v_reason,
        'actor_user_id', p_actor_user_id
      )
    );
  exception
    when unique_violation then
      -- [U8 review fix] backstop นี้ต้อง abort ทั้ง transaction เสมอ: writer ทุกตัวของ
      -- receipts ต้องถือ pg_advisory_xact_lock((store,key)) ก่อน จึงแทบไม่มีทางชนกัน
      -- แต่ถ้าเกิดจริง (writer ใหม่ลืม lock) mutation ที่ทำไว้ก่อน block นี้ต้อง rollback
      -- ทั้งหมด — การ return ปกติจะ commit mutation เหล่านั้นพร้อมตอบ replayed/conflict ลวง
      raise;
  end;

  -- ---------- 13) Audit ----------
  insert into public.audit_logs (
    organization_id,
    store_id,
    actor_user_id,
    action,
    before,
    after,
    request_id
  )
  values (
    p_organization_id,
    p_store_id,
    p_actor_user_id,
    'unified_pos.item_reject',
    jsonb_build_object(
      'order_id', p_order_id,
      'item_id', p_item_id,
      'voided', false,
      'fulfillment_status', v_item.fulfillment_status,
      'order_status', v_order.status,
      'subtotal', v_order.subtotal,
      'total', v_order.total
    ),
    jsonb_build_object(
      'order_id', p_order_id,
      'item_id', p_item_id,
      'voided', true,
      'voided_reason', v_reason,
      'fulfillment_status', v_item.fulfillment_status,
      'fulfillment_version', v_version,
      'order_status', v_status,
      'order_prep_status', v_prep,
      'subtotal', v_subtotal,
      'total', v_total,
      'stock_restored_quantity', v_stock_quantity
    ),
    p_operation_key
  );

  return jsonb_build_object('status','executed','result', v_result);
end;
$$;

-- ------------------------------------------------------------
-- (f) void_qr_order_item — wrapper เดิมจาก 20260901000004 + คืน Pool (legacy path)
-- ------------------------------------------------------------

create or replace function public.void_qr_order_item(
  p_store_id uuid,
  p_order_id uuid,
  p_item_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_flag boolean;
  v_status text;
  v_qr boolean;
  v_variant uuid;
  v_qty integer;
  v_remaining integer;
  v_subtotal numeric;
  v_outcome jsonb;
  v_operation_key text;
  v_pool_managed boolean := false;
  v_request_hash text;
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  -- gating: อ่าน flag ของร้านก่อนเลือกเส้นทาง
  select organization_id, coalesce(unified_pos_enabled, false)
    into v_org, v_flag
    from stores
   where id = p_store_id;
  if not found then
    raise exception 'ไม่พบออเดอร์';
  end if;

  -- ---------- เส้นทาง canonical (ร้านเปิด unified_pos_enabled) ----------
  if v_flag then
    v_operation_key := 'legacy_void:' || p_item_id::text;
    v_request_hash := md5(
      'void_item:' || p_store_id::text || ':' || p_order_id::text || ':' ||
      p_item_id::text || ':' || coalesce(p_reason, '') || ':' || v_actor::text
    );
    v_outcome := public.unified_pos_reject_order_item(
      v_org, p_store_id, p_order_id, p_item_id,
      v_operation_key, v_request_hash, v_actor, p_reason
    );
    case v_outcome ->> 'status'
      when 'executed' then
        return;
      when 'replayed' then
        -- retry ของคำขอ void เดิม (same key + same hash) → ถือว่าสำเร็จแบบ idempotent
        return;
      when 'hash_conflict' then
        raise exception 'คำขอยกเลิกรายการขัดแย้งกัน กรุณารีเฟรชหน้าจอ';
      else
        raise exception '%', coalesce(v_outcome ->> 'message', 'ยกเลิกรายการไม่สำเร็จ');
    end case;
  end if;

  -- ---------- เส้นทาง legacy (ร้านปิด flag — body เดิมจาก 20260701000002) ----------
  select organization_id, status, qr_order_source
    into v_org, v_status, v_qr
    from orders
   where id = p_order_id and store_id = p_store_id
   for update;
  if not found then
    raise exception 'ไม่พบออเดอร์';
  end if;
  if not auth_user_role_in_store(v_org, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์จัดการออเดอร์';
  end if;
  if not coalesce(v_qr, false) then
    raise exception 'เฉพาะออเดอร์ที่สั่งผ่าน QR';
  end if;
  if v_status <> 'open' then
    raise exception 'ออเดอร์นี้แก้ไขไม่ได้';
  end if;

  select variant_id, quantity
    into v_variant, v_qty
    from order_items
   where id = p_item_id and order_id = p_order_id and voided = false;
  if not found then
    raise exception 'ไม่พบรายการ';
  end if;

  -- Stock Pool มาก่อน: รายการที่ผูก Pool ห้ามคืน Variant stock (จะคืนซ้ำ)
  v_pool_managed := public.restore_voided_order_item_stock_pool(
    p_order_id, p_item_id, p_store_id, v_org, p_reason, v_actor
  );

  -- Restore the stock deducted at order creation.
  if v_variant is not null and not v_pool_managed then
    update product_variants
       set stock_quantity = coalesce(stock_quantity, 0) + v_qty
     where id = v_variant and track_stock = true;
  end if;

  update order_items
     set voided = true, voided_reason = p_reason
   where id = p_item_id;

  -- Recompute order totals from the remaining (non-voided) lines.
  select count(*), coalesce(sum(total_price), 0)
    into v_remaining, v_subtotal
    from order_items
   where order_id = p_order_id and voided = false;

  update orders
     set subtotal = round(v_subtotal, 2),
         total = round(v_subtotal, 2),
         updated_at = now()
   where id = p_order_id;

  -- Nothing left to make — cancel the whole order.
  if v_remaining = 0 then
    update orders set status = 'cancelled', updated_at = now() where id = p_order_id;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- (g) unified_pos_settle_table_order — ของเดิมจาก 20260901000005 + หัก Pool
-- ------------------------------------------------------------

create or replace function public.unified_pos_settle_table_order(
  p_organization_id uuid,
  p_store_id uuid,
  p_table_id uuid,
  p_mode text,
  p_order_ids jsonb,
  p_expected_revisions jsonb,
  p_operation_key text,
  p_request_hash text,
  p_actor_user_id uuid,
  p_method text,
  p_amount numeric,
  p_received_amount numeric default null,
  p_change_amount numeric default null,
  p_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table public.tables%rowtype;
  v_order public.orders%rowtype;
  v_receipt public.unified_pos_operation_receipts%rowtype;
  v_result jsonb;
  v_result_payments jsonb := '[]'::jsonb;
  v_result_orders jsonb := '[]'::jsonb;
  v_elem jsonb;
  v_elem_text text;
  v_uuid_pattern text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_number_pattern text := '^-?[0-9]+$';
  v_order_ids uuid[] := '{}';
  v_order_count integer := 0;
  v_requested_count integer := 0;
  v_map_count integer := 0;
  v_bad_values integer := 0;
  v_expected_revision bigint;
  v_new_revision bigint;
  v_grand_total numeric := 0;
  v_now timestamptz := now();
  v_cash boolean := false;
  v_received numeric;
  v_change numeric;
  v_pay_received numeric;
  v_pay_change numeric;
  v_payment_id uuid;
  v_category accounting_categories%rowtype;
  v_transaction_id uuid;
  v_previous_balance numeric := 0;
  v_stock record;
  v_pool_short text;
  v_variant product_variants%rowtype;
  v_loyalty_settings loyalty_settings%rowtype;
  v_points_per_currency numeric := 0;
  v_points numeric := 0;
  v_account loyalty_accounts%rowtype;
  v_ledger_id uuid;
  v_reward_key text;
  v_session_closed boolean := false;
begin
  -- ---------- 0) envelope ----------
  if p_operation_key is null or length(p_operation_key) < 8 or length(p_operation_key) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','operation key ไม่ถูกต้อง');
  end if;
  if p_request_hash is null or length(p_request_hash) < 16 or length(p_request_hash) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','request hash ไม่ถูกต้อง');
  end if;
  if p_mode not in ('partial', 'whole_table') then
    return jsonb_build_object('status','error','code','up_invalid_item','message','โหมดการชำระไม่ถูกต้อง');
  end if;
  if p_method not in ('cash','qr_promptpay','credit_card','bank_transfer','other') then
    return jsonb_build_object('status','error','code','up_invalid_payment','message','วิธีชำระไม่ถูกต้อง');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('status','error','code','up_invalid_payment','message','ยอดชำระไม่ถูกต้อง');
  end if;
  if p_actor_user_id is null then
    return jsonb_build_object('status','error','code','up_forbidden','message','ไม่มีสิทธิ์ชำระเงิน');
  end if;
  if p_mode = 'whole_table' and p_table_id is null then
    return jsonb_build_object('status','error','code','up_invalid_item','message','ต้องระบุโต๊ะสำหรับการชำระทั้งโต๊ะ');
  end if;
  if p_mode = 'partial' then
    if p_order_ids is null or jsonb_typeof(p_order_ids) is distinct from 'array' or jsonb_array_length(p_order_ids) = 0 then
      return jsonb_build_object('status','error','code','up_invalid_item','message','ไม่มีออเดอร์ที่จะชำระ');
    end if;
    for v_elem in select e from jsonb_array_elements(p_order_ids) as e loop
      v_elem_text := case when jsonb_typeof(v_elem) = 'string' then v_elem #>> '{}' else null end;
      if v_elem_text is null or v_elem_text !~ v_uuid_pattern then
        return jsonb_build_object('status','error','code','up_invalid_item','message','รายการออเดอร์ไม่ถูกต้อง');
      end if;
    end loop;
    v_requested_count := jsonb_array_length(p_order_ids);
    select count(distinct (e #>> '{}')::uuid)
      into v_order_count
      from jsonb_array_elements(p_order_ids) as e;
    if v_order_count is distinct from v_requested_count then
      return jsonb_build_object('status','error','code','up_invalid_item','message','รายการออเดอร์ซ้ำกัน');
    end if;
  end if;
  if p_expected_revisions is null or jsonb_typeof(p_expected_revisions) is distinct from 'object' then
    return jsonb_build_object('status','error','code','up_invalid_item','message','expected revisions ไม่ถูกต้อง');
  end if;
  select count(*)
    into v_bad_values
    from jsonb_object_keys(p_expected_revisions) as k
   where coalesce(p_expected_revisions ->> k, '') !~ v_number_pattern;
  if v_bad_values > 0 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','expected revisions ไม่ถูกต้อง');
  end if;
  v_cash := p_method = 'cash';

  -- ---------- 1) Serialize concurrent same-key ----------
  perform pg_advisory_xact_lock(
    hashtextextended('unified_pos:' || p_store_id::text || ':' || p_operation_key, 0)
  );

  -- ---------- 2) Idempotency: receipt ก่อน mutate ใดๆ ----------
  select *
    into v_receipt
    from public.unified_pos_operation_receipts
   where store_id = p_store_id
     and operation_key = p_operation_key;

  if found then
    if v_receipt.request_hash = p_request_hash then
      -- replay: คืนผลเดิม (is_financial → purge เก็บ result ไว้ จึง replay ได้แม้เกิน 30 วัน;
      -- result null ได้เฉพาะ receipt เก่าก่อน flag นี้ — tombstone ยังกันชำระซ้ำเสมอ)
      return jsonb_build_object('status','replayed','result', v_receipt.result);
    end if;
    return jsonb_build_object('status','hash_conflict');
  end if;

  -- ---------- 3) Store + flag (fail closed) ----------
  if not exists (
    select 1
      from public.stores
     where id = p_store_id
       and organization_id = p_organization_id
       and unified_pos_enabled = true
  ) then
    if exists (
      select 1
        from public.stores
       where id = p_store_id
         and organization_id = p_organization_id
    ) then
      return jsonb_build_object('status','error','code','up_store_flag_disabled','message','ระบบ Unified POS ยังปิดอยู่สำหรับร้านนี้');
    end if;
    return jsonb_build_object('status','error','code','up_not_found','message','ไม่พบร้าน');
  end if;

  -- ---------- 4) Permission (ชุดเดียวกับชั้น action ของ payment เดิม) ----------
  if not public.user_has_permission_in_store(p_actor_user_id, p_organization_id, p_store_id, 'pos.use') then
    return jsonb_build_object('status','error','code','up_forbidden','message','ไม่มีสิทธิ์ชำระเงินออเดอร์');
  end if;

  -- ---------- 5) Lock table (เมื่อระบุ) — serialize การปิดโต๊ะ/ชำระทั้งโต๊ะ ----------
  if p_table_id is not null then
    select *
      into v_table
      from public.tables
     where id = p_table_id
       and organization_id = p_organization_id
       and store_id = p_store_id
     for update;

    if not found then
      return jsonb_build_object('status','error','code','up_not_found','message','ไม่พบโต๊ะ');
    end if;
  end if;

  -- ---------- 6) Derive + lock order set FOR UPDATE ----------
  if p_mode = 'whole_table' then
    for v_order in
      select *
        from public.orders
       where organization_id = p_organization_id
         and store_id = p_store_id
         and table_id = p_table_id
         and status = 'open'
         and paid_at is null
       order by created_at, id
       for update
    loop
      v_order_ids := v_order_ids || v_order.id;
      v_grand_total := v_grand_total + v_order.total;
    end loop;
    v_order_count := coalesce(array_length(v_order_ids, 1), 0);
    if v_order_count = 0 then
      return jsonb_build_object('status','error','code','up_not_found','message','โต๊ะนี้ไม่มีบิลที่เปิดอยู่');
    end if;
  else
    for v_order in
      select *
        from public.orders
       where organization_id = p_organization_id
         and store_id = p_store_id
         and id = any (select (e #>> '{}')::uuid from jsonb_array_elements(p_order_ids) as e)
       order by created_at, id
       for update
    loop
      -- partial ที่ระบุโต๊ะ: ออเดอร์ต้องผูกกับโต๊ะนั้นจริง (ข้ามร้าน/ข้ามโต๊ะ = not found)
      if p_table_id is not null and v_order.table_id is distinct from p_table_id then
        return jsonb_build_object('status','error','code','up_not_found','message','ไม่พบออเดอร์ในโต๊ะนี้');
      end if;
      v_order_ids := v_order_ids || v_order.id;
      v_grand_total := v_grand_total + v_order.total;
    end loop;
    v_order_count := coalesce(array_length(v_order_ids, 1), 0);
    if v_order_count is distinct from v_requested_count then
      return jsonb_build_object('status','error','code','up_not_found','message','ไม่พบออเดอร์');
    end if;
  end if;

  -- ---------- 7) Guards + expected revision (ห้ามชำระบิลที่จ่าย/ปิดไปแล้ว) ----------
  foreach v_elem_text in array v_order_ids loop
    select * into v_order from public.orders where id = v_elem_text::uuid;
    if v_order.status not in ('open','pending_payment') or v_order.paid_at is not null then
      return jsonb_build_object('status','error','code','up_invalid_state_transition','message','ออเดอร์ชำระเงินหรือปิดแล้ว');
    end if;
    if v_order.total is null or v_order.total <= 0 then
      return jsonb_build_object('status','error','code','up_invalid_payment','message','ยอดออเดอร์ไม่ถูกต้อง');
    end if;
    v_expected_revision := nullif(btrim(coalesce(p_expected_revisions ->> v_elem_text, '')), '');
    if v_expected_revision is null or v_expected_revision <> v_order.revision then
      return jsonb_build_object('status','error','code','up_stale_version','message','ข้อมูลบิลเปลี่ยนไปแล้ว กรุณารีเฟรชหน้าจอ');
    end if;
  end loop;
  -- map ต้องครบพอดีชุดที่จะชำระ (เหลือ key เกิน = ชุดบิลเปลี่ยนระหว่างอ่านกับส่ง)
  select count(*)
    into v_map_count
    from jsonb_object_keys(p_expected_revisions) as k;
  if v_map_count is distinct from v_order_count then
    return jsonb_build_object('status','error','code','up_stale_version','message','ข้อมูลบิลเปลี่ยนไปแล้ว กรุณารีเฟรชหน้าจอ');
  end if;

  -- ---------- 8) ยอดรวมฝั่ง server (ห้ามเชื่อ client) + cash math ----------
  if round(p_amount, 2) is distinct from round(v_grand_total, 2) then
    return jsonb_build_object('status','error','code','up_invalid_payment','message','ยอดชำระไม่ตรงกับยอดออเดอร์');
  end if;

  v_received := coalesce(p_received_amount, p_amount);
  v_change := coalesce(p_change_amount, 0);
  if v_cash then
    if v_received < p_amount then
      return jsonb_build_object('status','error','code','up_invalid_payment','message','เงินสดที่รับไม่พอ');
    end if;
    if v_change < 0 then
      return jsonb_build_object('status','error','code','up_invalid_payment','message','เงินทอนไม่ถูกต้อง');
    end if;
    if v_received - v_change is distinct from p_amount then
      return jsonb_build_object('status','error','code','up_invalid_payment','message','ยอดเงินสดไม่ตรงกับยอดขาย');
    end if;

    -- mirror close_pos_order_payment (20260623000001): เงินสดต้องมีสิทธิ์
    -- cashflow.record + รอบเงินสดเปิดอยู่ (ล็อคแถว session) และต้องล็อค
    -- ledger ของร้าน "ก่อน" ล็อค variant (ลำดับเดียวกับ legacy: order rows →
    -- advisory(0) → session row → variants) เพื่อไม่สลับกับ close_pos_order_payment เดิม
    if not public.user_has_permission_in_store(p_actor_user_id, p_organization_id, p_store_id, 'cashflow.record') then
      return jsonb_build_object('status','error','code','up_forbidden','message','ไม่มีสิทธิ์รับเงินสด');
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 0));
    if not exists (
      select 1
        from public.cash_sessions
       where organization_id = p_organization_id
         and store_id = p_store_id
         and status = 'open'
       order by opened_at desc
       limit 1
         for update
    ) then
      return jsonb_build_object('status','error','code','up_invalid_payment','message','ต้องเปิดรอบเงินสดก่อนรับเงินสด');
    end if;
    select balance_after
      into v_previous_balance
      from public.cash_ledger_entries
     where store_id = p_store_id
     order by created_at desc
     limit 1;
    v_previous_balance := coalesce(v_previous_balance, 0);
  end if;

  -- ---------- 9) ประมวลผลต่อบิล (ล็อคครบแล้ว — failure ใดๆ rollback ทั้งก้อน) ----------
  foreach v_elem_text in array v_order_ids loop
    select * into v_order from public.orders where id = v_elem_text::uuid;

    -- หักสต๊อกเฉพาะออเดอร์พนักงาน (QR หักตอนสร้างแล้ว — convention 20260607000006);
    -- กรอง voided=false เพราะ U6 คืนสต๊อกให้รายการที่ถูก reject ไปแล้ว;
    -- คูณ unit_quantity ตาม wholesale (20260703000000) — แพ็ค 1 แถวใช้ Pool 3 หน่วย
    if not v_order.qr_order_source then
      for v_stock in
        select item.variant_id,
               sum(item.quantity * coalesce(item.unit_quantity, 1))::integer as requested_quantity
          from public.order_items item
         where item.order_id = v_order.id
           and item.variant_id is not null
           and item.voided = false
           and item.stock_pool_id is null
         group by item.variant_id
         order by item.variant_id
      loop
        select pv.*
          into v_variant
          from public.product_variants pv
          join public.products p on p.id = pv.product_id
         where pv.id = v_stock.variant_id
           and p.organization_id = p_organization_id
           and p.store_id = p_store_id
         for update;

        if not found then
          return jsonb_build_object('status','error','code','up_invalid_item','message','สินค้าไม่ถูกต้อง');
        end if;

        if v_variant.track_stock then
          if v_variant.stock_quantity is null or v_variant.stock_quantity < v_stock.requested_quantity then
            return jsonb_build_object('status','error','code','up_stock_insufficient','message','สินค้าเหลือไม่พอ');
          end if;
          update public.product_variants
             set stock_quantity = stock_quantity - v_stock.requested_quantity
           where id = v_stock.variant_id;
        end if;
      end loop;

      -- Stock Pool ของบิลพนักงาน: snapshot (บิลเก่าที่เปิดค้างก่อน feature นี้ยังไม่มี)
      -- แล้วตรวจให้พอก่อนหัก — เส้นทางเดียวกับ variant stock ด้านบนทุกประการ
      perform public.snapshot_order_item_stock_pools(v_order.id, p_store_id, p_organization_id);
      v_pool_short := public.unified_pos_order_stock_pool_shortfall(v_order.id);
      if v_pool_short is not null then
        return jsonb_build_object(
          'status','error','code','up_stock_insufficient',
          'message', 'สต๊อก ' || v_pool_short || ' เหลือไม่พอ'
        );
      end if;
      perform public.deduct_order_stock_pools(
        v_order.id, p_store_id, p_organization_id, p_actor_user_id
      );
    end if;

    -- close order: paid + paid_at + prep 'done' (U1 derive กฎ 1 — terminal → done)
    update public.orders
       set status = 'paid',
           paid_at = v_now,
           prep_status = 'done',
           updated_at = v_now
     where id = v_order.id
     returning revision into v_new_revision;

    -- payment row: amount มาจาก orders.total เสมอ (ห้ามใช้ยอด client)
    v_pay_received := case when v_order_count = 1 then v_received else v_order.total end;
    v_pay_change := case when v_order_count = 1 then v_change else 0 end;

    insert into public.payments (
      order_id, method, amount, status,
      received_amount, change_amount, reference, processed_by_user_id
    )
    values (
      v_order.id, p_method, v_order.total, 'completed',
      v_pay_received, v_pay_change, p_reference, p_actor_user_id
    )
    returning id into v_payment_id;

    -- accounting income (mirror close_pos_order_payment: advisory(2) serialize การ
    -- autocreate หมวด ตำแหน่งหลังล็อค variant เหมือน legacy; ถ้าไม่มีหมวดต้องสร้าง
    -- 'ยอดขาย POS' ให้เอง (20260623124138) — ห้ามข้ามรายรับเงียบ ๆ)
    perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 2));
    select *
      into v_category
      from public.accounting_categories
     where store_id = p_store_id
       and type = 'income'
       and (name = 'ยอดขาย POS' or is_default = true)
     order by
       case
         when name = 'ยอดขาย POS' then 0
         when is_default = true then 1
         else 2
       end,
       sort_order,
       name
     limit 1;

    if not found then
      insert into public.accounting_categories (
        organization_id, store_id, name, type, is_default, sort_order
      )
      values (
        v_order.organization_id, p_store_id, 'ยอดขาย POS', 'income', true, 0
      )
      returning * into v_category;
    end if;

    insert into public.transactions (
      organization_id, store_id, type, category_id, category_name,
      amount, note, date, created_by_user_id, order_id
    )
    values (
      v_order.organization_id, p_store_id, 'income', v_category.id, v_category.name,
      v_order.total, 'POS ' || v_order.id::text, (v_now at time zone 'UTC')::date,
      p_actor_user_id, v_order.id
    )
    returning id into v_transaction_id;

    -- cash ledger ต่อเนื่องต่อบิล (advisory(0) + snapshot ยอดทำแล้วใน section 8
    -- ก่อนล็อค variant — ลำดับเดียวกับ legacy ที่เก็บทีละใบ)
    if v_cash then
      v_previous_balance := v_previous_balance + v_order.total;
      insert into public.cash_ledger_entries (
        organization_id, store_id, type, amount, balance_after,
        transaction_id, order_id, created_by_user_id
      )
      values (
        v_order.organization_id, p_store_id, 'pos_sale', v_order.total, v_previous_balance,
        v_transaction_id, v_order.id, p_actor_user_id
      );
    end if;

    -- loyalty rewards (exactly-once) — mirror close_grocery_pos_order_payment_with_rewards
    v_points := 0;
    v_ledger_id := null;
    if v_order.customer_id is not null then
      select *
        into v_loyalty_settings
        from public.loyalty_settings
       where organization_id = v_order.organization_id
         and store_id = p_store_id;

      v_points_per_currency := case
        when found and v_loyalty_settings.earn_enabled is true then v_loyalty_settings.points_per_currency
        when found then 0
        else 0.0100
      end;

      -- mirror legacy (20260626140000): round(x, 2) ทศนิยม 2 ตำแหน่ง — คอลัมน์
      -- points_delta เป็น numeric(12,2) legacy โพสต์แต้มทศนิยมได้ ห้าม floor/ปัด integer
      v_points := round(v_order.total * v_points_per_currency, 2);
      if v_points > 0 then
        insert into public.loyalty_accounts (
          organization_id, store_id, customer_id
        )
        values (
          v_order.organization_id, p_store_id, v_order.customer_id
        )
        on conflict (store_id, customer_id) do update
          set updated_at = loyalty_accounts.updated_at
        returning * into v_account;

        v_reward_key := p_operation_key || ':' || v_order.id::text || ':loyalty_earn';
        insert into public.loyalty_ledger (
          organization_id, store_id, account_id, customer_id, order_id,
          type, points_delta, reason, idempotency_key
        )
        values (
          v_order.organization_id, p_store_id, v_account.id, v_order.customer_id, v_order.id,
          'earn', v_points, 'payment_success', v_reward_key
        )
        on conflict (store_id, idempotency_key) do nothing
        returning id into v_ledger_id;

        if v_ledger_id is not null then
          update public.loyalty_accounts
             set points_balance = points_balance + v_points,
                 updated_at = now()
           where id = v_account.id
             and store_id = p_store_id;
          -- การเขียนครั้งนี้ trigger revision ของ orders จะบวกอีกครั้ง → capture
          -- revision ล่าสุดไว้ใน result (ไม่งั้น result รายงาน revision เก่ากว่า DB 1)
          update public.orders
             set loyalty_points_earned = v_points
           where id = v_order.id
          returning revision into v_new_revision;
        else
          v_points := 0; -- duplicate key (ไม่ควรเกิดใต้ lock) — ไม่บวก balance ซ้ำเด็ดขาด
        end if;
      end if;
    end if;

    v_result_payments := v_result_payments || jsonb_build_array(jsonb_build_object(
      'order_id', v_order.id,
      'payment_id', v_payment_id,
      'amount', v_order.total,
      'received_amount', v_pay_received,
      'change_amount', v_pay_change
    ));
    v_result_orders := v_result_orders || jsonb_build_array(jsonb_build_object(
      'order_id', v_order.id,
      'status', 'paid',
      'prep_status', 'done',
      'revision', v_new_revision,
      'points_earned', v_points
    ));
  end loop;

  -- ---------- 10) whole_table → ปิด session โต๊ะ (body เดียวกับ close_table_session) ----------
  if p_mode = 'whole_table' then
    update public.tables
       set status = 'available',
           session_started_at = null,
           session_expires_at = null,
           updated_at = v_now
     where id = p_table_id
       and store_id = p_store_id;
    v_session_closed := true;
  end if;

  -- ---------- 11) Receipt (financial — commit พร้อมทุกอย่างข้างบน) ----------
  v_result := jsonb_build_object(
    'mode', p_mode,
    'table_id', p_table_id,
    'table_closed', v_session_closed,
    'order_ids', to_jsonb(v_order_ids),
    'grand_total', round(v_grand_total, 2),
    'payments', v_result_payments,
    'orders', v_result_orders
  );

  begin
    insert into public.unified_pos_operation_receipts (
      organization_id, store_id, operation_type, operation_key, request_hash,
      result, targets, payload, is_financial
    )
    values (
      p_organization_id, p_store_id, 'table_settlement', p_operation_key, p_request_hash,
      v_result,
      jsonb_build_array(
        jsonb_build_object('type','table','id',p_table_id),
        jsonb_build_object('type','orders','ids',to_jsonb(v_order_ids))
      ),
      jsonb_build_object(
        'mode', p_mode,
        'order_ids', p_order_ids,
        'table_id', p_table_id,
        'method', p_method,
        'amount', p_amount,
        'received_amount', p_received_amount,
        'change_amount', p_change_amount,
        'reference', p_reference,
        'actor_user_id', p_actor_user_id,
        'expected_revisions', p_expected_revisions
      ),
      true
    );
  exception
    when unique_violation then
      -- [U8 review fix] backstop นี้ต้อง abort ทั้ง transaction เสมอ: writer ทุกตัวของ
      -- receipts ต้องถือ pg_advisory_xact_lock((store,key)) ก่อน จึงแทบไม่มีทางชนกัน
      -- แต่ถ้าเกิดจริง (writer ใหม่ลืม lock) mutation ที่ทำไว้ก่อน block นี้ต้อง rollback
      -- ทั้งหมด (payment/rewards/stock) — การ return ปกติจะ commit mutation เหล่านั้น
      -- พร้อมตอบ replayed/conflict ลวง
      raise;
  end;

  -- ---------- 12) Audit ----------
  insert into public.audit_logs (
    organization_id, store_id, actor_user_id, action, before, after, request_id
  )
  values (
    p_organization_id, p_store_id, p_actor_user_id, 'unified_pos.table_settlement',
    jsonb_build_object(
      'mode', p_mode,
      'table_id', p_table_id,
      'order_ids', to_jsonb(v_order_ids),
      'grand_total', round(v_grand_total, 2),
      'method', p_method
    ),
    jsonb_build_object(
      'mode', p_mode,
      'table_id', p_table_id,
      'table_closed', v_session_closed,
      'order_ids', to_jsonb(v_order_ids),
      'grand_total', round(v_grand_total, 2),
      'method', p_method,
      'payments', v_result_payments,
      'orders', v_result_orders
    ),
    p_operation_key
  );

  return jsonb_build_object('status','executed','result', v_result);
end;
$$;

-- grants เดิมของแต่ละฟังก์ชัน (คัดจาก migration ต้นทางแบบตรงตัว — create or replace
-- ไม่ล้าง grant อยู่แล้ว แต่เขียนซ้ำไว้ให้ไฟล์นี้อ่านจบได้ในตัวตาม convention ของ repo)
revoke execute on function public.unified_pos_submit_table_order(uuid, uuid, uuid, text, text, text, numeric, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.unified_pos_submit_table_order(uuid, uuid, uuid, text, text, text, numeric, jsonb, text, uuid) to service_role;

revoke execute on function public.unified_pos_cancel_table_order(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.unified_pos_cancel_table_order(uuid, uuid, uuid, uuid, text, text) to service_role;

revoke execute on function public.unified_pos_reject_order_item(uuid, uuid, uuid, uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.unified_pos_reject_order_item(uuid, uuid, uuid, uuid, text, text, uuid, text) to service_role;

revoke execute on function public.unified_pos_settle_table_order(uuid, uuid, uuid, text, jsonb, jsonb, text, text, uuid, text, numeric, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.unified_pos_settle_table_order(uuid, uuid, uuid, text, jsonb, jsonb, text, text, uuid, text, numeric, numeric, numeric, text) to service_role;

revoke execute on function public.void_qr_order_item(uuid, uuid, uuid, text) from public, anon, service_role;
grant execute on function public.void_qr_order_item(uuid, uuid, uuid, text) to authenticated;
