-- แผนสลิปพนักงาน v4 · P2–P6 "เงินเดือนขั้นสูง" (ฟีเจอร์แพ็ก advancedPayroll — R33)
-- Plan/Employee Payslip Self-Service Plan v4.html
--
--   P2  สวิตช์ฟีเจอร์ (R32, ค่าเริ่มต้นปิด) + รอบเงินเดือน/วันจ่าย (R14–R16) + ประวัติเรท (R13, R29)
--   P3  ค่าทักษะ ② / ค่าอายุงาน ③ / โบนัสยอดขายรายวัน ④ (R1–R12)
--   P4  ประกันสังคม / ภาษีหัก ณ ที่จ่าย (R18, R19, R28)
--   P5  งวดเงินเดือน + สลิปถาวร + ปิดงวดอัตโนมัติ (R16, R22–R24) + pg_cron
--   P6  สลิปของฉัน (R17, R23, R27) — RLS ให้พนักงานอ่านสลิปตัวเองเมื่อถึงวันจ่าย
--
-- ทุกอย่างค่าเริ่มต้นปิด: ร้านเดิมไม่เห็นอะไรเปลี่ยนจนกว่าจะซื้อแพ็ก + เปิดสวิตช์เอง

-- ---------------------------------------------------------------------------
-- 1) ตั้งค่าระดับสาขา
-- ---------------------------------------------------------------------------
alter table store_hr_settings
  add column if not exists feat_sales_target_bar boolean not null default false,
  add column if not exists feat_sales_bonus boolean not null default false,
  add column if not exists feat_skill_pay boolean not null default false,
  add column if not exists feat_seniority_pay boolean not null default false,
  add column if not exists feat_social_security boolean not null default false,
  add column if not exists feat_withholding_tax boolean not null default false,
  add column if not exists feat_pay_cycle boolean not null default false,
  add column if not exists feat_my_payslip boolean not null default false,
  add column if not exists feat_payroll_notifications boolean not null default false,
  -- รอบเงินเดือน: เริ่มวันที่ N ของเดือน (24 → 24 ต.ค.–23 พ.ย.); วันจ่าย 0 = วันสุดท้ายของเดือน
  add column if not exists pay_cycle_start_day smallint not null default 1,
  add column if not exists pay_day smallint not null default 0,
  -- ขั้นต่าง ๆ เป็น jsonb ให้ร้านแก้เองได้ (ค่าเริ่มต้นตามตัวอย่างที่ผู้ใช้ให้มา)
  add column if not exists skill_tiers jsonb not null
    default '[{"count":1,"amount":500},{"count":2,"amount":1000},{"count":3,"amount":1500}]'::jsonb,
  add column if not exists seniority_tiers jsonb not null
    default '[{"months":6,"amount":300},{"months":12,"amount":600},{"months":24,"amount":900},{"months":36,"amount":1200}]'::jsonb,
  add column if not exists sales_bonus_tiers jsonb not null
    default '[{"minSales":30000,"amount":100},{"minSales":35000,"amount":150},{"minSales":40000,"amount":250}]'::jsonb,
  add column if not exists sales_bonus_channels text[] not null default array['pos','qr','delivery'],
  -- null = มาสายไม่มีผลกับโบนัส; N = สายเกิน N นาที ไม่ได้โบนัสวันนั้น (R2)
  add column if not exists sales_bonus_late_max_minutes smallint,
  add column if not exists sales_record_bonus numeric(12,2) not null default 500,
  add column if not exists sales_record_mode text not null default 'replace',
  -- ยอดสถิติเริ่มต้นที่ร้านตั้ง (กันช่วงแรกทำสถิติทุกวัน)
  add column if not exists sales_record_baseline numeric(14,2) not null default 0,
  -- ประกันสังคม: อัตรา % + ฐานต่ำสุด/สูงสุด (ร้านต้องตรวจประกาศล่าสุดเอง)
  add column if not exists sso_rate numeric(5,2) not null default 5,
  add column if not exists sso_wage_floor numeric(12,2) not null default 1650,
  add column if not exists sso_wage_ceiling numeric(12,2) not null default 17500,
  add column if not exists wht_mode text not null default 'manual',
  -- วันที่เปิดรอบเงินเดือน: cron ปิดอัตโนมัติเฉพาะงวดที่จบตั้งแต่วันนี้ (ไม่ย้อนปิดงวดเก่าก่อนเปิดใช้)
  add column if not exists pay_cycle_enabled_at date;

