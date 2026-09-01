-- ============================================================
-- Task U5 (v0.35.5) — Versioned item fulfillment + order prep derive
-- ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U5)
--
-- เนื้อหา:
--   a) orders.prep_status CHECK เพิ่ม 'ready' (คง 'done' ไว้ — ห้ามลบตาม U1 contract)
--   b) unified_pos_derive_order_prep_status — derive สถานะ order จาก items
--      mirror ตรงกับ deriveOrderPrepStatus ใน src/modules/unified-pos/contracts.ts:
--        1. order ปิดแล้ว (paid/refunded/voided/cancelled หรือ paid_at ไม่ null) → 'done'
--        2. ไม่มี active item → 'done'
--        3. active ล้วนสถานะเดียว → สถานะนั้น
--        4. active ผสม + มี new/preparing → 'preparing'
--        5. active ready/served ผสม + มี ready → 'ready'
--        6. active served ล้วน → 'served'
--   c) trigger unified_pos_items_prep_derive — ทุกการเปลี่ยนแปลง order_item
--      (INSERT/UPDATE/DELETE) derive สถานะ order และ persist (เฉพาะร้านที่เปิด
--      unified_pos_enabled — ร้านปิด flag คงพฤติกรรม legacy ทุกอย่าง)
--      เขียนเฉพาะเมื่อค่า derived ต่างจากเดิม (ไม่เพิ่ม revision โดยไม่จำเป็น)
--   d) unified_pos_update_item_fulfillment — RPC เปลี่ยนสถานะ fulfillment ระดับ item:
--        receipt (replay/conflict) → flag → permission orders.manage_qr →
--        lock order/item → voided guard → expected version (up_stale_version) →
--        transition matrix one-step (up_invalid_state_transition) →
--        update item → derive + persist order prep → receipt → audit
--   e) unified_pos_cancel_table_order — customer cancel ตาม canCustomerCancelOrder:
--        QR order เท่านั้น + status='open' + ยังไม่จ่าย + active items ทั้งหมด 'new'
--        → คืนสต๊อกเฉพาะ active items (voided ถูกคืนไปแล้วตอน void_qr_order_item
--        ต่างจาก legacy cancel ที่คืนทุก item แล้ว over-restore) →
--        status='cancelled' + prep derive → 'done' → receipt → audit
--   f) grants ตาม convention ของ repo (service_role เท่านั้น)
--
-- Transition matrix (mirror canTransitionItemFulfillment — one step forward เท่านั้น):
--   new → preparing → ready → served ; ถอย/ข้าม/สถานะเดิม = ไม่ผ่านทั้งหมด
-- ============================================================

-- ------------------------------------------------------------
-- (a) orders.prep_status CHECK เพิ่ม 'ready' (idempotent — ห้ามลบ 'done')
--     เดิม: check (prep_status in ('new','preparing','served','done'))
--     จาก migration 20260607000002_qr_order_fulfillment.sql (constraint ชื่ออัตโนมัติ)
-- ------------------------------------------------------------
do $$
declare
  v_con text;
begin
  if not exists (
    select 1
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'orders'
       and con.conname = 'orders_prep_status_ready_check'
  ) then
    select con.conname
      into v_con
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'orders'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%prep_status%'
     limit 1;

    if v_con is not null then
      execute format('alter table public.orders drop constraint %I', v_con);
    end if;

    alter table public.orders
      add constraint orders_prep_status_ready_check
      check (prep_status in ('new','preparing','ready','served','done'));
  end if;
end $$;

