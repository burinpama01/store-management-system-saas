-- ============================================================
-- เวลาปิดร้าน + ส่งสรุปยอดสำรองเมื่อคนสุดท้ายไม่ได้กดออกงาน
--
-- ที่มา (2026-10-04): สรุปยอดเข้า LINE/Telegram ส่งตอน "คนสุดท้ายของสาขากดออกงาน" เท่านั้น
-- พนักงานลืมกดออก (each other II วันอาทิตย์ 20 ก.ย. และ 4 ต.ค.) = เจ้าของไม่ได้สรุปเลย
--
-- ทำอะไร
--   1) stores.closing_time — เวลาปิดร้านรายสาขา (null = ไม่ใช้ระบบนี้ พฤติกรรมเดิมทุกอย่าง)
--   2) closing_summary_due_stores() — สาขาที่เลยเวลาปิด 1 ชม. แล้วยังไม่มีสรุปของวันนั้น
--      ทั้ง pg_cron และ API ใช้ฟังก์ชันนี้ตัวเดียว ตัดสินตรงกันเสมอ
--   3) pg_cron ทุก 30 นาที: เช็คในฐานข้อมูลก่อน เรียก API เฉพาะเมื่อมีสาขาที่ถึงเวลา
--      (ไม่มีสาขาถึงเวลา = ไม่มี request ไป Vercel เลย)
--   4) กุญแจเรียก API เก็บใน Vault — สร้างในฐานข้อมูล ไม่ต้องตั้ง env ที่ Vercel
--
-- ไม่แตะข้อมูลกะ (ผู้ใช้สั่ง): ส่งสรุป + ชื่อคนที่ยังไม่กดออกงานเท่านั้น
-- ============================================================

-- 1) เวลาปิดร้าน -------------------------------------------------
alter table public.stores
  add column if not exists closing_time time;

comment on column public.stores.closing_time is
  'เวลาปิดร้าน (เวลาท้องถิ่นของสาขา) — เลยไป 1 ชม. แล้วยังไม่มีสรุปยอดของวัน ระบบส่งให้เอง; ก่อน 05:00 = ปิดหลังเที่ยงคืนของวันถัดไป';

-- 2) ตารางกันส่งซ้ำ: รองรับการส่งจากเวลาปิดร้าน -------------------
-- ส่งจากเวลาปิดร้านไม่มีแถวออกงานให้อ้างอิง
alter table public.daily_summary_notification_log
  alter column attendance_record_id drop not null;

alter table public.daily_summary_notification_log
  add column if not exists trigger_source text not null default 'clock_out';

alter table public.daily_summary_notification_log
  drop constraint if exists daily_summary_notification_log_trigger_source_check;
alter table public.daily_summary_notification_log
  add constraint daily_summary_notification_log_trigger_source_check
  check (trigger_source in ('clock_out', 'closing_time'));

-- skipped = ถึงเวลาปิดแล้วแต่ไม่มีบิลของวันนั้น (จองไว้กัน pg_cron เรียกซ้ำทุก 30 นาที)
alter table public.daily_summary_notification_log
  drop constraint if exists daily_summary_notification_log_delivery_status_check;
alter table public.daily_summary_notification_log
  add constraint daily_summary_notification_log_delivery_status_check
  check (delivery_status in ('claimed', 'sent', 'failed', 'skipped'));

-- 3) สาขาที่ถึงเวลาส่งสรุปจากเวลาปิดร้าน ---------------------------
-- ดูทั้ง "วันนี้" และ "เมื่อวาน" ตามเวลาสาขา เพราะร้านที่ปิดหลังเที่ยงคืนถึงกำหนดในวันถัดไป
-- หน้าต่าง 12 ชม. กันไม่ให้ไล่ส่งย้อนหลังของวันเก่า (เช่น วันแรกที่ตั้งเวลาปิด)
create or replace function public.closing_summary_due_stores(p_now timestamptz default now())
returns table (
  organization_id uuid,
  store_id uuid,
  store_name text,
  summary_date date,
  timezone text,
  closing_time time
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.organization_id, s.id, s.name, d.day, s.timezone, s.closing_time
  from public.stores s
  cross join lateral (
    values ((p_now at time zone s.timezone)::date),
           ((p_now at time zone s.timezone)::date - 1)
  ) as d(day)
  cross join lateral (
    select (
      (d.day + s.closing_time
        + case when s.closing_time < time '05:00' then interval '1 day' else interval '0' end
        + interval '1 hour'
      ) at time zone s.timezone
    ) as due_at
  ) as x
  where s.closing_time is not null
    and s.timezone is not null -- timezone ว่างแถวเดียวต้องไม่ทำให้ทั้งรอบ error
    and s.is_active
    and p_now >= x.due_at
    and p_now < x.due_at + interval '12 hours'
    and not exists (
      select 1
      from public.daily_summary_notification_log l
      where l.organization_id = s.organization_id
        and l.store_id = s.id
        and l.summary_date = d.day
    );
$$;

revoke all on function public.closing_summary_due_stores(timestamptz) from public, anon, authenticated;
grant execute on function public.closing_summary_due_stores(timestamptz) to service_role;

-- 4) กุญแจเรียก API (Vault) ---------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'closing_summary_cron_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'closing_summary_cron_key',
      'pg_cron -> /api/attendance/cron/closing-summary'
    );
  end if;
end $$;

-- API ตรวจกุญแจด้วยฟังก์ชันนี้ — ค่าจริงไม่เคยออกจากฐานข้อมูลไปที่ Vercel
create or replace function public.verify_closing_summary_cron_key(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'closing_summary_cron_key' and decrypted_secret = p_key
  ), false);
$$;

revoke all on function public.verify_closing_summary_cron_key(text) from public, anon, authenticated;
grant execute on function public.verify_closing_summary_cron_key(text) to service_role;

-- 5) pg_cron ทุก 30 นาที -----------------------------------------
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'closing-summary') then
    perform cron.unschedule('closing-summary');
  end if;
end $$;

select cron.schedule(
  'closing-summary',
  '*/30 * * * *',
  $job$
  select net.http_post(
    url := 'https://www.store-os.online/api/attendance/cron/closing-summary',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-closing-summary-key',
      (select decrypted_secret from vault.decrypted_secrets where name = 'closing_summary_cron_key' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (select 1 from public.closing_summary_due_stores());
  $job$
);