alter table store_hr_settings drop constraint if exists store_hr_settings_advanced_payroll_check;
alter table store_hr_settings add constraint store_hr_settings_advanced_payroll_check
  check (
    pay_cycle_start_day between 1 and 28
    and pay_day between 0 and 31
    and jsonb_typeof(skill_tiers) = 'array'
    and jsonb_typeof(seniority_tiers) = 'array'
    and jsonb_typeof(sales_bonus_tiers) = 'array'
    and sales_bonus_channels <@ array['pos','qr','delivery']
    and (sales_bonus_late_max_minutes is null or sales_bonus_late_max_minutes between 0 and 600)
    and sales_record_bonus >= 0
    and sales_record_mode in ('replace','stack')
    and sales_record_baseline >= 0
    and sso_rate between 0 and 20
    and sso_wage_floor >= 0
    and sso_wage_ceiling >= sso_wage_floor
    and wht_mode in ('manual','percent')
  );

-- ---------------------------------------------------------------------------
-- 2) ข้อมูลรายคน
-- ---------------------------------------------------------------------------
alter table employee_profiles
  add column if not exists sso_enabled boolean not null default true,
  add column if not exists withholding_tax_rate numeric(5,2) not null default 0;

alter table employee_profiles drop constraint if exists employee_profiles_wht_rate_check;
alter table employee_profiles add constraint employee_profiles_wht_rate_check
  check (withholding_tax_rate between 0 and 35);

-- ภาษีโหมดกรอกเอง = รายการปรับประเภทใหม่
alter table payroll_adjustments drop constraint if exists payroll_adjustments_type_check;
alter table payroll_adjustments add constraint payroll_adjustments_type_check
  check (type in ('penalty','bonus','leave','absent','late','withholding_tax'));

-- ---------------------------------------------------------------------------
-- 3) ประวัติเรทเงินเดือน (R13, R29) — คิดตามวันที่มีผล
-- ---------------------------------------------------------------------------
create table if not exists employee_pay_rates (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  user_id         uuid not null,
  pay_type        text not null check (pay_type in ('monthly','daily','hourly')),
  monthly_salary  numeric(12,2) not null default 0 check (monthly_salary >= 0),
  daily_rate      numeric(12,2) not null default 0 check (daily_rate >= 0),
  hourly_rate     numeric(12,2) not null default 0 check (hourly_rate >= 0),
  effective_from  date not null,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (store_id, user_id, effective_from)
);
create index if not exists employee_pay_rates_store_user_idx on employee_pay_rates(store_id, user_id, effective_from);

-- ---------------------------------------------------------------------------
-- 4) ทักษะ (R11, R12 แยกต่อสาขา)
-- ---------------------------------------------------------------------------
create table if not exists store_skills (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  name            text not null check (length(name) between 1 and 60),
  sort_order      int not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists store_skills_store_idx on store_skills(store_id);

create table if not exists employee_skills (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  user_id         uuid not null,
  skill_id        uuid not null references store_skills(id) on delete cascade,
  granted_at      date not null,
  revoked_at      date,
  granted_by      uuid,
  created_at      timestamptz not null default now(),
  check (revoked_at is null or revoked_at >= granted_at)
);
create index if not exists employee_skills_store_user_idx on employee_skills(store_id, user_id);
-- ทักษะเดียวกันถือได้ครั้งละ 1 แถวที่ยังไม่ถอน
create unique index if not exists employee_skills_active_uidx
  on employee_skills(store_id, user_id, skill_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 5) งวดเงินเดือน + สลิปถาวร (R16, R22–R24)
-- ---------------------------------------------------------------------------
create table if not exists payroll_periods (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  period_start    date not null,
  period_end      date not null,
  pay_date        date not null,
  status          text not null default 'closed' check (status in ('closed','reopened')),
  revision        int not null default 1,
  closed_at       timestamptz,
  closed_by       uuid,            -- null = ระบบปิดอัตโนมัติ
  reopened_at     timestamptz,
  reopened_by     uuid,
  total_net_pay   numeric(14,2) not null default 0,
  employee_count  int not null default 0,
  created_at      timestamptz not null default now(),
  unique (store_id, period_start),
  check (period_end >= period_start)
);

create table if not exists payslips (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  period_id       uuid not null references payroll_periods(id) on delete cascade,
  user_id         uuid not null,
  revision        int not null default 1,
  doc_no          text not null,
  net_pay         numeric(14,2) not null,
  data            jsonb not null,
  visible_from    date not null,
  superseded_at   timestamptz,
  created_at      timestamptz not null default now(),
  unique (period_id, user_id, revision)
);
create index if not exists payslips_user_idx on payslips(user_id, store_id);
create index if not exists payslips_period_idx on payslips(period_id);

-- กันแจ้งเตือนซ้ำ (R31): หนึ่งเหตุการณ์ต่อ key
create table if not exists payroll_notification_log (
  store_id   uuid not null references stores(id) on delete cascade,
  kind       text not null,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  primary key (store_id, kind, dedupe_key)
);

-- ---------------------------------------------------------------------------
-- 6) RLS
-- ---------------------------------------------------------------------------
alter table employee_pay_rates enable row level security;
alter table store_skills enable row level security;
alter table employee_skills enable row level security;
alter table payroll_periods enable row level security;
alter table payslips enable row level security;
alter table payroll_notification_log enable row level security;

