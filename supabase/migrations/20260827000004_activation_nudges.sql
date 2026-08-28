-- Task 12/E (v0.34.3): activation nudge idempotency log.
-- One row per (store, step, Bangkok day) — the cron route claims atomically via
-- ON CONFLICT DO NOTHING; service-only (no client policies).
create table public.activation_nudge_log (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  step text not null,
  nudged_on date not null,
  created_at timestamptz not null default now(),
  unique (store_id, step, nudged_on)
);

alter table public.activation_nudge_log enable row level security;

-- Allow 'activation_nudge' in tenant notification settings (same drop+re-add
-- pattern as 20260620232000).
alter table notification_settings
  drop constraint if exists notification_settings_notification_type_check;

alter table notification_settings
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
      'activation_nudge'
    )
  );