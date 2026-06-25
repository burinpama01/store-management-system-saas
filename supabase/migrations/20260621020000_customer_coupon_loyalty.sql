-- Grocery POS phase 2: customers, coupons, and append-only loyalty ledger.

create table if not exists customers (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  name            text not null,
  phone           text,
  email           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists customers_store_active_idx on customers(store_id, is_active);
create index if not exists customers_store_phone_idx on customers(store_id, phone) where phone is not null;
create index if not exists customers_store_email_idx on customers(store_id, lower(email)) where email is not null;

create table if not exists coupons (
  id                           uuid primary key default uuid_generate_v4(),
  organization_id              uuid not null references organizations(id) on delete cascade,
  store_id                     uuid not null references stores(id) on delete cascade,
  code                         text not null,
  name                         text not null,
  discount_type                text not null check (discount_type in ('amount', 'percentage')),
  discount_value               numeric(12,2) not null check (discount_value > 0),
  min_subtotal                 numeric(12,2) not null default 0 check (min_subtotal >= 0),
  starts_at                    timestamptz,
  ends_at                      timestamptz,
  max_redemptions              integer check (max_redemptions is null or max_redemptions > 0),
  max_redemptions_per_customer integer check (max_redemptions_per_customer is null or max_redemptions_per_customer > 0),
  customer_ids                 uuid[] not null default '{}',
  stackable_with_manual_discount boolean not null default false,
  is_active                    boolean not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index if not exists coupons_store_active_idx on coupons(store_id, is_active);
create index if not exists coupons_store_code_idx on coupons(store_id, lower(code));

create or replace function normalize_coupon_code(input text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(trim(coalesce(input, '')), '\s+', '', 'g'));
$$;

alter table coupons add column if not exists normalized_code text;

create or replace function set_coupon_normalized_code()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.code := upper(trim(new.code));
  new.normalized_code := normalize_coupon_code(new.code);
  if new.normalized_code = '' then
    raise exception 'coupon code is required';
  end if;
  return new;
end;
$$;

drop trigger if exists coupons_set_normalized_code on coupons;
create trigger coupons_set_normalized_code
before insert or update of code
on coupons
for each row
execute function set_coupon_normalized_code();

update coupons set code = upper(trim(code)), normalized_code = normalize_coupon_code(code);
alter table coupons alter column normalized_code set not null;
create unique index if not exists coupons_store_normalized_code_idx on coupons(store_id, normalized_code);
create unique index if not exists coupons_store_code_lower_idx on coupons(store_id, lower(code));

create table if not exists coupon_redemptions (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  coupon_id       uuid not null references coupons(id) on delete restrict,
  customer_id     uuid references customers(id) on delete set null,
  order_id        uuid not null references orders(id) on delete cascade,
  discount_amount numeric(12,2) not null check (discount_amount > 0),
  idempotency_key text not null,
  voided_at       timestamptz,
  created_at      timestamptz not null default now(),
  unique (store_id, idempotency_key)
);

create index if not exists coupon_redemptions_coupon_idx on coupon_redemptions(coupon_id);
create index if not exists coupon_redemptions_customer_idx on coupon_redemptions(store_id, customer_id) where customer_id is not null;

create table if not exists loyalty_accounts (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  points_balance  integer not null default 0 check (points_balance >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (store_id, customer_id)
);

create table if not exists loyalty_settings (
  id                   uuid primary key default uuid_generate_v4(),
  organization_id      uuid not null references organizations(id) on delete cascade,
  store_id             uuid not null references stores(id) on delete cascade unique,
  points_per_currency  numeric(10,4) not null default 0.0100 check (points_per_currency >= 0),
  earn_enabled         boolean not null default true,
  redeem_enabled       boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists loyalty_ledger (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  account_id      uuid not null references loyalty_accounts(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  order_id        uuid references orders(id) on delete set null,
  type            text not null check (type in ('earn', 'redeem', 'reversal')),
  points_delta    integer not null check (points_delta <> 0),
  reason          text,
  reversed_entry_id uuid references loyalty_ledger(id) on delete set null,
  idempotency_key text not null,
  created_at      timestamptz not null default now()
);

create unique index if not exists loyalty_ledger_idempotency_key_idx on loyalty_ledger(store_id, idempotency_key);
create index if not exists loyalty_ledger_account_idx on loyalty_ledger(account_id, created_at desc);
create index if not exists loyalty_ledger_customer_idx on loyalty_ledger(store_id, customer_id);

alter table orders add column if not exists customer_id uuid references customers(id) on delete set null;
alter table orders add column if not exists coupon_id uuid references coupons(id) on delete set null;
alter table orders add column if not exists coupon_discount_amount numeric(12,2) not null default 0 check (coupon_discount_amount >= 0);
alter table orders add column if not exists loyalty_points_earned integer not null default 0 check (loyalty_points_earned >= 0);
alter table orders add column if not exists loyalty_points_redeemed integer not null default 0 check (loyalty_points_redeemed >= 0);

create unique index if not exists customers_id_store_id_idx on customers(id, store_id);
create unique index if not exists coupons_id_store_id_idx on coupons(id, store_id);
create unique index if not exists orders_id_store_id_idx on orders(id, store_id);
create unique index if not exists loyalty_accounts_id_store_id_idx on loyalty_accounts(id, store_id);
create unique index if not exists loyalty_ledger_id_store_id_idx on loyalty_ledger(id, store_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'coupon_redemptions_coupon_store_fkey') then
    alter table coupon_redemptions
      add constraint coupon_redemptions_coupon_store_fkey
      foreign key (coupon_id, store_id) references coupons(id, store_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'coupon_redemptions_customer_store_fkey') then
    alter table coupon_redemptions
      add constraint coupon_redemptions_customer_store_fkey
      foreign key (customer_id, store_id) references customers(id, store_id) on delete set null (customer_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'coupon_redemptions_order_store_fkey') then
    alter table coupon_redemptions
      add constraint coupon_redemptions_order_store_fkey
      foreign key (order_id, store_id) references orders(id, store_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_accounts_customer_store_fkey') then
    alter table loyalty_accounts
      add constraint loyalty_accounts_customer_store_fkey
      foreign key (customer_id, store_id) references customers(id, store_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_ledger_account_store_fkey') then
    alter table loyalty_ledger
      add constraint loyalty_ledger_account_store_fkey
      foreign key (account_id, store_id) references loyalty_accounts(id, store_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_ledger_customer_store_fkey') then
    alter table loyalty_ledger
      add constraint loyalty_ledger_customer_store_fkey
      foreign key (customer_id, store_id) references customers(id, store_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_ledger_order_store_fkey') then
    alter table loyalty_ledger
      add constraint loyalty_ledger_order_store_fkey
      foreign key (order_id, store_id) references orders(id, store_id) on delete set null (order_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_ledger_reversal_store_fkey') then
    alter table loyalty_ledger
      add constraint loyalty_ledger_reversal_store_fkey
      foreign key (reversed_entry_id, store_id) references loyalty_ledger(id, store_id) on delete set null (reversed_entry_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_customer_store_fkey') then
    alter table orders
      add constraint orders_customer_store_fkey
      foreign key (customer_id, store_id) references customers(id, store_id) on delete set null (customer_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_coupon_store_fkey') then
    alter table orders
      add constraint orders_coupon_store_fkey
      foreign key (coupon_id, store_id) references coupons(id, store_id) on delete set null (coupon_id);
  end if;
end $$;

alter table customers enable row level security;
alter table coupons enable row level security;
alter table coupon_redemptions enable row level security;
alter table loyalty_accounts enable row level security;
alter table loyalty_settings enable row level security;
alter table loyalty_ledger enable row level security;

create policy "customers: store member can read"
  on customers for select
  using (store_id in (select auth_user_store_ids()));

create policy "customers: cashier+ can write"
  on customers for all
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'))
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

create policy "coupons: store member can read"
  on coupons for select
  using (store_id in (select auth_user_store_ids()));

create policy "coupons: manager+ can write"
  on coupons for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "coupon_redemptions: store member can read"
  on coupon_redemptions for select
  using (store_id in (select auth_user_store_ids()));

revoke insert, update, delete on coupon_redemptions from authenticated;
revoke insert, update, delete on coupon_redemptions from anon;

create policy "loyalty_accounts: store member can read"
  on loyalty_accounts for select
  using (store_id in (select auth_user_store_ids()));

revoke insert, update, delete on loyalty_accounts from authenticated;
revoke insert, update, delete on loyalty_accounts from anon;

create policy "loyalty_settings: store member can read"
  on loyalty_settings for select
  using (store_id in (select auth_user_store_ids()));

create policy "loyalty_settings: manager+ can write"
  on loyalty_settings for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "loyalty_ledger: store member can read"
  on loyalty_ledger for select
  using (store_id in (select auth_user_store_ids()));

revoke insert, update, delete on loyalty_ledger from authenticated;
revoke insert, update, delete on loyalty_ledger from anon;
