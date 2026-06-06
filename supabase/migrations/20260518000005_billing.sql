-- ============================================================
-- Package D2 — Stripe Billing: add billing tables
-- ============================================================

-- 1. Extend subscription plan values to match approved pricing tiers.
--    Existing 'professional' rows become 'standard' before we drop the old value.
alter table subscriptions
  drop constraint if exists subscriptions_plan_check;

update subscriptions set plan = 'standard' where plan = 'professional';

alter table subscriptions
  add constraint subscriptions_plan_check
    check (plan in ('free','starter','standard','premium','enterprise'));

-- 2. Extend subscription status to cover all Stripe statuses.
alter table subscriptions
  drop constraint if exists subscriptions_status_check;

alter table subscriptions
  add constraint subscriptions_status_check
    check (status in (
      'active', 'trialing', 'past_due',
      'incomplete', 'incomplete_expired',
      'unpaid', 'canceled', 'paused'
    ));

-- 3. Add unique constraint on organization_id (one active subscription per org).
alter table subscriptions
  add constraint subscriptions_organization_id_unique unique (organization_id);

-- 4. Add Stripe-specific columns to subscriptions.
alter table subscriptions
  add column if not exists stripe_subscription_id text unique,
  add column if not exists stripe_price_id        text,
  add column if not exists trial_end              timestamptz;

-- 5. Stripe customer ↔ organization mapping.
create table billing_customers (
  id               uuid primary key default uuid_generate_v4(),
  organization_id  uuid not null unique references organizations(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index billing_customers_org_idx on billing_customers(organization_id);

-- 5. Webhook event idempotency store.
create table billing_events (
  id               uuid primary key default uuid_generate_v4(),
  stripe_event_id  text not null unique,
  event_type       text not null,
  processed_at     timestamptz not null default now()
);
create index billing_events_event_id_idx on billing_events(stripe_event_id);

-- 6. RLS: billing tables are internal; only service role writes.
--    App reads billing_customers via service client only.
alter table billing_customers enable row level security;
alter table billing_events    enable row level security;

-- No SELECT policies: all access goes through service client or server actions.
