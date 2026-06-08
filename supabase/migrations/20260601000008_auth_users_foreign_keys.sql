-- Add explicit auth.users foreign keys for user-owned records.
-- Historical nullable actor fields use SET NULL; required ownership fields use RESTRICT.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_owner_id_auth_users_fk') then
    alter table organizations
      add constraint organizations_owner_id_auth_users_fk
      foreign key (owner_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'memberships_user_id_auth_users_fk') then
    alter table memberships
      add constraint memberships_user_id_auth_users_fk
      foreign key (user_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'membership_permission_overrides_granted_by_user_id_auth_users_fk') then
    alter table membership_permission_overrides
      add constraint membership_permission_overrides_granted_by_user_id_auth_users_fk
      foreign key (granted_by_user_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'audit_logs_actor_user_id_auth_users_fk') then
    alter table audit_logs
      add constraint audit_logs_actor_user_id_auth_users_fk
      foreign key (actor_user_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'audit_logs_target_user_id_auth_users_fk') then
    alter table audit_logs
      add constraint audit_logs_target_user_id_auth_users_fk
      foreign key (target_user_id) references auth.users(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'orders_cashier_id_auth_users_fk') then
    alter table orders
      add constraint orders_cashier_id_auth_users_fk
      foreign key (cashier_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'orders_voided_by_user_id_auth_users_fk') then
    alter table orders
      add constraint orders_voided_by_user_id_auth_users_fk
      foreign key (voided_by_user_id) references auth.users(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'payments_processed_by_user_id_auth_users_fk') then
    alter table payments
      add constraint payments_processed_by_user_id_auth_users_fk
      foreign key (processed_by_user_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'transactions_created_by_user_id_auth_users_fk') then
    alter table transactions
      add constraint transactions_created_by_user_id_auth_users_fk
      foreign key (created_by_user_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'cash_ledger_entries_created_by_user_id_auth_users_fk') then
    alter table cash_ledger_entries
      add constraint cash_ledger_entries_created_by_user_id_auth_users_fk
      foreign key (created_by_user_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'attendance_records_user_id_auth_users_fk') then
    alter table attendance_records
      add constraint attendance_records_user_id_auth_users_fk
      foreign key (user_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'attendance_records_adjusted_by_user_id_auth_users_fk') then
    alter table attendance_records
      add constraint attendance_records_adjusted_by_user_id_auth_users_fk
      foreign key (adjusted_by_user_id) references auth.users(id) on delete set null;
  end if;
end $$;
