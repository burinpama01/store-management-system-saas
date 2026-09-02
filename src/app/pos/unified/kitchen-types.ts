import {
  canTransitionItemFulfillment,
  type EffectiveItemState,
  type FulfillmentStatus,
} from "@/modules/unified-pos/contracts";

// U10 — Kitchen queue view contracts (v0.37.1)
// types ฝั่ง server (repository) + client (panel/card) ใช้ร่วมกัน — ห้ามพึ่ง server-only module
// (เดียวกับกฎของ types.ts ในโฟลเดอร์นี้) ข้อมูลทั้งหมดเป็น plain serializable เพราะ
// วิ่งข้าม server action boundary ทั้งตอน initial props และตอน refetch snapshot

/** แหล่งที่มาของออร์เดอร์ — QR (qr_order_source=true) หรือพนักงานหน้าร้าน (false) */
export type KitchenItemSource = "qr" | "staff";

/** รายการหนึ่งของคิวครัว = order_item หนึ่งแถว + บริบทออร์เดอร์ที่การ์ดต้องแสดง */
export interface UnifiedKitchenItem {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly itemId: string;
  readonly productName: string;
  readonly variantName?: string;
  readonly quantity: number;
  readonly note?: string;
  /** canonical void (U1) — voided=true ชนะ fulfillment status เสมอ (render เป็น "ยกเลิกแล้ว") */
  readonly voided: boolean;
  readonly voidedReason?: string;
  readonly fulfillmentStatus: FulfillmentStatus;
  /** version เดิมของ DB (bigint) — ใช้เป็น expected fulfillment_version ตอน transition */
  readonly fulfillmentVersion: number;
  readonly source: KitchenItemSource;
  readonly tableNumber: string | null;
  /** เวลาออร์เดอร์ (orders.created_at ISO) — การ์ดแสดงเป็น "เมื่อสักครู่ / N นาทีที่แล้ว" */
  readonly orderCreatedAt: string;
}

/** ป้ายสถานะ effective ของ item — "ยกเลิกแล้ว" มาจาก canonical void ไม่ใช่ fulfillment enum */
export const KITCHEN_STATE_LABEL: Record<EffectiveItemState, string> = Object.freeze({
  new: "ใหม่",
  preparing: "กำลังเตรียม",
  ready: "พร้อมเสิร์ฟ",
  served: "เสิร์ฟแล้ว",
  voided: "ยกเลิกแล้ว",
});

/** สีป้ายตาม token เดิมของ StoreOS (ชุดเดียวกับ legacy board) — voided เป็นแดงชัดเจน */
export const KITCHEN_STATE_BADGE_CLASS: Record<EffectiveItemState, string> = Object.freeze({
  new: "bg-orange-100 text-orange-700",
  preparing: "bg-blue-100 text-blue-700",
  ready: "bg-emerald-100 text-emerald-700",
  served: "bg-green-100 text-green-700",
  voided: "bg-red-100 text-red-600",
});

/** ป้ายแหล่งที่มาบนการ์ด */
export function kitchenSourceLabel(source: KitchenItemSource): string {
  return source === "qr" ? "QR" : "พนักงาน";
}

/**
 * transition ถัดไปที่ปุ่มบนการ์ดทำได้ — เดินหน้าขั้นเดียวตาม canTransitionItemFulfillment (U1/U5)
 * คืน null เมื่อไม่มีปุ่ม (voided หรือ served คือปลายทาง) — ห้ามข้าม/ถอยขั้น
 */
export function nextKitchenItemTransition(item: {
  readonly voided: boolean;
  readonly fulfillmentStatus: FulfillmentStatus;
}): { to: FulfillmentStatus; label: string } | null {
  if (item.voided) return null;
  const candidates = {
    new: { to: "preparing", label: "รับรายการ" },
    preparing: { to: "ready", label: "พร้อมเสิร์ฟ" },
    ready: { to: "served", label: "เสิร์ฟแล้ว" },
    served: null,
  } as const satisfies Record<FulfillmentStatus, { to: FulfillmentStatus; label: string } | null>;
  const candidate = candidates[item.fulfillmentStatus];
  if (!candidate) return null;
  // กัน enum/ค่าแปลก — ผ่านกฎ transition ของ contracts ก่อนเสมอ (fail-closed)
  if (!canTransitionItemFulfillment(item.fulfillmentStatus, candidate.to)) return null;
  return candidate;
}

/** เวลาแบบย่อของออร์เดอร์ (สไตล์เดียวกับ legacy QrOrdersBoard.timeAgo) */
export function kitchenOrderTimeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "เมื่อสักครู่";
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} ชม. ${mins % 60} นาทีที่แล้ว`;
}
