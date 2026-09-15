-- BYO Payment Gateway Phase A: TrueMoney Shop QR (manual)
-- Additive tables only. Stripe SaaS billing untouched.

-- ── payment_provider_configs ──────────────────────────────────────────────
create table if not exists public.payment_provider_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  provider_key text not null check (provider_key in ('truemoney', 'beam', 'omise')),
  mode text not null check (mode in ('manual', 'open_api')),
  environment text not null default 'live' check (environment in ('test', 'live')),
  display_name text,
  is_enabled boolean not null default false,
  is_default boolean not null default false,
  disabled_at timestamptz,
  -- Phase A: JSON blob { "staticEmvPayload": "..." }; Phase B may hold encrypted API secrets.
  credentials_encrypted text,
  encryption_key_version integer not null default 0,
  public_config jsonb not null default '{}'::jsonb,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_provider_configs_store_provider_mode_uidx
  on public.payment_provider_configs (store_id, provider_key, mode);

create index if not exists payment_provider_configs_org_idx
  on public.payment_provider_configs (organization_id);

create index if not exists payment_provider_configs_store_enabled_idx
  on public.payment_provider_configs (store_id)
  where is_enabled = true and disabled_at is null;

comment on table public.payment_provider_configs is
  'BYO merchant payment gateway credentials per store. Separate from Stripe SaaS billing.';

-- ── gateway_payments ──────────────────────────────────────────────────────
create table if not exists public.gateway_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  provider_config_id uuid not null references public.payment_provider_configs(id),
  provider_key text not null,
  mode text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'THB',
  status text not null default 'PENDING'
    check (status in (
      'CREATED','PENDING','REQUIRES_ACTION','PROCESSING','PAID',
      'FAILED','EXPIRED','CANCELLED','REFUND_PENDING','REFUND_SUCCEEDED',
      'REFUND_FAILED','LATE_PAID','REVIEW_REQUIRED'
    )),
  storeos_reference text not null,
  provider_payment_id text,
  injected_emv_payload text,
  verification_source text
    check (verification_source is null or verification_source in (
      'MANUAL_STAFF','PROVIDER_WEBHOOK','PROVIDER_API'
    )),
  confirmed_by uuid,
  confirmed_at timestamptz,
  confirm_reason text,
  pos_payment_id uuid references public.payments(id) on delete set null,
  failure_code text,
  failure_message text,
  metadata jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, storeos_reference)
);

create index if not exists gateway_payments_order_idx
  on public.gateway_payments (order_id);

create index if not exists gateway_payments_store_status_idx
  on public.gateway_payments (store_id, status);

create index if not exists gateway_payments_config_idx
  on public.gateway_payments (provider_config_id);

comment on table public.gateway_payments is
  'BYO gateway payment objects. Do not confuse with public.payments (POS tender rows).';

-- ── gateway_payment_attempts (minimal for Phase A / future retries) ───────
create table if not exists public.gateway_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  gateway_payment_id uuid not null references public.gateway_payments(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  attempt_number integer not null check (attempt_number >= 1),
  status text not null default 'PENDING'
    check (status in (
      'CREATED','PENDING','REQUIRES_ACTION','PROCESSING','PAID',
      'FAILED','EXPIRED','CANCELLED','REVIEW_REQUIRED'
    )),
  injected_emv_payload text,
  provider_payment_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (gateway_payment_id, attempt_number)
);

create index if not exists gateway_payment_attempts_payment_idx
  on public.gateway_payment_attempts (gateway_payment_id);

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.payment_provider_configs enable row level security;
alter table public.gateway_payments enable row level security;
alter table public.gateway_payment_attempts enable row level security;

create policy "payment_provider_configs: store member can read"
  on public.payment_provider_configs for select
  using (store_id in (select auth_user_store_ids()));

create policy "payment_provider_configs: manager+ can write"
  on public.payment_provider_configs for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "gateway_payments: store member can read"
  on public.gateway_payments for select
  using (store_id in (select auth_user_store_ids()));

create policy "gateway_payments: cashier+ can insert"
  on public.gateway_payments for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

create policy "gateway_payments: cashier+ can update"
  on public.gateway_payments for update
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'));

create policy "gateway_payment_attempts: store member can read"
  on public.gateway_payment_attempts for select
  using (store_id in (select auth_user_store_ids()));

create policy "gateway_payment_attempts: cashier+ can insert"
  on public.gateway_payment_attempts for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

create policy "gateway_payment_attempts: cashier+ can update"
  on public.gateway_payment_attempts for update
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'));
