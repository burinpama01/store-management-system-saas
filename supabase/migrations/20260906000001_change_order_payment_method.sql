-- ============================================================
-- แก้ช่องทางชำระของบิลที่จ่ายแล้ว (เช่น ลูกค้าโอนแต่แคชเชียร์กดเงินสด)
--
-- เดิมทางเดียวที่ทำได้คือยกเลิกบิลแล้วเปิดใหม่ ซึ่งทำให้เลขบิล/แต้ม/สต๊อกรวนไปทั้งชุด
-- ทั้งที่ความจริงมีแค่ "ประเภทเงินที่รับ" ผิดอย่างเดียว ยอดขายเท่าเดิมทุกบาท
--
-- กติกาที่บังคับในฟังก์ชันนี้ (ตกลงกับเจ้าของร้าน 2026-09-06):
--   1. สิทธิ์เท่ากับการยกเลิกบิล (pos.delete_bill) — เพราะกระทบเงินสดในลิ้นชักโดยตรง
--   2. แก้ได้เฉพาะบิลที่จ่ายอยู่ใน "รอบเงินสดที่เปิดอยู่" เท่านั้น
--      บิลของรอบที่ปิดไปแล้วห้ามแก้ ไม่งั้นเงินสดที่ควรอยู่ในรอบเก่าจะถูกปรับเข้ารอบ
--      ปัจจุบัน = ยอดที่นับได้ตอนปิดรอบเพี้ยนทั้งสองรอบโดยไม่มีใครรู้
--   3. บิลที่มีหลายรายการชำระ (แยกจ่าย) ไม่รองรับ — ต้องยกเลิกแล้วออกใหม่
--
-- ยอดขาย (transactions) ไม่ถูกแตะเลย เพราะรายได้เท่าเดิม เปลี่ยนแค่ประเภทเงินที่รับ
-- ส่วนเงินสดในลิ้นชักปรับด้วย cash_ledger_entries type 'adjustment' หนึ่งแถว
-- (ไม่แก้แถว pos_sale เดิม เพื่อให้ยังไล่ย้อนได้ว่าเกิดอะไรขึ้นตอนไหน)
--
-- แถว payments เก็บ "ช่องทางเดิม" ไว้ด้วย เพราะใบเสร็จที่พิมพ์ซ้ำหลังแก้ต้องบอกลูกค้า
-- และผู้ตรวจได้ว่าใบนี้เคยลงเป็นเงินสดแล้วเปลี่ยนเป็นโอน ไม่ใช่ใบที่โอนมาตั้งแต่แรก
-- ============================================================

alter table public.payments
  add column if not exists original_method text,
  add column if not exists method_changed_at timestamptz,
  add column if not exists method_changed_by_user_id uuid,
  add column if not exists method_change_reason text;

comment on column public.payments.original_method is
  'ช่องทางชำระที่บันทึกไว้ครั้งแรก (มีค่าเมื่อมีการแก้ช่องทางภายหลังเท่านั้น)';

