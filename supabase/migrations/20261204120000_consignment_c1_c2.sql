-- ============================================================
-- เฟส C1+C2 — สินค้าซื้อขาด/ฝากขาย (Plan/Resale and Consignment Goods Implementation Plan v2.html)
--
-- C1 ที่มาสินค้า: products.sourcing_mode (made/resale/consignment) + เจ้าของ + วิธีคิดเงิน
--    + ราคาจ่ายเจ้าของ/ราคาซื้อต่อชิ้น (เมนู และรายรสใน modifier_options)
--    เปลี่ยนได้ผ่าน RPC consignment_save_product เท่านั้น (trigger กันเขียนตรง — แคชเชียร์ที่แก้เมนูได้
--    จะเปิดฝากขายเองโดยไม่มีสิทธิ์ Enterprise ไม่ได้)
-- C2 ล็อต + ตัดขาย:
--    resale_lots         = รับของ 1 ครั้ง ต่อเมนู/รส (จำนวนเป็นชิ้น)
--    resale_movements    = สมุดเข้า–ออก (receive/sale/sale_restore/...) — ไม่มี policy เขียน
--    trigger บน order_items ครอบทุกช่องทางขาย (POS, QR, unified POS, Connect, ร้านออนไลน์)
--      * เมนู "ทำเอง" ออกทันที (เส้นทางเดิมไม่เปลี่ยน)
--      * ตัดล็อตเก่าก่อน (FIFO) · ของไม่พอ = บันทึกขายเกิน (lot_id null) ไม่ทำให้การขายล้ม
--      * ห่อ exception ทั้งหมด → warning + system_event_logs (การขายต้องไม่ล้มเพราะฝากขาย)
--      * ยกเลิกรายการ/ลดจำนวน/ลบรายการ/ยกเลิกบิล → คืนของเข้าล็อตเดิม
--      * รสหมด → ซ่อนตัวเลือก (is_active=false, จำว่าระบบซ่อน) · เมนูไม่มีรสหมด → out_of_stock
--        รับของเข้า/คืนของ → เปิดกลับเฉพาะที่ระบบซ่อนเอง
--    ต้นทุนตอนขายเขียนทับ order_item_costs.unit_cost (รายงานกำไรเดิมใช้ต่อได้)
-- ============================================================

-- ---------- C1: คอลัมน์ ----------
alter table public.products
  add column if not exists sourcing_mode text not null default 'made'
    check (sourcing_mode in ('made', 'resale', 'consignment')),
  add column if not exists supplier_id uuid references public.suppliers(id) on delete restrict,
  add column if not exists consign_pricing text check (consign_pricing in ('per_unit', 'percent')),
  add column if not exists consign_store_pct numeric(5,2) check (consign_store_pct > 0 and consign_store_pct < 100),
  add column if not exists resale_unit_cost numeric(12,2) check (resale_unit_cost >= 0 and resale_unit_cost <= 999999),
  add column if not exists resale_option_group_id uuid references public.modifier_groups(id) on delete set null,
  add column if not exists resale_auto_oos boolean not null default false;

alter table public.products drop constraint if exists products_sourcing_consistent;
alter table public.products add constraint products_sourcing_consistent check (
  (sourcing_mode = 'made' and supplier_id is null and consign_pricing is null and consign_store_pct is null
     and resale_option_group_id is null)
  or (sourcing_mode = 'resale' and supplier_id is not null and consign_pricing is null and consign_store_pct is null)
  or (sourcing_mode = 'consignment' and supplier_id is not null and consign_pricing is not null
     and ((consign_pricing = 'percent') = (consign_store_pct is not null)))
);
create index if not exists products_supplier_idx on public.products (supplier_id) where supplier_id is not null;

alter table public.modifier_options
  add column if not exists resale_unit_cost numeric(12,2) check (resale_unit_cost >= 0 and resale_unit_cost <= 999999),
  add column if not exists resale_auto_hidden boolean not null default false;

