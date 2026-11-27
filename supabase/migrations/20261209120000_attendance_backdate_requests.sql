-- คำขอลงเวลาย้อนหลังต้องผ่านการอนุมัติ + ไม่สร้างแถวซ้อน
--
-- เดิม: พนักงานกด "ลงเวลาย้อนหลัง" → insert attendance_records (status backdated) ทันที
--   - มีผลกับเงินเดือนทันทีโดยไม่มีใครตรวจ (เคยเกิด: เลือกวันออกผิดเป็น 32 ชม.)
--   - วันที่ลืมกดออก (แถว abandoned มีเวลาเข้าแล้ว) กลายเป็น 2 แถวซ้อนกัน
-- ใหม่: เก็บเป็นคำขอในตารางนี้ → ผู้จัดการ (attendance.manage) อนุมัติ/ปฏิเสธ
--   - มีแถวลืมกดออก: ขอแค่ "เวลาออก" → อนุมัติแล้วเติมเวลาออกในแถวเดิม (ไม่สร้างแถวใหม่)
--   - วันที่ไม่ได้ลงเวลาเลย: ขอทั้งเข้า-ออก → อนุมัติแล้วสร้างแถว backdated
create table if not exists public.attendance_backdate_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null,
  employee_name text not null,
  attendance_record_id uuid references public.attendance_records(id) on delete set null,
  date date not null,
  clock_in_at timestamptz not null,
  clock_out_at timestamptz not null,
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by_user_id uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_backdate_out_after_in check (clock_out_at > clock_in_at),
  constraint attendance_backdate_max_span check (clock_out_at <= clock_in_at + interval '24 hours')
);

create index if not exists attendance_backdate_requests_store_status_idx
  on public.attendance_backdate_requests (store_id, status, created_at desc);
create index if not exists attendance_backdate_requests_user_idx
  on public.attendance_backdate_requests (user_id, date);
-- คำขอค้างได้ครั้งละ 1 ต่อแถวลืมกดออก / ต่อวัน (กันกดซ้ำ)
create unique index if not exists attendance_backdate_one_pending_per_record
  on public.attendance_backdate_requests (attendance_record_id) where status = 'pending' and attendance_record_id is not null;
create unique index if not exists attendance_backdate_one_pending_per_day
  on public.attendance_backdate_requests (store_id, user_id, date) where status = 'pending';

alter table public.attendance_backdate_requests enable row level security;

drop policy if exists attendance_backdate_requests_select on public.attendance_backdate_requests;
create policy attendance_backdate_requests_select on public.attendance_backdate_requests
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.auth_user_has_permission(organization_id, store_id, 'attendance.manage')
  );
-- เขียนผ่าน RPC ด้านล่างเท่านั้น
revoke insert, update, delete on table public.attendance_backdate_requests from authenticated, anon;

