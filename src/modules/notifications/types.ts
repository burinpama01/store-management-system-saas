import type { Role } from "@/modules/tenants/types";

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
  | "test"
  | "activation_nudge"
  | "subscription_expiring"
  | "daily_summary";

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
  "activation_nudge",
  "subscription_expiring",
  "daily_summary",
];

export const NOTIFICATION_CHANNELS: NotificationChannel[] = ["line", "telegram", "push"];

/**
 * ประเภทแจ้งเตือนเชิงปฏิบัติการหน้าร้าน (ออเดอร์เข้า/ยกเลิก/เรียกพนักงาน) ที่ push
 * ต้องถึงมือทุก role ของสาขา รวมแคชเชียร์/สตาฟ — ประเภทอื่น (ยอดขาย, สรุปยอด,
 * ลงเวลา, สต็อก, billing) ส่งเฉพาะผู้บริหารร้าน เพื่อไม่ให้ข้อมูลธุรกิจรั่วไปมือถือพนักงาน
 */
export const STAFF_PUSH_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  "new_pos_order",
  "new_qr_order",
  "new_buffet_order",
  "order_cancelled",
  "buffet_expiring",
  "service_request",
  "test",
]);

const MANAGEMENT_PUSH_ROLES: readonly Role[] = ["super_admin", "owner", "admin", "manager"];

export function isPushRecipientRole(type: NotificationType, role: Role): boolean {
  if (STAFF_PUSH_NOTIFICATION_TYPES.has(type)) return true;
  return MANAGEMENT_PUSH_ROLES.includes(role);
}
