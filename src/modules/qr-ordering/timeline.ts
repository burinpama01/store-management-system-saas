/**
 * Unified QR Ordering — Customer fulfillment timeline (Task U12, v0.37.3)
 *
 * ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U12)
 *   - "timeline maps received/preparing/ready/served/voided with allowed reason"
 *   - "legacy rows without new fields map safely during migration window"
 *   - "cancel only before kitchen acceptance; stale request receives current state"
 *
 * หลักการ (ทำไมต้องมี mapping แยก):
 *   - ลูกค้าต้อง "ไม่เห็น" ข้อมูลภายใน: fulfillment_version / operation key / actor id —
 *     type ของผลลัพธ์จึงมีเฉพาะสถานะที่ลูกค้าควรเห็นเท่านั้น
 *   - ช่วง migration (flag unified_pos_enabled เปิด/ปิดคู่ขนานจน cutover) ข้อมูลมี 2 รูปแบบ:
 *     1) รูปแบบใหม่ (flag on): order_items.fulfillment_status เดินหน้า + trigger derive
 *        orders.prep_status ตาม contracts.deriveOrderPrepStatus
 *     2) รูปแบบเดิม (flag off / แถวก่อน U5): items คง default 'new' ตลอด ครัวเดินหน้า
 *        ที่ orders.prep_status เท่านั้น และค่าเดิมไม่มี 'ready' (new|preparing|served|done)
 *     mapping จึงใช้ "สถานะที่เดินหน้าที่สุด" ของสองแหล่ง (item fulfillment ที่รู้ค่า +
 *     orders.prep_status ดิบ) — ปลอดภัยทั้งสองรูปแบบและช่วงผสม
 *   - voided item คง canonical เดิม (voided boolean + voided_reason) — แสดงด้วยเหตุผล
 *     ที่อนุญาตเท่านั้น ไม่มี stage เพราะรายการถูกตัดออกจากการเตรียมแล้ว
 */

import type { OrderStatus } from "@/modules/pos/types";
import type { QrOrderLine, QrOrderView } from "./types";
import {
  canCustomerCancelOrder,
  FULFILLMENT_STATUSES,
  type FulfillmentStatus,
} from "@/modules/unified-pos/contracts";

/** สถานะ timeline ที่ลูกค้าเห็น (แผน U12: received → preparing → ready → served + closed) */
export const CUSTOMER_STAGES = Object.freeze([
  "received",
  "preparing",
  "ready",
  "served",
  "closed",
] as const);
export type CustomerStage = (typeof CUSTOMER_STAGES)[number];

/** ป้ายภาษาไทยของแต่ละ stage (ใช้ทั้ง badge ของหน้าติดตามและข้อความ stale cancel) */
export const CUSTOMER_STAGE_LABEL: Readonly<Record<CustomerStage, string>> = Object.freeze({
  received: "ได้รับออเดอร์แล้ว",
  preparing: "กำลังเตรียม",
  ready: "พร้อมเสิร์ฟ",
  served: "เสิร์ฟแล้ว",
  closed: "เสร็จสิ้น",
});

/** ลำดับความก้าวหน้าของ stage — ใช้เลือก "สถานะที่เดินหน้าที่สุด" ของสองแหล่งข้อมูล */
const STAGE_RANK: Readonly<Record<CustomerStage, number>> = Object.freeze({
  received: 0,
  preparing: 1,
  ready: 2,
  served: 3,
  closed: 4,
});

/** fulfillment_status (รูปแบบใหม่) → stage ของลูกค้า */
const STAGE_BY_FULFILLMENT: Readonly<Record<FulfillmentStatus, CustomerStage>> = Object.freeze({
  new: "received",
  preparing: "preparing",
  ready: "ready",
  served: "served",
});

/**
 * orders.prep_status ดิบ (ทั้งรูปแบบเก่าที่ไม่มี 'ready' และรูปแบบใหม่) → stage
 * ค่านอก enum (ป้องกันไว้แล้วด้วย CHECK แต่ mapping ต้องไม่พัง) → null แล้ว fallback
 */
const STAGE_BY_PREP_STATUS: Readonly<Record<string, CustomerStage>> = Object.freeze({
  new: "received",
  preparing: "preparing",
  ready: "ready",
  served: "served",
  done: "closed",
});

/** status ของ order ที่ถือว่าปิดแล้ว (mirror contracts.deriveOrderPrepStatus) */
const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = Object.freeze([
  "paid",
  "refunded",
  "voided",
  "cancelled",
] as const);

