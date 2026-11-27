-- พนักงานกรอกข้อมูลตัวเองได้ ยกเว้นช่องที่เจ้าของ/ผู้จัดการตั้งไว้แล้ว
--
-- เก็บแยกจาก employee_profiles เพราะแถวนั้นคือ "การตั้งค่าจ้าง" (มีแถว = เข้ารอบเงินเดือน/วันทำงาน)
-- ถ้าให้พนักงานสร้างแถวเองจะเปลี่ยนผลเงินเดือน
--
-- ค่าที่ใช้จริงบนสลิป = ค่าของเจ้าของ (employee_profiles) ถ้ามี ไม่งั้นใช้ค่าที่พนักงานกรอก
-- ช่องที่เจ้าของตั้งแล้ว: trigger ล้างค่าที่พนักงานส่งมาเป็น null (กันส่งตรงผ่าน API)
-- ช่องส่วนตัว (เบอร์, ที่อยู่, วันเกิด, ผู้ติดต่อฉุกเฉิน) เป็นของพนักงาน
--
-- กรอกครั้งแรก (ช่องว่าง) บันทึกได้ทันที · แก้/ลบช่องที่มีค่าแล้ว ต้องส่งคำขอให้ผู้มีสิทธิ์ attendance.manage อนุมัติ
-- (ตาราง employee_self_info_requests + RPC review_employee_self_info_request)

create table if not exists public.employee_self_info (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organizations(id) on delete cascade,
  store_id                uuid not null references stores(id) on delete cascade,
  user_id                 uuid not null,
  full_name               text,
  bank_name               text,
  bank_account_no         text,
  bank_account_name       text,
  nickname                text,
  phone                   text,
  birth_date              date,
  address                 text,
  emergency_contact_name  text,
  emergency_contact_phone text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (store_id, user_id),
  constraint employee_self_info_text_lengths_check check (
    coalesce(length(full_name), 0) <= 150
    and coalesce(length(bank_name), 0) <= 80
    and coalesce(length(bank_account_no), 0) <= 30
    and coalesce(length(bank_account_name), 0) <= 150
    and coalesce(length(nickname), 0) <= 50
    and coalesce(length(phone), 0) <= 20
    and coalesce(length(address), 0) <= 400
    and coalesce(length(emergency_contact_name), 0) <= 150
    and coalesce(length(emergency_contact_phone), 0) <= 20
  ),
  constraint employee_self_info_bank_digits_check check (bank_account_no is null or bank_account_no ~ '^[0-9]{6,20}$'),
  constraint employee_self_info_phone_check check (phone is null or phone ~ '^\+?[0-9]{9,15}$'),
  constraint employee_self_info_emergency_phone_check check (emergency_contact_phone is null or emergency_contact_phone ~ '^\+?[0-9]{9,15}$')
);

create index if not exists employee_self_info_store_idx on public.employee_self_info (store_id);

alter table public.employee_self_info enable row level security;

drop policy if exists "employee_self_info: own row or attendance manager can read" on public.employee_self_info;
create policy "employee_self_info: own row or attendance manager can read"
  on public.employee_self_info for select
  using (
    user_id = auth.uid()
    or auth_user_has_permission(organization_id, store_id, 'attendance.manage')
  );

-- เขียนได้เฉพาะแถวตัวเอง ในสาขาที่เป็นสมาชิก และ org ต้องตรงกับสาขา (ไม่มี delete)
drop policy if exists "employee_self_info: own row insert" on public.employee_self_info;
create policy "employee_self_info: own row insert"
  on public.employee_self_info for insert
  with check (
    user_id = auth.uid()
    and store_id in (select auth_user_store_ids())
    and organization_id = (select s.organization_id from stores s where s.id = store_id)
  );

drop policy if exists "employee_self_info: own row update" on public.employee_self_info;
create policy "employee_self_info: own row update"
  on public.employee_self_info for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and store_id in (select auth_user_store_ids())
    and organization_id = (select s.organization_id from stores s where s.id = store_id)
  );

