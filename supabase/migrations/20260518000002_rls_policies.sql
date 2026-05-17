-- ============================================================
-- Row Level Security Policies
-- ============================================================

-- Enable RLS on all exposed tables
alter table organizations                    enable row level security;
alter table subscriptions                    enable row level security;
alter table stores                           enable row level security;
alter table memberships                      enable row level security;
alter table membership_permission_overrides  enable row level security;
alter table audit_logs                       enable row level security;
alter table categories                       enable row level security;
alter table products                         enable row level security;
alter table product_variants                 enable row level security;
alter table modifier_groups                  enable row level security;
alter table modifier_options                 enable row level security;
alter table tables                           enable row level security;
alter table orders                           enable row level security;
alter table order_items                      enable row level security;
alter table payments                         enable row level security;
alter table accounting_categories            enable row level security;
alter table transactions                     enable row level security;
alter table cash_ledger_entries              enable row level security;
alter table attendance_records               enable row level security;
alter table buffet_sessions                  enable row level security;
alter table receipt_settings                 enable row level security;
alter table printers                         enable row level security;

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Returns organization IDs the current user has membership in
create or replace function auth_user_organization_ids()
returns setof uuid language sql security definer stable as $$
  select distinct organization_id from memberships
  where user_id = auth.uid() and joined_at is not null;
$$;

-- Returns store IDs the current user has membership in (org-wide or store-scoped)
create or replace function auth_user_store_ids()
returns setof uuid language sql security definer stable as $$
  select s.id from stores s
  where s.organization_id in (select auth_user_organization_ids())
  and (
    -- org-wide member sees all stores in org
    exists (
      select 1 from memberships m
      where m.user_id = auth.uid()
        and m.organization_id = s.organization_id
        and m.store_id is null
        and m.joined_at is not null
    )
    or
    -- store-scoped member sees only their store
    exists (
      select 1 from memberships m
      where m.user_id = auth.uid()
        and m.store_id = s.id
        and m.joined_at is not null
    )
  );
$$;

-- Returns true if user has a specific role or higher in an org
create or replace function auth_user_role_in_org(org_id uuid, min_role text)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from memberships m
    where m.user_id = auth.uid()
      and m.organization_id = org_id
      and m.store_id is null
      and m.joined_at is not null
      and case min_role
        when 'owner'   then m.role = 'owner'
        when 'admin'   then m.role in ('owner','admin')
        when 'manager' then m.role in ('owner','admin','manager')
        when 'cashier' then m.role in ('owner','admin','manager','cashier')
        when 'staff'   then m.role in ('owner','admin','manager','cashier','staff')
        else false
      end
  );
$$;

-- Returns true if user has role in the exact store scope or org-wide scope
create or replace function auth_user_role_in_store(org_id uuid, target_store_id uuid, min_role text)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from memberships m
    where m.user_id = auth.uid()
      and m.organization_id = org_id
      and (m.store_id is null or m.store_id = target_store_id)
      and m.joined_at is not null
      and case min_role
        when 'owner'   then m.role = 'owner'
        when 'admin'   then m.role in ('owner','admin')
        when 'manager' then m.role in ('owner','admin','manager')
        when 'cashier' then m.role in ('owner','admin','manager','cashier')
        when 'staff'   then m.role in ('owner','admin','manager','cashier','staff')
        else false
      end
  );
$$;

-- ============================================================
-- ORGANIZATIONS
-- ============================================================

create policy "org: member can read own org"
  on organizations for select
  using (id in (select auth_user_organization_ids()));

create policy "org: owner can update"
  on organizations for update
  using (auth_user_role_in_org(id, 'owner'));

-- ============================================================
-- SUBSCRIPTIONS
-- ============================================================

create policy "sub: member can read"
  on subscriptions for select
  using (organization_id in (select auth_user_organization_ids()));

create policy "sub: owner can update"
  on subscriptions for update
  using (auth_user_role_in_org(organization_id, 'owner'));

