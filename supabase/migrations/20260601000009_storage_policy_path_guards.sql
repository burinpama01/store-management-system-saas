-- Harden staff-evidence object paths before reading fixed path segments.
-- staff-evidence path: <organizationId>/<storeId>/<userId>/<fileName>

drop policy if exists "staff-evidence: staff can upload own" on storage.objects;

create policy "staff-evidence: staff can upload own"
  on storage.objects for insert
  with check (
    bucket_id = 'staff-evidence'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[3] = auth.uid()::text
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where id in (select auth_user_organization_ids())
    )
  );