-- ช่องที่เจ้าของตั้งแล้ว → ไม่รับค่าจากพนักงาน
-- security invoker โดยตั้งใจ: ต้องอ่าน current_user ของผู้เรียกจริงเพื่อแยกพนักงาน (authenticated) กับ RPC อนุมัติ
-- (ถ้าเป็น definer current_user จะเป็นเจ้าของฟังก์ชันเสมอ) · พนักงานอ่าน employee_profiles แถวตัวเองได้ตาม RLS อยู่แล้ว
create or replace function public.employee_self_info_enforce_owner_locks()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_profile employee_profiles%rowtype;
  v_old jsonb;
  v_new jsonb;
  v_col text;
begin
  if tg_op = 'UPDATE' then
    new.store_id := old.store_id;
    new.organization_id := old.organization_id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;

    -- พนักงานแก้เอง (role authenticated/anon) ได้แค่ช่องที่ยังว่าง
    -- ช่องที่มีค่าแล้วต้องผ่าน review_employee_self_info_request (RPC นั้น current_user เป็นเจ้าของฟังก์ชัน จึงไม่เข้าเงื่อนไขนี้)
    if current_user in ('authenticated', 'anon') then
      v_old := to_jsonb(old);
      v_new := to_jsonb(new);
      foreach v_col in array array['full_name','bank_name','bank_account_no','bank_account_name','nickname','phone',
                                   'birth_date','address','emergency_contact_name','emergency_contact_phone'] loop
        if coalesce(btrim(v_old->>v_col), '') <> '' and (v_new->>v_col) is distinct from (v_old->>v_col) then
          raise exception 'แก้ข้อมูลที่กรอกแล้วต้องรอผู้จัดการอนุมัติ (%)', v_col using errcode = '42501';
        end if;
      end loop;
    end if;
  end if;
  new.updated_at := now();

  select * into v_profile
    from employee_profiles
   where store_id = new.store_id
     and user_id = new.user_id;

  if found then
    if coalesce(btrim(v_profile.full_name), '') <> '' then new.full_name := null; end if;
    if coalesce(btrim(v_profile.bank_name), '') <> '' then new.bank_name := null; end if;
    if coalesce(btrim(v_profile.bank_account_no), '') <> '' then new.bank_account_no := null; end if;
    if coalesce(btrim(v_profile.bank_account_name), '') <> '' then new.bank_account_name := null; end if;
  end if;
  return new;
end;
$$;

revoke all on function public.employee_self_info_enforce_owner_locks() from public, anon, authenticated;

drop trigger if exists employee_self_info_owner_locks on public.employee_self_info;
create trigger employee_self_info_owner_locks
  before insert or update on public.employee_self_info
  for each row execute function public.employee_self_info_enforce_owner_locks();

-- ---------------------------------------------------------------------------
-- คำขอแก้ข้อมูลที่กรอกแล้ว (รออนุมัติ) — พนักงานมีคำขอค้างได้ 1 รายการต่อสาขา
-- changes = { "<column>": "<ค่าใหม่>" | null } เฉพาะคอลัมน์ที่อนุญาต
-- ---------------------------------------------------------------------------
create table if not exists public.employee_self_info_requests (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  user_id         uuid not null,
  changes         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  review_note     text check (coalesce(length(review_note), 0) <= 300),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  constraint employee_self_info_requests_changes_object check (jsonb_typeof(changes) = 'object')
);

create unique index if not exists employee_self_info_requests_one_pending_idx
  on public.employee_self_info_requests (store_id, user_id) where status = 'pending';
create index if not exists employee_self_info_requests_store_idx
  on public.employee_self_info_requests (store_id, status, created_at desc);

alter table public.employee_self_info_requests enable row level security;

-- อ่านได้: เจ้าของคำขอ หรือ attendance.manage · เขียนผ่าน RPC เท่านั้น (ไม่มี policy เขียน)
drop policy if exists "employee_self_info_requests: own or attendance manager can read" on public.employee_self_info_requests;
create policy "employee_self_info_requests: own or attendance manager can read"
  on public.employee_self_info_requests for select
  using (
    user_id = auth.uid()
    or auth_user_has_permission(organization_id, store_id, 'attendance.manage')
  );

