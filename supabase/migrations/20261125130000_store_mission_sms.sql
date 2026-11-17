-- ภารกิจสะสม · M2 — SMS แจ้งลูกค้า (ผู้ใช้อนุมัติ 2026-11-17, เติมโควตา SMSKUB แล้ว)
--
-- 3 จังหวะ: ใกล้ครบ (เหลือ 1 ชิ้น) · ได้คูปองรางวัล · คูปองรางวัลใกล้หมดอายุ (3 วันก่อน)
-- ข้อกำหนด: แพลตฟอร์มออกค่า SMS ช่วงทดลอง และจำกัดจำนวนต่อร้านต่อเดือน
--
-- กติกา:
--   - ยินยอม: ติ๊กตอนกดรับภารกิจ (ค่าเริ่มต้นติ๊ก) · ยกเลิกรับได้จากหน้าสมาชิก (ต่อสาขา)
--   - เพดาน: ร้านละ stores.mission_sms_monthly_limit ข้อความ/เดือน (ค่าเริ่มต้น 200) · ลูกค้าละ 3 ข้อความ/สัปดาห์/สาขา
--   - ส่งเฉพาะ 09:00–20:00 เวลาไทย · ข้อความค้างเกิน 3 วันทิ้ง (expired)
--   - คิวอยู่ใน DB · pg_cron เรียก API เฉพาะเมื่อมีคิวรอ (ไม่เปลือง invocation ของ Vercel)
--   - ไม่ส่งในเส้นทางจ่ายเงิน (trigger แค่ใส่คิว)

alter table public.stores
  add column if not exists mission_sms_monthly_limit integer not null default 200
    check (mission_sms_monthly_limit between 0 and 100000);

alter table public.store_mission_enrollments
  add column if not exists sms_opt_in boolean not null default true;

alter table public.customers
  add column if not exists mission_sms_opt_out boolean not null default false;

create table if not exists public.store_mission_sms_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null check (kind in ('near', 'reward', 'expiring')),
  enrollment_id uuid references public.store_mission_enrollments(id) on delete cascade,
  redemption_id uuid references public.loyalty_reward_redemptions(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped', 'expired')),
  skip_reason text,
  message text,
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz
);

-- ข้อความแต่ละจังหวะส่งครั้งเดียวต่อรอบ/ต่อคูปอง
create unique index if not exists store_mission_sms_queue_near_uidx
  on public.store_mission_sms_queue (enrollment_id) where kind = 'near' and status in ('queued', 'sending', 'sent');
create unique index if not exists store_mission_sms_queue_redemption_uidx
  on public.store_mission_sms_queue (redemption_id, kind) where redemption_id is not null and status in ('queued', 'sending', 'sent');
create index if not exists store_mission_sms_queue_status_idx
  on public.store_mission_sms_queue (status, created_at) where status in ('queued', 'sending');
create index if not exists store_mission_sms_queue_store_sent_idx
  on public.store_mission_sms_queue (store_id, sent_at) where status = 'sent';
create index if not exists store_mission_sms_queue_customer_sent_idx
  on public.store_mission_sms_queue (customer_id, sent_at) where status = 'sent';

alter table public.store_mission_sms_queue enable row level security;
revoke all on table public.store_mission_sms_queue from anon, authenticated;
grant select on table public.store_mission_sms_queue to authenticated;
drop policy if exists "store_mission_sms_queue: store member can read" on public.store_mission_sms_queue;
create policy "store_mission_sms_queue: store member can read" on public.store_mission_sms_queue for select
  using (store_id in (select auth_user_store_ids()));

