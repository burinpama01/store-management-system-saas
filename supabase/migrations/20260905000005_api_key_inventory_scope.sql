-- Scope the read-only API without expanding keys that already carry an
-- explicit permission set. New keys preserve the pre-scope read behavior.
alter table public.api_keys
  alter column scopes set default array[
    'products.read',
    'inventory.read',
    'orders.read'
  ]::text[];

update public.api_keys
set scopes = array[
  'products.read',
  'inventory.read',
  'orders.read'
]::text[]
where coalesce(cardinality(scopes), 0) = 0;

-- A movement is claimed before its best-effort owner notification is queued.
-- The primary key is the cross-request dedupe boundary.
create table public.stock_movement_notification_claims (
  movement_id uuid primary key references public.stock_movements(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

alter table public.stock_movement_notification_claims enable row level security;
revoke all privileges on table public.stock_movement_notification_claims from public, anon, authenticated;
grant select, insert, delete on table public.stock_movement_notification_claims to service_role;

-- Retried provider delivery may attempt to persist the same in-app alert again.
-- Keep the durable notification center idempotent by its source movement.
create unique index notifications_stock_movement_idempotency_idx
on public.notifications ((metadata ->> 'stockMovementId'))
where type = 'stock_alert'
  and nullif(metadata ->> 'stockMovementId', '') is not null;