drop policy if exists "employee_pay_rates: own or attendance manager read" on employee_pay_rates;
create policy "employee_pay_rates: own or attendance manager read" on employee_pay_rates for select
  using (user_id = auth.uid() or auth_user_has_permission(organization_id, store_id, 'attendance.manage'));
drop policy if exists "employee_pay_rates: attendance manager write" on employee_pay_rates;
create policy "employee_pay_rates: attendance manager write" on employee_pay_rates for all
  using (auth_user_has_permission(organization_id, store_id, 'attendance.manage'))
  with check (auth_user_has_permission(organization_id, store_id, 'attendance.manage'));

-- รายการทักษะของร้าน: ทุกคนในสาขาเห็น (ให้รู้ทางเพิ่มรายได้) แก้ได้เฉพาะผู้จัดการ
drop policy if exists "store_skills: store member read" on store_skills;
create policy "store_skills: store member read" on store_skills for select
  using (store_id in (select auth_user_store_ids()));
drop policy if exists "store_skills: attendance manager write" on store_skills;
create policy "store_skills: attendance manager write" on store_skills for all
  using (auth_user_has_permission(organization_id, store_id, 'attendance.manage'))
  with check (auth_user_has_permission(organization_id, store_id, 'attendance.manage'));

drop policy if exists "employee_skills: own or attendance manager read" on employee_skills;
create policy "employee_skills: own or attendance manager read" on employee_skills for select
  using (user_id = auth.uid() or auth_user_has_permission(organization_id, store_id, 'attendance.manage'));
drop policy if exists "employee_skills: attendance manager write" on employee_skills;
create policy "employee_skills: attendance manager write" on employee_skills for all
  using (auth_user_has_permission(organization_id, store_id, 'attendance.manage'))
  with check (auth_user_has_permission(organization_id, store_id, 'attendance.manage'));

-- งวด: ผู้จัดการอ่าน; เขียนผ่าน service role (ปิดงวด/เปิดงวดใหม่ทำใน server action ที่เช็กสิทธิ์แล้ว)
drop policy if exists "payroll_periods: attendance manager read" on payroll_periods;
create policy "payroll_periods: attendance manager read" on payroll_periods for select
  using (auth_user_has_permission(organization_id, store_id, 'attendance.manage'));

-- สลิป: ผู้จัดการอ่านทุกฉบับ; พนักงานอ่านฉบับปัจจุบันของตัวเอง เมื่อถึงวันจ่าย (เวลาสาขา)
-- และยังไม่พ้นวันออกงาน (R17, R23, R27)
drop policy if exists "payslips: attendance manager read" on payslips;
create policy "payslips: attendance manager read" on payslips for select
  using (auth_user_has_permission(organization_id, store_id, 'attendance.manage'));
drop policy if exists "payslips: own visible current read" on payslips;
create policy "payslips: own visible current read" on payslips for select
  using (
    user_id = auth.uid()
    and superseded_at is null
    and visible_from <= (now() at time zone coalesce((select s.timezone from stores s where s.id = payslips.store_id), 'Asia/Bangkok'))::date
    and not exists (
      select 1 from employee_profiles p
       where p.store_id = payslips.store_id
         and p.user_id = payslips.user_id
         and p.employment_end_date is not null
         and p.employment_end_date < (now() at time zone coalesce((select s.timezone from stores s where s.id = payslips.store_id), 'Asia/Bangkok'))::date
    )
  );
