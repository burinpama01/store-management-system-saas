-- ============================================================
-- Supabase Storage Buckets and Policies
-- ============================================================

-- product-images: public read, org-scoped write
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', false)
on conflict (id) do nothing;

-- receipt-assets: private, store admin/manager only
insert into storage.buckets (id, name, public)
values ('receipt-assets', 'receipt-assets', false)
on conflict (id) do nothing;

-- staff-evidence: private, org owner/admin/manager only
insert into storage.buckets (id, name, public)
values ('staff-evidence', 'staff-evidence', false)
on conflict (id) do nothing;

-- ============================================================
-- product-images policies
-- Object paths: organizationId/storeId/productId/filename
-- ============================================================

create policy "product-images: org member can read"
  on storage.objects for select
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select id::text from organizations
      where id in (select auth_user_organization_ids())
    )
  );

create policy "product-images: manager+ can upload"
  on storage.objects for insert
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where auth_user_role_in_org(o.id, 'manager')
    )
  );

create policy "product-images: manager+ can update"
  on storage.objects for update
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where auth_user_role_in_org(o.id, 'manager')
    )
  );

create policy "product-images: manager+ can delete"
  on storage.objects for delete
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where auth_user_role_in_org(o.id, 'manager')
    )
  );

-- ============================================================
-- receipt-assets policies
-- Object paths: organizationId/storeId/filename
-- ============================================================

create policy "receipt-assets: admin+ can read"
  on storage.objects for select
  using (
    bucket_id = 'receipt-assets'
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where auth_user_role_in_org(o.id, 'admin')
    )
  );

create policy "receipt-assets: admin+ can upload"
  on storage.objects for insert
  with check (
    bucket_id = 'receipt-assets'
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where auth_user_role_in_org(o.id, 'admin')
    )
  );

create policy "receipt-assets: admin+ can update"
  on storage.objects for update
  using (
    bucket_id = 'receipt-assets'
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where auth_user_role_in_org(o.id, 'admin')
    )
  );

create policy "receipt-assets: admin+ can delete"
  on storage.objects for delete
  using (
    bucket_id = 'receipt-assets'
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where auth_user_role_in_org(o.id, 'admin')
    )
  );

-- ============================================================
-- staff-evidence policies
-- Object paths: organizationId/storeId/userId/filename
-- ============================================================

create policy "staff-evidence: manager+ can read"
  on storage.objects for select
  using (
    bucket_id = 'staff-evidence'
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where auth_user_role_in_org(o.id, 'manager')
    )
  );

create policy "staff-evidence: staff can upload own"
  on storage.objects for insert
  with check (
    bucket_id = 'staff-evidence'
    -- path[3] = userId so staff can only upload into their own folder
    and (storage.foldername(name))[3] = auth.uid()::text
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where id in (select auth_user_organization_ids())
    )
  );

create policy "staff-evidence: manager+ can delete"
  on storage.objects for delete
  using (
    bucket_id = 'staff-evidence'
    and (storage.foldername(name))[1] in (
      select o.id::text from organizations o
      where auth_user_role_in_org(o.id, 'manager')
    )
  );
