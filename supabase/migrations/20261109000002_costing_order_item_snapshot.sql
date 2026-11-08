-- ============================================================
-- Store Cost Engine C1 — บันทึกต้นทุนตอนขาย (Plan/Store Cost Engine Plan v3.html หัวข้อ 3)
--
-- ทำไมเป็น trigger: มีเส้นทางเขียน order_items ~10 จุด (POS, QR, unified POS, wholesale,
--   stock pool, Connect, offline sync) — trigger AFTER INSERT ครอบทุกเส้นทางโดยไม่แตะ RPC เดิม
-- ทำไมเป็นตารางแยก: RLS ของ order_items ให้สมาชิกร้านทุกคนอ่านได้ (แคชเชียร์จะเห็นต้นทุน)
--   order_item_costs ให้ manager อ่านเท่านั้น และไม่มี policy เขียน (trigger definer เขียนอย่างเดียว)
-- การขายต้องไม่ล้มเพราะ trigger: ห่อ exception ทั้งหมดแล้ว raise warning + เขียน system_event_logs
-- แถวไม่มี = ตอนขายเมนูนั้นยังไม่มีสูตรและค่าบรรจุภัณฑ์ (รายงานแยกนับ "ยังไม่มีสูตร")
-- ============================================================

create table if not exists public.order_item_costs (
  order_item_id   uuid primary key references public.order_items(id) on delete cascade,
  order_id        uuid not null references public.orders(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  product_id      uuid,
  variant_id      uuid,
  unit_cost       numeric(12,4),   -- วัตถุดิบต่อ 1 หน่วยฐาน ณ เวลาขาย (null = ไม่มีสูตร)
  packaging_cost  numeric(12,2),   -- บรรจุภัณฑ์ต่อ 1 หน่วยฐาน ณ เวลาขาย
  snapshot_at     timestamptz not null default now()
);
create index if not exists order_item_costs_store_idx on public.order_item_costs (store_id, snapshot_at desc);
create index if not exists order_item_costs_order_idx on public.order_item_costs (order_id);

alter table public.order_item_costs enable row level security;
drop policy if exists "order_item_costs_manager_select" on public.order_item_costs;
create policy "order_item_costs_manager_select" on public.order_item_costs for select
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- ต้นทุนต่อจาน — สูตรเดียวกับ src/modules/costing/math.ts (มี parity test)
--   unitCost = purchase_price ÷ usage_per_purchase ÷ (yield_pct/100)
--   plate    = Σ quantity × unitCost ของบรรทัดที่ variant_id is null หรือ = ตัวเลือกที่ขาย
create or replace function public.costing_plate_cost(p_product_id uuid, p_variant_id uuid)
returns table (unit_cost numeric, packaging_cost numeric)
language sql
stable
set search_path = public
as $$
  with lines as (
    select rl.quantity * (i.purchase_price / i.usage_per_purchase / (i.yield_pct / 100)) as line_cost
      from recipe_lines rl
      join ingredients i on i.id = rl.ingredient_id
     where rl.product_id = p_product_id
       and (rl.variant_id is null or rl.variant_id = p_variant_id)
  )
  select
    (select round(sum(line_cost), 4) from lines) as unit_cost,
    (select pcs.packaging_cost from product_cost_settings pcs where pcs.product_id = p_product_id) as packaging_cost;
$$;

-- ไม่ใช่ security definer และไม่ให้สิทธิ์ผู้ใช้เรียกตรง — ถ้าให้ แคชเชียร์จะอ่านต้นทุนเมนูผ่าน RPC ได้
-- trigger (security definer) เรียกได้ในฐานะเจ้าของฟังก์ชัน · แอปคำนวณฝั่ง TS เองจากตารางที่ผ่าน RLS
revoke all on function public.costing_plate_cost(uuid, uuid) from public, anon, authenticated;

create or replace function public.costing_snapshot_order_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit_cost numeric;
  v_packaging numeric;
  v_org uuid;
  v_store uuid;
begin
  if new.product_id is null then
    return null;
  end if;
  begin
    select c.unit_cost, c.packaging_cost into v_unit_cost, v_packaging
      from costing_plate_cost(new.product_id, new.variant_id) c;
    if v_unit_cost is null and coalesce(v_packaging, 0) = 0 then
      return null;  -- ยังไม่มีสูตรและไม่มีค่าบรรจุภัณฑ์: ไม่บันทึก (รายงานนับเป็น "ยังไม่มีสูตร")
    end if;
    select o.organization_id, o.store_id into v_org, v_store
      from orders o where o.id = new.order_id;
    if v_store is null then
      return null;
    end if;
    insert into order_item_costs (
      order_item_id, order_id, organization_id, store_id, product_id, variant_id, unit_cost, packaging_cost
    ) values (
      new.id, new.order_id, v_org, v_store, new.product_id, new.variant_id, v_unit_cost, coalesce(v_packaging, 0)
    )
    on conflict (order_item_id) do nothing;
  exception when others then
    raise warning 'costing snapshot failed for order_item %: %', new.id, sqlerrm;
    begin
      insert into system_event_logs (level, source, action, message, error_code, store_id, context, fingerprint)
      values (
        'error', 'costing.snapshot', 'costing_snapshot_order_item',
        'บันทึกต้นทุนตอนขายไม่สำเร็จ (การขายยังสำเร็จ)', sqlstate, v_store,
        jsonb_build_object('orderItemId', new.id, 'productId', new.product_id),
        'costing.snapshot:' || sqlstate
      );
    exception when others then
      null;
    end;
  end;
  return null;
end;
$$;

revoke all on function public.costing_snapshot_order_item() from public, anon, authenticated;

drop trigger if exists order_items_cost_snapshot on public.order_items;
create trigger order_items_cost_snapshot
  after insert on public.order_items
  for each row execute function public.costing_snapshot_order_item();
