-- พนักงานกรอกข้อมูลตัวเองได้ ยกเว้นช่องที่เจ้าของ/ผู้จัดการตั้งไว้แล้ว
--
-- เก็บแยกจาก employee_profiles เพราะแถวนั้นคือ "การตั้งค่าจ้าง" (มีแถว = เข้ารอบเงินเดือน/วันทำงาน)
-- ถ้าให้พนักงานสร้างแถวเองจะเปลี่ยนผลเงินเดือน
--
-- ค่าที่ใช้จริงบนสลิป = ค่าของเจ้าของ (employee_profiles) ถ้ามี ไม่งั้นใช้ค่าที่พนักงานกรอก
-- ช่องที่เจ้าของตั้งแล้ว: trigger ล้างค่าที่พนักงานส่งมาเป็น null (กันส่งตรงผ่าน API)
-- ช่องส่วนตัว (เบอร์, ที่อยู่, วันเกิด, ผู้ติดต่อฉุกเฉิน) เป็นของพนักงาน แก้ได้เสมอ

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
  constraint employee_self_info_bank_digits_check check (bank_account_no is null or bank_account_no ~ '^[0-9]{6,20}$')
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
-- security definer: พนักงานอ่าน employee_profiles ได้แค่แถวตัวเองอยู่แล้ว แต่ให้ trigger ไม่ขึ้นกับ RLS
create or replace function public.employee_self_info_enforce_owner_locks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile employee_profiles%rowtype;
begin
  if tg_op = 'UPDATE' then
    new.store_id := old.store_id;
    new.organization_id := old.organization_id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
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
