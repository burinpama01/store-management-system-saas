-- ============================================================
-- สรุปยอดขายรายวัน — อีเมลถึงเจ้าของร้าน + แจ้งเตือน LINE/Telegram ตอนพนักงานออกงาน
--
-- ทำไม: เจ้าของร้านที่ไม่ได้อยู่หน้าร้านไม่มีทางรู้ยอดของวันเลย ต้องเปิดแอปเองทุกครั้ง
-- ไฟล์นี้ทำ 3 อย่าง
--   1) ตารางกันส่งอีเมลซ้ำ — หนึ่งองค์กร หนึ่งวัน ส่งได้ครั้งเดียว (cron รันซ้ำก็ปลอดภัย)
--   2) สวิตช์ปิดอีเมลสรุประดับร้าน (default เปิด เพราะเป็นข้อมูลที่เจ้าของอยากรู้อยู่แล้ว
--      และรายชื่อผู้รับถูกจำกัดที่ "เจ้าขององค์กร" เท่านั้น)
--   3) เปิดชนิดแจ้งเตือนใหม่ 'daily_summary' ให้ร้านเปิด/ปิดเองได้ใน Notification Matrix
-- ============================================================

-- ------------------------------------------------------------
-- 1) กันอีเมลสรุปซ้ำ
-- ------------------------------------------------------------
create table if not exists public.daily_summary_email_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- วันของยอดที่สรุป (ตามเวลาไทย) ไม่ใช่วันที่ส่ง — ส่งซ้ำวันเดิมจะชน unique index
  summary_date    date not null,
  store_count     integer not null default 0,
  order_count     integer not null default 0,
  revenue         numeric(12, 2) not null default 0,
  created_at      timestamptz not null default now()
);

create unique index if not exists daily_summary_email_log_once_idx
  on public.daily_summary_email_log (organization_id, summary_date);

create index if not exists daily_summary_email_log_day_idx
  on public.daily_summary_email_log (summary_date desc);

alter table public.daily_summary_email_log enable row level security;
-- ตั้งใจไม่มี policy: เขียนโดย cron ผ่าน service role เท่านั้น
revoke all on public.daily_summary_email_log from anon, authenticated;

comment on table public.daily_summary_email_log is
  'กันส่งอีเมลสรุปรายวันซ้ำ — หนึ่งองค์กร หนึ่งวัน (เขียนโดย cron เท่านั้น)';

-- ------------------------------------------------------------
-- 1.1) กันแจ้งเตือนซ้ำตอนคนสุดท้ายออกงาน
-- ------------------------------------------------------------
create table if not exists public.daily_summary_notification_log (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  store_id             uuid not null references public.stores (id) on delete cascade,
  summary_date         date not null,
  attendance_record_id uuid not null,
  delivery_status      text not null default 'claimed'
    check (delivery_status in ('claimed', 'sent', 'failed')),
  created_at           timestamptz not null default now(),
  completed_at         timestamptz
);

create unique index if not exists daily_summary_notification_log_once_idx
  on public.daily_summary_notification_log (organization_id, store_id, summary_date);

create index if not exists daily_summary_notification_log_day_idx
  on public.daily_summary_notification_log (summary_date desc);

alter table public.daily_summary_notification_log enable row level security;
-- ตั้งใจไม่มี policy: เส้นทาง after() ใช้ service role และผลลัพธ์ไม่ถูกส่งคืนให้พนักงาน
revoke all on public.daily_summary_notification_log from anon, authenticated;

comment on table public.daily_summary_notification_log is
  'กันสรุปยอดซ้ำเมื่อคำขอออกงานหลายรายการแข่งกัน — หนึ่งร้าน หนึ่งวัน พร้อมสถานะ delivery สำหรับ audit';

-- ------------------------------------------------------------
-- 2) สวิตช์ปิดอีเมลสรุประดับร้าน
-- ------------------------------------------------------------
alter table public.stores
  add column if not exists daily_summary_email_enabled boolean not null default true;

comment on column public.stores.daily_summary_email_enabled is
  'ให้ร้านนี้เข้าไปอยู่ในอีเมลสรุปยอดรายวันที่ส่งถึงเจ้าขององค์กรหรือไม่ (ร้านที่ไม่มีออเดอร์ของวันนั้นจะถูกข้ามอยู่แล้ว)';

-- ------------------------------------------------------------
-- 3) ชนิดแจ้งเตือนใหม่ 'daily_summary'
-- ------------------------------------------------------------
alter table public.notification_settings
  drop constraint if exists notification_settings_notification_type_check;

alter table public.notification_settings
  add constraint notification_settings_notification_type_check check (
    notification_type in (
      'payment',
      'new_table',
      'new_pos_order',
      'new_qr_order',
      'new_buffet_order',
      'kitchen_order',
      'buffet_expiring',
      'stock_alert',
      'order_cancelled',
      'approval',
      'service_request',
      'attendance_clock_in',
      'attendance_clock_out',
      'test',
      'activation_nudge',
      'subscription_expiring',
      'daily_summary'
    )
  );

-- constraint ของ template ยังค้างอยู่ที่ชุดเดิมตั้งแต่ 2026-07-07 — ชนิดที่เพิ่มมาทีหลัง
-- (activation_nudge / subscription_expiring) จึงบันทึก template ไม่ได้เลย ตามเก็บให้ตรงกันที่นี่
alter table public.notification_templates
  drop constraint if exists notification_templates_notification_type_check;

alter table public.notification_templates
  add constraint notification_templates_notification_type_check check (
    notification_type in (
      'payment',
      'new_table',
      'new_pos_order',
      'new_qr_order',
      'new_buffet_order',
      'kitchen_order',
      'buffet_expiring',
      'stock_alert',
      'order_cancelled',
      'approval',
      'service_request',
      'attendance_clock_in',
      'attendance_clock_out',
      'test',
      'activation_nudge',
      'subscription_expiring',
      'daily_summary'
    )
  );
