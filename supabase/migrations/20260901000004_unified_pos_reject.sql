-- ============================================================
-- Task U6 (v0.35.6) — Governed item reject/void + stock restore + totals recalc
-- ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U6)
--
-- เนื้อหา:
--   a) unified_pos_reject_order_item — RPC ยกเลิกรายการ (reject/void) แบบ governed:
--        receipt (replay/conflict) → store flag (fail closed เมื่อ false) →
--        permission orders.manage_qr (ชุดเดียวกับ action voidQrOrderItemAction
--        และ U5 fulfillment ≈ cashier+ ของ legacy) → lock order+item FOR UPDATE →
--        guard: order ต้อง 'open' + ยังไม่จ่าย, item ต้องยังไม่ voided →
--        set voided=true (canonical void = order_items.voided boolean เท่านั้น
--        ห้ามใช้ fulfillment_status='voided' ตาม U1 contract — fulfillment_status
--        คงค่าเดิมไว้) → คืนสต๊อกเฉพาะ variant track_stock ของร้านนี้ "ครั้งเดียว"
--        (อยู่ใต้ row lock ของ item + voided guard → concurrent double-reject
--        คนละ key ตัวที่สองโดน voided guard จึง restore ได้ครั้งเดียวต่อ item) →
--        recalc subtotal/discount/total จากผลรวม total_price ของ active items
--        (แหล่งคำนวณเดียวกับ submit RPC: sum(item.total_price) — สูตร
--        total = subtotal - discount ตาม pos_create_order; orders ไม่มีคอลัมน์
--        tax ใน schema นี้ พื้นที่เงินของ order จึงครบด้วย 3 คอลัมน์นี้) →
--        ไม่เหลือ active item → ปิดออเดอร์เป็น 'cancelled' (legacy parity
--        ของ void_qr_order_item เดิม) → receipt → audit
--      หมายเหตุ: ไม่บังคับ qr_order_source (ต่างจาก legacy) เพราะ Unified POS
--      ครอบทั้ง QR และ staff table order — reject รายการของออเดอร์พนักงานได้
--      เมื่อร้านเปิด flag (ผ่าน permission orders.manage_qr เช่นกัน)
--   b) void_qr_order_item เดิม → thin wrapper คง signature + grants เดิม
--      ทางเลือกที่ใช้: "flags-gated" (ไม่ใช่ always) เหตุผล:
--        - governed RPC fail closed เมื่อร้านปิด flag → ถ้า route "always"
--          ครัวของร้าน legacy (flag off) จะยกเลิกรายการไม่ได้ทันที = regression
--          กับร้านที่ยังไม่เข้าร่วม Unified POS
--        - flag off → รัน legacy body เดิมทุกอย่าง (คัดลอกตรงจาก
--          20260701000002_void_qr_order_item.sql — พฤติกรรมเท่าเดิม)
--        - flag on → route เข้า unified_pos_reject_order_item (canonical) โดย
--          derive operation key/hash ฝั่ง server จาก (store, order, item, reason,
--          actor): retry คำขอเดิม → replayed (ถือว่าสำเร็จ), payload ต่าง →
--          hash_conflict, error อื่น → raise exception ข้อความไทยจาก RPC
--        สอดคล้อง convention gating ของ U5 (trigger derive เฉพาะร้านเปิด flag)
--   c) grants — RPC ใหม่ service_role เท่านั้น (ตาม convention U4/U5),
--      wrapper คง grant เดิม (authenticated)
--
-- Atomicity: ทุก mutation (stock/item/totals/receipt/audit) อยู่ใน transaction
-- เดียว — exception กลางทางใดๆ rollback ทั้งหมด (plpgsql default)
-- ============================================================

-- ------------------------------------------------------------
-- (a) Governed reject RPC
--     คืน jsonb:
--       { status:'executed'|'replayed', result:{order_id,item_id,voided,
--         order_status,order_prep_status,order_revision,subtotal,discount,
--         total,stock_restored_quantity} }
--       { status:'hash_conflict' }
--       { status:'error', code:'up_*', message:'...' }
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
  if v_item.variant_id is not null then
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
-- (b) void_qr_order_item → thin wrapper (flags-gated — เหตุผลในหัว migration)
--     คง signature + grants เดิมของ 20260701000002_void_qr_order_item.sql
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

  -- Restore the stock deducted at order creation.
  if v_variant is not null then
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
-- (c) Grants — RPC ใหม่ service_role เท่านั้น; wrapper คง grants เดิม
-- ------------------------------------------------------------
revoke execute on function public.unified_pos_reject_order_item(uuid, uuid, uuid, uuid, text, text, uuid, text) from public;
revoke execute on function public.unified_pos_reject_order_item(uuid, uuid, uuid, uuid, text, text, uuid, text) from anon;
revoke execute on function public.unified_pos_reject_order_item(uuid, uuid, uuid, uuid, text, text, uuid, text) from authenticated;
grant execute on function public.unified_pos_reject_order_item(uuid, uuid, uuid, uuid, text, text, uuid, text) to service_role;

-- คง grants เดิมของ wrapper (authenticated เท่านั้น)
revoke execute on function public.void_qr_order_item(uuid, uuid, uuid, text) from public, anon;
revoke execute on function public.void_qr_order_item(uuid, uuid, uuid, text) from service_role;
grant execute on function public.void_qr_order_item(uuid, uuid, uuid, text) to authenticated;
