-- Dedicated Grocery POS barcode support.
-- Product barcodes live directly on products; variant barcodes are denormalized
-- with store_id so scanner lookup can enforce per-store uniqueness.

alter table products add column if not exists barcode text;

alter table product_variants add column if not exists store_id uuid;
alter table product_variants add column if not exists barcode text;

update product_variants pv
set store_id = p.store_id
from products p
where pv.product_id = p.id
  and pv.store_id is null;

alter table product_variants
  alter column store_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'product_variants_store_id_fkey'
  ) then
    alter table product_variants
      add constraint product_variants_store_id_fkey
      foreign key (store_id) references stores(id) on delete cascade;
  end if;
end $$;

create or replace function set_product_variant_store_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select p.store_id
    into new.store_id
    from products p
   where p.id = new.product_id;

  if new.store_id is null then
    raise exception 'product variant requires a valid product_id';
  end if;

  return new;
end;
$$;

drop trigger if exists product_variants_set_store_id on product_variants;
create trigger product_variants_set_store_id
before insert or update of product_id
on product_variants
for each row
execute function set_product_variant_store_id();

create unique index if not exists products_store_barcode_active_idx
  on products (store_id, lower(barcode))
  where barcode is not null and is_active;

create unique index if not exists product_variants_store_barcode_active_idx
  on product_variants (store_id, lower(barcode))
  where barcode is not null and is_active;

create index if not exists products_store_barcode_lookup_idx
  on products (store_id, barcode)
  where barcode is not null and is_active and available_for_pos;

create index if not exists product_variants_store_barcode_lookup_idx
  on product_variants (store_id, barcode)
  where barcode is not null and is_active;

create or replace function normalize_catalog_barcode(input text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(trim(coalesce(input, '')), '\s+', '', 'g'));
$$;

create table if not exists catalog_barcodes (
  id                 uuid primary key default uuid_generate_v4(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  store_id           uuid not null references stores(id) on delete cascade,
  normalized_barcode text not null,
  product_id         uuid references products(id) on delete cascade,
  variant_id         uuid references product_variants(id) on delete cascade,
  source             text not null check (source in ('product', 'variant')),
  created_at         timestamptz not null default now(),
  check (
    (product_id is not null and variant_id is null and source = 'product')
    or (product_id is null and variant_id is not null and source = 'variant')
  )
);

create unique index if not exists catalog_barcodes_store_normalized_barcode_idx
  on catalog_barcodes(store_id, normalized_barcode);
create unique index if not exists catalog_barcodes_product_idx
  on catalog_barcodes(product_id)
  where product_id is not null;
create unique index if not exists catalog_barcodes_variant_idx
  on catalog_barcodes(variant_id)
  where variant_id is not null;

alter table catalog_barcodes enable row level security;

create policy "catalog_barcodes: store member can read"
  on catalog_barcodes for select
  using (store_id in (select auth_user_store_ids()));

revoke insert, update, delete on catalog_barcodes from authenticated;
revoke insert, update, delete on catalog_barcodes from anon;

create or replace function sync_store_barcode_registry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_store_id uuid;
  v_normalized_barcode text;
begin
  if tg_table_name = 'products' then
    if tg_op in ('UPDATE', 'DELETE') then
      delete from catalog_barcodes where product_id = old.id;
    end if;
    if tg_op = 'DELETE' then
      return old;
    end if;

    v_organization_id := new.organization_id;
    v_store_id := new.store_id;
    v_normalized_barcode := nullif(normalize_catalog_barcode(new.barcode), '');
    if v_normalized_barcode is not null and new.is_active is true then
      insert into catalog_barcodes (
        organization_id,
        store_id,
        normalized_barcode,
        product_id,
        source
      )
      values (
        v_organization_id,
        v_store_id,
        v_normalized_barcode,
        new.id,
        'product'
      );
    end if;
    return new;
  end if;

  if tg_table_name = 'product_variants' then
    if tg_op in ('UPDATE', 'DELETE') then
      delete from catalog_barcodes where variant_id = old.id;
    end if;
    if tg_op = 'DELETE' then
      return old;
    end if;

    select p.organization_id, p.store_id
      into v_organization_id, v_store_id
      from products p
     where p.id = new.product_id;

    v_normalized_barcode := nullif(normalize_catalog_barcode(new.barcode), '');
    if v_normalized_barcode is not null and new.is_active is true then
      insert into catalog_barcodes (
        organization_id,
        store_id,
        normalized_barcode,
        variant_id,
        source
      )
      values (
        v_organization_id,
        v_store_id,
        v_normalized_barcode,
        new.id,
        'variant'
      );
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists products_sync_barcode_registry on products;
create trigger products_sync_barcode_registry
after insert or update of store_id, organization_id, barcode, is_active or delete
on products
for each row
execute function sync_store_barcode_registry();

drop trigger if exists product_variants_sync_barcode_registry on product_variants;
create trigger product_variants_sync_barcode_registry
after insert or update of product_id, store_id, barcode, is_active or delete
on product_variants
for each row
execute function sync_store_barcode_registry();

insert into catalog_barcodes (
  organization_id,
  store_id,
  normalized_barcode,
  product_id,
  source
)
select
  p.organization_id,
  p.store_id,
  normalize_catalog_barcode(p.barcode),
  p.id,
  'product'
from products p
where p.barcode is not null
  and normalize_catalog_barcode(p.barcode) <> ''
  and p.is_active = true;

insert into catalog_barcodes (
  organization_id,
  store_id,
  normalized_barcode,
  variant_id,
  source
)
select
  p.organization_id,
  p.store_id,
  normalize_catalog_barcode(pv.barcode),
  pv.id,
  'variant'
from product_variants pv
join products p on p.id = pv.product_id
where pv.barcode is not null
  and normalize_catalog_barcode(pv.barcode) <> ''
  and pv.is_active = true;

create or replace function ensure_store_barcode_unique()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_store_id uuid;
  v_barcode text;
begin
  v_barcode := nullif(normalize_catalog_barcode(new.barcode), '');
  if v_barcode is null or new.is_active is not true then
    return new;
  end if;

  if tg_table_name = 'products' then
    if exists (
      select 1
      from product_variants pv
      where pv.store_id = new.store_id
        and pv.is_active = true
        and normalize_catalog_barcode(pv.barcode) = v_barcode
    ) then
      raise exception 'barcode already exists in this store';
    end if;
  elsif tg_table_name = 'product_variants' then
    v_store_id := new.store_id;
    if v_store_id is null then
      select p.store_id into v_store_id from products p where p.id = new.product_id;
      new.store_id := v_store_id;
    end if;

    if exists (
      select 1
      from products p
      where p.store_id = v_store_id
        and p.is_active = true
        and normalize_catalog_barcode(p.barcode) = v_barcode
    ) then
      raise exception 'barcode already exists in this store';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists products_store_barcode_cross_check on products;
create trigger products_store_barcode_cross_check
before insert or update of store_id, barcode, is_active
on products
for each row
execute function ensure_store_barcode_unique();

drop trigger if exists product_variants_store_barcode_cross_check on product_variants;
create trigger product_variants_store_barcode_cross_check
before insert or update of product_id, store_id, barcode, is_active
on product_variants
for each row
execute function ensure_store_barcode_unique();
