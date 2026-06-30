// StoreOS Connect — ชนิดข้อมูลกลาง + การ map สถานะระหว่าง StoreOS กับช่องทางเดลิเวอรี (JDC)
// อ้างอิงแผน: Plan/StoreOS-Connect-Architecture-Plan-v2.html

/** สถานะ fulfillment ของออเดอร์เดลิเวอรีฝั่ง StoreOS (เก็บใน connect_orders) */
export type FulfillmentStatus =
  | "received"
  | "accepted"
  | "preparing"
  | "ready"
  | "completed"
  | "cancelled";

/** ต้นทางของการเปลี่ยนสถานะ — ใช้กัน loop ในการ sync สองทาง */
export type StatusOrigin = "jdc" | "storeos";

export const CONNECT_CHANNEL_JDC = "jdc";

/** ลำดับ fulfillment ปกติ (ใช้ตรวจ transition เดินหน้า) */
const FULFILLMENT_ORDER: FulfillmentStatus[] = [
  "received",
  "accepted",
  "preparing",
  "ready",
  "completed",
];

/**
 * map สถานะ fulfillment (StoreOS) → สถานะ booking ฝั่ง JDC ที่จะ push ไป
 * คืน null = ไม่ต้อง push (JDC เป็นเจ้าของสถานะนั้นเอง เช่น received/completed)
 */
export function fulfillmentToJdcStatus(status: FulfillmentStatus): string | null {
  switch (status) {
    case "accepted":
    case "preparing":
      return "preparing";
    case "ready":
      return "ready_for_pickup";
    case "cancelled":
      return "cancelled";
    case "received":
    case "completed":
      return null; // received = ยังไม่กด, completed = คนขับ/JDC คุมเอง
  }
}

/** map สถานะ booking ฝั่ง JDC (ขาเข้า webhook) → สถานะ fulfillment ฝั่ง StoreOS */
export function jdcStatusToFulfillment(jdcStatus: string): FulfillmentStatus {
  switch (jdcStatus) {
    case "pending":
    case "pending_merchant":
      return "received";
    case "preparing":
    case "matched":
    case "driver_accepted":
    case "accepted":
    case "arrived_at_merchant":
    case "arrived":
      return "preparing";
    case "ready_for_pickup":
    case "picking_up_order":
      return "ready";
    case "in_transit":
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "received";
  }
}

/** สถานะที่พนักงานกดเปลี่ยนได้จาก StoreOS POS (ที่เหลือเป็นของ JDC/คนขับ) */
export const POS_SETTABLE_STATUSES: FulfillmentStatus[] = [
  "accepted",
  "preparing",
  "ready",
  "cancelled",
];

/**
 * กติกาการยกเลิกจากฝั่ง StoreOS (ผู้ใช้เคาะ 2026-06-30):
 * "ร้านกดรับแล้วยกเลิกไม่ได้" → POS ยกเลิกได้เฉพาะตอนยังเป็น received เท่านั้น
 * (admin JDC ยกเลิกได้ทุกสถานะ — มาทาง webhook ขาเข้า ไม่ผ่านเงื่อนไขนี้)
 */
export function canPosCancel(current: FulfillmentStatus): boolean {
  return current === "received";
}

/**
 * ตรวจว่า POS เปลี่ยนสถานะจาก current → next ได้ไหม
 * - cancelled: ได้เฉพาะตอน received (กติกาด้านบน)
 * - อื่น ๆ: ต้องเดินหน้าตามลำดับ ห้ามถอยหลัง
 */
export function canPosTransition(
  current: FulfillmentStatus,
  next: FulfillmentStatus,
): { ok: true } | { ok: false; reason: string } {
  if (!POS_SETTABLE_STATUSES.includes(next)) {
    return { ok: false, reason: `สถานะ ${next} เปลี่ยนจาก POS ไม่ได้` };
  }
  if (current === "cancelled" || current === "completed") {
    return { ok: false, reason: "ออเดอร์ปิดแล้ว เปลี่ยนสถานะไม่ได้" };
  }
  if (next === "cancelled") {
    return canPosCancel(current)
      ? { ok: true }
      : { ok: false, reason: "รับออเดอร์แล้วยกเลิกจากร้านไม่ได้ (ติดต่อ JDC)" };
  }
  const ci = FULFILLMENT_ORDER.indexOf(current);
  const ni = FULFILLMENT_ORDER.indexOf(next);
  if (ni <= ci) return { ok: false, reason: "ย้อนสถานะกลับไม่ได้" };
  return { ok: true };
}

/** payload เมนูที่ส่งไป JDC (connect_upsert_menu) */
export interface ConnectMenuItemPayload {
  external_ref: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  is_available: boolean;
  category: string | null;
  preparation_time: number | null;
}

/**
 * รายการในออเดอร์ที่ JDC ส่งเข้ามา
 * external_ref = products.id ฝั่ง StoreOS (JDC เก็บไว้ใน menu_items.external_ref ตอน sync เมนู)
 * ใช้ map กลับเป็นสินค้าใน StoreOS ได้ตรงโดยไม่ต้องพึ่ง menu_items.id ของ JDC
 */
export interface InboundOrderItem {
  menu_item_id?: string;
  external_ref?: string;
  qty: number;
  price: number;
  name: string;
}

/** payload webhook ขาเข้าจาก JDC */
export interface InboundOrderPayload {
  topic: "order.created" | "order.status";
  booking_id: string;
  merchant_id: string;
  status: string;
  items?: InboundOrderItem[];
  customer?: Record<string, unknown>;
  dropoff?: Record<string, unknown>;
  total?: number;
  paid?: boolean;
  ts?: number;
}