-- payroll_notification_log: service role เท่านั้น (ไม่มี policy)

-- ---------------------------------------------------------------------------
-- 7) ยอดขายรายวันตามเวลาปิดร้าน (R4, R5) — aggregate ใน DB ไม่ดึงออเดอร์ทุกแถว (egress)
--    ช่องทาง: qr = qr_order_source, delivery = เลขบิล JDC-, pos = ที่เหลือ
--    ปิดก่อนเที่ยง (เช่น 02:00) = ยอดหลังเที่ยงคืนนับเป็นของเมื่อวาน; ไม่ตั้ง/ปิดหลังเที่ยง = ตัด 00:00
-- ---------------------------------------------------------------------------
create or replace function public.payroll_business_day_offset(p_store_id uuid)
returns interval
language sql
stable
security definer
set search_path = public
as $$
  select case
    when s.closing_time is not null and s.closing_time < time '12:00' then s.closing_time - time '00:00'
    else interval '0'
  end
  from stores s where s.id = p_store_id;
$$;

create or replace function public.payroll_store_daily_sales(
  p_store_id uuid,
  p_from date,
  p_to date,
  p_channels text[]
)
returns table (business_date date, total numeric)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select coalesce(s.timezone, 'Asia/Bangkok') as tz,
           coalesce(public.payroll_business_day_offset(s.id), interval '0') as off
      from stores s where s.id = p_store_id
  )
  select ((o.paid_at at time zone cfg.tz) - cfg.off)::date as business_date,
         round(sum(o.total), 2) as total
    from orders o, cfg
   where o.store_id = p_store_id
     and o.status = 'paid'
     and o.paid_at >= ((p_from::timestamp + cfg.off) at time zone cfg.tz)
     and o.paid_at <  (((p_to + 1)::timestamp + cfg.off) at time zone cfg.tz)
     and (case
            when o.qr_order_source then 'qr'
            when o.order_number like 'JDC-%' then 'delivery'
            else 'pos'
          end) = any(p_channels)
   group by 1
   order by 1;
$$;

-- ยอดสูงสุดต่อวันก่อนวันที่กำหนด (ใช้ตัดสิน "ทำสถิติ" — R6)
create or replace function public.payroll_store_max_daily_sales_before(
  p_store_id uuid,
  p_before date,
  p_channels text[]
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select coalesce(s.timezone, 'Asia/Bangkok') as tz,
           coalesce(public.payroll_business_day_offset(s.id), interval '0') as off
      from stores s where s.id = p_store_id
  ), days as (
    select ((o.paid_at at time zone cfg.tz) - cfg.off)::date as d, sum(o.total) as t
      from orders o, cfg
     where o.store_id = p_store_id
       and o.status = 'paid'
       and o.paid_at < ((p_before::timestamp + cfg.off) at time zone cfg.tz)
       and (case
              when o.qr_order_source then 'qr'
              when o.order_number like 'JDC-%' then 'delivery'
              else 'pos'
            end) = any(p_channels)
     group by 1
  )
  select coalesce(round(max(t), 2), 0) from days;
$$;

revoke all on function public.payroll_business_day_offset(uuid) from public, anon, authenticated;
revoke all on function public.payroll_store_daily_sales(uuid, date, date, text[]) from public, anon, authenticated;
revoke all on function public.payroll_store_max_daily_sales_before(uuid, date, text[]) from public, anon, authenticated;
grant execute on function public.payroll_business_day_offset(uuid) to service_role;
grant execute on function public.payroll_store_daily_sales(uuid, date, date, text[]) to service_role;
grant execute on function public.payroll_store_max_daily_sales_before(uuid, date, text[]) to service_role;

-- ยอดขายต่อวัน/ยอดสถิติ query ตาม store + paid_at ของบิลที่จ่ายแล้ว — index บางส่วนเฉพาะ paid
-- (สร้างครั้งเดียว ล็อกการเขียน orders สั้น ๆ ระหว่างสร้าง)
create index if not exists orders_store_paid_at_paid_idx on orders(store_id, paid_at) where status = 'paid';

