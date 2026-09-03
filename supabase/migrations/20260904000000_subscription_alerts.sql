-- ============================================================
-- แจ้งเตือนวงจรชีวิตแพ็กเกจของร้าน (สมัคร / ใกล้หมด / หมดอายุ / ชำระสำเร็จ)
--
-- ทำไม: ตรวจ prod 2026-09-03 พบ 8 ร้านหมดอายุไปแล้วโดยไม่มีใครรู้ — ไม่มีอะไร
-- ตรวจ current_period_end เลย สิทธิ์ตกเป็น free เงียบ ๆ ทั้งร้านและผู้ดูแลไม่ได้รับแจ้ง
--
-- ไฟล์นี้ทำ 2 อย่าง:
--   1. ตารางกันเตือนซ้ำ — หนึ่งองค์กร หนึ่งขั้น หนึ่งวัน ยิงได้ครั้งเดียว
--   2. เพิ่มชนิดแจ้งเตือน 'subscription_expiring' ให้ร้านเปิด/ปิดได้เองใน Notification Matrix
-- ============================================================

create table if not exists public.subscription_alert_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- ขั้นการเตือน: d7 / d3 / d1 / expired (ดู modules/billing/subscription-watch.ts)
  stage           text not null check (stage in ('d7', 'd3', 'd1', 'expired')),
  -- วันที่เตือนตามเวลาไทย เพื่อให้ "วันละครั้ง" ตรงกับวันทำการร้าน
  alerted_on      date not null,
  created_at      timestamptz not null default now()
);

-- หัวใจของการกันซ้ำ: insert ซ้ำจะชนที่นี่ = cron รันซ้ำกี่รอบก็ยิงครั้งเดียว
create unique index if not exists subscription_alert_log_once_idx
  on public.subscription_alert_log (organization_id, stage, alerted_on);

create index if not exists subscription_alert_log_day_idx
  on public.subscription_alert_log (alerted_on desc);

alter table public.subscription_alert_log enable row level security;
-- ตั้งใจไม่มี policy: เขียนโดย cron ผ่าน service role เท่านั้น
revoke all on public.subscription_alert_log from anon, authenticated;

comment on table public.subscription_alert_log is
  'กันเตือนเรื่องแพ็กเกจซ้ำ — หนึ่งองค์กร หนึ่งขั้น หนึ่งวัน (เขียนโดย cron เท่านั้น)';

-- ------------------------------------------------------------
-- เปิดชนิดแจ้งเตือนใหม่ให้ร้านตั้งค่าได้เอง
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
      'subscription_expiring'
    )
  );