-- กันเขียนช่องฝากขายตรง (ต้องผ่าน RPC ที่ตรวจ Enterprise) · แก้สถานะเปิด/หมดเองด้วยมือ = ล้างธง "ระบบซ่อน"
create or replace function public.resale_guard_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rpc boolean := coalesce(current_setting('storeos.resale_rpc', true), '') = 'on';
begin
  if tg_table_name = 'products' then
    if tg_op = 'INSERT' then
      if not v_rpc and (new.sourcing_mode <> 'made' or new.supplier_id is not null or new.resale_unit_cost is not null
                        or new.resale_option_group_id is not null or new.resale_auto_oos) then
        -- คัดลอกเมนูข้ามสาขา/สร้างเมนูใหม่: เริ่มเป็น "ทำเอง" เสมอ (เจ้าของอยู่คนละสาขา)
        new.sourcing_mode := 'made';
        new.supplier_id := null;
        new.consign_pricing := null;
        new.consign_store_pct := null;
        new.resale_unit_cost := null;
        new.resale_option_group_id := null;
        new.resale_auto_oos := false;
      end if;
      return new;
    end if;
    if not v_rpc and (
      new.sourcing_mode is distinct from old.sourcing_mode
      or new.supplier_id is distinct from old.supplier_id
      or new.consign_pricing is distinct from old.consign_pricing
      or new.consign_store_pct is distinct from old.consign_store_pct
      or new.resale_unit_cost is distinct from old.resale_unit_cost
      or new.resale_option_group_id is distinct from old.resale_option_group_id
    ) then
      raise exception 'resale settings must be changed via consignment_save_product';
    end if;
    if not v_rpc and new.out_of_stock is distinct from old.out_of_stock then
      new.resale_auto_oos := false;
    end if;
    if not v_rpc and new.resale_auto_oos is distinct from old.resale_auto_oos then
      new.resale_auto_oos := old.resale_auto_oos;
    end if;
    return new;
  end if;

  -- modifier_options
  if tg_op = 'INSERT' then
    if not v_rpc then
      new.resale_unit_cost := null;
      new.resale_auto_hidden := false;
    end if;
    return new;
  end if;
  if not v_rpc and new.resale_unit_cost is distinct from old.resale_unit_cost then
    raise exception 'resale settings must be changed via consignment_save_product';
  end if;
  if not v_rpc and new.is_active is distinct from old.is_active then
    new.resale_auto_hidden := false;
  end if;
  if not v_rpc and new.resale_auto_hidden is distinct from old.resale_auto_hidden then
    new.resale_auto_hidden := old.resale_auto_hidden;
  end if;
  return new;
end;
$$;

drop trigger if exists products_resale_guard on public.products;
create trigger products_resale_guard before insert or update on public.products
  for each row execute function public.resale_guard_columns();
drop trigger if exists modifier_options_resale_guard on public.modifier_options;
create trigger modifier_options_resale_guard before insert or update on public.modifier_options
  for each row execute function public.resale_guard_columns();

-- ---------- C2: ล็อต + สมุด ----------
create table if not exists public.resale_lots (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  store_id         uuid not null references public.stores(id) on delete cascade,
  product_id       uuid not null references public.products on delete restrict,
  option_id        uuid references public.modifier_options(id) on delete restrict,
  supplier_id      uuid not null references public.suppliers(id) on delete restrict,
  mode             text not null check (mode in ('resale', 'consignment')),
  qty_received     int not null check (qty_received > 0 and qty_received <= 100000),
  qty_remaining    int not null check (qty_remaining >= 0),
  unit_cost        numeric(12,2) not null check (unit_cost >= 0 and unit_cost <= 999999),
  expires_on       date,
  note             text check (note is null or char_length(note) <= 300),
  received_by      uuid,
  received_at      timestamptz not null default now(),
  check (qty_remaining <= qty_received)
);
create index if not exists resale_lots_open_idx
  on public.resale_lots (store_id, product_id, option_id, received_at) where qty_remaining > 0;
create index if not exists resale_lots_supplier_idx on public.resale_lots (supplier_id, received_at desc);

create table if not exists public.resale_movements (
  id               uuid primary key default gen_random_uuid(),
  -- ลำดับที่แน่นอน (created_at ซ้ำกันได้ในธุรกรรมเดียว) — คืนของล่าสุดก่อนต้องเรียงตามนี้
  seq              bigint generated always as identity,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  store_id         uuid not null references public.stores(id) on delete cascade,
  product_id       uuid not null references public.products on delete restrict,
  option_id        uuid references public.modifier_options(id) on delete restrict,
  lot_id           uuid references public.resale_lots(id) on delete restrict,
  supplier_id      uuid not null references public.suppliers(id) on delete restrict,
  mode             text not null check (mode in ('resale', 'consignment')),
  movement_type    text not null check (movement_type in (
    'receive', 'sale', 'sale_restore', 'return_owner', 'damage', 'count_adjust', 'store_buyout'
  )),
  qty              int not null check (qty <> 0),
  unit_cost        numeric(12,2) not null default 0 check (unit_cost >= 0),
  -- ฝากขาย: ยอดที่ต้องจ่ายเจ้าของของแถวนี้ (sale บวก / sale_restore ลบ) · ซื้อขาด = 0
  owner_amount     numeric(12,2) not null default 0,
  liability        text check (liability in ('store', 'owner')),
  -- ไม่ใช้ FK: รายการอาจถูกลบภายหลัง แต่ประวัติขายต้องอยู่
  order_item_id    uuid,
  order_id         uuid,
  reverses_id      uuid references public.resale_movements(id) on delete restrict,
  -- ขายเกิน (ของในล็อตไม่พอ) หรือออเดอร์ไม่มีรส (Connect) → รอเลือกรส
  oversold         boolean not null default false,
  needs_flavor     boolean not null default false,
  settlement_id    uuid,
  settled_amount   numeric(12,2),
  clawback_settlement_id uuid,
  actor_id         uuid,
  note             text check (note is null or char_length(note) <= 300),
  created_at       timestamptz not null default now()
);
create index if not exists resale_movements_store_idx on public.resale_movements (store_id, created_at desc);
create index if not exists resale_movements_item_idx on public.resale_movements (order_item_id) where order_item_id is not null;
create index if not exists resale_movements_unsettled_idx
  on public.resale_movements (supplier_id, created_at) where movement_type = 'sale' and settlement_id is null;