-- ------------------------------------------------------------
-- (b) Derive order prep status จาก items (mirror contracts.deriveOrderPrepStatus)
--     คืน NULL เมื่อไม่พบ order
-- ------------------------------------------------------------
create or replace function public.unified_pos_derive_order_prep_status(
  p_order_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_states text[];
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id;

  if not found then
    return null;
  end if;

  -- (1) order ปิดแล้ว → done (terminal status หรือ paid_at ไม่ null)
  if v_order.status in ('paid','refunded','voided','cancelled')
     or v_order.paid_at is not null then
    return 'done';
  end if;

  -- active item = voided = false เท่านั้น (canonical void)
  select coalesce(array_agg(oi.fulfillment_status order by oi.fulfillment_status), '{}')
    into v_states
    from public.order_items oi
   where oi.order_id = p_order_id
     and oi.voided = false;

  -- (2) ไม่มี active item → done
  if v_states is null or array_length(v_states, 1) is null then
    return 'done';
  end if;

  -- (3) active ล้วนสถานะเดียว → สถานะนั้น
  if (select count(distinct s) from unnest(v_states) as s) = 1 then
    return v_states[1];
  end if;

  -- (4) ผสม + มี new/preparing → preparing
  if 'new' = any(v_states) or 'preparing' = any(v_states) then
    return 'preparing';
  end if;

  -- (5)(6) ready/served ผสม → ready ; served ล้วน → served
  if 'ready' = any(v_states) then
    return 'ready';
  end if;
  return 'served';
end;
$$;

-- ------------------------------------------------------------
-- (c) Trigger: ทุกการเปลี่ยนแปลง order_item → derive + persist prep status
--     (เฉพาะร้านที่เปิด unified_pos_enabled; ร้านปิด flag คง legacy ทุกอย่าง)
--     หมายเหตุ: แยกจาก trigger parent bump ของ U2 — revision เพิ่มอีกครั้งเฉพาะ
--     ตอนค่า prep เปลี่ยนจริง (เขียนเมื่อต่างเท่านั้น)
-- ------------------------------------------------------------
create or replace function public.unified_pos_items_prep_derive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
  v_flag boolean;
  v_current text;
  v_derived text;
begin
  select coalesce(s.unified_pos_enabled, false)
    into v_flag
    from public.orders o
    join public.stores s on s.id = o.store_id
   where o.id = v_order_id;

  if not found or not coalesce(v_flag, false) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_derived := public.unified_pos_derive_order_prep_status(v_order_id);
  if v_derived is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select o.prep_status
    into v_current
    from public.orders o
   where o.id = v_order_id;

  if v_derived is distinct from v_current then
    update public.orders
       set prep_status = v_derived
     where id = v_order_id;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists unified_pos_items_prep_derive on public.order_items;
create trigger unified_pos_items_prep_derive
  after insert or update or delete on public.order_items
  for each row execute function public.unified_pos_items_prep_derive();

-- ------------------------------------------------------------
-- (d) RPC เปลี่ยนสถานะ fulfillment ระดับ item (governed + idempotent)
--     คืน jsonb:
--       { status:'executed'|'replayed', result:{order_id,item_id,fulfillment_status,
--         fulfillment_version,order_prep_status,order_revision} }
--       { status:'hash_conflict' }
--       { status:'error', code:'up_*', message:'...' }
-- ------------------------------------------------------------
create or replace function public.unified_pos_update_item_fulfillment(
  p_organization_id uuid,
  p_store_id uuid,
  p_order_id uuid,
  p_item_id uuid,
  p_expected_fulfillment_version bigint,
  p_target_fulfillment_status text,
  p_operation_key text,
  p_request_hash text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.order_items%rowtype;
  v_valid_transition boolean;
  v_new_version bigint;
  v_prep text;
  v_revision bigint;
  v_receipt public.unified_pos_operation_receipts%rowtype;
  v_result jsonb;
begin
  -- ---------- 0) envelope + target enum ----------
  if p_operation_key is null or length(p_operation_key) < 8 or length(p_operation_key) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','operation key ไม่ถูกต้อง');
  end if;
  if p_request_hash is null or length(p_request_hash) < 16 or length(p_request_hash) > 128 then
    return jsonb_build_object('status','error','code','up_invalid_item','message','request hash ไม่ถูกต้อง');
  end if;
  if p_target_fulfillment_status not in ('new','preparing','ready','served') then
    return jsonb_build_object('status','error','code','up_invalid_state_transition','message','สถานะที่ต้องการไม่ถูกต้อง');
  end if;
  if p_actor_user_id is null then
    return jsonb_build_object('status','error','code','up_forbidden','message','ไม่มีสิทธิ์เปลี่ยนสถานะรายการ');
  end if;
  if p_expected_fulfillment_version is null then
    return jsonb_build_object('status','error','code','up_stale_version','message','เวอร์ชันรายการไม่ถูกต้อง กรุณารีเฟรชหน้าจอ');
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

  -- ---------- 3) Store + flag ----------
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

  -- ---------- 4) Permission (kitchen/board ใช้ orders.manage_qr เหมือน legacy) ----------
  if not public.user_has_permission_in_store(p_actor_user_id, p_organization_id, p_store_id, 'orders.manage_qr') then
    return jsonb_build_object('status','error','code','up_forbidden','message','ไม่มีสิทธิ์เปลี่ยนสถานะรายการ');
  end if;

  -- ---------- 5) Lock order (scope org+store — ข้ามร้าน = not_found) ----------
  if not exists (
    select 1
      from public.orders
     where id = p_order_id
       and organization_id = p_organization_id
       and store_id = p_store_id
     for update
  ) then
    return jsonb_build_object('status','error','code','up_not_found','message','ไม่พบออเดอร์');
  end if;

  -- ---------- 6) Lock item ----------
  select *
    into v_item
    from public.order_items
    where id = p_item_id
      and order_id = p_order_id
    for update;

  if not found then
    return jsonb_build_object('status','error','code','up_invalid_item','message','รายการไม่อยู่ในออเดอร์นี้');
  end if;

  -- ---------- 7) Voided guard (canonical void — voided ชนะเสมอ) ----------
  if v_item.voided then
    return jsonb_build_object('status','error','code','up_invalid_item','message','รายการนี้ถูกยกเลิกไปแล้ว');
  end if;

  -- ---------- 8) Expected version (optimistic concurrency) ----------
  if v_item.fulfillment_version is distinct from p_expected_fulfillment_version then
    return jsonb_build_object('status','error','code','up_stale_version','message','สถานะรายการถูกอัปเดตไปก่อนแล้ว กรุณารีเฟรชหน้าจอ');
  end if;

  -- ---------- 9) Transition matrix (mirror canTransitionItemFulfillment) ----------
  v_valid_transition :=
    (v_item.fulfillment_status = 'new' and p_target_fulfillment_status = 'preparing')
    or (v_item.fulfillment_status = 'preparing' and p_target_fulfillment_status = 'ready')
    or (v_item.fulfillment_status = 'ready' and p_target_fulfillment_status = 'served');

  if not v_valid_transition then
    return jsonb_build_object(
      'status','error',
      'code','up_invalid_state_transition',
      'message','เปลี่ยนสถานะไม่ถูกลำดับ (ได้เฉพาะขั้นถัดไป: new → preparing → ready → served)'
    );
  end if;

  -- ---------- 10) Update item (trigger bump fulfillment_version + derive prep) ----------
  update public.order_items
     set fulfillment_status = p_target_fulfillment_status
   where id = p_item_id
   returning fulfillment_version into v_new_version;

  v_prep := public.unified_pos_derive_order_prep_status(p_order_id);
  select revision into v_revision from public.orders where id = p_order_id;

  -- ---------- 11) Receipt (idempotency tombstone — commit พร้อมทุกอย่างข้างบน) ----------
  v_result := jsonb_build_object(
    'order_id', p_order_id,
    'item_id', p_item_id,
    'fulfillment_status', p_target_fulfillment_status,
    'fulfillment_version', v_new_version,
    'order_prep_status', v_prep,
    'order_revision', v_revision
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
      'item_fulfillment',
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
        'expected_fulfillment_version', p_expected_fulfillment_version,
        'target_fulfillment_status', p_target_fulfillment_status
      )
    );
  exception
    when unique_violation then
      select *
        into v_receipt
        from public.unified_pos_operation_receipts
        where store_id = p_store_id
          and operation_key = p_operation_key;
      if found and v_receipt.request_hash = p_request_hash then
        return jsonb_build_object('status','replayed','result', v_receipt.result);
      end if;
      return jsonb_build_object('status','hash_conflict');
  end;

  -- ---------- 12) Audit ----------
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
    'unified_pos.item_fulfillment',
    jsonb_build_object(
      'order_id', p_order_id,
      'item_id', p_item_id,
      'fulfillment_status', v_item.fulfillment_status,
      'fulfillment_version', v_item.fulfillment_version
    ),
    jsonb_build_object(
      'order_id', p_order_id,
      'item_id', p_item_id,
      'fulfillment_status', p_target_fulfillment_status,
      'fulfillment_version', v_new_version,
      'order_prep_status', v_prep
    ),
    p_operation_key
  );

  return jsonb_build_object('status','executed','result', v_result);