-- ---------------------------------------------------------------------------
-- 7.1) ปิดงวด = ธุรกรรมเดียว (R22, R24): ล็อกต่อสาขา+งวด กัน cron/คนกดซ้อนกัน
--      ปิดแล้ว → ไม่ทำซ้ำ; เปิดแก้แล้วปิดใหม่ → revision+1, ฉบับเก่าถูกแทนแต่เก็บไว้
--      ขั้นใดล้ม = ย้อนทั้งหมด (ไม่มีงวด "ปิดแล้วแต่สลิปหาย")
-- ---------------------------------------------------------------------------
create or replace function public.close_payroll_period_snapshot(
  p_organization_id uuid,
  p_store_id uuid,
  p_period_start date,
  p_period_end date,
  p_pay_date date,
  p_closed_by uuid,
  p_slips jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing payroll_periods%rowtype;
  v_found boolean;
  v_revision int;
  v_period_id uuid;
  v_total numeric;
  v_count int;
  v_ym text := to_char(p_period_end, 'YYYYMM');
begin
  perform pg_advisory_xact_lock(hashtext('payroll_close:' || p_store_id::text || ':' || p_period_start::text));

  select * into v_existing from payroll_periods
   where store_id = p_store_id and period_start = p_period_start
   for update;
  v_found := found;
  if v_found and v_existing.status = 'closed' then
    return jsonb_build_object('status', 'already_closed', 'period_id', v_existing.id, 'revision', v_existing.revision);
  end if;
  v_revision := case when v_found then v_existing.revision + 1 else 1 end;

  select coalesce(round(sum((s->>'net_pay')::numeric), 2), 0), count(*)
    into v_total, v_count
    from jsonb_array_elements(coalesce(p_slips, '[]'::jsonb)) s;

  insert into payroll_periods (
    organization_id, store_id, period_start, period_end, pay_date, status, revision,
    closed_at, closed_by, total_net_pay, employee_count
  ) values (
    p_organization_id, p_store_id, p_period_start, p_period_end, p_pay_date, 'closed', v_revision,
    now(), p_closed_by, v_total, v_count
  )
  on conflict (store_id, period_start) do update
    set period_end = excluded.period_end,
        pay_date = excluded.pay_date,
        status = 'closed',
        revision = excluded.revision,
        closed_at = excluded.closed_at,
        closed_by = excluded.closed_by,
        total_net_pay = excluded.total_net_pay,
        employee_count = excluded.employee_count
  returning id into v_period_id;

  update payslips set superseded_at = now()
   where period_id = v_period_id and superseded_at is null;

  insert into payslips (organization_id, store_id, period_id, user_id, revision, doc_no, net_pay, data, visible_from)
  select p_organization_id, p_store_id, v_period_id, (s->>'user_id')::uuid, v_revision,
         'PS-' || v_ym || '-' || upper(substr(replace(s->>'user_id', '-', ''), 1, 8))
           || case when v_revision > 1 then '-R' || v_revision else '' end,
         (s->>'net_pay')::numeric, s->'data', p_pay_date
    from jsonb_array_elements(coalesce(p_slips, '[]'::jsonb)) s;

  return jsonb_build_object('status', 'closed', 'period_id', v_period_id, 'revision', v_revision,
                            'total', v_total, 'count', v_count);
end;
$$;

revoke all on function public.close_payroll_period_snapshot(uuid, uuid, date, date, date, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.close_payroll_period_snapshot(uuid, uuid, date, date, date, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 8) pg_cron ทุก 30 นาที → /api/hr/cron/payroll (ปิดงวด, เปิดสลิปวันจ่าย, แจ้งเตือน)
--    ยิงเฉพาะเมื่อมีสาขาที่เปิดรอบเงินเดือนหรือแจ้งเตือนเงินเดือน — ไม่มีใครเปิด = ไม่เรียก Vercel เลย
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'payroll_cron_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'payroll_cron_key',
      'pg_cron -> /api/hr/cron/payroll'
    );
  end if;
end $$;

create or replace function public.verify_payroll_cron_key(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'payroll_cron_key' and decrypted_secret = p_key
  );
$$;
revoke all on function public.verify_payroll_cron_key(text) from public, anon, authenticated;
grant execute on function public.verify_payroll_cron_key(text) to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'advanced-payroll') then
    perform cron.unschedule('advanced-payroll');
  end if;
end $$;

select cron.schedule(
  'advanced-payroll',
  '*/30 * * * *',
  $job$
  select net.http_post(
    url := 'https://www.store-os.online/api/hr/cron/payroll',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-payroll-cron-key',
      (select decrypted_secret from vault.decrypted_secrets where name = 'payroll_cron_key' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (
    select 1 from public.store_hr_settings
     where feat_pay_cycle or feat_payroll_notifications or feat_sales_bonus
  );
  $job$
);