-- คอลัมน์ที่ขอแก้ได้ (ตรงกับ employee_self_info)
create or replace function public.employee_self_info_allowed_columns()
returns text[]
language sql
immutable
as $$
  select array['full_name','bank_name','bank_account_no','bank_account_name','nickname','phone',
               'birth_date','address','emergency_contact_name','emergency_contact_phone']
$$;

-- พนักงานส่งคำขอ (แทนที่คำขอค้างเดิม)
create or replace function public.submit_employee_self_info_request(p_store_id uuid, p_changes jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_key text;
  v_val text;
  v_id uuid;
  v_profile employee_profiles%rowtype;
begin
  if v_uid is null or p_store_id not in (select auth_user_store_ids()) then
    raise exception 'ไม่มีสิทธิ์ในสาขานี้' using errcode = '42501';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'ไม่มีช่องที่ขอแก้' using errcode = '22023';
  end if;
  select * into v_profile from employee_profiles where store_id = p_store_id and user_id = v_uid;

  -- ตรวจค่าตั้งแต่ตอนส่ง: คำขอที่ผิดรูปแบบจะค้างจนผู้จัดการอนุมัติไม่ได้ (ผู้ใช้เรียก RPC ตรงข้ามการตรวจฝั่งแอปได้)
  for v_key in select jsonb_object_keys(p_changes) loop
    if not (v_key = any (employee_self_info_allowed_columns())) then
      raise exception 'ขอแก้ช่องนี้ไม่ได้: %', v_key using errcode = '22023';
    end if;
    if jsonb_typeof(p_changes->v_key) not in ('string', 'null') or coalesce(length(p_changes->>v_key), 0) > 400 then
      raise exception 'ค่าที่ขอแก้ไม่ถูกต้อง: %', v_key using errcode = '22023';
    end if;
    -- ช่องที่เจ้าของตั้งแล้วขอแก้ไม่ได้ (อนุมัติไปก็ไม่มีผล)
    if v_key in ('full_name', 'bank_name', 'bank_account_no', 'bank_account_name')
       and coalesce(btrim(to_jsonb(v_profile)->>v_key), '') <> '' then
      raise exception 'ช่องนี้เจ้าของร้านตั้งไว้แล้ว แก้ได้ที่ผู้จัดการเท่านั้น' using errcode = '22023';
    end if;

    v_val := nullif(btrim(p_changes->>v_key), '');
    continue when v_val is null;
    if v_key = 'bank_account_no' and v_val !~ '^[0-9]{6,20}$' then
      raise exception 'เลขบัญชีต้องเป็นตัวเลข 6–20 หลัก' using errcode = '22023';
    end if;
    if v_key in ('phone', 'emergency_contact_phone') and v_val !~ '^\+?[0-9]{9,15}$' then
      raise exception 'เบอร์โทรต้องเป็นตัวเลข 9–15 หลัก' using errcode = '22023';
    end if;
    if v_key = 'birth_date' then
      begin
        perform v_val::date;
      exception when others then
        raise exception 'วันเกิดไม่ถูกต้อง' using errcode = '22023';
      end;
    end if;
    -- ความยาวเดียวกับ check constraint ของตาราง
    if (v_key = 'bank_name' and length(v_val) > 80)
       or (v_key = 'nickname' and length(v_val) > 50)
       or (v_key in ('full_name', 'bank_account_name', 'emergency_contact_name') and length(v_val) > 150) then
      raise exception 'ข้อความยาวเกินกำหนด' using errcode = '22023';
    end if;
  end loop;

  select organization_id into v_org from stores where id = p_store_id;

  update employee_self_info_requests
     set status = 'cancelled', reviewed_at = now()
   where store_id = p_store_id and user_id = v_uid and status = 'pending';

  insert into employee_self_info_requests (organization_id, store_id, user_id, changes)
  values (v_org, p_store_id, v_uid, p_changes)
  returning id into v_id;
  return v_id;
end;
$$;

-- พนักงานยกเลิกคำขอของตัวเอง
create or replace function public.cancel_employee_self_info_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update employee_self_info_requests
     set status = 'cancelled', reviewed_at = now()
   where id = p_request_id and user_id = auth.uid() and status = 'pending';
  if not found then
    raise exception 'ไม่พบคำขอที่รออนุมัติ' using errcode = 'P0002';
  end if;
end;
$$;

-- ผู้จัดการอนุมัติ/ปฏิเสธ — อนุมัติแล้วเขียนค่าลง employee_self_info ในธุรกรรมเดียว
-- (trigger ยังล้างช่องที่เจ้าของตั้งแล้ว และ check constraint ยังตรวจรูปแบบเลขบัญชี/เบอร์/ความยาว)
-- กรณีที่ยอมรับ: เจ้าของตั้งช่องนั้นหลังพนักงานส่งคำขอ → อนุมัติสำเร็จแต่ช่องนั้นไม่มีผล เพราะค่าของเจ้าของมาก่อนอยู่แล้ว
create or replace function public.review_employee_self_info_request(p_request_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r employee_self_info_requests%rowtype;
  c jsonb;
begin
  select * into r from employee_self_info_requests where id = p_request_id for update;
  if not found or r.status <> 'pending' then
    raise exception 'ไม่พบคำขอที่รออนุมัติ' using errcode = 'P0002';
  end if;
  if not auth_user_has_permission(r.organization_id, r.store_id, 'attendance.manage') then
    raise exception 'ไม่มีสิทธิ์อนุมัติ' using errcode = '42501';
  end if;
  -- ไม่ห้ามอนุมัติของตัวเอง: ผู้มี attendance.manage ตั้งค่าตัวเองในฟอร์มพนักงานได้อยู่แล้ว
  -- และเจ้าของร้านคนเดียวจะไม่มีใครอนุมัติให้

  if p_approve then
    c := r.changes;
    insert into employee_self_info (organization_id, store_id, user_id)
    values (r.organization_id, r.store_id, r.user_id)
    on conflict (store_id, user_id) do nothing;

    update employee_self_info
       set full_name               = case when c ? 'full_name' then nullif(btrim(c->>'full_name'), '') else full_name end,
           bank_name               = case when c ? 'bank_name' then nullif(btrim(c->>'bank_name'), '') else bank_name end,
           bank_account_no         = case when c ? 'bank_account_no' then nullif(btrim(c->>'bank_account_no'), '') else bank_account_no end,
           bank_account_name       = case when c ? 'bank_account_name' then nullif(btrim(c->>'bank_account_name'), '') else bank_account_name end,
           nickname                = case when c ? 'nickname' then nullif(btrim(c->>'nickname'), '') else nickname end,
           phone                   = case when c ? 'phone' then nullif(btrim(c->>'phone'), '') else phone end,
           birth_date              = case when c ? 'birth_date' then nullif(btrim(c->>'birth_date'), '')::date else birth_date end,
           address                 = case when c ? 'address' then nullif(btrim(c->>'address'), '') else address end,
           emergency_contact_name  = case when c ? 'emergency_contact_name' then nullif(btrim(c->>'emergency_contact_name'), '') else emergency_contact_name end,
           emergency_contact_phone = case when c ? 'emergency_contact_phone' then nullif(btrim(c->>'emergency_contact_phone'), '') else emergency_contact_phone end
     where store_id = r.store_id and user_id = r.user_id;
  end if;

  update employee_self_info_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         review_note = nullif(btrim(coalesce(p_note, '')), ''),
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_request_id;
end;
$$;

revoke all on function public.submit_employee_self_info_request(uuid, jsonb) from public, anon;
revoke all on function public.cancel_employee_self_info_request(uuid) from public, anon;
revoke all on function public.review_employee_self_info_request(uuid, boolean, text) from public, anon;
grant execute on function public.submit_employee_self_info_request(uuid, jsonb) to authenticated;
grant execute on function public.cancel_employee_self_info_request(uuid) to authenticated;
grant execute on function public.review_employee_self_info_request(uuid, boolean, text) to authenticated;
