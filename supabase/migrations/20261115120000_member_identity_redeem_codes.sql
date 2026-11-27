-- แพ็กล่วงหน้า + ระดับสมาชิก · P0 (Plan/Prepaid Pass and Member Tiers Implementation Plan v1.html)
--
-- 1) member_identities: เบอร์เดียวกันในองค์กร = คนเดียวกัน (customers ยังแยกตาม store_id เหมือนเดิม
--    แค่ผูกเข้ากับ identity ผ่าน customers.member_identity_id ซึ่ง trigger ดูแลให้เอง)
-- 2) member_redeem_codes: รหัส 6 หลักที่ลูกค้าเปิดจากหน้าสมาชิก อายุ 5 นาที ใช้ได้ครั้งเดียว
-- 3) member_verifications: ผลยืนยันที่ POS อายุสั้น ให้ P1 (ตัดแพ็ก) / P2 (ส่วนลดระดับ) ตรวจซ้ำตอนปิดบิล
-- 4) member_redeem_attempts: นับครั้งที่กรอกรหัสผิด เพื่อล็อกการเดาสุ่ม
-- 5) stores.member_code_enabled: สวิตช์ต่อสาขา ค่าเริ่มต้นปิด
--
-- ตารางรหัส/ความพยายาม เขียนผ่าน RPC แบบ security definer ที่เรียกได้เฉพาะ service_role เท่านั้น
-- (server action ตรวจสิทธิ์พนักงาน/เซสชันลูกค้าก่อนเรียก) — เหมือน customer_member_otps

-- ---------------------------------------------------------------------------
-- คีย์เบอร์โทรขององค์กร: เหลือแต่ตัวเลข และแปลง 66xxxxxxxxx / 0066xxxxxxxxx เป็น 0xxxxxxxxx
-- ต้องตรงกับ memberPhoneKey() ใน src/modules/members/phone-key.ts
-- ---------------------------------------------------------------------------
create or replace function public.member_phone_key(p_phone text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when d ~ '^0066[0-9]{9}$' then '0' || substr(d, 5)
    when d ~ '^66[0-9]{9}$' then '0' || substr(d, 3)
    when length(d) between 9 and 15 then d
    else null
  end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as d) s
$$;

-- ---------------------------------------------------------------------------
-- member_identities
-- ---------------------------------------------------------------------------
create table if not exists public.member_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  phone_key text not null check (phone_key ~ '^[0-9]{9,15}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone_key)
);

-- phone_key คือเบอร์โทร (PII) — ไม่เปิดให้พนักงานอ่านตรง ๆ ข้ามสาขา; ทุกการใช้งานผ่าน RPC/service role
alter table public.member_identities enable row level security;
revoke all on table public.member_identities from anon;
revoke all on table public.member_identities from authenticated;
drop policy if exists "member_identities: org member can read" on public.member_identities;

alter table public.customers
  add column if not exists member_identity_id uuid references public.member_identities(id) on delete set null;

create index if not exists customers_member_identity_idx
  on public.customers (member_identity_id, store_id)
  where member_identity_id is not null;

-- ผูก identity อัตโนมัติทุกครั้งที่สร้างลูกค้าหรือเปลี่ยนเบอร์ (security definer เพราะ
-- พนักงานที่สร้างลูกค้าไม่มีสิทธิ์ insert member_identities ตรง ๆ)
create or replace function public.customers_link_member_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := public.member_phone_key(new.phone);
  v_id uuid;
begin
  if v_key is null then
    new.member_identity_id := null;
    return new;
  end if;

  insert into public.member_identities (organization_id, phone_key)
  values (new.organization_id, v_key)
  on conflict (organization_id, phone_key) do update set updated_at = now()
  returning id into v_id;

  new.member_identity_id := v_id;
  return new;
end;
$$;

