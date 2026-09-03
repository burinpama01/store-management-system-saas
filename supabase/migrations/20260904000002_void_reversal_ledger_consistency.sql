-- ============================================================
-- แก้ balance กับ loyalty_ledger ไม่ตรงกันเวลายกเลิกบิล (audit ข้อ 8)
--
-- ปัญหา: ตอนกลับรายการ "ได้แต้ม" ฟังก์ชันเขียน ledger เต็มจำนวน (-10) แต่ตอนอัปเดต
-- ยอดคงเหลือใช้ greatest(0, balance - 10) เพราะมี CHECK points_balance >= 0
-- ถ้าลูกค้าใช้แต้มไปก่อนแล้วเหลือ 3 แต้ม ledger จะบอกว่าหัก 10 แต่ balance ลดแค่ 3
-- → ผลรวม ledger ไม่เท่ากับ balance อีกต่อไป และไม่มีอะไรบอกว่าเพี้ยนตอนไหน
--
-- แก้: clamp ที่ "จำนวนที่บันทึก" แทนที่จะ clamp ตอนอัปเดต และเขียนส่วนที่คืนไม่ได้
-- ลงใน reason ให้อ่านออก — ledger กับ balance จึงตรงกันเสมอ และตรวจสอบย้อนหลังได้
--
-- ไม่แตะพฤติกรรมอื่น: ส่วนที่เหลือคัดลอกจาก 20260705150000 ทุกตัวอักษร
-- (เทียบ pg_get_functiondef บน prod แล้วว่าตรงกับไฟล์ migration ก่อนแก้)
--
-- หมายเหตุ: ไม่ไล่แก้ข้อมูลที่เพี้ยนไปแล้วย้อนหลัง เพราะจะเป็นการเปลี่ยนแต้มของลูกค้าจริง
-- โดยไม่มีใครตัดสินใจ — ใช้หน้าประวัติแต้ม (ใหม่) ตรวจแล้วปรับมือเป็นราย ๆ แทน
-- ============================================================

create or replace function void_grocery_pos_order_with_rewards(
  p_order_id uuid,
  p_store_id uuid,
  p_voided_by_user_id uuid,
  p_reason text default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_entry loyalty_ledger%rowtype;
  v_reversal_id uuid;
  v_balance numeric(12,2);
  v_applied numeric(12,2);
  v_shortfall numeric(12,2);
  v_entry_reason text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
begin
  select *
    into v_order
    from orders
   where id = p_order_id
     and store_id = p_store_id
     and status in ('pending_payment', 'open')
   for update;

  if not found then
    raise exception 'ไม่สามารถยกเลิกออร์เดอร์นี้ได้';
  end if;

  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนยกเลิกออร์เดอร์';
  end if;

  if p_voided_by_user_id <> auth.uid() then
    raise exception 'ผู้ยกเลิกออร์เดอร์ไม่ถูกต้อง';
  end if;

  if not auth_user_role_in_store(v_order.organization_id, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์ยกเลิกออร์เดอร์นี้';
  end if;

  update coupon_redemptions
     set voided_at = now()
   where order_id = p_order_id
     and store_id = p_store_id
     and voided_at is null;

  -- Product reward vouchers attached to this order become usable again.
  -- Expiry still applies at next use, so releasing an expired voucher is safe.
  update loyalty_reward_redemptions
     set status = 'pending',
         used_at = null,
         used_order_id = null,
         fulfilled_at = null
   where used_order_id = p_order_id
     and store_id = p_store_id
     and status = 'fulfilled';

  for v_entry in
    select *
      from loyalty_ledger
     where order_id = p_order_id
       and store_id = p_store_id
       and type in ('earn', 'redeem')
  loop
    v_reversal_id := null;

    -- ยอดที่คืนได้จริง: balance ห้ามติดลบ (CHECK points_balance >= 0)
    -- เดิมเขียน ledger เต็มจำนวนแล้วค่อย greatest(0, ...) ตอนอัปเดต balance
    -- ทำให้ ledger กับ balance ไม่ตรงกันเงียบ ๆ เมื่อลูกค้าใช้แต้มไปก่อนบิลถูกยกเลิก
    -- (audit ข้อ 8) — ตอนนี้ clamp ที่ "จำนวนที่บันทึก" แทน ledger จึงเท่ากับ balance เสมอ
    select points_balance
      into v_balance
      from loyalty_accounts
     where id = v_entry.account_id
       and store_id = p_store_id
     for update;

    if v_entry.points_delta > 0 then
      -- กลับรายการ "ได้แต้ม" = ต้องหักคืน หักได้ไม่เกินที่เหลืออยู่
      v_applied := -least(coalesce(v_balance, 0), v_entry.points_delta);
      v_shortfall := v_entry.points_delta + v_applied;
    else
      -- กลับรายการ "ใช้แต้ม" = คืนแต้มให้ ทำได้เต็มจำนวนเสมอ
      v_applied := -v_entry.points_delta;
      v_shortfall := 0;
    end if;

    v_entry_reason := coalesce(v_reason, 'void_order');
    if v_shortfall > 0 then
      -- บอกให้ชัดว่าคืนได้ไม่ครบเพราะลูกค้าใช้แต้มไปแล้ว จะได้ไม่ต้องมาไล่เดาทีหลัง
      v_entry_reason := v_entry_reason
        || ' (คืนได้ไม่ครบ ขาด ' || trim(to_char(v_shortfall, 'FM999999990.00')) || ' แต้ม เพราะลูกค้าใช้ไปแล้ว)';
    end if;

    insert into loyalty_ledger (
      organization_id,
      store_id,
      account_id,
      customer_id,
      order_id,
      type,
      points_delta,
      reason,
      reversed_entry_id,
      idempotency_key
    )
    values (
      v_entry.organization_id,
      v_entry.store_id,
      v_entry.account_id,
      v_entry.customer_id,
      v_entry.order_id,
      'reversal',
      v_applied,
      v_entry_reason,
      v_entry.id,
      coalesce(v_idempotency_key, p_order_id::text || ':void') || ':' || v_entry.id::text || ':reversal'
    )
    on conflict (store_id, idempotency_key) do nothing
    returning id into v_reversal_id;

    if v_reversal_id is not null then
      -- ใช้ v_applied ตัวเดียวกับที่เขียนลง ledger — ผลรวม ledger จึงเท่ากับ balance เสมอ
      update loyalty_accounts
         set points_balance = points_balance + v_applied,
             updated_at = now()
       where id = v_entry.account_id
         and store_id = p_store_id;
    end if;
  end loop;

  update orders
     set status = 'voided',
         voided_at = now(),
         void_reason = coalesce(v_reason, 'void_order'),
         voided_by_user_id = p_voided_by_user_id
   where id = p_order_id
     and store_id = p_store_id;

  return p_order_id;
end;
$$;
