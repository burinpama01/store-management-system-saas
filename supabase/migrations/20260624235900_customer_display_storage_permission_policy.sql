-- Keep customer display media behind settings.manage_store permission overrides.
-- Object paths: organizationId/storeId/customer-display/filename

drop policy if exists "product-images: manager+ can upload" on storage.objects;
drop policy if exists "product-images: manager+ can update" on storage.objects;
drop policy if exists "product-images: manager+ can delete" on storage.objects;
drop policy if exists "product-images: settings managers can upload customer display" on storage.objects;
drop policy if exists "product-images: settings managers can update customer display" on storage.objects;
drop policy if exists "product-images: settings managers can delete customer display" on storage.objects;

create policy "product-images: manager+ can upload"
  on storage.objects for insert
  with check (
    bucket_id = 'product-images'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[3] <> 'customer-display'
    and exists (
      select 1 from stores s
      where s.organization_id::text = (storage.foldername(name))[1]
        and s.id::text = (storage.foldername(name))[2]
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  );

create policy "product-images: manager+ can update"
  on storage.objects for update
  using (
    bucket_id = 'product-images'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[3] <> 'customer-display'
    and exists (
      select 1 from stores s
      where s.organization_id::text = (storage.foldername(name))[1]
        and s.id::text = (storage.foldername(name))[2]
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  )
  with check (
    bucket_id = 'product-images'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[3] <> 'customer-display'
    and exists (
      select 1 from stores s
      where s.organization_id::text = (storage.foldername(name))[1]
        and s.id::text = (storage.foldername(name))[2]
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  );

create policy "product-images: manager+ can delete"
  on storage.objects for delete
  using (
    bucket_id = 'product-images'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[3] <> 'customer-display'
    and exists (
      select 1 from stores s
      where s.organization_id::text = (storage.foldername(name))[1]
        and s.id::text = (storage.foldername(name))[2]
        and auth_user_role_in_store(s.organization_id, s.id, 'manager')
    )
  );

create policy "product-images: settings managers can upload customer display"
  on storage.objects for insert
  with check (
    bucket_id = 'product-images'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[3] = 'customer-display'
    and exists (
      select 1 from stores s
      where s.organization_id::text = (storage.foldername(name))[1]
        and s.id::text = (storage.foldername(name))[2]
        and auth_user_has_permission(s.organization_id, s.id, 'settings.manage_store')
    )
  );

create policy "product-images: settings managers can update customer display"
  on storage.objects for update
  using (
    bucket_id = 'product-images'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[3] = 'customer-display'
    and exists (
      select 1 from stores s
      where s.organization_id::text = (storage.foldername(name))[1]
        and s.id::text = (storage.foldername(name))[2]
        and auth_user_has_permission(s.organization_id, s.id, 'settings.manage_store')
    )
  )
  with check (
    bucket_id = 'product-images'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[3] = 'customer-display'
    and exists (
      select 1 from stores s
      where s.organization_id::text = (storage.foldername(name))[1]
        and s.id::text = (storage.foldername(name))[2]
        and auth_user_has_permission(s.organization_id, s.id, 'settings.manage_store')
    )
  );

create policy "product-images: settings managers can delete customer display"
  on storage.objects for delete
  using (
    bucket_id = 'product-images'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[3] = 'customer-display'
    and exists (
      select 1 from stores s
      where s.organization_id::text = (storage.foldername(name))[1]
        and s.id::text = (storage.foldername(name))[2]
        and auth_user_has_permission(s.organization_id, s.id, 'settings.manage_store')
    )
  );
