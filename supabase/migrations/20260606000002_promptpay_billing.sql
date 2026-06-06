-- ============================================================
-- PromptPay billing: platform PromptPay config + slip-verified payments
-- Replaces Stripe as the active SaaS payment flow (Stripe code kept, disabled).
-- ============================================================

-- 1. Platform-level settings (single row) configured by super_admin.
create table if not exists platform_settings (
  id                       text primary key default 'singleton',
  billing_provider         text not null default 'promptpay'
                             check (billing_provider in ('promptpay', 'stripe')),
  promptpay_id             text,                 -- phone or national/tax id
  promptpay_name           text,
  promptpay_qr_image_path  text,                 -- storage path for static QR (accounts w/o PromptPay)
  updated_by               uuid references auth.users(id) on delete set null,
  updated_at               timestamptz not null default now(),
  constraint platform_settings_singleton check (id = 'singleton')
);

insert into platform_settings (id) values ('singleton')
  on conflict (id) do nothing;

-- 2. PromptPay slip payment submissions (one per purchase attempt).
create table if not exists payment_submissions (
  id               uuid primary key default uuid_generate_v4(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  plan             text not null check (plan in ('starter','standard','premium')),
  duration         text not null check (duration in ('30d','1y')),
  amount_expected  numeric(12,2) not null,
  verified_amount  numeric(12,2),
  slip_ref         text,                  -- bank transaction reference (dedupe)
  slip_image_path  text,
  slip2go_raw      jsonb,
  status           text not null default 'pending'
                     check (status in ('pending','verified','rejected','duplicate')),
  reason           text,
  submitted_by     uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  verified_at      timestamptz
);

create index if not exists payment_submissions_org_idx
  on payment_submissions(organization_id);

-- Prevent the same bank slip from being CREDITED twice. Only verified rows are
-- constrained, so rejected/duplicate attempts can still be logged for audit.
create unique index if not exists payment_submissions_slip_ref_verified_unique
  on payment_submissions(slip_ref)
  where slip_ref is not null and status = 'verified';

-- 3. RLS: both tables are internal; access only via service client / server actions.
alter table platform_settings    enable row level security;
alter table payment_submissions  enable row level security;
-- No SELECT/INSERT/UPDATE policies: deny-all to client roles by default.
