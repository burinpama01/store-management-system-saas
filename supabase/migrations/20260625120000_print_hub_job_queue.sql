-- StoreOS Print Hub: server-side print queue so tablet/iPad POS can print
-- through a central Print Hub running on the store's cashier PC.
-- Browser (HTTPS) enqueues jobs; the Hub long-polls + claims + prints over LAN.

-- 1. Per-store Print Hub credentials + heartbeat.
alter table stores
  add column if not exists print_hub_token_hash text,
  add column if not exists print_hub_last_seen timestamptz;

-- 2. Print job queue.
create table if not exists print_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  printer_id uuid,
  target_host text not null,
  target_port integer not null default 9100,
  payload_b64 text not null,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'printed', 'failed')),
  attempts integer not null default 0,
  error text,
  claimed_at timestamptz,
  printed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Hub polls oldest pending jobs for its store; index supports that hot path.
create index if not exists print_jobs_store_pending_idx
  on print_jobs(store_id, status, created_at);

create index if not exists print_jobs_created_at_idx
  on print_jobs(created_at);

-- 3. RLS. Hub poll/ack/status and enqueue run through the service client
--    (token-authenticated / app-permission-checked). These policies are
--    defense-in-depth for any future authenticated direct access.
alter table print_jobs enable row level security;

drop policy if exists "print_jobs: staff can read" on print_jobs;
create policy "print_jobs: staff can read"
  on print_jobs for select
  to authenticated
  using (
    auth_user_has_permission(organization_id, store_id, 'pos.use')
    or auth_user_has_permission(organization_id, store_id, 'settings.manage_store')
  );

drop policy if exists "print_jobs: staff can enqueue" on print_jobs;
create policy "print_jobs: staff can enqueue"
  on print_jobs for insert
  to authenticated
  with check (auth_user_has_permission(organization_id, store_id, 'pos.use'));
