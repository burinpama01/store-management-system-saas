-- ============================================================
-- เฟส C3+C4 — เคลียร์เงินเจ้าของ + คืนของ/ของเสีย/นับ + รายงานรายวัน
-- (Plan/Resale and Consignment Goods Implementation Plan v2.html ข้อ 7, 7.1, 8)
--
-- ยอดที่ต้องจ่ายคำนวณจากสมุด resale_movements ตอนกดเคลียร์ (ไม่มีตารางยอดรายวันแยก — ไม่มีอะไรให้เพี้ยน):
--   + แถวขาย (sale) ที่ยังไม่เคลียร์ ของบิลที่ "จ่ายแล้ว" และรายการไม่ถูกยกเลิก (สุทธิหลังคืนบางส่วน)
--   + แถวร้านซื้อของฝากไว้เอง (store_buyout) ที่ยังไม่เคลียร์
--   − ยอดที่เคยจ่ายไปแล้วแต่ภายหลังถูกยกเลิก/คืนเงิน (clawback)
--   − ยอดติดลบที่ยกมาจากรอบก่อน
--   แถวขายของบิลที่ยังไม่จ่าย → รอรอบถัดไป · บิลยกเลิก/คืนเงินก่อนเคลียร์ → ปิดทิ้งเป็น 0
--   ติดลบ = ไม่จ่าย ยกไปหักรอบหน้า (carry_out)
-- เคลียร์ 1 ครั้งต่อเจ้าของต่อคราว (ล็อกแถวผู้ขาย) · UI ส่งยอดที่เห็นมา ถ้าไม่ตรง = ปฏิเสธ (มีขายเพิ่มระหว่างนั้น)
-- ============================================================

create table if not exists public.consignment_settlements (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  supplier_id     uuid not null references public.suppliers(id) on delete restrict,
  trigger_kind    text not null check (trigger_kind in ('daily_close', 'restock', 'manual')),
  qty_sold        int not null default 0,
  gross_sales     numeric(12,2) not null default 0,
  owner_due       numeric(12,2) not null default 0,
  clawback        numeric(12,2) not null default 0,
  carry_in        numeric(12,2) not null default 0,
  carry_out       numeric(12,2) not null default 0 check (carry_out >= 0),
  paid_amount     numeric(12,2) not null default 0 check (paid_amount >= 0),
  payout_method   text check (payout_method in ('cash', 'transfer')),
  transaction_id  uuid,
  note            text check (note is null or char_length(note) <= 300),
  settled_by      uuid,
  settled_at      timestamptz not null default now()
);
create index if not exists consignment_settlements_supplier_idx
  on public.consignment_settlements (supplier_id, settled_at desc);
create index if not exists consignment_settlements_store_idx
  on public.consignment_settlements (store_id, settled_at desc);