drop trigger if exists customers_link_member_identity on public.customers;
create trigger customers_link_member_identity
  before insert or update of phone, organization_id on public.customers
  for each row execute function public.customers_link_member_identity();

-- backfill ลูกค้าเดิม (ไม่แตะคอลัมน์ phone จึงไม่ปลุก trigger ซ้ำ)
insert into public.member_identities (organization_id, phone_key)
select distinct c.organization_id, public.member_phone_key(c.phone)
  from public.customers c
 where public.member_phone_key(c.phone) is not null
on conflict (organization_id, phone_key) do nothing;

update public.customers c
   set member_identity_id = mi.id
  from public.member_identities mi
 where mi.organization_id = c.organization_id
   and mi.phone_key = public.member_phone_key(c.phone)
   and c.member_identity_id is distinct from mi.id;

-- ---------------------------------------------------------------------------
-- สวิตช์ต่อสาขา
-- ---------------------------------------------------------------------------
alter table public.stores
  add column if not exists member_code_enabled boolean not null default false;

comment on column public.stores.member_code_enabled is
  'เปิดรหัสยืนยันสมาชิก 5 นาที (หน้าสมาชิกแสดงรหัส + POS ยืนยัน) — ฐานของแพ็กล่วงหน้า/ระดับสมาชิก, Enterprise เท่านั้น';

-- ---------------------------------------------------------------------------
-- member_redeem_codes
-- ---------------------------------------------------------------------------
create table if not exists public.member_redeem_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_identity_id uuid not null references public.member_identities(id) on delete cascade,
  issued_store_id uuid not null references public.stores(id) on delete cascade,
  issued_customer_id uuid not null references public.customers(id) on delete cascade,
  -- sha256(organization_id || ':' || code) คำนวณฝั่ง server — ไม่เก็บรหัสจริง
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_store_id uuid references public.stores(id) on delete set null,
  used_by uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists member_redeem_codes_lookup_idx
  on public.member_redeem_codes (organization_id, code_hash)
  where used_at is null and revoked_at is null;
create index if not exists member_redeem_codes_identity_idx
  on public.member_redeem_codes (member_identity_id, created_at desc);

alter table public.member_redeem_codes enable row level security;
revoke all on table public.member_redeem_codes from anon;
revoke all on table public.member_redeem_codes from authenticated;

