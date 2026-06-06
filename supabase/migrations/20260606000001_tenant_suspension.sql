-- Platform-level tenant suspension. When set, all non-super_admin members of the
-- organization are blocked from the app (login is allowed but access is redirected
-- to /suspended). Only the platform console (super_admin) sets/clears this.
alter table organizations
  add column if not exists suspended_at timestamptz;

comment on column organizations.suspended_at is
  'Set by platform super_admin to suspend a tenant. NULL = active.';