alter table public.consignment_settlements enable row level security;
drop policy if exists "consignment_settlements_manager_select" on public.consignment_settlements;
create policy "consignment_settlements_manager_select" on public.consignment_settlements for select
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- ยอดสุทธิของแถวขาย = owner_amount + ยอดคืนที่อ้างแถวนี้ (ติดลบ)
create or replace function public.resale_net_owner(p_movement_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.owner_amount + coalesce((select sum(r.owner_amount) from public.resale_movements r where r.reverses_id = m.id), 0)
    from public.resale_movements m where m.id = p_movement_id;
$$;
revoke all on function public.resale_net_owner(uuid) from public, anon, authenticated;

-- สถานะของแถวขาย: billable (นับ) / pending (บิลยังไม่จ่าย) / dead (ยกเลิก/คืนเงิน/ลบ)
create or replace function public.resale_sale_state(p_order_item_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when oi.id is null then 'dead'
    when coalesce(oi.voided, false) then 'dead'
    when o.status = 'paid' then 'billable'
    when o.status in ('voided', 'cancelled', 'refunded') then 'dead'
    else 'pending'
  end
  from (select p_order_item_id as id) x
  left join public.order_items oi on oi.id = x.id
  left join public.orders o on o.id = oi.order_id;
$$;
revoke all on function public.resale_sale_state(uuid) from public, anon, authenticated;

-- ---------- พรีวิวยอดเคลียร์ (ไม่เขียนอะไร) ----------
create or replace function public.consignment_settlement_preview(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_s record;
  v_lines jsonb;
  v_due numeric;
  v_qty int;
  v_gross numeric;
  v_claw numeric;
  v_carry numeric;
  v_pending int;
begin
  select id, organization_id, store_id, name, payout_method, payout_account, settle_cycle into v_s
    from public.suppliers where id = p_supplier_id;
  -- cashier อ่านได้เพื่อแยกเงินตอนปิดรอบ
  if v_s.id is null or not public.auth_user_role_in_store(v_s.organization_id, v_s.store_id, 'cashier') then
    raise exception 'supplier not found';
  end if;
  if not public.organization_has_consignment(v_s.organization_id) then
    raise exception 'consignment requires enterprise plan';
  end if;

  with b as (
    select m.id, m.product_id, m.option_id, m.movement_type,
           public.resale_net_owner(m.id) as net,
           -m.qty - coalesce((select sum(r.qty) from public.resale_movements r where r.reverses_id = m.id), 0) as net_qty,
           case when m.movement_type = 'sale' then public.resale_sale_state(m.order_item_id) else 'billable' end as st,
           m.order_item_id
      from public.resale_movements m
     where m.supplier_id = p_supplier_id and m.mode = 'consignment'
       and m.movement_type in ('sale', 'store_buyout') and m.settlement_id is null and not m.needs_flavor
  ), billable as (
    select b.*, coalesce(round(oi.total_price * b.net_qty / nullif(oi.quantity, 0), 2), 0) as gross
      from b left join public.order_items oi on oi.id = b.order_item_id
     where b.st = 'billable' and b.net_qty > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('productId', product_id, 'optionId', option_id, 'qty', qty, 'gross', gross, 'due', due)
                            order by product_id, option_id), '[]'::jsonb),
         coalesce(sum(due), 0), coalesce(sum(qty), 0)::int, coalesce(sum(gross), 0)
    into v_lines, v_due, v_qty, v_gross
    from (select product_id, option_id, sum(net_qty)::int as qty, sum(gross) as gross, sum(net) as due
            from billable group by product_id, option_id) g;

  select coalesce(sum(m.settled_amount - public.resale_net_owner(m.id)), 0) into v_claw
    from public.resale_movements m
   where m.supplier_id = p_supplier_id and m.settlement_id is not null
     and m.movement_type = 'sale' and m.settled_amount > public.resale_net_owner(m.id);

  select coalesce((select carry_out from public.consignment_settlements
                    where supplier_id = p_supplier_id order by settled_at desc, id desc limit 1), 0) into v_carry;

  select count(*) into v_pending from public.resale_movements m
   where m.supplier_id = p_supplier_id and m.mode = 'consignment' and m.movement_type = 'sale'
     and m.settlement_id is null and (m.needs_flavor or public.resale_sale_state(m.order_item_id) = 'pending')
     and -m.qty - coalesce((select sum(r.qty) from public.resale_movements r where r.reverses_id = m.id), 0) > 0;

  return jsonb_build_object(
    'supplierId', v_s.id, 'name', v_s.name, 'payoutMethod', v_s.payout_method, 'payoutAccount', v_s.payout_account,
    'settleCycle', v_s.settle_cycle, 'lines', v_lines, 'qtySold', v_qty, 'grossSales', v_gross,
    'ownerDue', v_due, 'clawback', v_claw, 'carryIn', v_carry,
    'total', round(v_due - v_claw - v_carry, 2), 'pendingRows', v_pending
  );
end;
$$;
revoke all on function public.consignment_settlement_preview(uuid) from public, anon;
grant execute on function public.consignment_settlement_preview(uuid) to authenticated;

-- ---------- เคลียร์เงิน ----------
create or replace function public.consignment_settle(
  p_supplier_id uuid, p_method text, p_trigger text, p_expected_total numeric, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s record;
  v_id uuid;
  v_tx uuid;
  v_m record;
  v_state text;
  v_net numeric;
  v_nq int;
  v_due numeric := 0;
  v_qty int := 0;
  v_gross numeric := 0;
  v_claw numeric := 0;
  v_carry numeric;
  v_total numeric;
  v_paid numeric;
  v_touched int := 0;
begin
  select id, organization_id, store_id, name, is_active into v_s
    from public.suppliers where id = p_supplier_id for update;  -- เคลียร์ทีละคราวต่อเจ้าของ
  if v_s.id is null then
    raise exception 'supplier not found';
  end if;
  if p_trigger not in ('daily_close', 'restock', 'manual') then
    raise exception 'invalid settlement trigger';
  end if;
  if p_method not in ('cash', 'transfer') then
    raise exception 'invalid payout method';
  end if;
  -- ปิดรอบ: แคชเชียร์แยกเงินสดให้เจ้าของรอบรายวันได้ · อย่างอื่นต้องผู้จัดการ
  perform public.resale_assert_operator(v_s.organization_id, v_s.store_id,
    case when p_trigger = 'daily_close' and p_method = 'cash' then 'cashier' else 'manager' end);
  if p_note is not null and char_length(p_note) > 300 then
    raise exception 'note too long';
  end if;

  insert into public.consignment_settlements (organization_id, store_id, supplier_id, trigger_kind, payout_method, note, settled_by)
  values (v_s.organization_id, v_s.store_id, p_supplier_id, p_trigger, p_method, p_note, auth.uid())
  returning id into v_id;

  -- ยอดคำนวณจากแถวที่ล็อกและปิดจริงในรอบนี้เท่านั้น (แถวขายที่ commit เข้ามาระหว่างนี้รอรอบหน้า)
  for v_m in
    select m.id, m.movement_type, m.order_item_id, m.qty from public.resale_movements m
     where m.supplier_id = p_supplier_id and m.mode = 'consignment'
       and m.movement_type in ('sale', 'store_buyout') and m.settlement_id is null and not m.needs_flavor
     order by m.seq
     for update
  loop
    v_state := case when v_m.movement_type = 'store_buyout' then 'billable' else public.resale_sale_state(v_m.order_item_id) end;
    continue when v_state = 'pending';
    v_net := case when v_state = 'billable' then public.resale_net_owner(v_m.id) else 0 end;
    update public.resale_movements set settlement_id = v_id, settled_amount = v_net where id = v_m.id;
    v_touched := v_touched + 1;
    if v_state = 'billable' and v_m.movement_type = 'sale' then
      v_nq := -v_m.qty - coalesce((select sum(r.qty) from public.resale_movements r where r.reverses_id = v_m.id), 0);
      if v_nq > 0 then
        v_qty := v_qty + v_nq;
        v_gross := v_gross + coalesce((select round(oi.total_price * v_nq / nullif(oi.quantity, 0), 2)
                                         from public.order_items oi where oi.id = v_m.order_item_id), 0);
      end if;
    end if;
    v_due := v_due + v_net;
  end loop;

  -- clawback: แถวที่เคยจ่ายแล้วแต่ยอดสุทธิลดลง (ยกเลิก/คืนเงินหลังเคลียร์)
  for v_m in
    select m.id, m.settled_amount from public.resale_movements m
     where m.supplier_id = p_supplier_id and m.settlement_id is not null and m.settlement_id <> v_id
       and m.movement_type = 'sale'
     for update
  loop
    v_net := public.resale_net_owner(v_m.id);
    if v_m.settled_amount > v_net then
      v_claw := v_claw + (v_m.settled_amount - v_net);
      update public.resale_movements set settled_amount = v_net, clawback_settlement_id = v_id where id = v_m.id;
      v_touched := v_touched + 1;
    end if;
  end loop;

  if v_due = 0 and v_claw = 0 then
    raise exception 'nothing to settle';
  end if;

  select coalesce((select carry_out from public.consignment_settlements
                    where supplier_id = p_supplier_id and id <> v_id order by settled_at desc, id desc limit 1), 0)
    into v_carry;
  v_total := round(v_due - v_claw - v_carry, 2);
  if p_expected_total is null or round(p_expected_total, 2) <> v_total then
    raise exception 'settlement amount changed';
  end if;
  v_paid := greatest(v_total, 0);

  update public.consignment_settlements
     set qty_sold = v_qty, gross_sales = v_gross, owner_due = v_due, clawback = v_claw, carry_in = v_carry,
         carry_out = greatest(-v_total, 0), paid_amount = v_paid,
         payout_method = case when v_paid > 0 then p_method end
   where id = v_id;

  if v_paid > 0 then
    v_tx := public.resale_record_expense(v_s.organization_id, v_s.store_id, 'จ่ายค่าสินค้าฝากขาย', v_paid, p_method,
                                         'ฝากขาย: ' || v_s.name, auth.uid());
    update public.consignment_settlements set transaction_id = v_tx where id = v_id;
  end if;

  return jsonb_build_object('settlementId', v_id, 'paid', v_paid, 'carryOut', greatest(-v_total, 0), 'transactionId', v_tx);
end;
$$;
revoke all on function public.consignment_settle(uuid, text, text, numeric, text) from public, anon;
grant execute on function public.consignment_settle(uuid, text, text, numeric, text) to authenticated;

-- ---------- คืนของ / ของเสีย / นับ / ร้านซื้อไว้เอง (C4) ----------
-- p_kind: return_owner (ฝากขายเท่านั้น) · damage · count_adjust (p_qty มีเครื่องหมาย) · store_buyout (ฝากขายเท่านั้น)
create or replace function public.consignment_adjust_lot(p_lot_id uuid, p_kind text, p_qty int, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_l record;
  v_delta int;
  v_liab text;
  v_owner numeric := 0;
begin
  select * into v_l from public.resale_lots where id = p_lot_id for update;
  if v_l.id is null then
    raise exception 'lot not found';
  end if;
  perform public.resale_assert_operator(v_l.organization_id, v_l.store_id);
  if p_note is not null and char_length(p_note) > 300 then
    raise exception 'note too long';
  end if;
  if p_qty is null or p_qty = 0 or abs(p_qty) > 100000 then
    raise exception 'invalid quantity';
  end if;

  if p_kind in ('return_owner', 'store_buyout') then
    if v_l.mode <> 'consignment' then
      raise exception 'only consignment lots';
    end if;
    if p_qty < 0 or p_qty > v_l.qty_remaining then
      raise exception 'not enough stock in lot';
    end if;
    v_delta := -p_qty;
    if p_kind = 'store_buyout' then
      -- ร้านรับซื้อ = ต้องจ่ายเจ้าของเหมือนขายได้ · หัก % = ราคาขาย (รวมส่วนต่างรส) × (100 − %ร้าน)
      select case when p.consign_pricing = 'percent'
                  then round((p.base_price + coalesce(o.price_adjustment, 0)) * (100 - p.consign_store_pct) / 100 * p_qty, 2)
                  else round(v_l.unit_cost * p_qty, 2) end
        into v_owner
        from public.products p left join public.modifier_options o on o.id = v_l.option_id
       where p.id = v_l.product_id;
    end if;
  elsif p_kind = 'damage' then
    if p_qty < 0 or p_qty > v_l.qty_remaining then
      raise exception 'not enough stock in lot';
    end if;
    v_delta := -p_qty;
    v_liab := case when v_l.mode = 'resale' then 'store' else 'owner' end;
  elsif p_kind = 'count_adjust' then
    if p_qty < 0 and -p_qty > v_l.qty_remaining then
      raise exception 'not enough stock in lot';
    end if;
    v_delta := p_qty;
    v_liab := case when p_qty < 0 then case when v_l.mode = 'resale' then 'store' else 'owner' end end;
  else
    raise exception 'invalid adjustment';
  end if;

  update public.resale_lots
     set qty_remaining = qty_remaining + v_delta,
         qty_received = qty_received + greatest(v_delta, 0)  -- นับเจอเกิน: เพิ่มยอดรับด้วย (คงเงื่อนไข remaining ≤ received)
   where id = p_lot_id;
  insert into public.resale_movements (organization_id, store_id, product_id, option_id, lot_id, supplier_id, mode,
    movement_type, qty, unit_cost, owner_amount, liability, actor_id, note)
  values (v_l.organization_id, v_l.store_id, v_l.product_id, v_l.option_id, v_l.id, v_l.supplier_id, v_l.mode,
    p_kind, v_delta, v_l.unit_cost, v_owner, v_liab, auth.uid(), p_note);
  perform public.resale_sync_availability(v_l.product_id, v_l.option_id);
  return jsonb_build_object('lotId', v_l.id, 'qtyRemaining', v_l.qty_remaining + v_delta, 'ownerAmount', v_owner);
end;
$$;
revoke all on function public.consignment_adjust_lot(uuid, text, int, text) from public, anon;
grant execute on function public.consignment_adjust_lot(uuid, text, int, text) to authenticated;

-- ---------- รายงานรายวัน (ตามวันไทย) ----------
-- ต่อวัน/ต่อเจ้าของ/ต่อเมนู-รส: ชิ้นที่ขาย (บิลจ่ายแล้ว สุทธิหลังคืน), ยอดขาย, ต้องจ่ายเจ้าของ, ต้นทุนซื้อขาด,
-- ร้านได้, ยังไม่เคลียร์ · รวมของเสีย/คืนของ/ซื้อไว้เอง
create or replace function public.consignment_daily_report(p_store_id uuid, p_from date, p_to date)
returns table (
  day date, supplier_id uuid, product_id uuid, option_id uuid, mode text,
  qty_sold int, gross_sales numeric, owner_due numeric, resale_cost numeric, store_profit numeric,
  unsettled_due numeric, damaged_store int, damaged_owner int, returned int, bought_out int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or not public.auth_user_role_in_store(v_org, p_store_id, 'manager') then
    raise exception 'consignment requires manager role';
  end if;
  if not public.organization_has_consignment(v_org) then
    raise exception 'consignment requires enterprise plan';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception 'invalid date range';
  end if;
  return query
  with m as (
    select mv.*, (mv.created_at at time zone 'Asia/Bangkok')::date as d
      from public.resale_movements mv
     where mv.store_id = p_store_id
       and mv.created_at >= (p_from::timestamp at time zone 'Asia/Bangkok')
       and mv.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Bangkok')
       and mv.movement_type in ('sale', 'damage', 'count_adjust', 'return_owner', 'store_buyout')
  ), sales as (
    select m.d, m.supplier_id, m.product_id, m.option_id, m.mode,
           -m.qty - coalesce((select sum(r.qty) from public.resale_movements r where r.reverses_id = m.id), 0) as nq,
           public.resale_net_owner(m.id) as net,
           m.unit_cost, m.settlement_id, m.order_item_id
      from m where m.movement_type = 'sale' and not m.needs_flavor
       and public.resale_sale_state(m.order_item_id) = 'billable'
  ), s2 as (
    select s.*, coalesce(round(oi.total_price * s.nq / nullif(oi.quantity, 0), 2), 0) as gross
      from sales s left join public.order_items oi on oi.id = s.order_item_id
     where s.nq > 0
  )
  select x.d, x.supplier_id, x.product_id, x.option_id, x.mode,
         sum(x.qs)::int, sum(x.gs), sum(x.od), sum(x.rc),
         sum(x.gs) - sum(x.od) - sum(x.rc),
         sum(x.ud),
         sum(x.dst)::int, sum(x.dow)::int, sum(x.ret)::int, sum(x.bo)::int
    from (
      select d, s2.supplier_id, s2.product_id, s2.option_id, s2.mode, nq as qs, gross as gs,
             case when s2.mode = 'consignment' then net else 0 end as od,
             case when s2.mode = 'resale' then s2.unit_cost * nq else 0 end as rc,
             case when s2.mode = 'consignment' and s2.settlement_id is null then net else 0 end as ud,
             0 as dst, 0 as dow, 0 as ret, 0 as bo
        from s2
      union all
      select d, m.supplier_id, m.product_id, m.option_id, m.mode, 0, 0,
             case when m.movement_type = 'store_buyout' then m.owner_amount else 0 end,
             -- ซื้อขาดของเสีย/หาย = ค่าเสียหายของร้าน (นับเป็นต้นทุน)
             case when m.mode = 'resale' and m.liability = 'store' then m.unit_cost * -m.qty else 0 end,
             case when m.movement_type = 'store_buyout' and m.settlement_id is null then m.owner_amount else 0 end,
             case when m.liability = 'store' then -m.qty else 0 end,
             case when m.liability = 'owner' then -m.qty else 0 end,
             case when m.movement_type = 'return_owner' then -m.qty else 0 end,
             case when m.movement_type = 'store_buyout' then -m.qty else 0 end
        from m where m.movement_type <> 'sale'
    ) x
   group by x.d, x.supplier_id, x.product_id, x.option_id, x.mode
   order by x.d desc, x.supplier_id, x.product_id;
end;
$$;
revoke all on function public.consignment_daily_report(uuid, date, date) from public, anon;
grant execute on function public.consignment_daily_report(uuid, date, date) to authenticated;
