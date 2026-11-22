-- ============================================================
-- เฟส A1 — บิลซื้อด้วยมือ + บิลค้างจ่าย (Plan/Purchasing and Ingredient Inventory Plan v4.html)
--
--   * purchase_bills / purchase_bill_lines — บรรทัดเป็นวัตถุดิบ (เข้าคลัง) หรือค่าใช้จ่ายอื่น (หมวดบัญชี)
--   * purchase_bill_post (ธุรกรรมเดียว): รับเข้าคลัง → ต้นทุนเฉลี่ย → ราคาซื้อล่าสุด + ประวัติราคา → รายจ่าย (ถ้าจ่ายแล้ว)
--   * กติกาติดลบ (v3/v4): ยอดติดลบตอนรับของ → movement negative_reset ล้างเป็น 0 ก่อน แล้วค่อย receive
--     ⇒ ยอดหลังรับ = จำนวนที่ซื้อเข้ามาใหม่ (ไม่ถมยอดติดลบ) · ส่วนติดลบไปอยู่รายงาน "ใช้เกินก่อนรับของ"
--   * ยกเลิกบิล = กลับรายการ (receive_void + รายรับคืนเงิน) ไม่ลบ · ไม่ย้อน negative_reset (ใช้เกินไปแล้วจริง)
--   * เงินสด: ใช้ resale_record_expense (ตรวจลิ้นชักใน DB + advisory lock) ที่มีอยู่แล้ว
-- ============================================================

-- 1) ชนิด movement ใหม่
alter table public.ingredient_movements drop constraint if exists ingredient_movements_movement_type_check;
alter table public.ingredient_movements add constraint ingredient_movements_movement_type_check
  check (movement_type in (
    'opening', 'manual_adjust', 'receive', 'receive_void', 'negative_reset',
    'sale_usage', 'sale_restore', 'waste', 'count_adjust'
  ));

-- 2) บิลซื้อ
create table if not exists public.purchase_bills (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  store_id         uuid not null references public.stores(id) on delete cascade,
  supplier_id      uuid references public.suppliers(id) on delete restrict,
  supplier_name    text check (supplier_name is null or char_length(supplier_name) <= 120),
  bill_no          text check (bill_no is null or char_length(bill_no) <= 60),
  bill_date        date not null,
  is_tax_invoice   boolean not null default false,
  subtotal         numeric(12,2) not null check (subtotal >= 0),
  discount         numeric(12,2) not null default 0 check (discount >= 0),
  vat_amount       numeric(12,2) not null default 0 check (vat_amount >= 0),
  total            numeric(12,2) not null check (total >= 0),
  payment_status   text not null check (payment_status in ('paid', 'unpaid')),
  payment_method   text check (payment_method in ('cash', 'transfer')),
  due_date         date,
  paid_at          timestamptz,
  source           text not null default 'manual' check (source in ('manual', 'ai')),
  note             text check (note is null or char_length(note) <= 300),
  status           text not null default 'posted' check (status in ('posted', 'voided')),
  posted_by        uuid,
  posted_at        timestamptz not null default now(),
  voided_by        uuid,
  voided_at        timestamptz,
  void_reason      text check (void_reason is null or char_length(void_reason) <= 300),
  check ((payment_status = 'paid') = (payment_method is not null)),
  check (total = round(subtotal - discount + vat_amount, 2))
);
create index if not exists purchase_bills_store_idx on public.purchase_bills (store_id, bill_date desc);
create index if not exists purchase_bills_unpaid_idx on public.purchase_bills (store_id, due_date)
  where payment_status = 'unpaid' and status = 'posted';
-- กันบิลซ้ำ: เลขบิลเดียวกันของผู้ขายเดียวกัน (เฉพาะที่ยังไม่ยกเลิก)
create unique index if not exists purchase_bills_supplier_no_unique_idx
  on public.purchase_bills (store_id, supplier_id, lower(btrim(bill_no)))
  where supplier_id is not null and bill_no is not null and status = 'posted';

