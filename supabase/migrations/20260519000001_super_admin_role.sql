-- Add platform owner role for SaaS-level administration.
-- This role is above organization owner and can satisfy every org/store RLS role check.

alter table memberships
  drop constraint if exists memberships_role_check;

alter table memberships
  add constraint memberships_role_check
  check (role in ('super_admin','owner','admin','manager','cashier','staff'));

create or replace function auth_user_role_in_org(org_id uuid, min_role text)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from memberships m
    where m.user_id = auth.uid()
      and m.organization_id = org_id
      and m.joined_at is not null
      and case min_role
        when 'super_admin' then m.role = 'super_admin'
        when 'owner'   then m.role in ('super_admin','owner')
        when 'admin'   then m.role in ('super_admin','owner','admin')
        when 'manager' then m.role in ('super_admin','owner','admin','manager')
        when 'cashier' then m.role in ('super_admin','owner','admin','manager','cashier')
        when 'staff'   then m.role in ('super_admin','owner','admin','manager','cashier','staff')
        else false
      end
  );
$$;

create or replace function auth_user_role_in_store(org_id uuid, target_store_id uuid, min_role text)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from memberships m
    where m.user_id = auth.uid()
      and m.organization_id = org_id
      and (m.store_id is null or m.store_id = target_store_id)
      and m.joined_at is not null
      and case min_role
        when 'super_admin' then m.role = 'super_admin'
        when 'owner'   then m.role in ('super_admin','owner')
        when 'admin'   then m.role in ('super_admin','owner','admin')
        when 'manager' then m.role in ('super_admin','owner','admin','manager')
        when 'cashier' then m.role in ('super_admin','owner','admin','manager','cashier')
        when 'staff'   then m.role in ('super_admin','owner','admin','manager','cashier','staff')
        else false
      end
  );
$$;
