-- แก้ variance ตอนปิดรอบเงินสด: "เงินที่ควรมี" ต้องหักรายจ่าย/รวมรายรับเงินสด
-- ที่บันทึกมือระหว่างรอบด้วย ไม่ใช่แค่ยอดขายเงินสด POS
--
-- เดิม: expected = opening_float + POS cash sales → บันทึกรายจ่ายเงินสด (เช่น ซื้อของ)
-- ระหว่างรอบแล้วนับเงินจริงได้น้อยกว่า ทำให้ variance โชว์ "ขาด" ทั้งที่ไม่ได้ขาด
--
-- ใหม่: expected = opening_float + (ยอด ledger ล่าสุด − ยอด ledger ณ ตอนเปิดรอบ)
-- cash_ledger_entries เก็บ balance_after สะสมของทุกการเคลื่อนไหวเงินสด
-- (pos_sale / income / expense / adjustment) — ทุกการจ่ายเงินสด POS เขียน ledger ผ่าน
-- close_pos_order_payment เสมอ (path สมาชิก/รางวัลก็เรียกตัวเดียวกัน) ส่วนต่าง balance
-- จึงเท่ากับเงินสดเข้า-ออกจริงระหว่างรอบ โดยไม่ต้องเดาเครื่องหมายของแต่ละประเภท
-- (สอดคล้องกับ getCurrentCashDrawer ฝั่งแอปที่ deploy ไปแล้ว)
--
-- คอลัมน์ cash_sales ยังเก็บ "ยอดขายเงินสด POS" ตามเดิม (ไว้โชว์แยกบรรทัด)

create or replace function close_cash_session(
  p_session_id uuid,
  p_store_id uuid,
  p_closing_count numeric,
  p_note text default null
)
returns cash_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session cash_sessions%rowtype;
  v_cash_sales numeric := 0;
  v_balance_now numeric;
  v_balance_at_open numeric;
  v_ledger_delta numeric := 0;
  v_expected numeric;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  if p_closing_count is null or p_closing_count < 0 then
    raise exception 'ยอดเงินนับจริงไม่ถูกต้อง';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 0));

  select *
    into v_session
    from cash_sessions
    where id = p_session_id
      and store_id = p_store_id
    for update;
  if not found then
    raise exception 'ไม่พบรอบเงินสด';
  end if;

  if v_session.status <> 'open' then
    raise exception 'รอบเงินสดนี้ปิดไปแล้ว';
  end if;

  if not auth_user_has_permission(v_session.organization_id, p_store_id, 'cashflow.record') then
    raise exception 'ไม่มีสิทธิ์ปิดรอบเงินสด';
  end if;

  -- ยอดขายเงินสด POS (net เข้าเครื่อง = รับมา − ทอน) — เก็บโชว์ในคอลัมน์ cash_sales
  select coalesce(sum(
    case
      when p.received_amount is not null and p.change_amount is not null
        then p.received_amount - p.change_amount
      else p.amount
    end
  ), 0)
    into v_cash_sales
    from payments p
    join orders o on o.id = p.order_id
    where o.store_id = p_store_id
      and p.method = 'cash'
      and p.status = 'completed'
      and p.processed_at >= v_session.opened_at
      and p.processed_at <= now();

  -- เงินสดเข้า-ออกจริงระหว่างรอบ จากส่วนต่าง balance ของ cash ledger
  select balance_after
    into v_balance_now
    from cash_ledger_entries
    where store_id = p_store_id
    order by created_at desc
    limit 1;

  select balance_after
    into v_balance_at_open
    from cash_ledger_entries
    where store_id = p_store_id
      and created_at < v_session.opened_at
    order by created_at desc
    limit 1;

  v_ledger_delta := coalesce(v_balance_now, 0) - coalesce(v_balance_at_open, 0);

  v_expected := round(v_session.opening_float + v_ledger_delta, 2);

  update cash_sessions
     set status        = 'closed',
         closing_count = round(p_closing_count, 2),
         cash_sales    = round(v_cash_sales, 2),
         expected_cash = v_expected,
         variance      = round(p_closing_count, 2) - v_expected,
         closed_by_user_id = auth.uid(),
         closed_at     = now(),
         close_note    = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at    = now()
   where id = p_session_id
   returning * into v_session;

  return v_session;
end;
$$;

revoke execute on function close_cash_session(uuid, uuid, numeric, text) from public, anon;
grant execute on function close_cash_session(uuid, uuid, numeric, text) to authenticated;
