-- ============================================================
-- Discount codes for SaaS subscription (package) purchases.
-- Super-admin creates codes; tenants enter a code at billing checkout.
-- A code's discount applies to the post-promotion plan price, before the
-- pro-rated upgrade credit. Redemptions are tracked via the verified
-- payment_submissions row that carries the code (no separate ledger).
-- ============================================================

create table if not exists billing_discount_codes (
  id                       uuid primary key default uuid_generate_v4(),
  code                     text not null,
  normalized_code          text not null unique,
  description              text not null,
  discount_type            text not null check (discount_type in ('percentage','fixed')),
  discount_value           numeric(12,2) not null check (discount_value > 0),
  -- null = applies to every paid plan / duration; otherwise restricts to one.
  plan                     text check (plan in ('starter','standard','premium')),
  duration                 text check (duration in ('30d','1y')),
  min_amount               numeric(12,2) not null default 0 check (min_amount >= 0),
  -- null = unlimited. Counted from verified payment_submissions rows.
  max_redemptions          integer check (max_redemptions is null or max_redemptions > 0),
  max_redemptions_per_org  integer check (max_redemptions_per_org is null or max_redemptions_per_org > 0),
  active                   boolean not null default true,
  starts_at                timestamptz,
  ends_at                  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists billing_discount_codes_active_idx
  on billing_discount_codes(active) where active;

-- Internal table: access only via service client / super-admin server actions.
alter table billing_discount_codes enable row level security;

-- Link a verified/attempted payment to the discount code it redeemed. The
-- verified row doubles as the redemption record (counted for usage limits).
alter table payment_submissions
  add column if not exists discount_code_id uuid references billing_discount_codes(id) on delete set null,
  add column if not exists discount_amount  numeric(12,2) not null default 0 check (discount_amount >= 0);

create index if not exists payment_submissions_discount_code_idx
  on payment_submissions(discount_code_id) where discount_code_id is not null;