create or replace function public.change_pos_order_payment_method(
  p_store_id uuid,
  p_order_id uuid,
  p_method text,
  p_actor_user_id uuid,
  p_reason text default null,
  p_received_amount numeric default null,
  p_change_amount numeric default null,
  p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_payment_count int;
  v_session public.cash_sessions%rowtype;
  v_old_cash numeric := 0;
  v_new_cash numeric := 0;
  v_delta numeric;
  v_received numeric;
  v_change numeric;
  v_previous_balance numeric := 0;
  v_transaction_id uuid;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_note text;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนแก้ช่องทางชำระ';
  end if;

  if p_actor_user_id is distinct from auth.uid() then
    raise exception 'ผู้แก้ไขไม่ถูกต้อง';
  end if;

  if p_method not in ('cash', 'qr_promptpay', 'credit_card', 'bank_transfer', 'other') then
    raise exception 'ช่องทางชำระไม่ถูกต้อง';
  end if;

  select *
  into v_order
  from public.orders
  where id = p_order_id
    and store_id = p_store_id
    and status = 'paid'
  for update;

  if not found then
    raise exception 'แก้ช่องทางชำระได้เฉพาะบิลที่ชำระเงินแล้วและยังไม่ถูกยกเลิก';
  end if;

  if not public.auth_user_has_permission(v_order.organization_id, p_store_id, 'pos.delete_bill') then
    raise exception 'ไม่มีสิทธิ์แก้ช่องทางชำระ';
  end if;

  select count(*)
  into v_payment_count
  from public.payments
  where order_id = p_order_id
    and status = 'completed';

  if v_payment_count = 0 then
    raise exception 'บิลนี้ไม่มีรายการชำระที่แก้ได้';
  end if;
  if v_payment_count > 1 then
    raise exception 'บิลนี้แยกจ่ายหลายช่องทาง ต้องยกเลิกบิลแล้วออกใหม่';
  end if;

  select *
  into v_payment
  from public.payments
  where order_id = p_order_id
    and status = 'completed'
  for update;

  if v_payment.method = p_method then
    raise exception 'ช่องทางชำระเดิมกับที่เลือกใหม่เป็นอันเดียวกัน';
  end if;

  -- ล็อกเดียวกับตอนรับเงินสด กันแก้ช่องทางชนกับการปิดรอบเงินสดพอดี
  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 0));

  select *
  into v_session
  from public.cash_sessions
  where organization_id = v_order.organization_id
    and store_id = p_store_id
    and status = 'open'
  order by opened_at desc
  limit 1
  for update;

  if not found then
    raise exception 'ต้องเปิดรอบเงินสดก่อนแก้ช่องทางชำระ';
  end if;

  if v_payment.processed_at < v_session.opened_at then
    raise exception 'บิลนี้อยู่ในรอบเงินสดที่ปิดไปแล้ว แก้ช่องทางชำระไม่ได้ — ให้บันทึกปรับยอดในรายรับ-รายจ่ายแทน';
  end if;

  -- เงินสดที่เข้าลิ้นชักจริงของรายการเดิม (รับมา - ทอนไป)
  if v_payment.method = 'cash' then
    v_old_cash := coalesce(v_payment.received_amount, v_payment.amount) - coalesce(v_payment.change_amount, 0);
  end if;

  if p_method = 'cash' then
    if not public.auth_user_has_permission(v_order.organization_id, p_store_id, 'cashflow.record') then
      raise exception 'ไม่มีสิทธิ์รับเงินสด';
    end if;

    v_received := coalesce(p_received_amount, v_payment.amount);
    v_change := coalesce(p_change_amount, 0);

    if v_received < v_payment.amount then
      raise exception 'เงินสดที่รับไม่พอ';
    end if;
    if v_change < 0 then
      raise exception 'เงินทอนไม่ถูกต้อง';
    end if;

    v_new_cash := v_received - v_change;
    if v_new_cash is distinct from v_payment.amount then
      raise exception 'ยอดเงินสดไม่ตรงกับยอดขาย';
    end if;
  else
    -- ช่องทางที่ไม่ใช่เงินสดไม่มีเงินทอน; received เก็บไว้ได้ถ้าผู้ใช้ระบุมา
    v_received := p_received_amount;
    v_change := null;
  end if;

  v_note := 'แก้ช่องทางชำระบิล ' || v_order.order_number
    || ': ' || v_payment.method || ' -> ' || p_method
    || coalesce(' (' || v_reason || ')', '');

  update public.payments
  set method = p_method,
      received_amount = v_received,
      change_amount = v_change,
      reference = coalesce(nullif(trim(coalesce(p_reference, '')), ''), reference),
      -- แก้ซ้ำหลายรอบต้องยังจำ "ช่องทางแรกสุด" ไว้ ไม่ใช่ช่องทางก่อนหน้ารอบล่าสุด
      original_method = coalesce(original_method, v_payment.method),
      method_changed_at = now(),
      method_changed_by_user_id = p_actor_user_id,
      method_change_reason = v_reason
  where id = v_payment.id;

  v_delta := v_new_cash - v_old_cash;

  if v_delta <> 0 then
    select id
    into v_transaction_id
    from public.transactions
    where order_id = p_order_id
      and store_id = p_store_id
    order by created_at
    limit 1;

    select balance_after
    into v_previous_balance
    from public.cash_ledger_entries
    where store_id = p_store_id
    order by created_at desc
    limit 1;

    insert into public.cash_ledger_entries (
      organization_id,
      store_id,
      type,
      amount,
      balance_after,
      transaction_id,
      order_id,
      note,
      created_by_user_id
    ) values (
      v_order.organization_id,
      p_store_id,
      'adjustment',
      v_delta,
      coalesce(v_previous_balance, 0) + v_delta,
      v_transaction_id,
      p_order_id,
      v_note,
      p_actor_user_id
    );
  end if;

  update public.orders
  set updated_at = now()
  where id = p_order_id;

  return v_payment.id;
end;
$$;

revoke all on function public.change_pos_order_payment_method(uuid, uuid, text, uuid, text, numeric, numeric, text) from public;
revoke execute on function public.change_pos_order_payment_method(uuid, uuid, text, uuid, text, numeric, numeric, text) from anon;
grant execute on function public.change_pos_order_payment_method(uuid, uuid, text, uuid, text, numeric, numeric, text) to authenticated;
