-- ============================================================
-- เฟส A0 — คลังวัตถุดิบ + ผู้ขาย (Plan/Purchasing and Ingredient Inventory Plan v1.html หัวข้อ 4–5)
--
-- หลักการ
--   * สวิตช์ต่อสาขา stores.inventory_enabled ปิดทุกร้าน — ตารางใหม่ทั้งหมด ไม่แตะเส้นทางขาย
--   * ingredient_stock = ยอดคงเหลือ + ต้นทุนเฉลี่ย (หน่วยใช้) · เขียนผ่าน RPC เท่านั้น
--   * ingredient_movements = สมุดเข้า–ออกแบบ append-only (ไม่มี policy เขียน + trigger กันแก้/ลบ)
--   * ทุกตารางเป็นข้อมูลระดับ manager ขึ้นไป (ต้นทุน) เหมือนตารางต้นทุนเดิม
--   * ตั้งค่าจุดสั่งซื้อ/ผู้ขายประจำเก็บที่ ingredients (manager แก้ได้อยู่แล้ว) ไม่ใช่ ingredient_stock
-- ============================================================

-- 1) สวิตช์ต่อสาขา
alter table public.stores
  add column if not exists inventory_enabled boolean not null default false;
comment on column public.stores.inventory_enabled is
  'เปิดคลังวัตถุดิบ (เฟส A) — ปิดทุกร้านเป็นค่าเริ่มต้น เปิดทีละร้านนำร่อง';

-- 2) ผู้ขาย
create table if not exists public.suppliers (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  store_id           uuid not null references public.stores(id) on delete cascade,
  name               text not null check (btrim(name) <> '' and char_length(name) <= 120),
  tax_id             text check (tax_id is null or tax_id ~ '^[0-9]{13}$'),
  branch_code        text check (branch_code is null or branch_code ~ '^[0-9]{5}$'),
  contact_name       text check (contact_name is null or char_length(contact_name) <= 120),
  phone              text check (phone is null or char_length(phone) <= 40),
  line_id            text check (line_id is null or char_length(line_id) <= 80),
  address            text check (address is null or char_length(address) <= 500),
  note               text check (note is null or char_length(note) <= 500),
  lead_days          int not null default 1 check (lead_days between 0 and 60),
  payment_terms_days int not null default 0 check (payment_terms_days between 0 and 180),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists suppliers_store_name_unique_idx
  on public.suppliers (store_id, lower(btrim(name)));
create index if not exists suppliers_store_idx on public.suppliers (store_id, is_active);

-- 3) ตั้งค่าคลังต่อวัตถุดิบ (เก็บใน ingredients เพราะ manager แก้ได้อยู่แล้วผ่าน RLS เดิม)
alter table public.ingredients
  add column if not exists reorder_point numeric(14,4) check (reorder_point is null or reorder_point >= 0),
  add column if not exists safety_days int not null default 2 check (safety_days between 0 and 60),
  add column if not exists default_supplier_id uuid references public.suppliers(id) on delete set null;

-- 4) ยอดคงเหลือ + ต้นทุนเฉลี่ย (หน่วยใช้ เช่น กรัม) — ยอดติดลบได้ (ขายก่อนรับของ) แต่หน้าจอเตือน
create table if not exists public.ingredient_stock (
  ingredient_id   uuid primary key references public.ingredients(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  on_hand         numeric(14,4) not null default 0,
  avg_unit_cost   numeric(14,6) not null default 0 check (avg_unit_cost >= 0),
  updated_at      timestamptz not null default now()
);
create index if not exists ingredient_stock_store_idx on public.ingredient_stock (store_id);

-- 5) สมุดเข้า–ออก
create table if not exists public.ingredient_movements (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  -- restrict: วัตถุดิบที่มีประวัติคลังลบไม่ได้ (ปิดใช้งานแทน) — ประวัติต้องอยู่ครบ
  ingredient_id   uuid not null references public.ingredients(id) on delete restrict,
  movement_type   text not null check (movement_type in (
    'opening', 'manual_adjust', 'receive', 'receive_void',
    'sale_usage', 'sale_restore', 'waste', 'count_adjust'
  )),
  qty_delta       numeric(14,4) not null,
  before_qty      numeric(14,4) not null,
  after_qty       numeric(14,4) not null,
  unit_cost       numeric(14,6) not null default 0 check (unit_cost >= 0),
  reason          text check (reason is null or char_length(reason) <= 300),
  reference_type  text check (reference_type is null or char_length(reference_type) <= 40),
  reference_id    uuid,
  actor_id        uuid,
  created_at      timestamptz not null default now(),
  check (after_qty = before_qty + qty_delta)
);
create index if not exists ingredient_movements_ingredient_idx
  on public.ingredient_movements (ingredient_id, created_at desc);
