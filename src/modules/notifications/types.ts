export type NotificationChannel = "line" | "telegram";

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

export const NOTIFICATION_TYPES: NotificationType[] = [
  "payment",
  "new_table",
  "new_pos_order",
  "new_qr_order",
  "new_buffet_order",
  "kitchen_order",
  "buffet_expiring",
  "stock_alert",
  "order_cancelled",
  "attendance_clock_in",
  "attendance_clock_out",
  "approval",
  "service_request",
  "test",
];

export const NOTIFICATION_CHANNELS: NotificationChannel[] = ["line", "telegram"];