-- ============================================================
-- STORES
-- ============================================================

create policy "stores: member can read their stores"
  on stores for select
  using (id in (select auth_user_store_ids()));

create policy "stores: admin+ can insert"
  on stores for insert
  with check (auth_user_role_in_org(organization_id, 'admin'));

create policy "stores: admin+ can update"
  on stores for update
  using (auth_user_role_in_store(organization_id, id, 'admin'));

create policy "stores: owner can delete"
  on stores for delete
  using (auth_user_role_in_org(organization_id, 'owner'));

-- ============================================================
-- MEMBERSHIPS
-- ============================================================

create policy "memberships: member can read own org members"
  on memberships for select
  using (organization_id in (select auth_user_organization_ids()));

create policy "memberships: admin+ can invite (insert)"
  on memberships for insert
  with check (auth_user_role_in_org(organization_id, 'admin'));

create policy "memberships: admin+ can update (not self, not owner)"
  on memberships for update
  using (
    auth_user_role_in_org(organization_id, 'admin')
    and user_id <> auth.uid()
    and role <> 'owner'
  );

create policy "memberships: owner can manage all"
  on memberships for all
  using (auth_user_role_in_org(organization_id, 'owner'));

-- ============================================================
-- MEMBERSHIP PERMISSION OVERRIDES
-- ============================================================

create policy "mpo: org member can read"
  on membership_permission_overrides for select
  using (organization_id in (select auth_user_organization_ids()));

-- Writes handled by server action only; deny all direct client writes
create policy "mpo: deny client insert"
  on membership_permission_overrides for insert
  with check (false);

create policy "mpo: deny client update"
  on membership_permission_overrides for update
  using (false);

create policy "mpo: deny client delete"
  on membership_permission_overrides for delete
  using (false);

-- ============================================================
-- AUDIT LOGS – append-only
-- ============================================================

create policy "audit: member can read own org logs"
  on audit_logs for select
  using (organization_id in (select auth_user_organization_ids()));

-- Deny client insert/update/delete – only service role path allowed
create policy "audit: deny client insert"
  on audit_logs for insert
  with check (false);

create policy "audit: deny client update"
  on audit_logs for update
  using (false);

create policy "audit: deny client delete"
  on audit_logs for delete
  using (false);

-- ============================================================
-- CATALOG
-- ============================================================

create policy "categories: store member can read"
  on categories for select
  using (store_id in (select auth_user_store_ids()));

create policy "categories: manager+ can write"
  on categories for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "categories: manager+ can update"
  on categories for update
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "categories: manager+ can delete"
  on categories for delete
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "products: store member can read"
  on products for select
  using (store_id in (select auth_user_store_ids()));

create policy "products: manager+ can write"
  on products for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "products: manager+ can update"
  on products for update
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "products: manager+ can delete"
  on products for delete
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "product_variants: store member can read"
  on product_variants for select
  using (product_id in (select id from products where store_id in (select auth_user_store_ids())));

-- FOR ALL with both USING (row visibility for SELECT/UPDATE/DELETE) and WITH CHECK (INSERT guard)
create policy "product_variants: manager+ can write"
  on product_variants for all
  using (product_id in (select id from products p where auth_user_role_in_store(p.organization_id, p.store_id, 'manager')))
  with check (product_id in (select id from products p where auth_user_role_in_store(p.organization_id, p.store_id, 'manager')));

create policy "modifier_groups: store member can read"
  on modifier_groups for select
  using (product_id in (select id from products where store_id in (select auth_user_store_ids())));

create policy "modifier_groups: manager+ can write"
  on modifier_groups for all
  using (product_id in (select id from products p where auth_user_role_in_store(p.organization_id, p.store_id, 'manager')))
  with check (product_id in (select id from products p where auth_user_role_in_store(p.organization_id, p.store_id, 'manager')));

