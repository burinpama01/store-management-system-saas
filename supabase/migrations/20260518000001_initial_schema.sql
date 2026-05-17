-- ============================================================
-- Store Management SaaS – Initial Schema
-- ============================================================

-- Enable extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================
-- SAAS BOUNDARY: organizations, subscriptions, stores
-- ============================================================

create table organizations (
  id             uuid primary key default uuid_generate_v4(),
  name           text not null,
  slug           text not null unique,
  owner_id       uuid not null,               -- references auth.users(id)
  logo_url       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table subscriptions (
  id                    uuid primary key default uuid_generate_v4(),
  organization_id       uuid not null references organizations(id) on delete cascade,
  plan                  text not null default 'free' check (plan in ('free','starter','professional','enterprise')),
  status                text not null default 'active' check (status in ('active','trialing','past_due','canceled','paused')),
  current_period_start  timestamptz not null default now(),
  current_period_end    timestamptz not null default (now() + interval '30 days'),
  cancel_at_period_end  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table stores (
  id                    uuid primary key default uuid_generate_v4(),
  organization_id       uuid not null references organizations(id) on delete cascade,
  name                  text not null,
  slug                  text not null,
  address               text,
  phone                 text,
  logo_url              text,
  currency_code         text not null default 'THB',
  timezone              text not null default 'Asia/Bangkok',
  locale                text not null default 'th-TH',
  is_active             boolean not null default true,
  buffet_enabled        boolean not null default false,
  qr_ordering_enabled   boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organization_id, slug)
);

-- ============================================================
-- MEMBERSHIPS AND PERMISSIONS
-- ============================================================

create table memberships (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid references stores(id) on delete cascade,
  user_id         uuid not null,               -- references auth.users(id)
  role            text not null check (role in ('owner','admin','manager','cashier','staff')),
  invited_at      timestamptz not null default now(),
  joined_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index memberships_user_id_idx on memberships(user_id);
create index memberships_org_id_idx on memberships(organization_id);
create unique index memberships_org_user_unique_idx
  on memberships(organization_id, user_id)
  where store_id is null;
create unique index memberships_store_user_unique_idx
  on memberships(organization_id, store_id, user_id)
  where store_id is not null;

create table membership_permission_overrides (
  id              uuid primary key default uuid_generate_v4(),
  membership_id   uuid not null references memberships(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid references stores(id) on delete cascade,
  permission_key  text not null,
  granted         boolean not null,
  reason          text not null default '',
  granted_by_user_id uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (membership_id, permission_key)
);
create index mpo_org_id_idx on membership_permission_overrides(organization_id);
create index mpo_store_id_idx on membership_permission_overrides(store_id);

-- Append-only audit log
create table audit_logs (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid references stores(id) on delete set null,
  actor_user_id   uuid not null,
  target_user_id  uuid,
  action          text not null,
  before          jsonb,
  after           jsonb,
  reason          text,
  request_id      text,
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default now()
  -- No updated_at: rows are append-only
);
create index audit_logs_org_id_idx on audit_logs(organization_id);
create index audit_logs_actor_idx on audit_logs(actor_user_id);
create index audit_logs_created_at_idx on audit_logs(created_at desc);

-- ============================================================
-- CATALOG
-- ============================================================

create table categories (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  name            text not null,
  description     text,
  sort_order      int not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index categories_store_id_idx on categories(store_id);

create table products (
  id                   uuid primary key default uuid_generate_v4(),
  organization_id      uuid not null references organizations(id) on delete cascade,
  store_id             uuid not null references stores(id) on delete cascade,
  category_id          uuid not null references categories(id) on delete restrict,
  name                 text not null,
  description          text,
  image_url            text,
  base_price           numeric(12,2) not null default 0 check (base_price >= 0),
  is_active            boolean not null default true,
  available_for_pos    boolean not null default true,
  available_for_qr     boolean not null default true,
  sort_order           int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index products_store_id_idx on products(store_id);
create index products_category_id_idx on products(category_id);

create table product_variants (
  id               uuid primary key default uuid_generate_v4(),
  product_id       uuid not null references products(id) on delete cascade,
  name             text not null,
  price_adjustment numeric(12,2) not null default 0,
  sku              text,
  stock_quantity   int,
  track_stock      boolean not null default false,
  is_active        boolean not null default true,
  sort_order       int not null default 0
);
create index product_variants_product_id_idx on product_variants(product_id);

create table modifier_groups (
  id               uuid primary key default uuid_generate_v4(),
  product_id       uuid not null references products(id) on delete cascade,
  name             text not null,
  selection_type   text not null check (selection_type in ('single','multiple')),
  is_required      boolean not null default false,
  min_selections   int not null default 0 check (min_selections >= 0),
  max_selections   int not null default 1 check (max_selections >= 1),
  sort_order       int not null default 0,
  check (min_selections <= max_selections)
);
create index modifier_groups_product_id_idx on modifier_groups(product_id);

create table modifier_options (
  id                  uuid primary key default uuid_generate_v4(),
  modifier_group_id   uuid not null references modifier_groups(id) on delete cascade,
  name                text not null,
  price_adjustment    numeric(12,2) not null default 0,
  is_default          boolean not null default false,
  is_active           boolean not null default true,
  sort_order          int not null default 0
);
create index modifier_options_group_id_idx on modifier_options(modifier_group_id);

-- ============================================================
-- TABLES (physical restaurant/store tables)
-- ============================================================

create table tables (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  number          text not null,
  label           text,
  seats           int,
  is_active       boolean not null default true,
  qr_enabled      boolean not null default false,
  status          text not null default 'available' check (status in ('available','occupied','reserved','cleaning')),
  current_session_id uuid,               -- FK added after buffet_sessions table
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (store_id, number)
);
create index tables_store_id_idx on tables(store_id);

-- ============================================================
-- ORDERS, ORDER ITEMS, PAYMENTS
-- ============================================================

create table orders (
  id                  uuid primary key default uuid_generate_v4(),
  organization_id     uuid not null references organizations(id) on delete cascade,
  store_id            uuid not null references stores(id) on delete cascade,
  order_number        text not null,
  status              text not null default 'draft' check (status in ('draft','open','pending_payment','paid','refunded','voided','cancelled')),
  table_id            uuid references tables(id) on delete set null,
  table_number        text,
  buffet_session_id   uuid,               -- FK added after buffet_sessions
  cashier_id          uuid not null,
  subtotal            numeric(12,2) not null default 0,
  discount            numeric(12,2) not null default 0,
  discount_note       text,
  total               numeric(12,2) not null default 0,
  note                text,
  qr_order_source     boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  paid_at             timestamptz,
  voided_at           timestamptz,
  void_reason         text,
  voided_by_user_id   uuid,
  unique (store_id, order_number)
);
create index orders_store_id_idx on orders(store_id);
create index orders_status_idx on orders(status);
create index orders_created_at_idx on orders(created_at desc);

create table order_items (
  id                  uuid primary key default uuid_generate_v4(),
  order_id            uuid not null references orders(id) on delete cascade,
  product_id          uuid not null references products(id) on delete restrict,
  product_name        text not null,
  variant_id          uuid references product_variants(id) on delete set null,
  variant_name        text,
  modifiers           jsonb not null default '[]',
  quantity            int not null check (quantity > 0),
  unit_price          numeric(12,2) not null,
  total_price         numeric(12,2) not null,
  note                text
);
create index order_items_order_id_idx on order_items(order_id);

create table payments (
  id                  uuid primary key default uuid_generate_v4(),
  order_id            uuid not null references orders(id) on delete cascade,
  method              text not null check (method in ('cash','qr_promptpay','credit_card','bank_transfer','other')),
  amount              numeric(12,2) not null,
  status              text not null default 'pending' check (status in ('pending','completed','failed','refunded')),
  reference           text,
  received_amount     numeric(12,2),
  change_amount       numeric(12,2),
  processed_at        timestamptz not null default now(),
  processed_by_user_id uuid not null
);
create index payments_order_id_idx on payments(order_id);

-- ============================================================
-- ACCOUNTING
-- ============================================================

create table accounting_categories (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  name            text not null,
  type            text not null check (type in ('income','expense','cash_adjustment')),
  is_default      boolean not null default false,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index accounting_categories_store_id_idx on accounting_categories(store_id);

create table transactions (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  type            text not null check (type in ('income','expense','cash_adjustment')),
  category_id     uuid not null references accounting_categories(id) on delete restrict,
  category_name   text not null,
  amount          numeric(12,2) not null check (amount > 0),
  note            text,
  date            date not null,
  created_by_user_id uuid not null,
  order_id        uuid references orders(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index transactions_store_id_idx on transactions(store_id);
create index transactions_date_idx on transactions(date desc);

create table cash_ledger_entries (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  type            text not null check (type in ('open','close','adjustment','pos_sale','expense','income')),
  amount          numeric(12,2) not null,
  balance_after   numeric(12,2) not null,
  transaction_id  uuid references transactions(id) on delete set null,
  order_id        uuid references orders(id) on delete set null,
  note            text,
  created_by_user_id uuid not null,
  created_at      timestamptz not null default now()
);
create index cash_ledger_store_id_idx on cash_ledger_entries(store_id);
create index cash_ledger_created_at_idx on cash_ledger_entries(created_at desc);

-- ============================================================
-- ATTENDANCE
-- ============================================================

create table attendance_records (
  id                      uuid primary key default uuid_generate_v4(),
  organization_id         uuid not null references organizations(id) on delete cascade,
  store_id                uuid not null references stores(id) on delete cascade,
  user_id                 uuid not null,
  employee_name           text not null,
  date                    date not null,
  clock_in_at             timestamptz not null,
  clock_out_at            timestamptz,
  clock_in_lat            double precision,
  clock_in_lng            double precision,
  clock_in_location_label text,
  clock_out_lat           double precision,
  clock_out_lng           double precision,
  clock_out_location_label text,
  status                  text not null default 'active' check (status in ('active','completed','backdated','adjusted')),
  note                    text,
  adjusted_by_user_id     uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index attendance_store_id_idx on attendance_records(store_id);
create index attendance_user_date_idx on attendance_records(user_id, date desc);

-- ============================================================
-- BUFFET
-- ============================================================

create table buffet_sessions (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  table_id        uuid references tables(id) on delete set null,
  package_name    text not null,
  price_per_guest numeric(12,2) not null,
  guest_count     int not null check (guest_count > 0),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  status          text not null default 'open' check (status in ('open','closed')),
  order_id        uuid references orders(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index buffet_sessions_store_id_idx on buffet_sessions(store_id);

-- Add FK back to tables
alter table tables add constraint tables_current_session_id_fkey
  foreign key (current_session_id) references buffet_sessions(id) on delete set null;

-- Add FK back to orders
alter table orders add constraint orders_buffet_session_id_fkey
  foreign key (buffet_session_id) references buffet_sessions(id) on delete set null;

-- ============================================================
-- STORE SETTINGS
-- ============================================================

create table receipt_settings (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade unique,
  store_name      text not null,
  address         text,
  phone           text,
  tax_id          text,
  show_tax_id     boolean not null default false,
  show_qr_payment boolean not null default false,
  promptpay_id    text,
  header_text     text,
  footer_text     text,
  logo_url        text,
  paper_width     text not null default '80mm' check (paper_width in ('58mm','80mm')),
  print_copies    int not null default 1 check (print_copies >= 1),
  updated_at      timestamptz not null default now()
);

create table printers (
  id                  uuid primary key default uuid_generate_v4(),
  organization_id     uuid not null references organizations(id) on delete cascade,
  store_id            uuid not null references stores(id) on delete cascade,
  name                text not null,
  type                text not null check (type in ('browser','usb','bluetooth','ip','escpos')),
  is_default          boolean not null default false,
  ip_address          text,
  port                int,
  usb_vendor_id       text,
  usb_product_id      text,
  bluetooth_device_id text,
  paper_width         text not null default '80mm' check (paper_width in ('58mm','80mm')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index printers_store_id_idx on printers(store_id);

-- ============================================================
-- UPDATED_AT TRIGGER HELPER
-- ============================================================

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Apply trigger to all tables with updated_at
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'organizations','subscriptions','stores','memberships',
    'membership_permission_overrides','categories','products',
    'tables','orders','accounting_categories','transactions',
    'attendance_records','buffet_sessions','receipt_settings','printers'
  ]
  loop
    execute format(
      'create trigger set_updated_at before update on %I for each row execute function set_updated_at()',
      tbl
    );
  end loop;
end;
$$;