create table if not exists public.purchase_bill_lines (
  id                   uuid primary key default gen_random_uuid(),
  bill_id              uuid not null references public.purchase_bills(id) on delete cascade,
  line_no              int not null check (line_no between 1 and 200),
  ingredient_id        uuid references public.ingredients(id) on delete restrict,
  expense_category_id  uuid references public.accounting_categories(id) on delete restrict,
  raw_name             text not null check (btrim(raw_name) <> '' and char_length(raw_name) <= 200),
  qty                  numeric(14,4) not null check (qty > 0),
  unit_label           text check (unit_label is null or char_length(unit_label) <= 30),
  unit_price           numeric(14,4) not null check (unit_price >= 0),
  line_total           numeric(12,2) not null check (line_total >= 0),
  usage_qty            numeric(14,4),   -- วัตถุดิบ: qty × usage_per_purchase (หน่วยใช้)
  check ((ingredient_id is null) <> (expense_category_id is null)),
  unique (bill_id, line_no)
);
create index if not exists purchase_bill_lines_bill_idx on public.purchase_bill_lines (bill_id);
create index if not exists purchase_bill_lines_ingredient_idx on public.purchase_bill_lines (ingredient_id) where ingredient_id is not null;

-- ผูกรายจ่ายของบิล (จ่ายตอนโพสต์/จ่ายภายหลัง/คืนเงินตอนยกเลิก)
create table if not exists public.purchase_bill_payments (
  id              uuid primary key default gen_random_uuid(),
  bill_id         uuid not null references public.purchase_bills(id) on delete cascade,
  kind            text not null check (kind in ('payment', 'void_refund')),
  transaction_id  uuid not null,
  amount          numeric(12,2) not null,
  method          text not null check (method in ('cash', 'transfer')),
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index if not exists purchase_bill_payments_bill_idx on public.purchase_bill_payments (bill_id);

alter table public.purchase_bills enable row level security;
alter table public.purchase_bill_lines enable row level security;
alter table public.purchase_bill_payments enable row level security;
drop policy if exists "purchase_bills_manager_select" on public.purchase_bills;
create policy "purchase_bills_manager_select" on public.purchase_bills for select
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));
drop policy if exists "purchase_bill_lines_manager_select" on public.purchase_bill_lines;
create policy "purchase_bill_lines_manager_select" on public.purchase_bill_lines for select
  using (exists (select 1 from public.purchase_bills b where b.id = bill_id
                  and auth_user_role_in_store(b.organization_id, b.store_id, 'manager')));
drop policy if exists "purchase_bill_payments_manager_select" on public.purchase_bill_payments;
create policy "purchase_bill_payments_manager_select" on public.purchase_bill_payments for select
  using (exists (select 1 from public.purchase_bills b where b.id = bill_id
                  and auth_user_role_in_store(b.organization_id, b.store_id, 'manager')));