create index if not exists resale_movements_reverses_idx on public.resale_movements (reverses_id) where reverses_id is not null;
create index if not exists resale_movements_lot_idx on public.resale_movements (lot_id) where lot_id is not null;

alter table public.resale_lots enable row level security;
alter table public.resale_movements enable row level security;
drop policy if exists "resale_lots_manager_select" on public.resale_lots;
create policy "resale_lots_manager_select" on public.resale_lots for select
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));
drop policy if exists "resale_movements_manager_select" on public.resale_movements;
create policy "resale_movements_manager_select" on public.resale_movements for select
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- ---------- ตัวช่วย ----------
-- p_min_role: manager (ค่าเริ่มต้น) · ปิดรอบเงินสดแยกเงินเจ้าของรายวันอนุญาต cashier (ยอดคำนวณจากระบบ ไม่ได้พิมพ์เอง)
create or replace function public.resale_assert_operator(p_org uuid, p_store uuid, p_min_role text default 'manager')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if p_min_role not in ('manager', 'cashier') or not public.auth_user_role_in_store(p_org, p_store, p_min_role) then
    raise exception 'consignment requires manager role';
  end if;
  if not public.organization_has_consignment(p_org) then
    raise exception 'consignment requires enterprise plan';
  end if;
  if not exists (select 1 from public.stores where id = p_store and consignment_enabled) then
    raise exception 'consignment is not enabled for this store';
  end if;
end;
$$;
revoke all on function public.resale_assert_operator(uuid, uuid, text) from public, anon, authenticated;

-- คงเหลือรวมของเมนู/รส
create or replace function public.resale_on_hand(p_product_id uuid, p_option_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(qty_remaining), 0)::int
    from public.resale_lots
   where product_id = p_product_id and option_id is not distinct from p_option_id and qty_remaining > 0;
$$;
revoke all on function public.resale_on_hand(uuid, uuid) from public, anon, authenticated;

