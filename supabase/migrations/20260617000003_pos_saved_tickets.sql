-- Server-backed saved POS tickets. These are held carts, not posted orders.

do $$
begin
  alter table stores
    add constraint stores_id_organization_id_unique unique (id, organization_id);
exception
  when duplicate_object or duplicate_table then null;
end $$;

create table if not exists pos_saved_tickets (
  id                  uuid primary key default uuid_generate_v4(),
  organization_id     uuid not null references organizations(id) on delete cascade,
  store_id            uuid not null references stores(id) on delete cascade,
  ticket_number       text not null,
  label               text not null,
  cart_snapshot       jsonb not null,
  created_by_user_id  uuid not null references auth.users(id),
  updated_by_user_id  uuid not null references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pos_saved_tickets_store_org_match
    foreign key (store_id, organization_id) references stores(id, organization_id) on delete cascade,
  constraint pos_saved_tickets_cart_snapshot_object check (jsonb_typeof(cart_snapshot) = 'object'),
  constraint pos_saved_tickets_cart_store_match check (cart_snapshot->>'storeId' = store_id::text),
  constraint pos_saved_tickets_cart_items_array check (jsonb_typeof(cart_snapshot->'items') = 'array')
);

create index if not exists pos_saved_tickets_store_updated_idx
  on pos_saved_tickets(store_id, updated_at desc);

create index if not exists pos_saved_tickets_org_store_idx
  on pos_saved_tickets(organization_id, store_id);

alter table pos_saved_tickets enable row level security;

drop policy if exists "pos_saved_tickets: store member can read" on pos_saved_tickets;
create policy "pos_saved_tickets: store member can read"
  on pos_saved_tickets for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "pos_saved_tickets: cashier+ can create" on pos_saved_tickets;
create policy "pos_saved_tickets: cashier+ can create"
  on pos_saved_tickets for insert
  with check (
    store_id in (select auth_user_store_ids())
    and auth_user_role_in_store(organization_id, store_id, 'cashier')
    and created_by_user_id = auth.uid()
    and updated_by_user_id = auth.uid()
  );

drop policy if exists "pos_saved_tickets: cashier+ can update" on pos_saved_tickets;
create policy "pos_saved_tickets: cashier+ can update"
  on pos_saved_tickets for update
  using (
    store_id in (select auth_user_store_ids())
    and auth_user_role_in_store(organization_id, store_id, 'cashier')
  )
  with check (
    store_id in (select auth_user_store_ids())
    and auth_user_role_in_store(organization_id, store_id, 'cashier')
    and updated_by_user_id = auth.uid()
  );

drop policy if exists "pos_saved_tickets: cashier+ can delete" on pos_saved_tickets;
create policy "pos_saved_tickets: cashier+ can delete"
  on pos_saved_tickets for delete
  using (
    store_id in (select auth_user_store_ids())
    and auth_user_role_in_store(organization_id, store_id, 'cashier')
  );

create or replace function prevent_pos_saved_ticket_creator_change()
returns trigger language plpgsql as $$
begin
  if new.created_by_user_id <> old.created_by_user_id then
    raise exception 'created_by_user_id cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_pos_saved_ticket_creator_change on pos_saved_tickets;
create trigger prevent_pos_saved_ticket_creator_change before update on pos_saved_tickets
  for each row execute function prevent_pos_saved_ticket_creator_change();

drop trigger if exists set_updated_at on pos_saved_tickets;
create trigger set_updated_at before update on pos_saved_tickets
  for each row execute function set_updated_at();