-- ---------------------------------------------------------------------------
-- ใส่คิว (ภายใน trigger) — ไม่ใส่ถ้าลูกค้าไม่ยินยอม/ไม่มีเบอร์ · ซ้ำ = เงียบ
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_store_mission_sms(
  p_kind text, p_enrollment_id uuid, p_redemption_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_e public.store_mission_enrollments%rowtype;
begin
  select * into v_e from public.store_mission_enrollments where id = p_enrollment_id;
  if v_e.id is null or not v_e.sms_opt_in then return; end if;
  if exists (select 1 from public.customers c where c.id = v_e.customer_id and (c.mission_sms_opt_out or c.phone is null)) then
    return;
  end if;
  insert into public.store_mission_sms_queue (organization_id, store_id, customer_id, kind, enrollment_id, redemption_id)
  values (v_e.organization_id, v_e.store_id, v_e.customer_id, p_kind, v_e.id, p_redemption_id)
  on conflict do nothing;
exception when others then
  -- SMS เป็นของแถม — ใส่คิวพลาดต้องไม่กระทบการนับ/การจ่ายบิล
  insert into public.system_event_logs (level, source, action, message, error_code, store_id, context)
  values ('error', 'missions.sms', 'enqueue', left('ใส่คิว SMS ภารกิจไม่สำเร็จ: ' || sqlerrm, 500), sqlstate,
          v_e.store_id, jsonb_build_object('kind', p_kind, 'enrollmentId', p_enrollment_id));
end;
$$;

-- ใกล้ครบ: progress เปลี่ยนจนเหลือ 1 ชิ้น · ได้คูปอง: reward_redemption_id ถูกใส่
create or replace function public.store_mission_enrollment_sms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' and new.progress > old.progress and new.target_count - new.progress = 1 and new.target_count > 1 then
    perform public.enqueue_store_mission_sms('near', new.id, null);
  end if;
  if new.reward_redemption_id is not null and old.reward_redemption_id is distinct from new.reward_redemption_id then
    perform public.enqueue_store_mission_sms('reward', new.id, new.reward_redemption_id);
  end if;
  return new;
end;
$$;

drop trigger if exists store_mission_enrollment_sms on public.store_mission_enrollments;
create trigger store_mission_enrollment_sms
  after update of progress, reward_redemption_id on public.store_mission_enrollments
  for each row execute function public.store_mission_enrollment_sms();

-- คูปองรางวัลใกล้หมดอายุ (เรียกจาก cron วันละครั้ง)
create or replace function public.enqueue_expiring_mission_reward_sms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select r.id, r.mission_enrollment_id
      from public.loyalty_reward_redemptions r
     where r.mission_enrollment_id is not null
       and r.status = 'pending' and r.used_at is null
       and r.expires_at between now() + interval '2 days' and now() + interval '3 days'
     limit 1000
  loop
    perform public.enqueue_store_mission_sms('expiring', v_row.mission_enrollment_id, v_row.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- จองคิวไปส่ง (API เรียกด้วย service role) — ตรวจเพดาน/ยินยอม/เวลา ตรงนี้ที่เดียว
-- คืนแถวที่ต้องส่ง พร้อมเบอร์ ชื่อร้าน slug และข้อมูลประกอบข้อความ
-- ---------------------------------------------------------------------------
create or replace function public.claim_store_mission_sms(p_limit integer default 50)
returns table (
  id uuid, kind text, phone text, store_name text, store_slug text,
  mission_name text, reward_name text, voucher_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_hour integer := extract(hour from now() at time zone 'Asia/Bangkok');
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok';
  v_q record;
  v_store_sent integer;
  v_customer_sent integer;
  v_reason text;
begin
  -- หมดอายุคิวเก่า + คืนแถวที่ค้าง sending เกิน 10 นาที (API ล้มกลางทาง)
  update public.store_mission_sms_queue set status = 'expired'
   where status = 'queued' and created_at < now() - interval '3 days';
  update public.store_mission_sms_queue set status = 'queued'
   where status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts < 3;
  update public.store_mission_sms_queue set status = 'failed', error = coalesce(error, 'ส่งไม่สำเร็จ 3 ครั้ง')
   where status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts >= 3;

  if v_hour < 9 or v_hour >= 20 then
    return; -- นอกเวลาส่ง: คิวรอรอบถัดไป
  end if;

  for v_q in
    select q.*, c.phone as c_phone, c.mission_sms_opt_out, e.sms_opt_in, s.name as s_name, s.slug as s_slug,
           s.mission_sms_monthly_limit, s.missions_enabled, m.name as m_name,
           r.status as r_status, r.used_at as r_used_at, r.expires_at as r_expires_at, lr.name as lr_name
      from public.store_mission_sms_queue q
      join public.customers c on c.id = q.customer_id
      join public.stores s on s.id = q.store_id
      left join public.store_mission_enrollments e on e.id = q.enrollment_id
      left join public.store_missions m on m.id = e.mission_id
      left join public.loyalty_reward_redemptions r on r.id = q.redemption_id
      left join public.loyalty_rewards lr on lr.id = r.reward_id
     where q.status = 'queued'
     order by q.created_at
     limit greatest(least(p_limit, 200), 1)
     for update of q skip locked
  loop
    v_reason := null;
    if not v_q.missions_enabled then v_reason := 'ร้านปิดภารกิจ';
    elsif v_q.c_phone is null then v_reason := 'ไม่มีเบอร์';
    elsif v_q.mission_sms_opt_out or v_q.sms_opt_in is false then v_reason := 'ลูกค้าไม่รับ SMS';
    elsif v_q.kind = 'near' and exists (
      select 1 from public.store_mission_enrollments e2 where e2.id = v_q.enrollment_id and (e2.status <> 'active' or e2.target_count - e2.progress <> 1)
    ) then v_reason := 'สถานะเปลี่ยนแล้ว';
    elsif v_q.kind in ('reward', 'expiring') and (v_q.r_status is distinct from 'pending' or v_q.r_used_at is not null) then
      v_reason := 'คูปองถูกใช้/ยกเลิกแล้ว';
    end if;

    if v_reason is null then
      select count(*) into v_store_sent from public.store_mission_sms_queue
       where store_id = v_q.store_id and status in ('sent', 'sending') and coalesce(sent_at, claimed_at) >= v_month_start;
      if v_store_sent >= v_q.mission_sms_monthly_limit then v_reason := 'เกินโควตา SMS ของร้านเดือนนี้'; end if;
    end if;
    if v_reason is null then
      select count(*) into v_customer_sent from public.store_mission_sms_queue
       where customer_id = v_q.customer_id and status in ('sent', 'sending') and coalesce(sent_at, claimed_at) >= now() - interval '7 days';
      if v_customer_sent >= 3 then v_reason := 'ครบ 3 ข้อความ/สัปดาห์'; end if;
    end if;

    if v_reason is not null then
      update public.store_mission_sms_queue set status = 'skipped', skip_reason = v_reason where store_mission_sms_queue.id = v_q.id;
      continue;
    end if;

    update public.store_mission_sms_queue
       set status = 'sending', claimed_at = now(), attempts = attempts + 1
     where store_mission_sms_queue.id = v_q.id;
    id := v_q.id; kind := v_q.kind; phone := v_q.c_phone; store_name := v_q.s_name; store_slug := v_q.s_slug;
    mission_name := v_q.m_name; reward_name := v_q.lr_name; voucher_expires_at := v_q.r_expires_at;
    return next;
  end loop;
end;
$$;

create or replace function public.finish_store_mission_sms(p_id uuid, p_ok boolean, p_message text, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.store_mission_sms_queue
     set status = case when p_ok then 'sent' when attempts >= 3 then 'failed' else 'queued' end,
         sent_at = case when p_ok then now() else sent_at end,
         message = coalesce(p_message, message),
         error = case when p_ok then null else left(p_error, 500) end
   where id = p_id and status = 'sending';
$$;

-- ---------------------------------------------------------------------------
-- กุญแจ cron (Vault) — แบบเดียวกับสรุปเวลาปิดร้าน
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'mission_sms_cron_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'mission_sms_cron_key',
      'pg_cron -> /api/missions/cron/sms'
    );
  end if;
end $$;

create or replace function public.verify_mission_sms_cron_key(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'mission_sms_cron_key' and decrypted_secret = p_key
  ), false);
$$;

revoke all on function public.enqueue_store_mission_sms(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.store_mission_enrollment_sms() from public, anon, authenticated;
revoke all on function public.enqueue_expiring_mission_reward_sms() from public, anon, authenticated;
revoke all on function public.claim_store_mission_sms(integer) from public, anon, authenticated;
revoke all on function public.finish_store_mission_sms(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.verify_mission_sms_cron_key(text) from public, anon, authenticated;
grant execute on function public.claim_store_mission_sms(integer) to service_role;
grant execute on function public.finish_store_mission_sms(uuid, boolean, text, text) to service_role;
grant execute on function public.verify_mission_sms_cron_key(text) to service_role;
grant execute on function public.enqueue_expiring_mission_reward_sms() to service_role;

-- ---------------------------------------------------------------------------
-- cron: ทุก 10 นาทีช่วง 09–20 น. ไทย (02:00–12:59 UTC) ยิง API เฉพาะเมื่อมีคิวรอ
--       + วันละครั้ง 10:05 ไทย ใส่คิวคูปองใกล้หมดอายุ
-- ---------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'mission-sms-send') then
    perform cron.unschedule('mission-sms-send');
  end if;
  if exists (select 1 from cron.job where jobname = 'mission-sms-expiring') then
    perform cron.unschedule('mission-sms-expiring');
  end if;
end $$;

select cron.schedule(
  'mission-sms-send',
  '*/10 2-12 * * *',
  $job$
  select net.http_post(
    url := 'https://www.store-os.online/api/missions/cron/sms',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-mission-sms-key',
      (select decrypted_secret from vault.decrypted_secrets where name = 'mission_sms_cron_key' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (select 1 from public.store_mission_sms_queue where status = 'queued');
  $job$
);

select cron.schedule('mission-sms-expiring', '5 3 * * *', $job$ select public.enqueue_expiring_mission_reward_sms(); $job$);
