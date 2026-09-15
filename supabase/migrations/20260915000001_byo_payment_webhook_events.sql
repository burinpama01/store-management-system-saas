-- TrueMoney Open API Phase B scaffold: idempotent webhook event log
-- Official field names / JWT claims must be confirmed from in-app TrueMoney docs when eligible.

create table if not exists public.gateway_payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  store_id uuid references public.stores(id) on delete set null,
  provider_key text not null,
  provider_event_id text not null,
  event_type text,
  processing_status text not null default 'received'
    check (processing_status in ('received','processing','processed','ignored','failed')),
  gateway_payment_id uuid references public.gateway_payments(id) on delete set null,
  amount_major numeric(12,2),
  payload_redacted jsonb not null default '{}'::jsonb,
  failure_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider_key, provider_event_id)
);

create index if not exists gateway_payment_webhook_events_store_idx
  on public.gateway_payment_webhook_events (store_id, created_at desc);

alter table public.gateway_payment_webhook_events enable row level security;

-- Service role writes webhooks; store members may read their own events.
create policy "gateway_payment_webhook_events: store member can read"
  on public.gateway_payment_webhook_events for select
  using (store_id is null or store_id in (select auth_user_store_ids()));

comment on table public.gateway_payment_webhook_events is
  'BYO provider webhook idempotency log (TrueMoney Open API Phase B scaffold).';
