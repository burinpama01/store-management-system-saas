-- ============================================================
-- Enterprise plan request inbox.
-- Public visitors (or logged-in tenants) submit a contact form asking for an
-- Enterprise package; the platform super-admin reviews them at /system/enterprise.
-- Writes/reads go through service-client server actions only.
-- ============================================================

create table if not exists enterprise_requests (
  id               uuid primary key default uuid_generate_v4(),
  company_name     text not null,
  contact_name     text not null,
  email            text not null,
  phone            text,
  branch_count     integer check (branch_count is null or branch_count >= 0),
  message          text,
  -- Set when the form was submitted by a logged-in tenant (links to their org).
  organization_id  uuid references organizations(id) on delete set null,
  status           text not null default 'new'
                     check (status in ('new','contacted','closed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists enterprise_requests_status_idx
  on enterprise_requests(status, created_at desc);

-- Internal table: access only via service client / super-admin server actions.
alter table enterprise_requests enable row level security;
