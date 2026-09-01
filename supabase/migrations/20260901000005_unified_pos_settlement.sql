-- ============================================================
-- Task U7 (v0.35.7) — Governed dine-in table settlement + payment + rewards
-- ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U7)
--
-- เนื้อหา:
--   a) unified_pos_settle_table_order — RPC ปิดบิล/ชำระเงินแบบ governed (engine เดียว
--      ของสองโหมดตามความหมายเดิมของ surfaces ที่มีอยู่):
--        p_mode = 'partial'     → ชำระเฉพาะ order ids ที่ส่งมา (collectPaymentAction,
--                                 ขั้นชำระของ checkoutAndPayAction) — โต๊ะ/บิลอื่นคงเปิด
--        p_mode = 'whole_table' → ชำระทุกบิลเปิดของโต๊ะ (status='open' + ยังไม่จ่าย)
--                                 แล้วปิด session โต๊ะ (settleWholeTableAction)
--      ลำดับภายใน transaction เดียว (exception ใดๆ → rollback ทั้งหมด):
--        envelope (key/hash/mode/method) → advisory lock (store,operation_key) →
--        receipt (replay/conflict — ไม่ mutate) → store flag (fail closed) →
--        permission 'pos.use' ของ actor (ชุดเดียวกับชั้น action ของ payment surfaces
--        เดิม ตามหลักเดียวกับ U4 add-items / U6 reject) → lock โต๊ะ (เมื่อระบุ) + ล็อค
--        orders FOR UPDATE → guard: status ∈ (open, pending_payment) + ยังไม่จ่าย →
--        expected revision (stale → up_stale_version ให้ client refetch) →
--        คำนวณยอด "ฝั่ง server" จาก orders.total เท่านั้น (ห้ามเชื่อยอด client;
--        p_amount ที่ client อ้างต้องตรงกับยอดรวม server มิฉะนั้น up_invalid_payment) →
--        cash math (received/change/net เหมือน close_pos_order_payment) →
--        ต่อบิล: หักสต๊อกเฉพาะออเดอร์พนักงาน (qr_order_source=false, เฉพาะ item ที่
--        voided=false — U6 คืนสต๊อกไปแล้วตอน reject จึงต้องกรอง มิฉะนั้นหักเกิน) →
--        status='paid' + paid_at + prep_status='done' (กฎ 1 ของ U1 derive contract:
--        terminal → done) → payment row (amount = orders.total ของบิลนั้น) →
--        accounting income transaction → cash ledger (ต่อเนื่อง balance_after) →
--        loyalty rewards (exactly-once) → ปิด session (whole_table) → receipt → audit
--      Rewards exactly-once: ledger idempotency_key = operation_key:order_id:loyalty_earn
--        (unique (store_id, idempotency_key) เดิม) + guard "ยังไม่จ่าย" ใต้ row lock →
--        double-settlement (key ซ้ำ = replay, ต่าง key = up_invalid_state_transition)
--        ไม่มีทางโพสต์แต้มซ้ำ
--      สูตรแต้ม mirror close_grocery_pos_order_payment_with_rewards เป๊ะ:
--        settings ของร้าน (earn_enabled ? points_per_currency : 0) / ไม่มี settings
--        → default 0.0100 / points = round(total * ppc, 2) เป็น "ทศนิยม 2 ตำแหน่ง"
--        (คอลัมน์ points_delta/points_balance/loyalty_points_earned เป็น numeric(12,2)
--        ตั้งแต่ 20260626140000 — legacy โพสต์แต้มทศนิยมได้ เช่น 45 × 0.01 = 0.45 แต้ม;
--        ห้าม floor หรือปัดเป็น integer เพราะให้แต้มน้อยกว่า legacy) /
--        balance + points / orders.loyalty_points_earned = points
--      Print intent: ไม่สร้าง print job ใน transaction (ผูกกับ commit ไม่ได้) —
--        งานพิมพ์ยังอยู่กับ Print Hub flow เดิมที่ client เรียกหลัง RPC สำเร็จ
--        (executed/replayed); แนวปฏิบัติ: ใช้ source key ที่ derive จาก operation key
--        เช่น "unified_pos_settlement:<operation_key>:<order_id>" เพื่อให้ retry
--        ของคำขอเดิม (replay) ไม่ enqueue งานพิมพ์ซ้ำ
--   b) receipts การเงิน: เพิ่ม unified_pos_operation_receipts.is_financial (default false)
--      + purge function ใหม่ — tombstone (key/hash/type/targets) ของทุก operation
--      "คงอยู่ตลอดไป" อยู่แล้วตาม U2 (purge ห้ามลบแถว — ตัดเฉพาะ result/payload);
--      flag is_financial เพิ่มการรับประกันอีกชั้นสำหรับ operation การเงิน:
--      เมื่อ payload หมดอายุ 30 วัน → ล้าง payload เท่านั้น แต่ "คง result ไว้"
--      (payment ids/ยอด/สถานะ) เพื่อให้ replay ของคำขอชำระเงินยังตอบผลจริงได้
--      แม้เกิน retention ส่วน operation อื่นคงพฤติกรรมเดิม (ล้าง result + payload)
--   c) grants — RPC ใหม่ service_role เท่านั้น (convention U4/U5/U6; action layer
--      เรียกผ่าน service client และส่ง actor ชัดเจน — สิทธิ์ตรวจใน RPC ด้วย
--      user_has_permission_in_store)
--
-- หมายเหตุ permission: governed path ตรวจ 'pos.use' ของ actor ผ่าน user_has_permission_in_store
--   (ชุดเดียวกับ close_pos_order_payment ล่าสุดที่ใช้ auth_user_has_permission('pos.use')
--   ตั้งแต่ migration wholesale 20260703000000) และเงินสดตรวจ 'cashflow.record' +
--   รอบเงินสดเปิดอยู่เพิ่ม (mirror legacy เดียวกัน + invariant 2026-06-23 ของโปรเจค)
-- ============================================================

