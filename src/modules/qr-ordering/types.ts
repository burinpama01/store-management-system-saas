import type { SelectedModifier } from "@/modules/pos/types";

export type PrepStatus = "new" | "preparing" | "served" | "done";
export type ServiceRequestType =
  | "call_staff"
  | "request_water"
  | "request_condiment"
  | "request_bill";
export type ServiceRequestStatus = "pending" | "resolved";

/** ปุ่มเรียกบริการที่ร้านปรับแต่งได้ (ข้อความ + เปิด/ปิด) */
export interface ServiceButtonConfig {
  key: ServiceRequestType;
  label: string;
  enabled: boolean;
}

export const SERVICE_REQUEST_TYPES: ServiceRequestType[] = [
  "call_staff",
  "request_water",
  "request_condiment",
  "request_bill",
];

export const DEFAULT_SERVICE_BUTTONS: ServiceButtonConfig[] = [
  { key: "call_staff", label: "เรียกพนักงาน", enabled: true },
  { key: "request_water", label: "ขอน้ำเพิ่ม", enabled: true },
  { key: "request_condiment", label: "ขอน้ำจิ้มเพิ่ม", enabled: true },
  { key: "request_bill", label: "ขอเช็คบิล", enabled: true },
];

/** อีโมจิประจำปุ่ม (ใช้ในหน้าลูกค้า) */
export const SERVICE_BUTTON_EMOJI: Record<ServiceRequestType, string> = {
  call_staff: "🙋",
  request_water: "💧",
  request_condiment: "🥫",
  request_bill: "🧾",
};

/** แปลงค่า JSON จาก DB → รายการปุ่มที่ปลอดภัย เติมค่าเริ่มต้นให้ปุ่มที่ขาด */
export function parseServiceButtons(input: unknown): ServiceButtonConfig[] {
  const rows = Array.isArray(input) ? input : [];
  const byKey = new Map<ServiceRequestType, ServiceButtonConfig>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const key = rec.key as ServiceRequestType;
    if (!SERVICE_REQUEST_TYPES.includes(key)) continue;
    const fallback = DEFAULT_SERVICE_BUTTONS.find((b) => b.key === key)!;
    byKey.set(key, {
      key,
      label: typeof rec.label === "string" && rec.label.trim() ? rec.label.trim().slice(0, 40) : fallback.label,
      enabled: typeof rec.enabled === "boolean" ? rec.enabled : true,
    });
  }
  // Keep canonical order and include any button not present in the stored config.
  return DEFAULT_SERVICE_BUTTONS.map((def) => byKey.get(def.key) ?? def);
}

export interface QrOrderLine {
  id: string;
  productName: string;
  variantName?: string;
  kitchenStationId?: string;
  kitchenStationName?: string;
  modifiers: SelectedModifier[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  note?: string;
  voided?: boolean;
  voidedReason?: string;
}

/** A QR order as seen by the customer (tracking) and the restaurant (board). */
export interface QrOrderView {
  id: string;
  orderNumber: string;
  status: "draft" | "open" | "pending_payment" | "paid" | "refunded" | "voided" | "cancelled";
  prepStatus: PrepStatus;
  tableId?: string;
  tableNumber?: string;
  total: number;
  note?: string;
  items: QrOrderLine[];
  createdAt: string;
  paidAt?: string;
}

export interface ServiceRequest {
  id: string;
  storeId: string;
  tableId: string;
  tableNumber: string;
  type: ServiceRequestType;
  status: ServiceRequestStatus;
  note?: string;
  createdAt: string;
  resolvedAt?: string;
}

export const PREP_STATUS_LABEL: Record<PrepStatus, string> = {
  new: "ออร์เดอร์ใหม่",
  preparing: "กำลังเตรียม",
  served: "เสิร์ฟแล้ว",
  done: "เสร็จสิ้น",
};

export const SERVICE_REQUEST_LABEL: Record<ServiceRequestType, string> = {
  call_staff: "เรียกพนักงาน",
  request_water: "ขอน้ำเพิ่ม",
  request_condiment: "ขอน้ำจิ้มเพิ่ม",
  request_bill: "ขอเช็คบิล",
};
