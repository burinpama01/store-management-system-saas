-- Public QR menu/table reads must use anon/authenticated RLS, not service role.

drop policy if exists "stores: anon can read active QR stores" on stores;
create policy "stores: anon can read active QR stores"
  on stores
  for select
  to anon, authenticated
  using (
    is_active = true
    and qr_ordering_enabled = true
  );

drop policy if exists "tables: anon can read active QR tables" on tables;
create policy "tables: anon can read active QR tables"
  on tables
  for select
  to anon, authenticated
  using (
    is_active = true
    and qr_enabled = true
    and exists (
      select 1
      from stores
      where stores.id = tables.store_id
        and stores.is_active = true
        and stores.qr_ordering_enabled = true
    )
  );

drop policy if exists "categories: anon can read active QR categories" on categories;
create policy "categories: anon can read active QR categories"
  on categories
  for select
  to anon, authenticated
  using (
    is_active = true
    and exists (
      select 1
      from stores
      where stores.id = categories.store_id
        and stores.is_active = true
        and stores.qr_ordering_enabled = true
    )
  );

drop policy if exists "products: anon can read active QR products" on products;
create policy "products: anon can read active QR products"
  on products
  for select
  to anon, authenticated
  using (
    is_active = true
    and available_for_qr = true
    and exists (
      select 1
      from stores
      where stores.id = products.store_id
        and stores.is_active = true
        and stores.qr_ordering_enabled = true
    )
  );

drop policy if exists "product_variants: anon can read active QR variants" on product_variants;
create policy "product_variants: anon can read active QR variants"
  on product_variants
  for select
  to anon, authenticated
  using (
    is_active = true
    and exists (
      select 1
      from products
      join stores on stores.id = products.store_id
      where products.id = product_variants.product_id
        and products.is_active = true
        and products.available_for_qr = true
        and stores.is_active = true
        and stores.qr_ordering_enabled = true
    )
  );

drop policy if exists "modifier_groups: anon can read active QR groups" on modifier_groups;
create policy "modifier_groups: anon can read active QR groups"
  on modifier_groups
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from products
      join stores on stores.id = products.store_id
      where products.id = modifier_groups.product_id
        and products.is_active = true
        and products.available_for_qr = true
        and stores.is_active = true
        and stores.qr_ordering_enabled = true
    )
  );

drop policy if exists "modifier_options: anon can read active QR options" on modifier_options;
create policy "modifier_options: anon can read active QR options"
  on modifier_options
  for select
  to anon, authenticated
  using (
    is_active = true
    and exists (
      select 1
      from modifier_groups
      join products on products.id = modifier_groups.product_id
      join stores on stores.id = products.store_id
      where modifier_groups.id = modifier_options.modifier_group_id
        and products.is_active = true
        and products.available_for_qr = true
        and stores.is_active = true
        and stores.qr_ordering_enabled = true
    )
  );
