-- เว็บไซต์ของร้าน · S4 (Plan/Store Website Builder Implementation Plan v1.html §S4)
--
-- 1) website_templates: คลังเทมเพลตรายเดือน — ซูเปอร์แอดมินเพิ่มจากหลังบ้านได้โดยไม่ต้อง deploy
--    ร้าน (ผู้ใช้ที่ล็อกอิน) อ่านได้เฉพาะที่เผยแพร่แล้ว · เขียนผ่าน service client ใน server action ของ /system เท่านั้น
-- 2) โดเมนของร้านเอง: store_websites.custom_domain + สถานะ
--    proxy ใช้ RPC website_slug_for_domain() (anon) แปลงโดเมน → slug เฉพาะโดเมนที่ยืนยันแล้ว + เว็บเปิดอยู่

create table if not exists public.website_templates (
  id text primary key check (id ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  name text not null check (char_length(name) between 1 and 60),
  business text not null check (business in ('cafe', 'restaurant', 'grocery')),
  style text not null check (style in ('minimal', 'cute', 'luxury')),
  description text not null default '' check (char_length(description) <= 160),
  theme jsonb not null,
  is_published boolean not null default false,
  published_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists website_templates_published_idx on public.website_templates (is_published, published_at desc);

alter table public.website_templates enable row level security;
revoke all on table public.website_templates from anon;
revoke insert, update, delete on table public.website_templates from authenticated;
grant select on table public.website_templates to authenticated;

drop policy if exists "website_templates: read published" on public.website_templates;
create policy "website_templates: read published" on public.website_templates for select
  to authenticated
  using (is_published);

-- ---------- โดเมนของร้านเอง ----------
alter table public.store_websites
  add column if not exists custom_domain text
    check (custom_domain is null or (custom_domain ~ '^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$' and char_length(custom_domain) <= 253)),
  add column if not exists custom_domain_status text not null default 'none'
    check (custom_domain_status in ('none', 'pending', 'active', 'error')),
  add column if not exists custom_domain_note text check (custom_domain_note is null or char_length(custom_domain_note) <= 300),
  add column if not exists custom_domain_checked_at timestamptz,
  add column if not exists custom_domain_changed_at timestamptz;

create unique index if not exists store_websites_custom_domain_unique
  on public.store_websites (lower(custom_domain))
  where custom_domain is not null;

-- ร้านแก้สถานะโดเมนเองไม่ได้ (กันตั้ง active เองโดยไม่ได้ยืนยัน DNS) — เปลี่ยนได้เฉพาะ service role (server action)
create or replace function public.store_websites_guard_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
       new.custom_domain is distinct from old.custom_domain
    or new.custom_domain_status is distinct from old.custom_domain_status
    or new.custom_domain_note is distinct from old.custom_domain_note
    or new.custom_domain_checked_at is distinct from old.custom_domain_checked_at
    or new.custom_domain_changed_at is distinct from old.custom_domain_changed_at
  ) then
    raise exception 'เปลี่ยนโดเมนได้ผ่านหน้าตั้งค่าเว็บไซต์เท่านั้น';
  end if;
  return new;
end;
$$;

drop trigger if exists store_websites_guard_domain on public.store_websites;
create trigger store_websites_guard_domain
  before update on public.store_websites
  for each row execute function public.store_websites_guard_domain();

revoke all on function public.store_websites_guard_domain() from public, anon, authenticated;

-- กันตั้งโดเมนตอน insert ด้วย (ร้านสร้างเว็บผ่าน RLS ของผู้ใช้)
create or replace function public.store_websites_guard_domain_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    new.custom_domain := null;
    new.custom_domain_status := 'none';
    new.custom_domain_note := null;
    new.custom_domain_checked_at := null;
    new.custom_domain_changed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists store_websites_guard_domain_insert on public.store_websites;
create trigger store_websites_guard_domain_insert
  before insert on public.store_websites
  for each row execute function public.store_websites_guard_domain_insert();

revoke all on function public.store_websites_guard_domain_insert() from public, anon, authenticated;

-- proxy: โดเมน → slug (เฉพาะโดเมนยืนยันแล้ว + เว็บเปิด + มีฉบับเผยแพร่) — ไม่คืนข้อมูลอื่น
create or replace function public.website_slug_for_domain(p_host text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select w.slug
    from public.store_websites w
   where p_host is not null
     and char_length(p_host) <= 253
     and lower(w.custom_domain) = lower(p_host)
     and w.custom_domain_status = 'active'
     and w.is_enabled
     and w.published_document is not null
   limit 1;
$$;

revoke all on function public.website_slug_for_domain(text) from public;
grant execute on function public.website_slug_for_domain(text) to anon, authenticated;