-- ---------------------------------------------------------------------------
-- พนักงานยื่นคำขอ
-- ---------------------------------------------------------------------------
create or replace function public.request_attendance_backdate(
  p_store_id uuid,
  p_record_id uuid,
  p_date date,
  p_clock_in_at timestamptz,
  p_clock_out_at timestamptz,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_tz text;
  v_today date;
  v_record public.attendance_records%rowtype;
  v_date date;
  v_in timestamptz;
  v_name text;
  v_used integer;
  v_rights integer;
  v_next_in timestamptz;
  v_id uuid;
begin
  if v_uid is null then raise exception 'ต้องเข้าสู่ระบบก่อน'; end if;
  select organization_id, coalesce(timezone, 'Asia/Bangkok') into v_org, v_tz from public.stores where id = p_store_id;
  if v_org is null then raise exception 'ไม่พบร้าน'; end if;
  if not public.auth_user_has_permission(v_org, p_store_id, 'attendance.clock') then
    raise exception 'ไม่มีสิทธิ์ลงเวลา';
  end if;
  v_today := (now() at time zone v_tz)::date;
  -- กันกดส่งพร้อมกันหลายวันจนเกินสิทธิ (นับ quota กับ insert ต้องเป็นลำดับเดียว)
  perform pg_advisory_xact_lock(hashtextextended('attendance_backdate:' || p_store_id::text || ':' || v_uid::text, 0));

  if p_record_id is not null then
    -- ลืมกดออก: ใช้เวลาเข้าของแถวเดิม ขอได้แค่เวลาออก
    select * into v_record from public.attendance_records
      where id = p_record_id and store_id = p_store_id and user_id = v_uid
      for update;
    if not found then raise exception 'ไม่พบบันทึกเวลาเข้างานนี้'; end if;
    if v_record.clock_out_at is not null then raise exception 'บันทึกนี้มีเวลาออกแล้ว'; end if;
    if v_record.status not in ('abandoned', 'active') or v_record.date >= v_today then
      raise exception 'ขอเวลาออกย้อนหลังได้เฉพาะวันที่ผ่านมาแล้วที่ลืมกดออกงาน';
    end if;
    v_date := v_record.date;
    v_in := v_record.clock_in_at;
    v_name := v_record.employee_name;
  else
    -- ไม่ได้ลงเวลาเลยทั้งวัน
    if p_date is null or p_date >= v_today then raise exception 'ลงย้อนหลังได้เฉพาะวันที่ผ่านมาแล้ว'; end if;
    if p_clock_in_at is null then raise exception 'ต้องระบุเวลาเข้า'; end if;
    if exists (select 1 from public.attendance_records where store_id = p_store_id and user_id = v_uid and date = p_date) then
      raise exception 'วันนี้มีบันทึกเวลาอยู่แล้ว — ถ้าลืมกดออก ให้เลือกขอเวลาออกจากบันทึกนั้น';
    end if;
    v_date := p_date;
    v_in := p_clock_in_at;
    v_name := coalesce(
      (select employee_name from public.attendance_records where store_id = p_store_id and user_id = v_uid order by created_at desc limit 1),
      (select email from auth.users where id = v_uid),
      v_uid::text
    );
  end if;

  if p_clock_out_at is null or p_clock_out_at <= v_in then raise exception 'เวลาออกต้องหลังเวลาเข้า'; end if;
  if p_clock_out_at > v_in + interval '24 hours' then raise exception 'เวลาออกห่างจากเวลาเข้าเกิน 24 ชั่วโมง — ตรวจวันที่อีกครั้ง'; end if;
  if p_clock_out_at > now() then raise exception 'เวลาออกต้องไม่เกินเวลาปัจจุบัน'; end if;
  select min(clock_in_at) into v_next_in from public.attendance_records
    where store_id = p_store_id and user_id = v_uid and clock_in_at > v_in
      and (p_record_id is null or id <> p_record_id);
  if v_next_in is not null and p_clock_out_at > v_next_in then
    raise exception 'เวลาออกทับกับการเข้างานครั้งถัดไป — ตรวจวันที่อีกครั้ง';
  end if;

  -- สิทธิต่อเดือนอ่านจากตั้งค่าร้าน (ไม่รับจาก client)
  select coalesce((select backdated_rights_per_month from public.store_hr_settings where store_id = p_store_id), 3) into v_rights;
  select count(*) into v_used from public.attendance_backdate_requests
    where store_id = p_store_id and user_id = v_uid and status in ('pending', 'approved')
      and date >= date_trunc('month', v_date)::date and date < (date_trunc('month', v_date) + interval '1 month')::date;
  if v_used >= v_rights then
    raise exception 'ใช้สิทธิลงเวลาย้อนหลังครบ % ครั้งในเดือนนี้แล้ว', v_rights;
  end if;

  insert into public.attendance_backdate_requests (
    organization_id, store_id, user_id, employee_name, attendance_record_id, date, clock_in_at, clock_out_at, note
  ) values (
    v_org, p_store_id, v_uid, v_name, p_record_id, v_date, v_in, p_clock_out_at, nullif(left(btrim(coalesce(p_note, '')), 200), '')
  ) returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'มีคำขอของวันนี้รออนุมัติอยู่แล้ว';
end;
$$;

-- ---------------------------------------------------------------------------
-- ผู้จัดการอนุมัติ / ปฏิเสธ (พนักงานยกเลิกคำขอของตัวเองได้ด้วย p_action = 'cancel')
-- ---------------------------------------------------------------------------
create or replace function public.decide_attendance_backdate(
  p_request_id uuid,
  p_action text,
  p_note text
) returns public.attendance_backdate_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.attendance_backdate_requests%rowtype;
  v_record public.attendance_records%rowtype;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 200), '');
  v_next_in timestamptz;