create index if not exists ingredient_movements_store_idx
  on public.ingredient_movements (store_id, created_at desc);
create index if not exists ingredient_movements_reference_idx
  on public.ingredient_movements (reference_type, reference_id) where reference_id is not null;

create or replace function public.ingredient_movements_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ingredient_movements is append-only (use a reversing movement)';
end;
$$;

drop trigger if exists ingredient_movements_no_update on public.ingredient_movements;
create trigger ingredient_movements_no_update
  before update or delete on public.ingredient_movements
  for each row execute function public.ingredient_movements_append_only();

-- กันผูกข้ามร้าน: supplier/stock/movement ต้องอยู่ร้านเดียวกับ store/org ที่ระบุ
create or replace function public.enforce_inventory_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.stores where id = new.store_id;
  if v_org is null or v_org is distinct from new.organization_id then
    raise exception 'store must belong to organization';
  end if;
  if tg_table_name in ('ingredient_stock', 'ingredient_movements') then
    if not exists (
      select 1 from public.ingredients i where i.id = new.ingredient_id and i.store_id = new.store_id
    ) then
      raise exception 'ingredient must belong to the same store';
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.store_id is distinct from old.store_id or new.organization_id is distinct from old.organization_id) then
    raise exception 'store_id and organization_id are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists suppliers_same_tenant on public.suppliers;
create trigger suppliers_same_tenant before insert or update on public.suppliers
  for each row execute function public.enforce_inventory_same_tenant();
drop trigger if exists ingredient_stock_same_tenant on public.ingredient_stock;
create trigger ingredient_stock_same_tenant before insert or update on public.ingredient_stock
  for each row execute function public.enforce_inventory_same_tenant();
drop trigger if exists ingredient_movements_same_tenant on public.ingredient_movements;
create trigger ingredient_movements_same_tenant before insert on public.ingredient_movements
  for each row execute function public.enforce_inventory_same_tenant();

-- ผู้ขายประจำต้องเป็นผู้ขายของร้านเดียวกับวัตถุดิบ
create or replace function public.enforce_ingredient_default_supplier()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.default_supplier_id is not null and not exists (
    select 1 from public.suppliers s where s.id = new.default_supplier_id and s.store_id = new.store_id
  ) then
    raise exception 'default supplier must belong to the same store';
  end if;
  return new;
end;
$$;

drop trigger if exists ingredients_default_supplier_same_store on public.ingredients;
create trigger ingredients_default_supplier_same_store
  before insert or update of default_supplier_id on public.ingredients
  for each row execute function public.enforce_ingredient_default_supplier();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.suppliers enable row level security;
alter table public.ingredient_stock enable row level security;
alter table public.ingredient_movements enable row level security;

drop policy if exists "suppliers_manager" on public.suppliers;
create policy "suppliers_manager" on public.suppliers for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- ยอดคงเหลือ/สมุด: อ่านได้ (manager) · ไม่มี policy เขียน — เขียนผ่าน RPC security definer เท่านั้น
drop policy if exists "ingredient_stock_manager_select" on public.ingredient_stock;
create policy "ingredient_stock_manager_select" on public.ingredient_stock for select
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