// --- Input (raw shape ตรงกับที่ action อ่านจาก DB) ---

export interface CustomerTimelineItemInput {
  readonly voided: boolean;
  /** เหตุผลที่ยกเลิก (แสดงต่อลูกค้าได้ — ข้อความที่ร้านตั้ง เช่น "ของหมด") */
  readonly voidedReason?: string | null;
  /**
   * order_items.fulfillment_status ดิบ — รูปแบบใหม่เท่านั้น รูปแบบเดิม (ก่อน U2)
   * ไม่มีคอลัมน์นี้ จะเป็น null/undefined ก็ได้ mapping จะ fallback ตามหลักด้านบน
   */
  readonly fulfillmentStatus?: string | null;
}

export interface CustomerTimelineOrderInput {
  readonly status: OrderStatus;
  readonly paidAt?: string | null;
  /** orders.prep_status ดิบ — รูปแบบเก่าไม่มี 'ready' ก็ map ได้ (null ได้ถ้ายังไม่มีคอลัมน์) */
  readonly prepStatus?: string | null;
  readonly items: ReadonlyArray<CustomerTimelineItemInput>;
}

// --- Output (typed immutable — ลูกค้าไม่เห็น version/operation key/actor id) ---

/** item ที่ยัง active → stage ของรายการนั้น */
export interface CustomerTimelineActiveItem {
  readonly voided: false;
  readonly stage: CustomerStage;
}

/** item ที่ถูกยกเลิก → แสดงด้วยเหตุผลที่อนุญาต (voided_reason เดิม) ไม่มี stage */
export interface CustomerTimelineVoidedItem {
  readonly voided: true;
  readonly reason?: string;
}

export type CustomerTimelineItem = CustomerTimelineActiveItem | CustomerTimelineVoidedItem;

export interface CustomerOrderTimeline {
  /** stage ระดับออเดอร์ที่ลูกค้าเห็น (badge ของหน้าติดตาม) */
  readonly stage: CustomerStage;
  /** server ตัดสินปุ่มยกเลิกแล้ว — true เฉพาะ "ก่อนครัวรับ" ในทั้งสองรูปแบบข้อมูล */
  readonly canCancel: boolean;
  /** สถานะรายการ ตรงตำแหน่ง (index) กับ items ที่ส่งเข้ามา */
  readonly items: readonly CustomerTimelineItem[];
}

function isKnownFulfillmentStatus(value: string | null | undefined): value is FulfillmentStatus {
  return typeof value === "string" && (FULFILLMENT_STATUSES as readonly string[]).includes(value);
}

function isClosedOrder(status: OrderStatus, paidAt?: string | null): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status) || (paidAt ?? null) !== null;
}

/** map orders.prep_status ดิบ → stage (ค่าไม่รู้จัก → null) */
function stageFromPrepStatus(prepStatus?: string | null): CustomerStage | null {
  if (typeof prepStatus !== "string") return null;
  return STAGE_BY_PREP_STATUS[prepStatus] ?? null;
}

/**
 * derive stage ระดับ order จาก active items — mirror contracts.deriveOrderPrepStatus
 * (ผสมหลายสถานะที่มี new/preparing → preparing; ready+served ผสม → ready; served ล้วน → served)
 * item ที่ไม่รู้จักค่า fulfillment ถือเป็น 'new' ตาม default ของคอลัมน์ (แถวก่อน migration)
 */
function deriveStageFromItems(items: ReadonlyArray<CustomerTimelineItemInput>): CustomerStage {
  const activeStates = items
    .filter((item) => !item.voided)
    .map((item) => (isKnownFulfillmentStatus(item.fulfillmentStatus) ? item.fulfillmentStatus : "new"));

  // ไม่มี active item → ปิด (mirror: ไม่มี active item → done)
  if (activeStates.length === 0) return "closed";

  const unique = new Set<CustomerStage>(activeStates.map((s) => STAGE_BY_FULFILLMENT[s]));

  // active ล้วนสถานะเดียว → stage ของสถานะนั้น (mirror: all new → new, ... all served → served)
  if (unique.size === 1) return STAGE_BY_FULFILLMENT[activeStates[0]];

  const hasEarlyState = activeStates.some((s) => s === "new" || s === "preparing");
  if (hasEarlyState) return "preparing";
  return unique.has("ready") ? "ready" : "served";
}

