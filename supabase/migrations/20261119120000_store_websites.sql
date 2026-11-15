-- เว็บไซต์ของร้าน · S0 (Plan/Store Website Builder Implementation Plan v1.html)
--
-- - store_websites: 1 แถวต่อสาขา — slug (ลิงก์ store-os.online/s/<slug>), เปิด/ปิด, เอกสารฉบับร่าง/ฉบับเผยแพร่
--   เอกสาร = JSON ของบล็อก + ธีม ตรวจรูปแบบด้วย zod ฝั่ง server ก่อนบันทึกทุกครั้ง (ไม่มี HTML/สคริปต์จากร้าน)
-- - store_website_versions: ประวัติฉบับที่เคยเผยแพร่ (ย้อนกลับได้)
-- - หน้าเว็บสาธารณะอ่านด้วย service client ฝั่ง server + แคช ISR — ไม่เปิด RLS ให้ anon
-- - เขียนได้เฉพาะ owner/admin ของสาขา (RLS) · Enterprise ตรวจใน server action
-- - เทมเพลต S0 อยู่ในโค้ด (src/modules/store-website/templates.ts) — คลังเทมเพลตในฐานข้อมูลเป็น S4

create table if not exists public.store_websites (
  store_id uuid primary key references public.stores(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  is_enabled boolean not null default false,
  template_id text not null,
  draft_document jsonb not null,
  published_document jsonb,
  published_at timestamptz,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists store_websites_slug_unique on public.store_websites (lower(slug));

create table if not exists public.store_website_versions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document jsonb not null,
  published_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists store_website_versions_store_idx on public.store_website_versions (store_id, created_at desc);

alter table public.store_websites enable row level security;
alter table public.store_website_versions enable row level security;
revoke all on table public.store_websites from anon;
revoke all on table public.store_website_versions from anon;
grant select, insert, update on table public.store_websites to authenticated;
grant select, insert on table public.store_website_versions to authenticated;

drop policy if exists "store_websites: store member can read" on public.store_websites;
create policy "store_websites: store member can read" on public.store_websites for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "store_websites: admin can insert" on public.store_websites;
create policy "store_websites: admin can insert" on public.store_websites for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'admin'));

drop policy if exists "store_websites: admin can update" on public.store_websites;
create policy "store_websites: admin can update" on public.store_websites for update
  using (auth_user_role_in_store(organization_id, store_id, 'admin'))
  with check (auth_user_role_in_store(organization_id, store_id, 'admin'));

drop policy if exists "store_website_versions: store member can read" on public.store_website_versions;
create policy "store_website_versions: store member can read" on public.store_website_versions for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "store_website_versions: admin can insert" on public.store_website_versions;
create policy "store_website_versions: admin can insert" on public.store_website_versions for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'admin'));

-- organization_id ต้องตรงกับสาขาจริง (กันใส่ org อื่นแล้วหลบ RLS)
create or replace function public.store_websites_check_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.stores s where s.id = new.store_id and s.organization_id = new.organization_id) then
    raise exception 'สาขาไม่ตรงกับองค์กร';
  end if;
  if tg_table_name = 'store_websites' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists store_websites_check_org on public.store_websites;
create trigger store_websites_check_org
  before insert or update on public.store_websites
  for each row execute function public.store_websites_check_org();

drop trigger if exists store_website_versions_check_org on public.store_website_versions;
create trigger store_website_versions_check_org
  before insert on public.store_website_versions
  for each row execute function public.store_websites_check_org();

revoke all on function public.store_websites_check_org() from public, anon, authenticated;

-- เก็บประวัติฉบับเผยแพร่ล่าสุด 20 ฉบับต่อสาขา (เอกสาร JSON เต็ม — ไม่ให้ตารางโตไม่จำกัด)
create or replace function public.store_website_versions_prune()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.store_website_versions
   where store_id = new.store_id
     and id not in (
       select id from public.store_website_versions
        where store_id = new.store_id
        order by created_at desc
        limit 20
     );
  return null;
end;
$$;

drop trigger if exists store_website_versions_prune on public.store_website_versions;
create trigger store_website_versions_prune
  after insert on public.store_website_versions
  for each row execute function public.store_website_versions_prune();

revoke all on function public.store_website_versions_prune() from public, anon, authenticated;