end;
$$;

-- ------------------------------------------------------------
-- (e) Customer cancel ตาม canCustomerCancelOrder (governed + idempotent)
--     กฎ: QR order + status='open' + ยังไม่จ่าย + active items ≥1 และล้วน 'new'
--     สำเร็จ → คืนสต๊อกเฉพาะ active items + status='cancelled' + prep='done'
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
     group by variant_id
  ) oi
  where pv.id = oi.variant_id
    and pv.track_stock = true;

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
      select *
        into v_receipt
        from public.unified_pos_operation_receipts
        where store_id = p_store_id
          and operation_key = p_operation_key;
      if found and v_receipt.request_hash = p_request_hash then
        return jsonb_build_object('status','replayed','result', v_receipt.result);
      end if;
      return jsonb_build_object('status','hash_conflict');
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
-- (f) Grants — service_role เท่านั้น (เรียกผ่าน server action ทั้งสองเส้นทาง)
-- ------------------------------------------------------------
revoke execute on function public.unified_pos_update_item_fulfillment(uuid, uuid, uuid, uuid, bigint, text, text, text, uuid) from public;
revoke execute on function public.unified_pos_update_item_fulfillment(uuid, uuid, uuid, uuid, bigint, text, text, text, uuid) from anon;
revoke execute on function public.unified_pos_update_item_fulfillment(uuid, uuid, uuid, uuid, bigint, text, text, text, uuid) from authenticated;
grant execute on function public.unified_pos_update_item_fulfillment(uuid, uuid, uuid, uuid, bigint, text, text, text, uuid) to service_role;

revoke execute on function public.unified_pos_cancel_table_order(uuid, uuid, uuid, uuid, text, text) from public;
revoke execute on function public.unified_pos_cancel_table_order(uuid, uuid, uuid, uuid, text, text) from anon;
revoke execute on function public.unified_pos_cancel_table_order(uuid, uuid, uuid, uuid, text, text) from authenticated;
grant execute on function public.unified_pos_cancel_table_order(uuid, uuid, uuid, uuid, text, text) to service_role;

revoke execute on function public.unified_pos_derive_order_prep_status(uuid) from public;
revoke execute on function public.unified_pos_derive_order_prep_status(uuid) from anon;
grant execute on function public.unified_pos_derive_order_prep_status(uuid) to authenticated, service_role;