-- ---------- ตัวช่วย ----------
create or replace function public.purchase_assert_operator(p_org uuid, p_store uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not public.auth_user_role_in_store(p_org, p_store, 'manager')
     or not public.organization_has_stock_management(p_org) then
    raise exception 'inventory requires manager role and stockManagement access';
  end if;
  if not exists (select 1 from public.stores where id = p_store and inventory_enabled) then
    raise exception 'inventory is not enabled for this store';
  end if;
end;
$$;
revoke all on function public.purchase_assert_operator(uuid, uuid) from public, anon, authenticated;

-- รับเข้า 1 บรรทัดวัตถุดิบ (ล้างติดลบก่อน) — คืน {after, reset} จากแถวที่ล็อกแล้ว
create or replace function public.inventory_receive_line(
  p_ingredient_id uuid, p_usage_qty numeric, p_unit_cost numeric, p_bill_id uuid, p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ing record;
  v_stock public.ingredient_stock%rowtype;
  v_avg numeric;
  v_reset boolean := false;
begin
  select id, organization_id, store_id into v_ing from public.ingredients where id = p_ingredient_id;
  insert into public.ingredient_stock (ingredient_id, organization_id, store_id)
  values (v_ing.id, v_ing.organization_id, v_ing.store_id)
  on conflict (ingredient_id) do nothing;
  select * into v_stock from public.ingredient_stock where ingredient_id = v_ing.id for update;

  -- กติกาติดลบ: ซื้อเข้า = นับใหม่ตามที่ซื้อ ไม่ถมยอดติดลบ
  if v_stock.on_hand < 0 then
    insert into public.ingredient_movements (organization_id, store_id, ingredient_id, movement_type,
      qty_delta, before_qty, after_qty, unit_cost, reason, reference_type, reference_id, actor_id)
    values (v_ing.organization_id, v_ing.store_id, v_ing.id, 'negative_reset',
      -v_stock.on_hand, v_stock.on_hand, 0, v_stock.avg_unit_cost,
      'ใช้เกินก่อนรับของ (ล้างยอดติดลบตอนซื้อเข้า)', 'purchase_bill', p_bill_id, p_actor);
    v_stock.on_hand := 0;
    v_reset := true;
  end if;

  v_avg := case when v_stock.on_hand <= 0 then p_unit_cost
                else round((v_stock.on_hand * v_stock.avg_unit_cost + p_usage_qty * p_unit_cost) / (v_stock.on_hand + p_usage_qty), 6)
           end;
  insert into public.ingredient_movements (organization_id, store_id, ingredient_id, movement_type,
    qty_delta, before_qty, after_qty, unit_cost, reason, reference_type, reference_id, actor_id)
  values (v_ing.organization_id, v_ing.store_id, v_ing.id, 'receive',
    p_usage_qty, v_stock.on_hand, v_stock.on_hand + p_usage_qty, round(p_unit_cost, 6),
    null, 'purchase_bill', p_bill_id, p_actor);
  update public.ingredient_stock
     set on_hand = v_stock.on_hand + p_usage_qty, avg_unit_cost = v_avg, updated_at = now()
   where ingredient_id = v_ing.id;
  return jsonb_build_object('after', v_stock.on_hand + p_usage_qty, 'reset', v_reset);
end;
$$;
revoke all on function public.inventory_receive_line(uuid, numeric, numeric, uuid, uuid) from public, anon, authenticated;

-- บันทึกรายจ่ายของบิล: วัตถุดิบรวมเป็นหมวด "ซื้อวัตถุดิบ" (ยอด = ยอดสุทธิ − ค่าใช้จ่ายอื่น) · ค่าใช้จ่ายอื่นแยกตามหมวด
create or replace function public.purchase_record_payment(p_bill_id uuid, p_method text, p_actor uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_b record;
  v_other numeric;
  v_ing_amount numeric;
  v_g record;
  v_tx uuid;
  v_label text;
begin
  select * into v_b from public.purchase_bills where id = p_bill_id;
  v_label := coalesce(v_b.supplier_name, (select name from public.suppliers where id = v_b.supplier_id), 'ไม่ระบุผู้ขาย')
             || coalesce(' #' || v_b.bill_no, '');
  select coalesce(sum(line_total), 0) into v_other from public.purchase_bill_lines
   where bill_id = p_bill_id and expense_category_id is not null;
  v_ing_amount := round(v_b.total - v_other, 2);
  if v_ing_amount < 0 then
    raise exception 'bill total is less than other expenses';
  end if;
  for v_g in
    select c.name, sum(l.line_total) as amount
      from public.purchase_bill_lines l join public.accounting_categories c on c.id = l.expense_category_id
     where l.bill_id = p_bill_id group by c.name
  loop
    if v_g.amount > 0 then
      v_tx := public.resale_record_expense(v_b.organization_id, v_b.store_id, v_g.name, v_g.amount, p_method,
                                           'บิลซื้อ: ' || v_label, p_actor);
      insert into public.purchase_bill_payments (bill_id, kind, transaction_id, amount, method, created_by)
      values (p_bill_id, 'payment', v_tx, v_g.amount, p_method, p_actor);
    end if;
  end loop;
  if v_ing_amount > 0 then
    v_tx := public.resale_record_expense(v_b.organization_id, v_b.store_id, 'ซื้อวัตถุดิบ', v_ing_amount, p_method,
                                         'บิลซื้อ: ' || v_label, p_actor);
    insert into public.purchase_bill_payments (bill_id, kind, transaction_id, amount, method, created_by)
    values (p_bill_id, 'payment', v_tx, v_ing_amount, p_method, p_actor);
  end if;
  update public.purchase_bills set payment_status = 'paid', payment_method = p_method, paid_at = now() where id = p_bill_id;
  return v_b.total;
end;
$$;
revoke all on function public.purchase_record_payment(uuid, text, uuid) from public, anon, authenticated;

-- ---------- RPC: โพสต์บิลซื้อ ----------
-- p_bill: {supplierId|null, supplierName|null, billNo|null, billDate, isTaxInvoice, discount, vatAmount, total,
--          paymentStatus: paid|unpaid, paymentMethod: cash|transfer|null, dueDate|null, note|null, source: manual|ai,
--          lines: [{ingredientId|null, expenseCategoryId|null, rawName, qty, unitLabel|null, unitPrice, lineTotal}]}
create or replace function public.purchase_bill_post(p_store_id uuid, p_bill jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_id uuid;
  v_supplier uuid := nullif(p_bill->>'supplierId', '')::uuid;
  v_status text := p_bill->>'paymentStatus';
  v_method text := nullif(p_bill->>'paymentMethod', '');
  v_discount numeric := coalesce((p_bill->>'discount')::numeric, 0);
  v_vat numeric := coalesce((p_bill->>'vatAmount')::numeric, 0);
  v_total numeric := (p_bill->>'total')::numeric;
  v_subtotal numeric := 0;
  v_el jsonb;
  v_n int := 0;
  v_ing record;
  v_qty numeric;
  v_price numeric;
  v_line numeric;
  v_usage numeric;
  v_after jsonb := '{}'::jsonb;
  v_resets int := 0;
  v_recv jsonb;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null then
    raise exception 'store not found';
  end if;
  perform public.purchase_assert_operator(v_org, p_store_id);

  if p_bill is null or jsonb_typeof(p_bill->'lines') <> 'array'
     or jsonb_array_length(p_bill->'lines') = 0 or jsonb_array_length(p_bill->'lines') > 200 then
    raise exception 'invalid bill lines';
  end if;
  if v_status not in ('paid', 'unpaid') then
    raise exception 'invalid payment status';
  end if;
  if v_status = 'paid' and coalesce(v_method, '') not in ('cash', 'transfer') then
    raise exception 'invalid payout method';
  end if;
  if v_supplier is not null and not exists (
    select 1 from public.suppliers where id = v_supplier and store_id = p_store_id and is_active
  ) then
    raise exception 'supplier not found';
  end if;
  if v_discount < 0 or v_vat < 0 or v_total is null or v_total < 0 then
    raise exception 'invalid bill amounts';
  end if;
  -- ยอดบิลต้องตรงกับบรรทัด: Σ ยอดบรรทัด − ส่วนลด + VAT = ยอดสุทธิ
  select coalesce(sum(round((el->>'lineTotal')::numeric, 2)), 0) into v_subtotal
    from jsonb_array_elements(p_bill->'lines') el;
  if round(v_subtotal - v_discount + v_vat, 2) <> round(v_total, 2) then
    raise exception 'bill total does not match lines';
  end if;

  insert into public.purchase_bills (organization_id, store_id, supplier_id, supplier_name, bill_no, bill_date,
    is_tax_invoice, subtotal, discount, vat_amount, total, payment_status, payment_method, due_date, source, note, posted_by)
  values (v_org, p_store_id, v_supplier,
    case when v_supplier is null then nullif(btrim(p_bill->>'supplierName'), '') end,
    nullif(btrim(p_bill->>'billNo'), ''), (p_bill->>'billDate')::date,
    coalesce((p_bill->>'isTaxInvoice')::boolean, false), round(v_subtotal, 2), v_discount, v_vat, round(v_total, 2),
    'unpaid', null, case when v_status = 'unpaid' then nullif(p_bill->>'dueDate', '')::date end,
    case when p_bill->>'source' = 'ai' then 'ai' else 'manual' end,
    nullif(btrim(p_bill->>'note'), ''), auth.uid())
  returning id into v_id;

  for v_el in select * from jsonb_array_elements(p_bill->'lines') loop
    v_n := v_n + 1;
    v_qty := (v_el->>'qty')::numeric;
    v_price := (v_el->>'unitPrice')::numeric;
    v_line := (v_el->>'lineTotal')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > 9999999 or v_price is null or v_price < 0 or v_price > 99999999
       or v_line is null or v_line < 0 or v_line > 99999999 then
      raise exception 'invalid line amounts';
    end if;
    if nullif(v_el->>'ingredientId', '') is not null then
      select id, usage_per_purchase, purchase_price into v_ing from public.ingredients
       where id = (v_el->>'ingredientId')::uuid and store_id = p_store_id;
      if v_ing.id is null then
        raise exception 'ingredient not found';
      end if;
      v_usage := round(v_qty * v_ing.usage_per_purchase, 4);
      insert into public.purchase_bill_lines (bill_id, line_no, ingredient_id, raw_name, qty, unit_label, unit_price, line_total, usage_qty)
      values (v_id, v_n, v_ing.id, left(btrim(coalesce(v_el->>'rawName', '')), 200), v_qty, nullif(v_el->>'unitLabel', ''),
              v_price, round(v_line, 2), v_usage);
      -- ต้นทุนต่อหน่วยใช้ = ยอดบรรทัด ÷ ปริมาณหน่วยใช้ (รวมส่วนลดในบรรทัดแล้ว)
      v_recv := public.inventory_receive_line(v_ing.id, v_usage, case when v_usage > 0 then v_line / v_usage else 0 end, v_id, auth.uid());
      v_after := v_after || jsonb_build_object(v_ing.id::text, (v_recv->>'after')::numeric);
      if (v_recv->>'reset')::boolean then
        v_resets := v_resets + 1;
      end if;
      -- ราคาซื้อล่าสุด (ต่อหน่วยซื้อ) → ต้นทุนต่อจานอัปเดตตามราคาจริง + ประวัติราคาเมื่อเปลี่ยน
      -- (ตั้งใจ: last-write-wins ตามเวลาที่บันทึก ไม่เรียงตามวันที่ในบิล)
      if round(v_line / v_qty, 2) is distinct from v_ing.purchase_price then
        update public.ingredients set purchase_price = round(v_line / v_qty, 2), updated_at = now() where id = v_ing.id;
        insert into public.ingredient_price_history (ingredient_id, purchase_price, recorded_by)
        values (v_ing.id, round(v_line / v_qty, 2), auth.uid());
      end if;
    else
      if not exists (select 1 from public.accounting_categories
                      where id = nullif(v_el->>'expenseCategoryId', '')::uuid and store_id = p_store_id and type = 'expense') then
        raise exception 'expense category not found';
      end if;
      insert into public.purchase_bill_lines (bill_id, line_no, expense_category_id, raw_name, qty, unit_label, unit_price, line_total)
      values (v_id, v_n, (v_el->>'expenseCategoryId')::uuid, left(btrim(coalesce(v_el->>'rawName', '')), 200), v_qty,
              nullif(v_el->>'unitLabel', ''), v_price, round(v_line, 2));
    end if;
  end loop;

  if v_status = 'paid' then
    perform public.purchase_record_payment(v_id, v_method, auth.uid());
  end if;

  return jsonb_build_object('billId', v_id, 'onHandAfter', v_after, 'negativeResets', v_resets);
end;
$$;
revoke all on function public.purchase_bill_post(uuid, jsonb) from public, anon;
grant execute on function public.purchase_bill_post(uuid, jsonb) to authenticated;

-- ---------- RPC: จ่ายบิลค้างจ่าย ----------
create or replace function public.purchase_bill_pay(p_bill_id uuid, p_method text)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_b record;
begin
  select * into v_b from public.purchase_bills where id = p_bill_id for update;
  if v_b.id is null then
    raise exception 'bill not found';
  end if;
  perform public.purchase_assert_operator(v_b.organization_id, v_b.store_id);
  if v_b.status <> 'posted' then
    raise exception 'bill is voided';
  end if;
  if v_b.payment_status = 'paid' then
    raise exception 'bill already paid';
  end if;
  if p_method not in ('cash', 'transfer') then
    raise exception 'invalid payout method';
  end if;
  return public.purchase_record_payment(p_bill_id, p_method, auth.uid());
end;
$$;
revoke all on function public.purchase_bill_pay(uuid, text) from public, anon;
grant execute on function public.purchase_bill_pay(uuid, text) to authenticated;

-- ---------- RPC: ยกเลิกบิล (กลับรายการ ไม่ลบ) ----------
create or replace function public.purchase_bill_void(p_bill_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_b record;
  v_l record;
  v_stock public.ingredient_stock%rowtype;
  v_p record;
  v_cat uuid;
  v_tx uuid;
  v_prev numeric;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_refund numeric := 0;
begin
  select * into v_b from public.purchase_bills where id = p_bill_id for update;
  if v_b.id is null then
    raise exception 'bill not found';
  end if;
  perform public.purchase_assert_operator(v_b.organization_id, v_b.store_id);
  if v_b.status = 'voided' then
    raise exception 'bill is voided';
  end if;
  if v_reason is null or char_length(v_reason) > 300 then
    raise exception 'void requires a reason';
  end if;

  -- คืนเฉพาะจำนวนที่ซื้อ (ติดลบได้) · ไม่ย้อน negative_reset
  -- ต้นทุนเฉลี่ยคงเดิม (ตั้งใจ: ย้อนสัดส่วนต้นทุนที่ถูกต้องไม่ได้หลังมีการใช้/รับเพิ่มไปแล้ว)
  for v_l in select * from public.purchase_bill_lines where bill_id = p_bill_id and ingredient_id is not null order by line_no loop
    select * into v_stock from public.ingredient_stock where ingredient_id = v_l.ingredient_id for update;
    insert into public.ingredient_movements (organization_id, store_id, ingredient_id, movement_type,
      qty_delta, before_qty, after_qty, unit_cost, reason, reference_type, reference_id, actor_id)
    values (v_b.organization_id, v_b.store_id, v_l.ingredient_id, 'receive_void',
      -v_l.usage_qty, v_stock.on_hand, v_stock.on_hand - v_l.usage_qty, v_stock.avg_unit_cost,
      'ยกเลิกบิลซื้อ: ' || v_reason, 'purchase_bill', p_bill_id, auth.uid());
    update public.ingredient_stock set on_hand = on_hand - v_l.usage_qty, updated_at = now()
     where ingredient_id = v_l.ingredient_id;
  end loop;

  -- จ่ายไปแล้ว → บันทึกรายรับคืน (เงินสดเข้าลิ้นชักกลับ) แทนการลบรายจ่าย (ledger ต่อเนื่อง)
  for v_p in select * from public.purchase_bill_payments where bill_id = p_bill_id and kind = 'payment' loop
    perform pg_advisory_xact_lock(hashtext('acct_cat:' || v_b.store_id::text || ':income:คืนเงินบิลซื้อ'));
    select id into v_cat from public.accounting_categories
     where store_id = v_b.store_id and type = 'income' and name = 'คืนเงินบิลซื้อ' limit 1;
    if v_cat is null then
      insert into public.accounting_categories (organization_id, store_id, name, type, is_default, sort_order)
      values (v_b.organization_id, v_b.store_id, 'คืนเงินบิลซื้อ', 'income', false, 92) returning id into v_cat;
    end if;
    insert into public.transactions (organization_id, store_id, type, category_id, category_name, amount, payment_method,
                                     note, date, created_by_user_id)
    values (v_b.organization_id, v_b.store_id, 'income', v_cat, 'คืนเงินบิลซื้อ', v_p.amount, v_p.method,
            left('ยกเลิกบิลซื้อ: ' || v_reason, 200), (now() at time zone 'Asia/Bangkok')::date, auth.uid())
    returning id into v_tx;
    if v_p.method = 'cash' then
      perform pg_advisory_xact_lock(hashtext('cash_ledger:' || v_b.store_id::text));
      select balance_after into v_prev from public.cash_ledger_entries
       where store_id = v_b.store_id order by created_at desc limit 1;
      insert into public.cash_ledger_entries (organization_id, store_id, type, amount, balance_after, transaction_id, note,
                                              created_by_user_id)
      values (v_b.organization_id, v_b.store_id, 'income', v_p.amount, round(coalesce(v_prev, 0) + v_p.amount, 2), v_tx,
              left('ยกเลิกบิลซื้อ: ' || v_reason, 200), auth.uid());
    end if;
    insert into public.purchase_bill_payments (bill_id, kind, transaction_id, amount, method, created_by)
    values (p_bill_id, 'void_refund', v_tx, -v_p.amount, v_p.method, auth.uid());
    v_refund := v_refund + v_p.amount;
  end loop;

  update public.purchase_bills set status = 'voided', voided_by = auth.uid(), voided_at = now(), void_reason = v_reason
   where id = p_bill_id;
  return jsonb_build_object('billId', p_bill_id, 'refunded', v_refund);
end;
$$;
revoke all on function public.purchase_bill_void(uuid, text) from public, anon;
grant execute on function public.purchase_bill_void(uuid, text) to authenticated;

-- ---------- ปรับ resale_record_expense (จากฝากขาย C1): สร้างหมวดบัญชีแบบไม่ซ้ำเมื่อเรียกพร้อมกัน ----------
create or replace function public.resale_record_expense(
  p_org uuid, p_store uuid, p_category text, p_amount numeric, p_method text, p_note text, p_actor uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cat uuid;
  v_tx uuid;
  v_prev numeric;
  v_session record;
  v_at_open numeric;
begin
  if p_amount is null or p_amount <= 0 then
    return null;
  end if;
  if p_method not in ('cash', 'transfer') then
    raise exception 'invalid payout method';
  end if;
  if p_method = 'cash' then
    -- กันสองรายการคำนวณ balance_after จากแถวเดียวกันพร้อมกัน + ตรวจเงินในลิ้นชักใน DB
    -- สูตรเดียวกับ getCashOnHand: เงินเปิดร้าน + ส่วนต่าง balance ใน ledger ตั้งแต่เปิดรอบ
    perform pg_advisory_xact_lock(hashtext('cash_ledger:' || p_store::text));
    select opening_float, opened_at into v_session from public.cash_sessions
     where store_id = p_store and status = 'open' order by opened_at desc limit 1;
    if v_session.opened_at is null then
      raise exception 'cash session is not open';
    end if;
    select balance_after into v_prev from public.cash_ledger_entries
     where store_id = p_store order by created_at desc limit 1;
    select balance_after into v_at_open from public.cash_ledger_entries
     where store_id = p_store and created_at < v_session.opened_at order by created_at desc limit 1;
    if v_session.opening_float + coalesce(v_prev, 0) - coalesce(v_at_open, 0) < p_amount then
      raise exception 'insufficient cash in drawer';
    end if;
  end if;
  -- หมวดบัญชี: ล็อกตามชื่อก่อนหา/สร้าง กันสร้างซ้ำเมื่อเรียกพร้อมกัน
  perform pg_advisory_xact_lock(hashtext('acct_cat:' || p_store::text || ':expense:' || p_category));
  select id into v_cat from public.accounting_categories
   where store_id = p_store and type = 'expense' and name = p_category limit 1;
  if v_cat is null then
    insert into public.accounting_categories (organization_id, store_id, name, type, is_default, sort_order)
    values (p_org, p_store, p_category, 'expense', false, 91)
    returning id into v_cat;
  end if;
  insert into public.transactions (organization_id, store_id, type, category_id, category_name, amount, payment_method,
                                   note, date, created_by_user_id)
  values (p_org, p_store, 'expense', v_cat, p_category, round(p_amount, 2), p_method, left(p_note, 200),
          (now() at time zone 'Asia/Bangkok')::date, p_actor)
  returning id into v_tx;
  if p_method = 'cash' then
    insert into public.cash_ledger_entries (organization_id, store_id, type, amount, balance_after, transaction_id, note,
                                            created_by_user_id)
    values (p_org, p_store, 'expense', round(p_amount, 2), round(coalesce(v_prev, 0) - p_amount, 2), v_tx,
            left(p_note, 200), p_actor);
  end if;
  return v_tx;
end;
$$;
revoke all on function public.resale_record_expense(uuid, uuid, text, numeric, text, text, uuid) from public, anon, authenticated;