drop policy if exists "ingredient_movements_manager_select" on public.ingredient_movements;
create policy "ingredient_movements_manager_select" on public.ingredient_movements for select
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- ------------------------------------------------------------
-- RPC: ตั้งยอดยกมา / ปรับยอดด้วยมือ
--   p_kind = 'opening'       ใช้ได้ครั้งเดียวต่อวัตถุดิบ (ยังไม่มีสมุด) · ต้นทุนเริ่ม = p_unit_cost
--                             หรือราคาซื้อ ÷ ปริมาณต่อหน่วยซื้อ ถ้าไม่ระบุ
--   p_kind = 'manual_adjust' ต้องมีเหตุผล · ต้นทุนเฉลี่ยไม่เปลี่ยน
-- ------------------------------------------------------------
create or replace function public.inventory_set_balance(
  p_ingredient_id uuid,
  p_kind text,
  p_new_on_hand numeric,
  p_reason text default null,
  p_unit_cost numeric default null
)
returns public.ingredient_stock
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ing public.ingredients%rowtype;
  v_stock public.ingredient_stock%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_cost numeric;
  v_delta numeric;
  v_has_movements boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_ing from public.ingredients where id = p_ingredient_id;
  if not found then
    raise exception 'ingredient not found';
  end if;

  if not public.auth_user_role_in_store(v_ing.organization_id, v_ing.store_id, 'manager')
    or not public.organization_has_stock_management(v_ing.organization_id) then
    raise exception 'inventory requires manager role and stockManagement access';
  end if;

  if not exists (select 1 from public.stores where id = v_ing.store_id and inventory_enabled) then
    raise exception 'inventory is not enabled for this store';
  end if;

  if p_kind not in ('opening', 'manual_adjust') then
    raise exception 'invalid balance kind';
  end if;

  if p_new_on_hand is null or p_new_on_hand < 0 or p_new_on_hand > 9999999999 then
    raise exception 'on hand must be between 0 and 9999999999';
  end if;

  if p_unit_cost is not null and (p_unit_cost < 0 or p_unit_cost > 99999999) then
    raise exception 'invalid unit cost';
  end if;

  if v_reason is not null and char_length(v_reason) > 300 then
    raise exception 'reason too long';
  end if;

  insert into public.ingredient_stock (ingredient_id, organization_id, store_id)
  values (v_ing.id, v_ing.organization_id, v_ing.store_id)
  on conflict (ingredient_id) do nothing;

  select * into v_stock from public.ingredient_stock where ingredient_id = v_ing.id for update;

  select exists (select 1 from public.ingredient_movements where ingredient_id = v_ing.id) into v_has_movements;

  if p_kind = 'opening' then
    if v_has_movements then
      raise exception 'opening balance already set — use manual_adjust';
    end if;
    v_cost := coalesce(
      p_unit_cost,
      round(v_ing.purchase_price / v_ing.usage_per_purchase, 6)
    );
  else
    if v_reason is null then
      raise exception 'manual adjustment requires a reason';
    end if;
    v_cost := v_stock.avg_unit_cost;
  end if;

  v_delta := round(p_new_on_hand, 4) - v_stock.on_hand;

  insert into public.ingredient_movements (
    organization_id, store_id, ingredient_id, movement_type,
    qty_delta, before_qty, after_qty, unit_cost, reason, actor_id
  ) values (
    v_ing.organization_id, v_ing.store_id, v_ing.id, p_kind,
    v_delta, v_stock.on_hand, v_stock.on_hand + v_delta, v_cost, v_reason, auth.uid()
  );

  update public.ingredient_stock
     set on_hand = v_stock.on_hand + v_delta,
         avg_unit_cost = v_cost,
         updated_at = now()
   where ingredient_id = v_ing.id
  returning * into v_stock;

  return v_stock;
end;
$$;

revoke all on function public.inventory_set_balance(uuid, text, numeric, text, numeric) from public, anon;
grant execute on function public.inventory_set_balance(uuid, text, numeric, text, numeric) to authenticated;
grant execute on function public.inventory_set_balance(uuid, text, numeric, text, numeric) to service_role;

-- ------------------------------------------------------------
-- RPC: เปิด/ปิดคลังของสาขา (owner/admin) — แยกจาก settings.manage_store ทั่วไปเพื่อให้ log ชัด
-- ------------------------------------------------------------
create or replace function public.inventory_set_enabled(p_store_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null then
    raise exception 'store not found';
  end if;
  if not public.auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'only owner/admin can toggle inventory';
  end if;
  if p_enabled and not public.organization_has_stock_management(v_org) then
    raise exception 'inventory requires stockManagement access';
  end if;
  update public.stores set inventory_enabled = coalesce(p_enabled, false) where id = p_store_id;
  return coalesce(p_enabled, false);
end;
$$;

revoke all on function public.inventory_set_enabled(uuid, boolean) from public, anon;
grant execute on function public.inventory_set_enabled(uuid, boolean) to authenticated;
grant execute on function public.inventory_set_enabled(uuid, boolean) to service_role;
