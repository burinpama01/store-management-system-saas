import type { NotificationType } from "./types";

/**
 * ค่าเริ่มต้นของหัวข้อ/ข้อความแจ้งเตือนต่อประเภท — ใช้เป็น "ค่าตั้งต้น" ในหน้าแก้ไข
 * และเป็น fallback เมื่อร้านยังไม่ได้ตั้ง template เอง (ตัว dispatcher จะใช้ข้อความ
 * ที่ call site ส่งมาอยู่แล้ว ค่าพวกนี้จึงมีไว้เพื่อ UX เป็นหลัก)
 *
 * ตัวแปรอยู่ในรูป {ชื่อ} — ระบบจะแทนค่าจาก metadata ของ notification + {store}=ชื่อร้าน
 */
export const DEFAULT_NOTIFICATION_TEMPLATES: Record<
  NotificationType,
  { title: string; message: string }
> = {
  payment: { title: "ชำระเงินแล้ว", message: "รับชำระเงิน {amount} ผ่าน {method}" },
  new_table: { title: "เปิดโต๊ะใหม่", message: "เปิดโต๊ะ {tableLabel} แล้ว" },
  new_pos_order: { title: "มีออเดอร์ POS ใหม่", message: "ออเดอร์ {orderNumber} ยอด {total}" },
  new_qr_order: { title: "มีออเดอร์ QR ใหม่", message: "ออเดอร์ {orderNumber} ยอด {total}" },
  new_buffet_order: { title: "มีออเดอร์บุฟเฟต์ใหม่", message: "ออเดอร์ {orderNumber} ยอด {total}" },
  kitchen_order: { title: "มีออเดอร์เข้าครัว", message: "ออเดอร์ {orderNumber} เข้าครัวแล้ว" },
  buffet_expiring: {
    title: "บุฟเฟต์ใกล้หมดเวลา",
    message: "โต๊ะ {tableLabel} จะหมดเวลาในอีก {minutesLeft} นาที",
  },
  stock_alert: {
    title: "สต็อกใกล้หมด",
    message: "{productName} เหลือ {stockQuantity} ชิ้น",
  },
  order_cancelled: { title: "ยกเลิก/คืนเงินออเดอร์", message: "ออเดอร์ {orderNumber} ถูกยกเลิก" },
  attendance_clock_in: { title: "พนักงานเข้างาน", message: "{employeeName} เข้างานแล้ว" },
  attendance_clock_out: { title: "พนักงานออกงาน", message: "{employeeName} ออกงานแล้ว" },
  approval: {
    title: "คำขออนุมัติใหม่",
    message: "{employeeName} ขอลงเวลาย้อนหลังวันที่ {date}",
  },
  service_request: { title: "ลูกค้าเรียกพนักงาน", message: "โต๊ะ {tableLabel}: {reason}" },
  test: { title: "ข้อความทดสอบ", message: "[TEST] notification พร้อมใช้งาน" },
};

/**
 * ตัวแปรที่ใช้ได้ในแต่ละประเภท (โชว์ในหน้าแก้ไขให้ผู้ใช้รู้ว่าแทรกอะไรได้)
 * ทุกประเภทใช้ {store} ได้เสมอ (ชื่อร้าน)
 */
export const NOTIFICATION_TEMPLATE_VARS: Record<NotificationType, string[]> = {
  payment: ["store", "amount", "method"],
  new_table: ["store", "tableLabel"],
  new_pos_order: ["store", "orderNumber", "total"],
  new_qr_order: ["store", "orderNumber", "total"],
  new_buffet_order: ["store", "orderNumber", "total"],
  kitchen_order: ["store", "orderNumber"],
  buffet_expiring: ["store", "tableLabel", "minutesLeft"],
  stock_alert: ["store", "productName", "stockQuantity"],
  order_cancelled: ["store", "orderNumber"],
  attendance_clock_in: ["store", "employeeName"],
  attendance_clock_out: ["store", "employeeName"],
  approval: ["store", "employeeName", "date"],
  service_request: ["store", "tableLabel", "reason"],
  test: ["store"],
};

export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

/** แทนที่ {key} ด้วยค่าจาก vars — key ที่ไม่มีค่าจะถูกลบทิ้ง (เป็นค่าว่าง) */
export function renderNotificationTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = vars[key];
      return value === undefined || value === null ? "" : String(value);
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
