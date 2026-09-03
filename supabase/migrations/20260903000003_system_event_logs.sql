-- ============================================================
-- บันทึกการทำงานของระบบ (system event logs) สำหรับหน้าซูเปอร์แอดมิน
--
-- ทำไม: เวลาเกิดปัญหาหน้างาน ตอนนี้ไม่มีที่ให้ดูเลยว่าพังตรงไหน มีแต่ console.error
-- กระจายอยู่ 16 จุดซึ่งหายไปกับ log ของ Vercel และไม่มีใครย้อนดูได้
--
-- ออกแบบตามที่เจ้าของระบบสั่ง:
--   • ดู "วันต่อวัน" และย้อนหลังได้        → คอลัมน์ occurred_on (วันตามเวลาไทย) + index
--   • อ่านง่ายที่สุดสำหรับคน               → level/source/action/message แยกฟิลด์ ไม่ใช่ข้อความก้อนเดียว
--   • ให้ AI อ่านแล้วรู้ทันทีว่าผิดตรงไหน  → context jsonb แบบมีโครงสร้าง + fingerprint ไว้จัดกลุ่ม
--
-- ความปลอดภัย: ไม่มี RLS policy = อ่าน/เขียนได้เฉพาะ service role (หน้าซูเปอร์แอดมินเท่านั้น)
-- ห้ามเก็บความลับ — ชั้นแอป (modules/system/event-log.ts) ตัดคีย์อ่อนไหวออกก่อนเสมอ
-- ============================================================

create table if not exists public.system_event_logs (
  id              uuid primary key default gen_random_uuid(),
  occurred_at     timestamptz not null default now(),
  -- วันตามเวลาไทย เพื่อให้ "วันต่อวัน" ตรงกับวันทำการของร้าน (ไม่ใช่ UTC)
  occurred_on     date not null generated always as (((occurred_at at time zone 'Asia/Bangkok'))::date) stored,
  level           text not null check (level in ('error', 'warn', 'info')),
  -- ส่วนของระบบที่เกิดเหตุ เช่น 'pos.payment', 'qr-order.submit', 'loyalty.claim'
  source          text not null,
  -- ชื่อการทำงานที่ชัดเจน เช่น 'collectPaymentAction'
  action          text not null,
  -- ข้อความสั้นภาษาคน (ห้ามยัด stack ทั้งก้อน)
  message         text not null,
  -- รหัสข้อผิดพลาดจากฐานข้อมูล/แอป เช่น '23505', 'permission_denied'
  error_code      text,
  organization_id uuid,
  store_id        uuid,
  actor_user_id   uuid,
  request_id      text,
  duration_ms     integer,
  -- รายละเอียดแบบมีโครงสร้างสำหรับ AI/คนอ่าน (ผ่านการตัดข้อมูลอ่อนไหวแล้ว)
  context         jsonb,
  -- ลายนิ้วมือของ "ปัญหาเดียวกัน" ไว้จัดกลุ่มนับซ้ำ
  fingerprint     text not null,
  created_at      timestamptz not null default now()
);

create index if not exists system_event_logs_day_level_idx
  on public.system_event_logs (occurred_on desc, level);

create index if not exists system_event_logs_fingerprint_idx
  on public.system_event_logs (occurred_on desc, fingerprint);

create index if not exists system_event_logs_store_idx
  on public.system_event_logs (store_id, occurred_on desc)
  where store_id is not null;

alter table public.system_event_logs enable row level security;
-- ตั้งใจไม่มี policy: ตารางนี้เข้าถึงได้ผ่าน service role เท่านั้น
revoke all on public.system_event_logs from anon, authenticated;

comment on table public.system_event_logs is
  'บันทึกการทำงาน/ข้อผิดพลาดของระบบ ดูที่ /system/logs (ซูเปอร์แอดมินเท่านั้น) — เก็บ 30 วัน';

-- ------------------------------------------------------------
-- ล้างของเก่าเกิน 30 วัน (เรียกเป็นครั้งคราวจากหน้าซูเปอร์แอดมิน/งานตามเวลา)
-- ------------------------------------------------------------
create or replace function public.purge_old_system_event_logs(p_keep_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.system_event_logs
   where occurred_at < now() - make_interval(days => greatest(1, p_keep_days));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_old_system_event_logs(integer) from public, anon, authenticated;

-- ------------------------------------------------------------
-- สรุปปัญหาของวันหนึ่ง — จัดกลุ่มด้วย fingerprint ให้เห็นทันทีว่าอะไรพังบ่อยสุด
-- (ทำใน SQL เพราะเร็วกว่าดึงทุกแถวมานับที่แอป และหน้าซูเปอร์แอดมินต้องเปิดไว)
-- ------------------------------------------------------------
create or replace function public.get_system_log_day_summary(p_day date)
returns table (
  fingerprint text,
  level text,
  source text,
  action text,
  error_code text,
  message text,
  occurrences bigint,
  first_at timestamptz,
  last_at timestamptz,
  store_count bigint,
  sample_context jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    l.fingerprint,
    min(l.level) as level,
    min(l.source) as source,
    min(l.action) as action,
    min(l.error_code) as error_code,
    min(l.message) as message,
    count(*) as occurrences,
    min(l.occurred_at) as first_at,
    max(l.occurred_at) as last_at,
    count(distinct l.store_id) as store_count,
    (array_agg(l.context order by l.occurred_at desc))[1] as sample_context
  from public.system_event_logs l
  where l.occurred_on = p_day
  group by l.fingerprint
  order by
    case min(l.level) when 'error' then 0 when 'warn' then 1 else 2 end,
    count(*) desc,
    max(l.occurred_at) desc;
$$;

revoke all on function public.get_system_log_day_summary(date) from public, anon, authenticated;
