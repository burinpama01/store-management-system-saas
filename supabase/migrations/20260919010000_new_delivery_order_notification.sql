-- ============================================================
-- ชนิดแจ้งเตือนใหม่ 'new_delivery_order' (ออเดอร์เดลิเวอรีเข้า)
--
-- เดิมออเดอร์เดลิเวอรี (StoreOS Connect / JDC) ไม่ยิงแจ้งเตือนเลย → แอป Android ที่พับ/ล็อกจอ
-- ไม่รู้ว่ามีออเดอร์เข้า. เพิ่มชนิดนี้ให้ร้านเปิด/ปิดใน Notification Matrix และแก้ template ได้
-- (push ใช้ช่อง storeos_orders + เสียง alert_new_order เหมือนออเดอร์ QR)
--
-- ขยาย check constraint แบบเดียวกับ 20260909000000_daily_summary.sql (ชุดเดิมทั้งหมด + ชนิดใหม่)
-- ============================================================

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
      'new_delivery_order',
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
      'new_delivery_order',
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
