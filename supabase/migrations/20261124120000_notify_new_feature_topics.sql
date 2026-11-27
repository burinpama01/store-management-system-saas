-- หัวข้อแจ้งเตือนของฟีเจอร์ใหม่ (2026-11-17) — ให้เจ้าของตั้งช่องทาง/ปิดเปิดได้ในหน้าตั้งค่าแจ้งเตือน
--   new_online_order       ออเดอร์ออนไลน์จากเว็บร้าน (จ่ายแล้ว) — แยกจาก new_delivery_order
--   salary_advance_request พนักงานขอเบิกเงิน (เดิมส่ง push ตรง ปิดไม่ได้)
--   pass_purchase          ลูกค้าซื้อแพ็กล่วงหน้าออนไลน์
-- + prepaid_pass_purchases.notified_at กันแจ้งซ้ำ (webhook กับ lookup มาพร้อมกันได้)

alter table public.notification_settings
  drop constraint if exists notification_settings_notification_type_check;

alter table public.notification_settings
  add constraint notification_settings_notification_type_check check (
    notification_type in (
      'payment', 'new_table', 'new_pos_order', 'new_qr_order', 'new_buffet_order',
      'new_delivery_order', 'kitchen_order', 'buffet_expiring', 'stock_alert',
      'order_cancelled', 'approval', 'service_request', 'attendance_clock_in',
      'attendance_clock_out', 'test', 'activation_nudge', 'subscription_expiring',
      'daily_summary', 'ops_checklist', 'new_online_order', 'salary_advance_request',
      'pass_purchase'
    )
  );

alter table public.notification_templates
  drop constraint if exists notification_templates_notification_type_check;

alter table public.notification_templates
  add constraint notification_templates_notification_type_check check (
    notification_type in (
      'payment', 'new_table', 'new_pos_order', 'new_qr_order', 'new_buffet_order',
      'new_delivery_order', 'kitchen_order', 'buffet_expiring', 'stock_alert',
      'order_cancelled', 'approval', 'service_request', 'attendance_clock_in',
      'attendance_clock_out', 'test', 'activation_nudge', 'subscription_expiring',
      'daily_summary', 'ops_checklist', 'new_online_order', 'salary_advance_request',
      'pass_purchase'
    )
  );

alter table public.prepaid_pass_purchases
  add column if not exists notified_at timestamptz;

-- คำสั่งซื้อที่จ่ายไปแล้วก่อน migration นี้ ไม่ต้องแจ้งย้อนหลัง
update public.prepaid_pass_purchases set notified_at = coalesce(updated_at, now()) where status = 'paid' and notified_at is null;