-- ---------------------------------------------------------------------------
-- member_verifications
-- ---------------------------------------------------------------------------
create table if not exists public.member_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  member_identity_id uuid not null references public.member_identities(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  redeem_code_id uuid not null unique references public.member_redeem_codes(id) on delete cascade,
  verified_by uuid not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_order_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists member_verifications_store_idx
  on public.member_verifications (store_id, created_at desc);
-- P1/P2 ตรวจผลยืนยันที่ยังไม่ถูกใช้ตอนปิดบิล
create index if not exists member_verifications_customer_open_idx
  on public.member_verifications (customer_id, expires_at desc)
  where consumed_at is null;

alter table public.member_verifications enable row level security;
revoke all on table public.member_verifications from anon;
revoke all on table public.member_verifications from authenticated;
grant select on table public.member_verifications to authenticated;

drop policy if exists "member_verifications: store member can read" on public.member_verifications;
create policy "member_verifications: store member can read"
  on public.member_verifications for select
  using (store_id in (select auth_user_store_ids()));

-- ---------------------------------------------------------------------------
-- member_redeem_attempts (กันเดาสุ่ม)
-- ---------------------------------------------------------------------------
create table if not exists public.member_redeem_attempts (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null,
  success boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists member_redeem_attempts_store_idx
  on public.member_redeem_attempts (store_id, created_at desc) where not success;
create index if not exists member_redeem_attempts_user_idx
  on public.member_redeem_attempts (user_id, created_at desc) where not success;

alter table public.member_redeem_attempts enable row level security;
revoke all on table public.member_redeem_attempts from anon;
revoke all on table public.member_redeem_attempts from authenticated;

-- ---------------------------------------------------------------------------
-- RPC: ออกรหัส (เรียกจากหน้าสมาชิก หลัง server ตรวจเซสชันลูกค้าแล้ว)
-- ---------------------------------------------------------------------------
create or replace function public.issue_member_redeem_code(
  p_store_id uuid,
  p_customer_id uuid,
  p_code_hash text,
  p_ttl_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store public.stores%rowtype;
  v_customer public.customers%rowtype;
  v_recent integer;
  v_id uuid;
  v_expires timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'ไม่มีสิทธิ์ออกรหัสสมาชิก';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 600 then
    raise exception 'อายุรหัสไม่ถูกต้อง';
  end if;

  select * into v_store from public.stores where id = p_store_id and is_active;
  if not found then
    return jsonb_build_object('status', 'store_not_found');
  end if;
  if not v_store.member_code_enabled then
    return jsonb_build_object('status', 'disabled');
  end if;

  select * into v_customer
    from public.customers
   where id = p_customer_id and store_id = p_store_id and is_active;
  if not found then
    return jsonb_build_object('status', 'customer_not_found');
  end if;
  if v_customer.member_identity_id is null then
    return jsonb_build_object('status', 'no_phone');
  end if;

  -- จำกัดการขอรหัส: ไม่เกิน 10 ครั้งต่อ 10 นาทีต่อคน
  select count(*) into v_recent
    from public.member_redeem_codes
   where member_identity_id = v_customer.member_identity_id
     and created_at > now() - interval '10 minutes';
  if v_recent >= 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- รหัสชนกับรหัสอื่นที่ยังใช้ได้ในองค์กรเดียวกัน → ให้ server สุ่มใหม่
  if exists (
    select 1 from public.member_redeem_codes
     where organization_id = v_store.organization_id
       and code_hash = p_code_hash
       and used_at is null and revoked_at is null
       and expires_at > now()
  ) then
    return jsonb_build_object('status', 'collision');
  end if;

  -- รหัสใหม่ทำให้รหัสเก่าของคนนี้ใช้ไม่ได้ทันที
  update public.member_redeem_codes
     set revoked_at = now()
   where member_identity_id = v_customer.member_identity_id
     and used_at is null and revoked_at is null;

  v_expires := now() + make_interval(secs => p_ttl_seconds);
  insert into public.member_redeem_codes (
    organization_id, member_identity_id, issued_store_id, issued_customer_id, code_hash, expires_at
  ) values (
    v_store.organization_id, v_customer.member_identity_id, p_store_id, p_customer_id, p_code_hash, v_expires
  )
  returning id into v_id;

  return jsonb_build_object('status', 'ok', 'code_id', v_id, 'expires_at', v_expires);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: ยืนยันรหัสที่ POS (เรียกจาก server action หลังตรวจสิทธิ์ pos.use แล้ว)
-- ---------------------------------------------------------------------------
create or replace function public.verify_member_redeem_code(
  p_store_id uuid,
  p_user_id uuid,
  p_code_hash text,
  p_verification_ttl_seconds integer default 1200
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store public.stores%rowtype;
  v_code public.member_redeem_codes%rowtype;
  v_source public.customers%rowtype;
  v_customer_id uuid;
  v_user_fail integer;
  v_store_fail integer;
  v_verification_id uuid;
  v_expires timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'ไม่มีสิทธิ์ยืนยันรหัสสมาชิก';
  end if;

  select * into v_store from public.stores where id = p_store_id and is_active;
  if not found then
    return jsonb_build_object('status', 'store_not_found');
  end if;
  if not v_store.member_code_enabled then
    return jsonb_build_object('status', 'disabled');
  end if;

  -- ล็อกการเดา: ผิด 5 ครั้งใน 10 นาทีต่อพนักงาน หรือ 15 ครั้งต่อสาขา
  select count(*) into v_user_fail
    from public.member_redeem_attempts
   where user_id = p_user_id and not success and created_at > now() - interval '10 minutes';
  select count(*) into v_store_fail
    from public.member_redeem_attempts
   where store_id = p_store_id and not success and created_at > now() - interval '10 minutes';
  if v_user_fail >= 5 or v_store_fail >= 15 then
    return jsonb_build_object('status', 'locked');
  end if;

  select * into v_code
    from public.member_redeem_codes
   where organization_id = v_store.organization_id
     and code_hash = p_code_hash
     and used_at is null and revoked_at is null
     and expires_at > now()
   order by created_at desc
   limit 1
   for update;

  if not found then
    insert into public.member_redeem_attempts (organization_id, store_id, user_id, success)
    values (v_store.organization_id, p_store_id, p_user_id, false);
    return jsonb_build_object(
      'status', 'invalid',
      'attempts_left', greatest(0, 4 - v_user_fail)
    );
  end if;

  -- หาลูกค้าของสาขานี้ที่เป็นคนเดียวกัน ถ้ายังไม่มีให้สร้างจากข้อมูลสาขาที่ออกรหัส
  select id into v_customer_id
    from public.customers
   where store_id = p_store_id
     and member_identity_id = v_code.member_identity_id
     and is_active
   order by updated_at desc
   limit 1;

  if v_customer_id is null then
    select * into v_source from public.customers where id = v_code.issued_customer_id;
    if not found or v_source.organization_id <> v_store.organization_id then
      return jsonb_build_object('status', 'customer_conflict');
    end if;
    if exists (
      select 1 from public.customers
       where store_id = p_store_id and member_identity_id = v_code.member_identity_id and not is_active
    ) then
      return jsonb_build_object('status', 'customer_inactive');
    end if;
    insert into public.customers (organization_id, store_id, name, phone, email)
    values (v_store.organization_id, p_store_id, v_source.name, v_source.phone, v_source.email)
    on conflict do nothing
    returning id into v_customer_id;
    if v_customer_id is null then
      -- เบอร์ซ้ำแบบเขียนต่างกัน (เช่น +66 กับ 0) ในสาขานี้ — trigger ผูก identity ไว้แล้ว ลองหาอีกครั้ง
      select id into v_customer_id
        from public.customers
       where store_id = p_store_id and member_identity_id = v_code.member_identity_id and is_active
       limit 1;
    end if;
    if v_customer_id is null then
      return jsonb_build_object('status', 'customer_conflict');
    end if;
  end if;

  update public.member_redeem_codes
     set used_at = now(), used_store_id = p_store_id, used_by = p_user_id
   where id = v_code.id;

  insert into public.member_redeem_attempts (organization_id, store_id, user_id, success)
  values (v_store.organization_id, p_store_id, p_user_id, true);

  v_expires := now() + make_interval(secs => greatest(60, least(coalesce(p_verification_ttl_seconds, 1200), 3600)));
  insert into public.member_verifications (
    organization_id, store_id, member_identity_id, customer_id, redeem_code_id, verified_by, expires_at
  ) values (
    v_store.organization_id, p_store_id, v_code.member_identity_id, v_customer_id, v_code.id, p_user_id, v_expires
  )
  returning id into v_verification_id;

  return jsonb_build_object(
    'status', 'ok',
    'verification_id', v_verification_id,
    'customer_id', v_customer_id,
    'member_identity_id', v_code.member_identity_id,
    'issued_store_id', v_code.issued_store_id,
    'expires_at', v_expires
  );
end;
$$;

revoke all on function public.issue_member_redeem_code(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.verify_member_redeem_code(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.issue_member_redeem_code(uuid, uuid, text, integer) to service_role;
grant execute on function public.verify_member_redeem_code(uuid, uuid, text, integer) to service_role;
revoke all on function public.customers_link_member_identity() from public, anon, authenticated;