/**
 * ฟังก์ชัน mapping หลัก (ตัวเดียวของ U12) — แปลงข้อมูลดิบของออเดอร์เป็น timeline
 * ที่ลูกค้าเห็น รองรับทั้งรูปแบบเก่า/ใหม่/ช่วงผสม:
 *   - stage = max(stage จาก prep_status ดิบ, stage ที่ derive จาก item fulfillment)
 *     (รูปแบบเดิม: items นิ่งที่ default แต่ prep_status เดินหน้า → prep ชนะตาม rank)
 *   - canCancel = canCustomerCancelOrder (contracts) && stage === 'received'
 *     (เพิ่มเงื่อนไข stage เพื่อให้ตรงกับ legacy RPC ที่ปฏิเสธเมื่อ prep_status <> 'new')
 */
export function mapOrderToCustomerTimeline(input: CustomerTimelineOrderInput): CustomerOrderTimeline {
  const closed = isClosedOrder(input.status, input.paidAt);

  let stage: CustomerStage;
  if (closed) {
    stage = "closed";
  } else {
    const candidates: CustomerStage[] = [];
    const fromPrep = stageFromPrepStatus(input.prepStatus);
    if (fromPrep) candidates.push(fromPrep);
    candidates.push(deriveStageFromItems(input.items));
    stage = candidates.reduce((best, next) => (STAGE_RANK[next] > STAGE_RANK[best] ? next : best));
  }

  const items: CustomerTimelineItem[] = input.items.map((item) => {
    if (item.voided) {
      return { voided: true, reason: item.voidedReason ?? undefined };
    }
    return {
      voided: false,
      stage: isKnownFulfillmentStatus(item.fulfillmentStatus)
        ? STAGE_BY_FULFILLMENT[item.fulfillmentStatus]
        : stage,
    };
  });

  // ปุ่มยกเลิก = กฎ contract (open + ยังไม่จ่าย + active ล้วน 'new') และยังไม่มีแหล่งใด
  // เดินหน้า (stage received) — ครอบพฤติกรรม legacy RPC ที่ปฏิเสธเมื่อ prep_status <> 'new'
  const canCancel =
    !closed &&
    stage === "received" &&
    canCustomerCancelOrder({
      status: input.status,
      paidAt: input.paidAt,
      items: input.items.map((item) => ({
        voided: item.voided,
        fulfillmentStatus: isKnownFulfillmentStatus(item.fulfillmentStatus)
          ? item.fulfillmentStatus
          : "new",
      })),
    });

  return { stage, canCancel, items };
}

// --- View ของหน้าลูกค้า (typed immutable props) ---

/** รายการในมุมมองลูกค้า: เพิ่ม stage ของ item (เฉพาะ active) — voided แสดงด้วยเหตุผลเดิม */
export type CustomerOrderLine = QrOrderLine & { readonly stage?: CustomerStage };

/**
 * QrOrderView ของลูกค้า + สถานะ timeline ที่ derive ฝั่ง server แล้ว
 * สร้างได้เฉพาะผ่าน mapOrderToCustomerTimeline (actions ของหน้า QR) เท่านั้น
 */
export type CustomerOrderView = Omit<QrOrderView, "items"> & {
  readonly stage: CustomerStage;
  readonly canCancel: boolean;
  readonly items: readonly CustomerOrderLine[];
};

// --- Stale cancel messaging (U12 requirement 2) ---

/**
 * จำแนน error ของ legacy cancel RPC ที่เป็น "การปฏิเสธตามกฎ" (ครัวรับแล้ว/ออเดอร์ปิดแล้ว)
 * — ข้อความจริงจาก migration 20260701000001: 'ออเดอร์นี้ยกเลิกไม่ได้' /
 * 'ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้' (ส่วน 'ไม่พบออเดอร์' ไม่เข้าเงื่อนไขนี้)
 */
export function isCancelRejectionMessage(message: string): boolean {
  return typeof message === "string" && message.includes("ยกเลิกไม่ได้");
}

/**
 * ข้อความ stale cancel: ระบุเหตุผลจาก server + สถานะปัจจุบันที่ลูกค้าเห็น
 * เช่น "ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้ (สถานะปัจจุบัน: กำลังเตรียม)"
 */
export function composeStaleCancelMessage(rpcMessage: string, currentStageLabel: string): string {
  return `${rpcMessage} (สถานะปัจจุบัน: ${currentStageLabel})`;
}