-- ซ่อน/เปิดตามคงเหลือ (เปิดกลับเฉพาะที่ระบบซ่อนเอง)
create or replace function public.resale_sync_availability(p_product_id uuid, p_option_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_left int := public.resale_on_hand(p_product_id, p_option_id);
begin
  perform set_config('storeos.resale_rpc', 'on', true);
  begin
  if p_option_id is not null then
    if v_left <= 0 then
      update public.modifier_options set is_active = false, resale_auto_hidden = true
       where id = p_option_id and is_active;
    else
      update public.modifier_options set is_active = true, resale_auto_hidden = false
       where id = p_option_id and resale_auto_hidden;
    end if;
  else
    if v_left <= 0 then
      update public.products set out_of_stock = true, resale_auto_oos = true
       where id = p_product_id and not out_of_stock;
    else
      update public.products set out_of_stock = false, resale_auto_oos = false
       where id = p_product_id and resale_auto_oos;
    end if;
  end if;
  exception when others then
    perform set_config('storeos.resale_rpc', '', true);
    raise;
  end;
  perform set_config('storeos.resale_rpc', '', true);
end;
$$;
revoke all on function public.resale_sync_availability(uuid, uuid) from public, anon, authenticated;

-- รสที่ลูกค้าเลือกจาก order_items.modifiers ([{modifierGroupId, option:{id}}])
create or replace function public.resale_option_from_modifiers(p_modifiers jsonb, p_group_id uuid)
returns uuid
language sql
immutable
as $$
  select (el->'option'->>'id')::uuid
    from jsonb_array_elements(case when jsonb_typeof(p_modifiers) = 'array' then p_modifiers else '[]'::jsonb end) el
   where el->>'modifierGroupId' = p_group_id::text
     and (el->'option'->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   limit 1;
$$;

-- ตัดขาย (FIFO) ของรายการ — ใช้ทั้งตอนสร้างรายการ เพิ่มจำนวน และเลือกรสย้อนหลัง
create or replace function public.resale_deduct(
  p_item_id uuid, p_order_id uuid, p_product_id uuid, p_option_id uuid, p_qty int,
  p_line_total numeric, p_needs_flavor boolean
)
returns numeric  -- ต้นทุนรวมของจำนวนที่ตัด
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p record;
  v_lot record;
  v_left int := p_qty;
  v_take int;
  v_cost numeric := 0;
  v_owner_total numeric;
  v_owner_left numeric;
  v_share numeric;
  v_default_cost numeric;
  v_ids uuid[] := '{}';
  v_qtys int[] := '{}';
  i int;
begin
  select id, organization_id, store_id, sourcing_mode, supplier_id, consign_pricing, consign_store_pct, resale_unit_cost
    into v_p from public.products where id = p_product_id;
  if v_p.id is null or v_p.sourcing_mode = 'made' or p_qty <= 0 then
    return 0;
  end if;

  if p_needs_flavor then
    insert into public.resale_movements (organization_id, store_id, product_id, option_id, lot_id, supplier_id, mode,
      movement_type, qty, unit_cost, owner_amount, order_item_id, order_id, needs_flavor)
    values (v_p.organization_id, v_p.store_id, p_product_id, null, null, v_p.supplier_id, v_p.sourcing_mode,
      'sale', -p_qty, 0, 0, p_item_id, p_order_id, true);
    return 0;
  end if;

  select coalesce(o.resale_unit_cost, v_p.resale_unit_cost, 0) into v_default_cost
    from (select 1) d left join public.modifier_options o on o.id = p_option_id;

  -- ฝากขายแบบหัก %: ยอดจ่ายเจ้าของ = ราคาขายจริงของบรรทัด × (100 − %ร้าน)
  if v_p.sourcing_mode = 'consignment' and v_p.consign_pricing = 'percent' then
    v_owner_total := round(greatest(coalesce(p_line_total, 0), 0) * (100 - v_p.consign_store_pct) / 100, 2);
  end if;
  v_owner_left := v_owner_total;

  for v_lot in
    select id, qty_remaining, unit_cost from public.resale_lots
     where product_id = p_product_id and option_id is not distinct from p_option_id and qty_remaining > 0
     order by received_at, id
     for update
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_lot.qty_remaining);
    update public.resale_lots set qty_remaining = qty_remaining - v_take where id = v_lot.id;
    v_ids := v_ids || v_lot.id;
    v_qtys := v_qtys || v_take;
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then
    v_ids := v_ids || null::uuid;
    v_qtys := v_qtys || v_left;
  end if;

  for i in 1 .. coalesce(array_length(v_qtys, 1), 0) loop
    declare
      v_unit numeric;
      v_owner numeric := 0;
    begin
      if v_ids[i] is null then
        v_unit := v_default_cost;
      else
        select unit_cost into v_unit from public.resale_lots where id = v_ids[i];
      end if;
      if v_p.sourcing_mode = 'consignment' then
        if v_p.consign_pricing = 'percent' then
          if i = array_length(v_qtys, 1) then
            v_share := v_owner_left;
          else
            v_share := round(v_owner_total * v_qtys[i] / p_qty, 2);
          end if;
          v_owner_left := v_owner_left - v_share;
          v_owner := v_share;
          v_unit := case when v_qtys[i] > 0 then round(v_share / v_qtys[i], 2) else 0 end;
        else
          v_owner := round(v_unit * v_qtys[i], 2);
        end if;
      end if;
      v_cost := v_cost + case when v_p.sourcing_mode = 'consignment' and v_p.consign_pricing = 'percent'
                              then v_owner else v_unit * v_qtys[i] end;
      insert into public.resale_movements (organization_id, store_id, product_id, option_id, lot_id, supplier_id, mode,
        movement_type, qty, unit_cost, owner_amount, order_item_id, order_id, oversold)
      values (v_p.organization_id, v_p.store_id, p_product_id, p_option_id, v_ids[i], v_p.supplier_id, v_p.sourcing_mode,
        'sale', -v_qtys[i], v_unit, v_owner, p_item_id, p_order_id, v_ids[i] is null);
    end;
  end loop;

  perform public.resale_sync_availability(p_product_id, p_option_id);
  return v_cost;
end;
$$;
revoke all on function public.resale_deduct(uuid, uuid, uuid, uuid, int, numeric, boolean) from public, anon, authenticated;

-- คืนของของรายการ (ล่าสุดก่อน) สูงสุด p_qty ชิ้น (null = ทั้งหมดที่ยังไม่คืน)
create or replace function public.resale_restore(p_item_id uuid, p_qty int, p_note text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m record;
  v_open int;
  v_take int;
  v_left int := coalesce(p_qty, 2147483647);
  v_done int := 0;
  v_pairs uuid[] := '{}';
begin
  for v_m in
    select m.* from public.resale_movements m
     where m.order_item_id = p_item_id and m.movement_type = 'sale'
     order by m.seq desc
     for update
  loop
    exit when v_left <= 0;
    v_open := -v_m.qty - coalesce((select sum(r.qty) from public.resale_movements r where r.reverses_id = v_m.id), 0);
    continue when v_open <= 0;
    v_take := least(v_open, v_left);
    if v_m.lot_id is not null and not v_m.needs_flavor then
      update public.resale_lots set qty_remaining = qty_remaining + v_take where id = v_m.lot_id;
    end if;
    insert into public.resale_movements (organization_id, store_id, product_id, option_id, lot_id, supplier_id, mode,
      movement_type, qty, unit_cost, owner_amount, order_item_id, order_id, reverses_id, needs_flavor, note)
    values (v_m.organization_id, v_m.store_id, v_m.product_id, v_m.option_id, v_m.lot_id, v_m.supplier_id, v_m.mode,
      'sale_restore', v_take, v_m.unit_cost,
      -round(v_m.owner_amount * v_take / greatest(-v_m.qty, 1), 2),
      v_m.order_item_id, v_m.order_id, v_m.id, v_m.needs_flavor, left(p_note, 300));
    v_left := v_left - v_take;
    v_done := v_done + v_take;
    if v_m.lot_id is not null then
      perform public.resale_sync_availability(v_m.product_id, v_m.option_id);
    end if;
  end loop;
  return v_done;
end;
$$;
revoke all on function public.resale_restore(uuid, int, text) from public, anon, authenticated;

-- ต้นทุนตอนขายของรายการ = ต้นทุนสุทธิของทุกแถวขาย/คืน ÷ จำนวนปัจจุบัน (เรียกหลังตัด/คืน/เลือกรส)
create or replace function public.resale_refresh_item_cost(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cost numeric;
  v_open int;
begin
  select coalesce(sum(-m.qty * m.unit_cost), 0),
         coalesce(sum(-m.qty) filter (where not m.needs_flavor), 0)
    into v_cost, v_open
    from public.resale_movements m
   where m.order_item_id = p_item_id and m.movement_type in ('sale', 'sale_restore');
  if v_open <= 0 then
    return;  -- ยกเลิกหมด/ยังรอเลือกรส: คงต้นทุนเดิมไว้ (รายงานกรองรายการ void เอง)
  end if;
  insert into public.order_item_costs (order_item_id, order_id, organization_id, store_id, product_id, variant_id,
                                       unit_cost, packaging_cost)
  select oi.id, oi.order_id, o.organization_id, o.store_id, oi.product_id, oi.variant_id, round(v_cost / v_open, 4), 0
    from public.order_items oi join public.orders o on o.id = oi.order_id
   where oi.id = p_item_id
  on conflict (order_item_id) do update set unit_cost = excluded.unit_cost;
end;
$$;
revoke all on function public.resale_refresh_item_cost(uuid) from public, anon, authenticated;

create or replace function public.resale_log_failure(p_action text, p_store uuid, p_context jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.system_event_logs (level, source, action, message, error_code, store_id, context, fingerprint)
  values ('error', 'consignment.stock', p_action,
          'ตัด/คืนสต็อกฝากขายไม่สำเร็จ (การขายยังสำเร็จ) — ตรวจหน้าฝากขาย', sqlstate, p_store, p_context,
          'consignment.stock:' || p_action);
exception when others then
  null;
end;
$$;
revoke all on function public.resale_log_failure(text, uuid, jsonb) from public, anon, authenticated;

-- ---------- triggers บน order_items / orders ----------
create or replace function public.resale_order_item_after()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text;
  v_group uuid;
  v_option uuid;
  v_cost numeric;
  v_qty int;
  v_store uuid;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.resale_movements where order_item_id = old.id) then
      begin
        perform public.resale_restore(old.id, null, 'ลบรายการออกจากบิล');
      exception when others then
        raise warning 'resale restore failed for order_item %: %', old.id, sqlerrm;
        perform public.resale_log_failure('order_item_delete', null, jsonb_build_object('orderItemId', old.id, 'error', sqlerrm));
      end;
    end if;
    return old;
  end if;

  select sourcing_mode, resale_option_group_id, store_id into v_mode, v_group, v_store
    from public.products where id = new.product_id;
  if v_mode is null or v_mode = 'made' then
    return new;  -- เมนูทำเอง: ไม่แตะอะไร
  end if;

  begin
    if tg_op = 'INSERT' then
      if coalesce(new.voided, false) then
        return new;
      end if;
      v_option := case when v_group is null then null else public.resale_option_from_modifiers(new.modifiers, v_group) end;
      v_cost := public.resale_deduct(new.id, new.order_id, new.product_id, v_option, new.quantity, new.total_price,
                                     v_group is not null and v_option is null);
      perform public.resale_refresh_item_cost(new.id);
      return new;
    end if;

    -- UPDATE
    if coalesce(new.voided, false) and not coalesce(old.voided, false) then
      perform public.resale_restore(new.id, null, 'ยกเลิกรายการ');
    elsif not coalesce(new.voided, false) and new.quantity <> old.quantity then
      if new.quantity < old.quantity then
        perform public.resale_restore(new.id, old.quantity - new.quantity, 'ลดจำนวน');
      else
        v_qty := new.quantity - old.quantity;
        v_option := case when v_group is null then null else public.resale_option_from_modifiers(new.modifiers, v_group) end;
        perform public.resale_deduct(new.id, new.order_id, new.product_id, v_option, v_qty,
                                     round(new.total_price * v_qty / new.quantity, 2), v_group is not null and v_option is null);
      end if;
      perform public.resale_refresh_item_cost(new.id);
    end if;
  exception when others then
    raise warning 'resale stock failed for order_item %: %', new.id, sqlerrm;
    perform public.resale_log_failure('order_item_' || lower(tg_op), v_store,
      jsonb_build_object('orderItemId', new.id, 'productId', new.product_id, 'error', sqlerrm));
  end;
  return new;
end;
$$;

-- ชื่อขึ้นต้น zz_ ให้ทำงานหลัง order_items_cost_snapshot (trigger AFTER เรียงตามชื่อ) → เขียนทับต้นทุน
drop trigger if exists zz_order_items_resale_insert on public.order_items;
create trigger zz_order_items_resale_insert after insert on public.order_items
  for each row execute function public.resale_order_item_after();
drop trigger if exists zz_order_items_resale_update on public.order_items;
create trigger zz_order_items_resale_update after update of voided, quantity on public.order_items
  for each row execute function public.resale_order_item_after();
drop trigger if exists zz_order_items_resale_delete on public.order_items;
create trigger zz_order_items_resale_delete before delete on public.order_items
  for each row execute function public.resale_order_item_after();

create or replace function public.resale_order_status_after()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
begin
  if new.status in ('voided', 'cancelled', 'refunded')
     and old.status not in ('voided', 'cancelled', 'refunded')
     and new.merged_into_order_id is null then
    for v_item in
      select distinct m.order_item_id from public.resale_movements m
        join public.order_items oi on oi.id = m.order_item_id
       where oi.order_id = new.id and m.movement_type = 'sale'
    loop
      begin
        perform public.resale_restore(v_item.order_item_id, null, 'ยกเลิก/คืนเงินทั้งบิล');
      exception when others then
        raise warning 'resale restore failed for order %: %', new.id, sqlerrm;
        perform public.resale_log_failure('order_status', new.store_id,
          jsonb_build_object('orderId', new.id, 'orderItemId', v_item.order_item_id, 'error', sqlerrm));
      end;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists zz_orders_resale_status on public.orders;
create trigger zz_orders_resale_status after update of status on public.orders
  for each row execute function public.resale_order_status_after();

-- ---------- รายจ่าย (ซื้อขาดตอนรับของ / จ่ายเจ้าของฝากขาย) ----------
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
    -- กันสองรายการคำนวณ balance_after จากแถวเดียวกันพร้อมกัน + ตรวจเงินในลิ้นชักใน DB (เรียก RPC ตรงก็ข้ามไม่ได้)
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

-- ---------- RPC: ตั้งที่มาสินค้า (C1) ----------
-- p_settings: {mode, supplierId, pricing, storePct, unitCost, optionGroupId, optionCosts:[{optionId, unitCost}]}
create or replace function public.consignment_save_product(p_product_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p record;
  v_mode text := p_settings->>'mode';
  v_supplier uuid;
  v_pricing text := nullif(p_settings->>'pricing', '');
  v_pct numeric;
  v_cost numeric;
  v_group uuid;
  v_el jsonb;
  v_opt uuid;
  v_open int;
begin
  select id, organization_id, store_id, sourcing_mode, supplier_id into v_p
    from public.products where id = p_product_id for update;
  if v_p.id is null then
    raise exception 'product not found';
  end if;
  perform public.resale_assert_operator(v_p.organization_id, v_p.store_id);
  if v_mode not in ('made', 'resale', 'consignment') then
    raise exception 'invalid sourcing mode';
  end if;
  if p_settings ? 'optionCosts' and jsonb_typeof(p_settings->'optionCosts') <> 'array' then
    raise exception 'invalid option costs';
  end if;
  if jsonb_array_length(coalesce(p_settings->'optionCosts', '[]'::jsonb)) > 100 then
    raise exception 'too many options';
  end if;

  select coalesce(sum(qty_remaining), 0) into v_open from public.resale_lots
   where product_id = p_product_id and qty_remaining > 0;

  perform set_config('storeos.resale_rpc', 'on', true);

  if v_mode = 'made' then
    if v_open > 0 then
      raise exception 'product still has resale stock';
    end if;
    update public.products set sourcing_mode = 'made', supplier_id = null, consign_pricing = null,
           consign_store_pct = null, resale_unit_cost = null, resale_option_group_id = null,
           out_of_stock = case when resale_auto_oos then false else out_of_stock end, resale_auto_oos = false
     where id = p_product_id;
    update public.modifier_options o set resale_unit_cost = null,
           is_active = case when o.resale_auto_hidden then true else o.is_active end, resale_auto_hidden = false
      from public.modifier_groups g
     where g.id = o.modifier_group_id and g.product_id = p_product_id;
    perform set_config('storeos.resale_rpc', '', true);
    return jsonb_build_object('mode', 'made');
  end if;

  v_supplier := nullif(p_settings->>'supplierId', '')::uuid;
  if v_supplier is null or not exists (
    select 1 from public.suppliers s where s.id = v_supplier and s.store_id = v_p.store_id and s.is_active
  ) then
    raise exception 'supplier not found';
  end if;
  if v_open > 0 and (v_p.supplier_id is distinct from v_supplier or v_p.sourcing_mode is distinct from v_mode) then
    raise exception 'cannot change owner or mode while stock remains';
  end if;
  if exists (
    select 1 from public.product_variants pv
     where pv.product_id = p_product_id and (pv.track_stock or exists (select 1 from public.variant_stock_links l where l.variant_id = pv.id))
  ) then
    raise exception 'product uses variant stock';
  end if;

  if nullif(p_settings->>'unitCost', '') is not null then
    v_cost := (p_settings->>'unitCost')::numeric;
    if v_cost < 0 or v_cost > 999999 then
      raise exception 'invalid unit cost';
    end if;
  end if;

  if v_mode = 'consignment' then
    if v_pricing not in ('per_unit', 'percent') then
      raise exception 'invalid consignment pricing';
    end if;
    if v_pricing = 'percent' then
      v_pct := (p_settings->>'storePct')::numeric;
      if v_pct is null or v_pct <= 0 or v_pct >= 100 then
        raise exception 'invalid store percent';
      end if;
    end if;
  else
    v_pricing := null;
  end if;

  v_group := nullif(p_settings->>'optionGroupId', '')::uuid;
  if v_group is not null then
    if not exists (select 1 from public.modifier_groups g where g.id = v_group and g.product_id = p_product_id) then
      raise exception 'option group not found';
    end if;
    -- นับรายรส = ลูกค้าต้องเลือก 1 รสเสมอ ไม่งั้นตัดสต็อกไม่ได้
    update public.modifier_groups set is_required = true, min_selections = 1, max_selections = 1 where id = v_group;
  end if;
  if exists (select 1 from public.resale_lots l where l.product_id = p_product_id and l.qty_remaining > 0
              and ((l.option_id is null) <> (v_group is null)
                   or (l.option_id is not null and not exists (
                         select 1 from public.modifier_options mo where mo.id = l.option_id and mo.modifier_group_id = v_group)))) then
    raise exception 'cannot change flavor group while stock remains';
  end if;

  update public.products set sourcing_mode = v_mode, supplier_id = v_supplier, consign_pricing = v_pricing,
         consign_store_pct = case when v_pricing = 'percent' then v_pct else null end,
         resale_unit_cost = v_cost, resale_option_group_id = v_group
   where id = p_product_id;

  -- ราคาต่อรส: เฉพาะตัวเลือกในกลุ่มรสของเมนูนี้ · ส่งมาไม่ครบ = ตัวที่ไม่ส่งถูกล้าง
  update public.modifier_options o set resale_unit_cost = null
    from public.modifier_groups g
   where g.id = o.modifier_group_id and g.product_id = p_product_id;
  if v_group is not null then
    for v_el in select * from jsonb_array_elements(coalesce(p_settings->'optionCosts', '[]'::jsonb)) loop
      v_opt := nullif(v_el->>'optionId', '')::uuid;
      if v_opt is null or not exists (select 1 from public.modifier_options where id = v_opt and modifier_group_id = v_group) then
        raise exception 'option not in flavor group';
      end if;
      if nullif(v_el->>'unitCost', '') is not null then
        if (v_el->>'unitCost')::numeric < 0 or (v_el->>'unitCost')::numeric > 999999 then
          raise exception 'invalid unit cost';
        end if;
        update public.modifier_options set resale_unit_cost = (v_el->>'unitCost')::numeric where id = v_opt;
      end if;
    end loop;
  end if;

  perform set_config('storeos.resale_rpc', '', true);
  return jsonb_build_object('mode', v_mode, 'flavorGroupForcedRequired', v_group is not null);
end;
$$;
revoke all on function public.consignment_save_product(uuid, jsonb) from public, anon;
grant execute on function public.consignment_save_product(uuid, jsonb) to authenticated;

-- ---------- RPC: รับของเป็นล็อต (C2) ----------
-- p_lines: [{productId, optionId|null, qty, unitCost}] · p_payment_method สำหรับซื้อขาด (cash/transfer)
create or replace function public.consignment_receive_lots(
  p_supplier_id uuid, p_mode text, p_lines jsonb, p_expires_on date, p_note text, p_payment_method text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s record;
  v_el jsonb;
  v_prod record;
  v_opt uuid;
  v_qty int;
  v_cost numeric;
  v_total numeric := 0;
  v_lot uuid;
  v_lots uuid[] := '{}';
  v_tx uuid;
  v_seen text[] := '{}';
  v_key text;
begin
  select id, organization_id, store_id, name, is_active into v_s from public.suppliers where id = p_supplier_id;
  if v_s.id is null or not v_s.is_active then
    raise exception 'supplier not found';
  end if;
  perform public.resale_assert_operator(v_s.organization_id, v_s.store_id);
  if p_mode not in ('resale', 'consignment') then
    raise exception 'invalid sourcing mode';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100 then
    raise exception 'invalid lines';
  end if;
  if p_note is not null and char_length(p_note) > 300 then
    raise exception 'note too long';
  end if;
  if p_mode = 'resale' and coalesce(p_payment_method, '') not in ('cash', 'transfer') then
    raise exception 'invalid payout method';
  end if;

  for v_el in select * from jsonb_array_elements(p_lines) loop
    select id, store_id, sourcing_mode, supplier_id, resale_option_group_id into v_prod
      from public.products where id = nullif(v_el->>'productId', '')::uuid;
    if v_prod.id is null or v_prod.store_id <> v_s.store_id or v_prod.sourcing_mode <> p_mode
       or v_prod.supplier_id <> p_supplier_id then
      raise exception 'product does not belong to this owner';
    end if;
    v_opt := nullif(v_el->>'optionId', '')::uuid;
    if (v_prod.resale_option_group_id is null) <> (v_opt is null) then
      raise exception 'flavor is required for this product';
    end if;
    if v_opt is not null and not exists (
      select 1 from public.modifier_options where id = v_opt and modifier_group_id = v_prod.resale_option_group_id
    ) then
      raise exception 'option not in flavor group';
    end if;
    v_key := v_prod.id::text || ':' || coalesce(v_opt::text, '-');
    if v_key = any(v_seen) then
      raise exception 'duplicate line';
    end if;
    v_seen := v_seen || v_key;
    v_qty := (v_el->>'qty')::int;
    v_cost := (v_el->>'unitCost')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 then
      raise exception 'invalid quantity';
    end if;
    if v_cost is null or v_cost < 0 or v_cost > 999999 then
      raise exception 'invalid unit cost';
    end if;
    insert into public.resale_lots (organization_id, store_id, product_id, option_id, supplier_id, mode, qty_received,
                                    qty_remaining, unit_cost, expires_on, note, received_by)
    values (v_s.organization_id, v_s.store_id, v_prod.id, v_opt, p_supplier_id, p_mode, v_qty, v_qty, round(v_cost, 2),
            p_expires_on, p_note, auth.uid())
    returning id into v_lot;
    insert into public.resale_movements (organization_id, store_id, product_id, option_id, lot_id, supplier_id, mode,
                                         movement_type, qty, unit_cost, actor_id, note)
    values (v_s.organization_id, v_s.store_id, v_prod.id, v_opt, v_lot, p_supplier_id, p_mode, 'receive', v_qty,
            round(v_cost, 2), auth.uid(), p_note);
    v_lots := v_lots || v_lot;
    v_total := v_total + round(v_cost, 2) * v_qty;
    perform public.resale_sync_availability(v_prod.id, v_opt);
  end loop;

  if p_mode = 'resale' and v_total > 0 then
    v_tx := public.resale_record_expense(v_s.organization_id, v_s.store_id, 'ซื้อสินค้ามาขาย', v_total,
                                         p_payment_method, 'ซื้อขาด: ' || v_s.name, auth.uid());
  end if;
  return jsonb_build_object('lotIds', to_jsonb(v_lots), 'total', v_total, 'transactionId', v_tx);
end;
$$;
revoke all on function public.consignment_receive_lots(uuid, text, jsonb, date, text, text) from public, anon;
grant execute on function public.consignment_receive_lots(uuid, text, jsonb, date, text, text) to authenticated;

-- ---------- RPC: เลือกรสให้ออเดอร์ที่ไม่มีรส (Connect) ----------
create or replace function public.consignment_assign_flavor(p_movement_id uuid, p_option_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m record;
  v_group uuid;
  v_open int;
  v_line numeric;
begin
  select * into v_m from public.resale_movements where id = p_movement_id for update;
  if v_m.id is null or not v_m.needs_flavor or v_m.movement_type <> 'sale' then
    raise exception 'movement not found';
  end if;
  perform public.resale_assert_operator(v_m.organization_id, v_m.store_id);
  select resale_option_group_id into v_group from public.products where id = v_m.product_id;
  if v_group is null or not exists (select 1 from public.modifier_options where id = p_option_id and modifier_group_id = v_group) then
    raise exception 'option not in flavor group';
  end if;
  v_open := -v_m.qty - coalesce((select sum(qty) from public.resale_movements where reverses_id = v_m.id), 0);
  if v_open <= 0 then
    raise exception 'nothing to assign';
  end if;
  -- ปิดแถวรอเลือกรส (คืนเต็มจำนวน) แล้วตัดใหม่ตามรสที่เลือก
  insert into public.resale_movements (organization_id, store_id, product_id, option_id, lot_id, supplier_id, mode,
    movement_type, qty, unit_cost, owner_amount, order_item_id, order_id, reverses_id, needs_flavor, actor_id, note)
  values (v_m.organization_id, v_m.store_id, v_m.product_id, null, null, v_m.supplier_id, v_m.mode,
    'sale_restore', v_open, 0, 0, v_m.order_item_id, v_m.order_id, v_m.id, true, auth.uid(), 'เลือกรสย้อนหลัง');
  select round(oi.total_price * v_open / oi.quantity, 2) into v_line from public.order_items oi where oi.id = v_m.order_item_id;
  v_line := public.resale_deduct(v_m.order_item_id, v_m.order_id, v_m.product_id, p_option_id, v_open, v_line, false);
  perform public.resale_refresh_item_cost(v_m.order_item_id);
  return v_open;
end;
$$;
revoke all on function public.consignment_assign_flavor(uuid, uuid) from public, anon;
grant execute on function public.consignment_assign_flavor(uuid, uuid) to authenticated;

-- ---------- คงเหลือรายเมนู/รส สำหรับหน้าฝากขาย (manager) ----------
create or replace function public.consignment_stock_levels(p_store_id uuid)
returns table (product_id uuid, option_id uuid, on_hand int, nearest_expiry date)
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
  return query
    select l.product_id, l.option_id, sum(l.qty_remaining)::int, min(l.expires_on)
      from public.resale_lots l
     where l.store_id = p_store_id and l.qty_remaining > 0
     group by l.product_id, l.option_id;
end;
$$;
revoke all on function public.consignment_stock_levels(uuid) from public, anon;
grant execute on function public.consignment_stock_levels(uuid) to authenticated;
