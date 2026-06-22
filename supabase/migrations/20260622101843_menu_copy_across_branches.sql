alter table public.products add column if not exists menu_link_id uuid;

update public.products set menu_link_id = id where menu_link_id is null;

create unique index if not exists products_store_menu_link_unique_idx
  on public.products (store_id, menu_link_id)
  where menu_link_id is not null;

create index if not exists products_organization_menu_link_idx
  on public.products (organization_id, menu_link_id);
