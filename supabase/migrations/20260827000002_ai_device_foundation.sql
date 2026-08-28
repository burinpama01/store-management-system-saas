-- Task 9/D (v0.34.0) — AI governance foundation: usage ledger, quota reservations,
-- shared device profiles. Privacy rules from the plan:
--   * ai_usage_logs: append-only, NO free-text/PII columns; client RLS = deny all
--     writes (service role appends via the server).
--   * ai_quota_reservations: service-only (no policies = denied to clients).
--   * device_profiles: platform-level aggregates only — no store/customer PII.

create table public.ai_quota_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id text not null,
  feature text not null,
  tokens_reserved int not null,
  status text not null default 'reserved' check (status in ('reserved','settled','reconcile')),
  created_at timestamptz not null default now(),
  unique (organization_id, request_id)
);

create table public.ai_usage_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  feature text not null,
  model text not null,
  tokens int not null default 0,
  cost_thb numeric(10,4) not null default 0,
  status text not null check (status in ('ok','error','timeout','denied')),
  request_hash text not null,
  created_at timestamptz not null default now()
);

create table public.device_profiles (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('windows','android','ios','other')),
  printer_model text not null,
  channel text not null,
  success_count int not null default 0,
  updated_at timestamptz not null default now(),
  unique (platform, printer_model, channel)
);

alter table public.ai_quota_reservations enable row level security;
alter table public.ai_usage_logs enable row level security;
alter table public.device_profiles enable row level security;

-- ai_quota_reservations: NO policies → every client operation denied; the server
-- uses the service role which bypasses RLS.

-- ai_usage_logs: org members may READ their own org's ledger; writes are
-- service-only (append happens through the governed server path).
create policy "org members read own org usage"
  on public.ai_usage_logs for select
  to authenticated
  using (organization_id in (select organization_id from public.memberships where user_id = auth.uid()));

-- device_profiles: shared platform knowledge, readable by any authenticated user.
create policy "authenticated read device profiles"
  on public.device_profiles for select
  to authenticated
  using (true);

-- Atomic per-org quota reservation: serialised by an advisory lock so concurrent
-- requests can never exceed the monthly budget. Idempotent on (org, request_id).
create or replace function public.reserve_ai_quota(
  p_organization_id uuid,
  p_request_id text,
  p_feature text,
  p_max_tokens int,
  p_monthly_budget int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  if p_max_tokens is null or p_max_tokens <= 0 or p_monthly_budget is null or p_monthly_budget <= 0 then
    return jsonb_build_object('granted', false, 'reason', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text));

  if exists (
    select 1 from public.ai_quota_reservations
    where organization_id = p_organization_id and request_id = p_request_id
  ) then
    return jsonb_build_object('granted', true, 'reason', 'idempotent');
  end if;

  select coalesce(sum(tokens_reserved), 0) into v_used
  from public.ai_quota_reservations
  where organization_id = p_organization_id
    and date_trunc('month', created_at) = date_trunc('month', now());

  if v_used + p_max_tokens > p_monthly_budget then
    insert into public.ai_usage_logs (organization_id, feature, model, tokens, status, request_hash)
    values (p_organization_id, p_feature, 'none', 0, 'denied', md5(p_request_id));
    return jsonb_build_object('granted', false, 'reason', 'budget_exceeded', 'used', v_used, 'budget', p_monthly_budget);
  end if;

  insert into public.ai_quota_reservations (organization_id, request_id, feature, tokens_reserved)
  values (p_organization_id, p_request_id, p_feature, p_max_tokens);

  return jsonb_build_object('granted', true);
end;
$$;

grant execute on function public.reserve_ai_quota(uuid, text, text, int, int) to authenticated;