-- ------------------------------------------------------------
-- (b) is_financial + purge ใหม่ (tombstone คงอยู่เสมอ, financial คง result)
-- ------------------------------------------------------------
alter table public.unified_pos_operation_receipts
  add column if not exists is_financial boolean not null default false;

create or replace function public.purge_expired_unified_pos_receipt_payloads()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purged integer;
begin
  -- tombstone (key/hash/type/targets/is_financial) ไม่ถูกลบเสมอ (U2 contract);
  -- payload หมดอายุ → ล้างทุกแถว; result ล้างเฉพาะ operation ที่ไม่ใช่การเงิน
  update public.unified_pos_operation_receipts
     set result = case when is_financial then result else null end,
         payload = null,
         updated_at = now()
   where payload_expires_at < now()
     and (payload is not null or (result is not null and is_financial = false));
  get diagnostics v_purged = row_count;
  return v_purged;
end;
$$;

-- ------------------------------------------------------------
-- (a) unified_pos_settle_table_order
--     คืน jsonb:
--       { status:'executed'|'replayed', result:{
--           mode, table_id, table_closed, order_ids, grand_total,
--           payments:[{order_id,payment_id,amount,received_amount,change_amount}],
--           orders:[{order_id,status,prep_status,revision,points_earned}] } }
--       { status:'hash_conflict' }
--       { status:'error', code:'up_*', message:'...' }
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

-- ------------------------------------------------------------
-- (c) Grants — service_role เท่านั้น (convention U4/U5/U6)
-- ------------------------------------------------------------
revoke execute on function public.unified_pos_settle_table_order(uuid, uuid, uuid, text, jsonb, jsonb, text, text, uuid, text, numeric, numeric, numeric, text) from public;
revoke execute on function public.unified_pos_settle_table_order(uuid, uuid, uuid, text, jsonb, jsonb, text, text, uuid, text, numeric, numeric, numeric, text) from anon;
revoke execute on function public.unified_pos_settle_table_order(uuid, uuid, uuid, text, jsonb, jsonb, text, text, uuid, text, numeric, numeric, numeric, text) from authenticated;
grant execute on function public.unified_pos_settle_table_order(uuid, uuid, uuid, text, jsonb, jsonb, text, text, uuid, text, numeric, numeric, numeric, text) to service_role;
