-- ============================================================
-- Store Cost Engine C1 — ฐานข้อมูลต้นทุน (Plan/Store Cost Engine Plan v3.html)
--
-- ตารางต้นทุนทั้งหมดเป็นข้อมูลระดับ manager ขึ้นไป (RLS) — แคชเชียร์/พนักงานต้องไม่เห็น
-- ไม่แก้ตาราง products / order_items ของ POS (ข้อมูลต้นทุนรายเมนูอยู่ใน product_cost_settings)
-- ============================================================

-- 1) หมวดบัญชีเดิมแต่ละหมวดเป็นต้นทุนประเภทไหน (ใช้เทียบค่าใช้จ่ายจริงใน C2)
alter table public.accounting_categories
  add column if not exists cost_type text;

do $$
begin
  alter table public.accounting_categories
    add constraint accounting_categories_cost_type_check
    check (cost_type is null or cost_type in (
      'rent', 'labor', 'utility', 'system', 'marketing', 'maintenance', 'ingredient', 'packaging', 'other'
    ));
exception when duplicate_object then null;
end $$;

-- 2) ตั้งค่าการคำนวณรายร้าน
create table if not exists public.store_cost_settings (
  store_id              uuid primary key references public.stores(id) on delete cascade,
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  open_days_per_month   int not null default 26 check (open_days_per_month between 1 and 31),
  target_profit_monthly numeric(12,2) not null default 0 check (target_profit_monthly >= 0),
  target_food_cost_pct  numeric(5,2) not null default 35
                        check (target_food_cost_pct > 0 and target_food_cost_pct < 100),
  other_variable_pct    numeric(5,2) not null default 0
                        check (other_variable_pct >= 0 and other_variable_pct < 100),
  price_rounding        text not null default 'ceil_1'
                        check (price_rounding in ('none', 'ceil_1', 'ceil_5', 'ceil_10')),
  cash_reserve          numeric(12,2) check (cash_reserve is null or cash_reserve >= 0),
  updated_at            timestamptz not null default now()
);

-- 3) งบต้นทุนคงที่ต่อเดือน + เงินลงทุนเริ่มต้น (ใช้ใน wizard C2)
create table if not exists public.store_cost_budgets (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  store_id           uuid not null references public.stores(id) on delete cascade,
  kind               text not null default 'monthly' check (kind in ('monthly', 'startup')),
  cost_type          text not null check (btrim(cost_type) <> ''),
  name               text not null check (btrim(name) <> ''),
  amount             numeric(12,2) not null check (amount >= 0),
  useful_life_months int check (useful_life_months is null or useful_life_months > 0),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists store_cost_budgets_store_idx on public.store_cost_budgets (store_id, kind);

-- 4) วัตถุดิบ
create table if not exists public.ingredients (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  store_id           uuid not null references public.stores(id) on delete cascade,
  name               text not null check (btrim(name) <> ''),
  purchase_unit      text not null check (btrim(purchase_unit) <> ''),  -- กก. / แพ็ค / ขวด
  usage_unit         text not null check (btrim(usage_unit) <> ''),     -- กรัม / ชิ้น / มล.
  usage_per_purchase numeric(12,4) not null check (usage_per_purchase > 0),
  purchase_price     numeric(12,2) not null check (purchase_price >= 0),
  yield_pct          numeric(5,2) not null default 100 check (yield_pct > 0 and yield_pct <= 100),
  stock_pool_id      uuid references public.stock_pools(id) on delete set null,  -- C3
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (store_id, name)
);

create table if not exists public.ingredient_price_history (
  id             uuid primary key default gen_random_uuid(),
  ingredient_id  uuid not null references public.ingredients(id) on delete cascade,
  purchase_price numeric(12,2) not null check (purchase_price >= 0),
  recorded_by    uuid,
  recorded_at    timestamptz not null default now()
);
create index if not exists ingredient_price_history_ingredient_idx
  on public.ingredient_price_history (ingredient_id, recorded_at desc);

-- 5) สูตรเมนู (variant_id null = ใช้กับทุกตัวเลือก)
create table if not exists public.recipe_lines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  product_id      uuid not null references products(id) on delete cascade,
  variant_id      uuid references public.product_variants(id) on delete cascade,
  ingredient_id   uuid not null references public.ingredients(id) on delete restrict,
  quantity        numeric(12,4) not null check (quantity > 0),
  created_at      timestamptz not null default now()
);
create index if not exists recipe_lines_product_idx on public.recipe_lines (product_id, variant_id);
create index if not exists recipe_lines_ingredient_idx on public.recipe_lines (ingredient_id);