begin
  if v_uid is null then raise exception 'ต้องเข้าสู่ระบบก่อน'; end if;
  if p_action not in ('approve', 'reject', 'cancel') then raise exception 'คำสั่งไม่ถูกต้อง'; end if;
  select * into v_req from public.attendance_backdate_requests where id = p_request_id for update;
  if not found then raise exception 'ไม่พบคำขอ'; end if;
  if v_req.status <> 'pending' then raise exception 'คำขอนี้ดำเนินการไปแล้ว'; end if;

  if p_action = 'cancel' then
    if v_req.user_id <> v_uid then raise exception 'ยกเลิกได้เฉพาะคำขอของตัวเอง'; end if;
  elsif v_req.user_id = v_uid then
    -- คนขอห้ามอนุมัติ/ปฏิเสธเอง (ต้นเหตุเดิม: เลือกเวลาเองไม่มีใครตรวจ)
    raise exception 'อนุมัติหรือปฏิเสธคำขอของตัวเองไม่ได้ — ให้ผู้จัดการคนอื่นตรวจ หรือแก้บันทึกเวลาโดยตรง';
  elsif not public.auth_user_has_permission(v_req.organization_id, v_req.store_id, 'attendance.manage') then
    raise exception 'ไม่มีสิทธิ์อนุมัติการลงเวลา';
  end if;

  if p_action = 'approve' then
    if v_req.attendance_record_id is not null then
      select * into v_record from public.attendance_records where id = v_req.attendance_record_id for update;
      if not found then raise exception 'บันทึกเวลาเข้างานเดิมถูกลบไปแล้ว'; end if;
      if v_record.clock_out_at is not null then raise exception 'บันทึกนี้มีเวลาออกแล้ว (อาจแก้ไปก่อนหน้า)'; end if;
      select min(clock_in_at) into v_next_in from public.attendance_records
        where user_id = v_req.user_id and organization_id = v_req.organization_id
          and clock_in_at > v_record.clock_in_at and id <> v_record.id;
      if v_next_in is not null and v_req.clock_out_at > v_next_in then
        raise exception 'เวลาออกทับกับการเข้างานครั้งถัดไป — ไม่อนุมัติคำขอนี้แล้วให้พนักงานขอใหม่';
      end if;
      update public.attendance_records
         set clock_out_at = v_req.clock_out_at,
             status = 'backdated',
             adjusted_by_user_id = v_uid,
             note = left(concat_ws(' · ', nullif(note, ''), 'ขอเวลาออกย้อนหลัง (อนุมัติแล้ว)', v_req.note), 200),
             updated_at = now()
       where id = v_record.id;
    else
      if exists (select 1 from public.attendance_records where store_id = v_req.store_id and user_id = v_req.user_id and date = v_req.date) then
        raise exception 'วันนี้มีบันทึกเวลาแล้ว — ปฏิเสธคำขอนี้แล้วแก้ที่บันทึกเดิมแทน';
      end if;
      select min(clock_in_at) into v_next_in from public.attendance_records
        where store_id = v_req.store_id and user_id = v_req.user_id and clock_in_at > v_req.clock_in_at;
      if v_next_in is not null and v_req.clock_out_at > v_next_in then
        raise exception 'เวลาออกทับกับการเข้างานครั้งถัดไป';
      end if;
      insert into public.attendance_records (
        organization_id, store_id, user_id, employee_name, date, clock_in_at, clock_out_at, note, status, adjusted_by_user_id
      ) values (
        v_req.organization_id, v_req.store_id, v_req.user_id, v_req.employee_name, v_req.date,
        v_req.clock_in_at, v_req.clock_out_at,
        left(concat_ws(' · ', 'ลงเวลาย้อนหลัง (อนุมัติแล้ว)', v_req.note), 200), 'backdated', v_uid
      );
    end if;
  end if;

  update public.attendance_backdate_requests
     set status = case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'cancelled' end,
         decided_by_user_id = v_uid,
         decided_at = now(),
         decision_note = v_note,
         updated_at = now()
   where id = v_req.id
   returning * into v_req;
  return v_req;
end;
$$;

revoke all on function public.request_attendance_backdate(uuid, uuid, date, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.request_attendance_backdate(uuid, uuid, date, timestamptz, timestamptz, text) to authenticated, service_role;
revoke all on function public.decide_attendance_backdate(uuid, text, text) from public, anon;
grant execute on function public.decide_attendance_backdate(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- แถวได้เวลาออกจากทางอื่น (พนักงานกดออก / ผู้จัดการแก้เอง) → คำขอที่ค้างของแถวนั้นหมดความหมาย
-- ปิดเป็น rejected พร้อมเหตุผล (ไม่กินสิทธิ) — ตอนอนุมัติ ฟังก์ชันจะเขียนสถานะ approved ทับภายหลัง
-- ---------------------------------------------------------------------------
create or replace function public.attendance_backdate_close_pending_on_clock_out()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.clock_out_at is null and new.clock_out_at is not null then
    update public.attendance_backdate_requests
       set status = 'rejected',
           decided_at = now(),
           decision_note = 'บันทึกเวลาออกถูกแก้ไขแล้ว (ปิดคำขออัตโนมัติ)',
           updated_at = now()
     where attendance_record_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_backdate_close_pending on public.attendance_records;
create trigger attendance_backdate_close_pending
  after update of clock_out_at on public.attendance_records
  for each row execute function public.attendance_backdate_close_pending_on_clock_out();

-- ---------------------------------------------------------------------------
-- นับสิทธิที่ใช้ไปแล้วในเดือนนี้ด้วยระบบเดิม (ลงย้อนหลังเองโดยตรง) เป็นคำขอ approved
-- ไม่งั้นคนที่ใช้ครบแล้วกลางเดือนจะได้สิทธิคืน
-- ---------------------------------------------------------------------------
insert into public.attendance_backdate_requests (
  organization_id, store_id, user_id, employee_name, attendance_record_id, date,
  clock_in_at, clock_out_at, note, status, decided_by_user_id, decided_at, decision_note
)
select r.organization_id, r.store_id, r.user_id, r.employee_name, r.id, r.date,
       r.clock_in_at, r.clock_out_at, r.note, 'approved', r.user_id, r.created_at,
       'นำเข้าจากระบบลงย้อนหลังเดิม (มีผลทันที)'
  from public.attendance_records r
 where r.status in ('backdated', 'adjusted')
   and r.adjusted_by_user_id = r.user_id
   and r.date >= date_trunc('month', now() at time zone 'Asia/Bangkok')::date
   and r.clock_out_at is not null
   and r.clock_out_at > r.clock_in_at
   and r.clock_out_at <= r.clock_in_at + interval '24 hours'
   and not exists (select 1 from public.attendance_backdate_requests q where q.attendance_record_id = r.id);
