-- LINE account binding for one-to-one app notifications.
-- Provider secrets stay in env; this stores only tenant/user scoped identifiers and hashed nonces.

create table if not exists line_account_links (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  line_user_id text not null,
  status text not null default 'active' check (status in ('active', 'unlinked')),
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists line_account_links_organization_id_idx
  on line_account_links(organization_id);

create index if not exists line_account_links_user_id_idx
  on line_account_links(user_id);

create unique index if not exists line_account_links_active_line_user_id_uidx
  on line_account_links(line_user_id)
  where status = 'active';

create table if not exists line_account_link_sessions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nonce_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (nonce_hash)
);

create index if not exists line_account_link_sessions_lookup_idx
  on line_account_link_sessions(nonce_hash, expires_at)
  where consumed_at is null;

alter table line_account_links enable row level security;
alter table line_account_link_sessions enable row level security;

create policy "line_account_links: owner can read"
  on line_account_links for select
  using (auth_user_role_in_org(organization_id, 'owner'));

create policy "line_account_links: owner can update"
  on line_account_links for update
  using (auth_user_role_in_org(organization_id, 'owner'))
  with check (auth_user_role_in_org(organization_id, 'owner'));

create policy "line_account_link_sessions: user can read own active"
  on line_account_link_sessions for select
  using (user_id = auth.uid() and consumed_at is null and expires_at > now());

create trigger set_updated_at before update on line_account_links
  for each row execute function set_updated_at();