-- 6) ค่าต้นทุนรายเมนู (แยกจาก products เพราะ products ถูกอ่านโดย POS/QR)
create table if not exists public.product_cost_settings (
  product_id           uuid primary key references products(id) on delete cascade,
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  store_id             uuid not null references public.stores(id) on delete cascade,
  packaging_cost       numeric(12,2) not null default 0 check (packaging_cost >= 0),
  target_food_cost_pct numeric(5,2) check (target_food_cost_pct is null or (target_food_cost_pct > 0 and target_food_cost_pct < 100)),
  updated_at           timestamptz not null default now()
);
create index if not exists product_cost_settings_store_idx on public.product_cost_settings (store_id);

-- 7) สัดส่วนเป้าหมาย 5 ส่วน (เก็บประวัติด้วย effective_from — แก้ = เพิ่มแถวใหม่)
create table if not exists public.cost_allocation_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  product_id      uuid references products(id) on delete cascade,  -- null = ค่าทั้งร้าน
  ingredient_pct  numeric(5,2) not null check (ingredient_pct >= 0),
  packaging_pct   numeric(5,2) not null check (packaging_pct >= 0),
  labor_pct       numeric(5,2) not null check (labor_pct >= 0),
  overhead_pct    numeric(5,2) not null check (overhead_pct >= 0),
  profit_pct      numeric(5,2) not null check (profit_pct >= 0),
  effective_from  timestamptz not null default now(),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint cost_allocation_templates_sum_100
    check (ingredient_pct + packaging_pct + labor_pct + overhead_pct + profit_pct = 100)
);
create index if not exists cost_allocation_templates_lookup_idx
  on public.cost_allocation_templates (store_id, product_id, effective_from desc);

-- ------------------------------------------------------------
-- RLS — manager ขึ้นไปเท่านั้น
-- ------------------------------------------------------------
alter table public.store_cost_settings enable row level security;
alter table public.store_cost_budgets enable row level security;
alter table public.ingredients enable row level security;
alter table public.ingredient_price_history enable row level security;
alter table public.recipe_lines enable row level security;
alter table public.product_cost_settings enable row level security;
alter table public.cost_allocation_templates enable row level security;

drop policy if exists "store_cost_settings_manager" on public.store_cost_settings;
create policy "store_cost_settings_manager" on public.store_cost_settings for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

drop policy if exists "store_cost_budgets_manager" on public.store_cost_budgets;
create policy "store_cost_budgets_manager" on public.store_cost_budgets for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

drop policy if exists "ingredients_manager" on public.ingredients;
create policy "ingredients_manager" on public.ingredients for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

drop policy if exists "ingredient_price_history_manager" on public.ingredient_price_history;
create policy "ingredient_price_history_manager" on public.ingredient_price_history for all
  using (exists (
    select 1 from public.ingredients i
    where i.id = ingredient_id and auth_user_role_in_store(i.organization_id, i.store_id, 'manager')
  ))
  with check (exists (
    select 1 from public.ingredients i
    where i.id = ingredient_id and auth_user_role_in_store(i.organization_id, i.store_id, 'manager')
  ));

drop policy if exists "recipe_lines_manager" on public.recipe_lines;
create policy "recipe_lines_manager" on public.recipe_lines for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (
    auth_user_role_in_store(organization_id, store_id, 'manager')
    -- สินค้า/วัตถุดิบ/ตัวเลือกต้องเป็นของร้านเดียวกัน (กันผูกข้ามร้าน)
    and exists (select 1 from public.products p where p.id = product_id and p.store_id = recipe_lines.store_id)
    and exists (select 1 from public.ingredients i where i.id = ingredient_id and i.store_id = recipe_lines.store_id)
    and (variant_id is null or exists (
      select 1 from public.product_variants v where v.id = variant_id and v.product_id = recipe_lines.product_id
    ))
  );

drop policy if exists "product_cost_settings_manager" on public.product_cost_settings;
create policy "product_cost_settings_manager" on public.product_cost_settings for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (
    auth_user_role_in_store(organization_id, store_id, 'manager')
    and exists (select 1 from public.products p where p.id = product_id and p.store_id = product_cost_settings.store_id)
  );

drop policy if exists "cost_allocation_templates_manager" on public.cost_allocation_templates;
create policy "cost_allocation_templates_manager" on public.cost_allocation_templates for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (
    auth_user_role_in_store(organization_id, store_id, 'manager')
    and (product_id is null or exists (
      select 1 from public.products p where p.id = product_id and p.store_id = cost_allocation_templates.store_id
    ))
  );
