-- Add attendance clock-in/out events to tenant notification settings.

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
      'test'
    )
  );