create policy "modifier_options: store member can read"
  on modifier_options for select
  using (modifier_group_id in (
    select mg.id from modifier_groups mg
    join products p on p.id = mg.product_id
    where p.store_id in (select auth_user_store_ids())
  ));

create policy "modifier_options: manager+ can write"
  on modifier_options for all
  using (modifier_group_id in (
    select mg.id from modifier_groups mg
    join products p on p.id = mg.product_id
    where auth_user_role_in_store(p.organization_id, p.store_id, 'manager')
  ))
  with check (modifier_group_id in (
    select mg.id from modifier_groups mg
    join products p on p.id = mg.product_id
    where auth_user_role_in_store(p.organization_id, p.store_id, 'manager')
  ));

-- ============================================================
-- TABLES
-- ============================================================

create policy "tables: store member can read"
  on tables for select
  using (store_id in (select auth_user_store_ids()));

create policy "tables: manager+ can write"
  on tables for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "tables: manager+ can update"
  on tables for update
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "tables: admin+ can delete"
  on tables for delete
  using (auth_user_role_in_store(organization_id, store_id, 'admin'));

-- ============================================================
-- ORDERS
-- ============================================================

create policy "orders: store member can read"
  on orders for select
  using (store_id in (select auth_user_store_ids()));

create policy "orders: cashier+ can create"
  on orders for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

create policy "orders: cashier+ can update"
  on orders for update
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'));

create policy "order_items: store member can read"
  on order_items for select
  using (order_id in (select id from orders where store_id in (select auth_user_store_ids())));

create policy "order_items: cashier+ can write"
  on order_items for insert
  with check (order_id in (
    select id from orders o
    where auth_user_role_in_store(o.organization_id, o.store_id, 'cashier')
  ));

create policy "payments: store member can read"
  on payments for select
  using (order_id in (select id from orders where store_id in (select auth_user_store_ids())));

create policy "payments: cashier+ can insert"
  on payments for insert
  with check (order_id in (
    select id from orders o
    where auth_user_role_in_store(o.organization_id, o.store_id, 'cashier')
  ));

-- ============================================================
-- ACCOUNTING
-- ============================================================

create policy "accounting_categories: store member can read"
  on accounting_categories for select
  using (store_id in (select auth_user_store_ids()));

create policy "accounting_categories: manager+ can write"
  on accounting_categories for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "transactions: cashflow.view member can read"
  on transactions for select
  using (store_id in (select auth_user_store_ids()));

create policy "transactions: manager+ can write"
  on transactions for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "transactions: manager+ can update"
  on transactions for update
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "cash_ledger: store member can read"
  on cash_ledger_entries for select
  using (store_id in (select auth_user_store_ids()));

create policy "cash_ledger: cashier+ can insert"
  on cash_ledger_entries for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

-- ============================================================
-- ATTENDANCE
-- ============================================================

-- Staff can read their own records; manager+ can read all in store
create policy "attendance: read own or manager+"
  on attendance_records for select
  using (
    user_id = auth.uid()
    or auth_user_role_in_store(organization_id, store_id, 'manager')
  );

create policy "attendance: staff+ can clock"
  on attendance_records for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'staff'));

create policy "attendance: manager+ can adjust"
  on attendance_records for update
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- ============================================================
-- BUFFET
-- ============================================================

create policy "buffet_sessions: store member can read"
  on buffet_sessions for select
  using (store_id in (select auth_user_store_ids()));

create policy "buffet_sessions: cashier+ can manage"
  on buffet_sessions for all
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'))
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

-- ============================================================
-- SETTINGS
-- ============================================================

create policy "receipt_settings: store member can read"
  on receipt_settings for select
  using (store_id in (select auth_user_store_ids()));

create policy "receipt_settings: manager+ can write"
  on receipt_settings for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "printers: store member can read"
  on printers for select
  using (store_id in (select auth_user_store_ids()));

create policy "printers: manager+ can write"
  on printers for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));
