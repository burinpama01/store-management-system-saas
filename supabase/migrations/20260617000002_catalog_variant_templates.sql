-- Catalog-level variant templates let managers define reusable option sets once,
-- then apply them to many products without retyping.

create table if not exists catalog_variant_templates (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  price_adjustment numeric(12,2) not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists catalog_variant_templates_store_id_idx
  on catalog_variant_templates(store_id);

create unique index if not exists catalog_variant_templates_store_name_price_idx
  on catalog_variant_templates(store_id, lower(btrim(name)), price_adjustment);

create table if not exists catalog_modifier_group_templates (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  selection_type text not null default 'single' check (selection_type in ('single', 'multiple')),
  is_required boolean not null default false,
  min_selections int not null default 0,
  max_selections int not null default 1,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists catalog_modifier_group_templates_store_id_idx
  on catalog_modifier_group_templates(store_id);

create unique index if not exists catalog_modifier_group_templates_store_name_idx
  on catalog_modifier_group_templates(store_id, lower(btrim(name)));

create table if not exists catalog_modifier_option_templates (
  id uuid primary key default gen_random_uuid(),
  group_template_id uuid not null references catalog_modifier_group_templates(id) on delete cascade,
  name text not null,
  price_adjustment numeric(12,2) not null default 0,
  is_default boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists catalog_modifier_option_templates_group_id_idx
  on catalog_modifier_option_templates(group_template_id);

create unique index if not exists catalog_modifier_option_templates_group_name_price_idx
  on catalog_modifier_option_templates(group_template_id, lower(btrim(name)), price_adjustment);

do $$
begin
  if exists (
    select 1
    from product_variants
    where is_active = true
    group by product_id, lower(btrim(name)), price_adjustment
    having count(*) > 1
  ) then
    raise exception
      'duplicate active product variants block variant template unique index; resolve duplicates by product_id/name/price_adjustment before applying migration';
  end if;
end $$;

create unique index if not exists product_variants_product_name_price_unique_idx
  on product_variants(product_id, lower(btrim(name)), price_adjustment)
  where is_active = true;

do $$
begin
  if exists (
    select 1
    from modifier_groups
    group by product_id, lower(btrim(name))
    having count(*) > 1
  ) then
    raise exception
      'duplicate product modifier groups block modifier group template unique index; resolve duplicates by product_id/name before applying migration';
  end if;
end $$;

create unique index if not exists modifier_groups_product_name_unique_idx
  on modifier_groups(product_id, lower(btrim(name)));

alter table catalog_variant_templates enable row level security;
alter table catalog_modifier_group_templates enable row level security;
alter table catalog_modifier_option_templates enable row level security;

drop policy if exists "catalog_variant_templates: store member can read" on catalog_variant_templates;
create policy "catalog_variant_templates: store member can read"
  on catalog_variant_templates for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "catalog_variant_templates: manager+ can write" on catalog_variant_templates;
create policy "catalog_variant_templates: manager+ can write"
  on catalog_variant_templates for all
  using (
    exists (
      select 1 from stores s
      where s.id = catalog_variant_templates.store_id
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  )
  with check (
    exists (
      select 1 from stores s
      where s.id = catalog_variant_templates.store_id
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  );

drop policy if exists "catalog_modifier_group_templates: store member can read" on catalog_modifier_group_templates;
create policy "catalog_modifier_group_templates: store member can read"
  on catalog_modifier_group_templates for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "catalog_modifier_group_templates: manager+ can write" on catalog_modifier_group_templates;
create policy "catalog_modifier_group_templates: manager+ can write"
  on catalog_modifier_group_templates for all
  using (
    exists (
      select 1 from stores s
      where s.id = catalog_modifier_group_templates.store_id
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  )
  with check (
    exists (
      select 1 from stores s
      where s.id = catalog_modifier_group_templates.store_id
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  );

drop policy if exists "catalog_modifier_option_templates: store member can read" on catalog_modifier_option_templates;
create policy "catalog_modifier_option_templates: store member can read"
  on catalog_modifier_option_templates for select
  using (
    exists (
      select 1
      from catalog_modifier_group_templates group_template
      where group_template.id = catalog_modifier_option_templates.group_template_id
        and group_template.store_id in (select auth_user_store_ids())
    )
  );

drop policy if exists "catalog_modifier_option_templates: manager+ can write" on catalog_modifier_option_templates;
create policy "catalog_modifier_option_templates: manager+ can write"
  on catalog_modifier_option_templates for all
  using (
    exists (
      select 1
      from catalog_modifier_group_templates group_template
      join stores s on s.id = group_template.store_id
      where group_template.id = catalog_modifier_option_templates.group_template_id
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  )
  with check (
    exists (
      select 1
      from catalog_modifier_group_templates group_template
      join stores s on s.id = group_template.store_id
      where group_template.id = catalog_modifier_option_templates.group_template_id
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  );
