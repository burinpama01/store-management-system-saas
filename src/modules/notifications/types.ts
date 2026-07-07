export type NotificationChannel = "line" | "telegram" | "push";

export type NotificationType =
  | "payment"
  | "new_table"
  | "new_pos_order"
  | "new_qr_order"
  | "new_buffet_order"
  | "kitchen_order"
  | "buffet_expiring"
  | "stock_alert"
  | "order_cancelled"
  | "attendance_clock_in"
  | "attendance_clock_out"
  | "approval"
  | "service_request"
  | "test";

export interface NotificationPayload {
  type: NotificationType;
  channel?: NotificationChannel;
  destination?: "owner" | "group" | "all";
  title?: string;
  message: string;
  organizationId?: string;
  storeId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

// หมายเหตุ: "kitchen_order" ยังอยู่ใน union/DB enum เพื่อความเข้ากันได้ แต่ถูกตัดออกจาก
// รายการนี้ (ซ้ำซ้อนกับ "ออร์เดอร์ POS/QR ใหม่") จึงไม่แสดงใน Notification Matrix และไม่ถูกยิง
export const NOTIFICATION_TYPES: NotificationType[] = [
  "payment",
  "new_table",
  "new_pos_order",
  "new_qr_order",
  "new_buffet_order",
  "buffet_expiring",
  "stock_alert",
  "order_cancelled",
  "attendance_clock_in",
  "attendance_clock_out",
  "approval",
  "service_request",
  "test",
];

export const NOTIFICATION_CHANNELS: NotificationChannel[] = ["line", "telegram", "push"];
