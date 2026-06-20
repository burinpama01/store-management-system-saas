-- LINE group and multi-person chat targets for tenant notifications.
-- User account linking remains in line_account_links; this table stores only chat destinations.

create table if not exists line_notification_targets (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  target_type text not null check (target_type in ('group', 'room')),
  target_id text not null,
  status text not null default 'active' check (status in ('active', 'unlinked')),
  linked_by uuid not null references auth.users(id) on delete cascade,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, target_type)
);

create index if not exists line_notification_targets_organization_id_idx
  on line_notification_targets(organization_id);

create index if not exists line_notification_targets_linked_by_idx
  on line_notification_targets(linked_by);

create unique index if not exists line_notification_targets_active_target_id_uidx
  on line_notification_targets(target_id)
  where status = 'active';

create unique index if not exists line_notification_targets_active_organization_id_uidx
  on line_notification_targets(organization_id)
  where status = 'active';

alter table line_notification_targets enable row level security;

create policy "line_notification_targets: owner can read"
  on line_notification_targets for select
  using (auth_user_role_in_org(organization_id, 'owner'));

create trigger set_updated_at before update on line_notification_targets
  for each row execute function set_updated_at();

create or replace function upsert_line_notification_target(
  p_organization_id uuid,
  p_linked_by uuid,
  p_target_type text,
  p_target_id text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflict_id uuid;
  v_target_id uuid;
begin
  if p_target_type not in ('group', 'room') then
    raise exception 'LINE_TARGET_TYPE_INVALID';
  end if;

  if not exists (
    select 1
    from memberships
    where organization_id = p_organization_id
      and user_id = p_linked_by
      and role = 'owner'
      and joined_at is not null
  ) then
    raise exception 'LINE_TARGET_OWNER_REQUIRED';
  end if;

  perform id
  from organizations
  where id = p_organization_id
  for update;

  select id into v_conflict_id
  from line_notification_targets
  where target_id = p_target_id
    and organization_id <> p_organization_id
    and status = 'active'
  limit 1;

  if v_conflict_id is not null then
    raise exception 'LINE_TARGET_ALREADY_LINKED';
  end if;

  update line_notification_targets
  set
    status = 'unlinked',
    unlinked_at = now(),
    updated_at = now()
  where organization_id = p_organization_id
    and status = 'active';

  insert into line_notification_targets (
    organization_id,
    target_type,
    target_id,
    status,
    linked_by,
    linked_at,
    unlinked_at,
    updated_at
  )
  values (
    p_organization_id,
    p_target_type,
    p_target_id,
    'active',
    p_linked_by,
    now(),
    null,
    now()
  )
  on conflict (organization_id, target_type) do update
  set
    target_id = excluded.target_id,
    status = 'active',
    linked_by = excluded.linked_by,
    linked_at = excluded.linked_at,
    unlinked_at = null,
    updated_at = excluded.updated_at
  returning id into v_target_id;

  return v_target_id;
end;
$$;

revoke all on function upsert_line_notification_target(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function upsert_line_notification_target(uuid, uuid, text, text) to service_role;
