-- Public API integration (Enterprise): per-organization API keys for the read-only
-- REST API at /api/v1/*. Keys are shown in full once at creation; only a SHA-256
-- hash + a display prefix are stored. All management goes through server actions
-- (service_role) gated by requireFeature('apiIntegration'); the table is RLS
-- deny-by-default so authenticated/anon clients can never read the hashes.

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists api_keys_org_idx on api_keys(organization_id);
create index if not exists api_keys_hash_active_idx on api_keys(key_hash) where revoked_at is null;

alter table api_keys enable row level security;
revoke all on api_keys from public, anon, authenticated;
