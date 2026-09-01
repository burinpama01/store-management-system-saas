/**
 * Unified POS — Compatibility Contracts (Task U1)
 *
 * Source of truth ของสถานะ/กฎที่ migration รอบถัดไป (U2) และ RPC (U5-U7) ต้องอ้างอิง
 * แผนอ้างอิง: Plan/QR Order Voice Unified POS Implementation Plan v2.html
 *   - Section "Contracts ที่ห้ามเปลี่ยนความหมาย" → Canonical void / Order prep derive /
 *     Optimistic concurrency / Idempotency retention
 *   - Task "U1 · Compatibility contracts และ state map" (version 0.35.1)
 *
 * ข้อเท็จจริง DB ณ commit 16af52b (v0.35.0):
 *   - orders.status CHECK: draft | open | pending_payment | paid | refunded | voided | cancelled (default 'draft')
 *   - orders.prep_status CHECK: new | preparing | served | done (default 'new') — ยังไม่มี 'ready'
 *   - order_items ยังไม่มีคอลัมน์ fulfillment_status (U2 จะเพิ่ม) แต่มี voided boolean + voided_reason อยู่แล้ว
 *
 * กฎเหล็กจากแผน:
 *   - "ห้ามเพิ่ม voided ซ้ำใน enum และห้ามลบ done ใน migration เดียว" (U1 task)
 *   - voided boolean ของ order_items คือ canonical — ห้ามสร้าง fulfillment_status='voided' เด็ดขาด
 */

import type { OrderStatus } from "@/modules/pos/types";

/**
 * Re-export เพื่อให้ U2/U5-U7 อ้าง OrderStatus จาก contracts จุดเดียว
 * (ค่าตรงกับ orders.status CHECK ณ commit 16af52b — canonical type อยู่ที่ src/modules/pos/types.ts)
 */
export type { OrderStatus };

/**
 * Fulfillment status ระดับ order_item (target enum ที่ U2 จะเพิ่มเป็นคอลัมน์)
 * แผน: "Contracts ที่ห้ามเปลี่ยนความหมาย → Canonical void"
 *   - fulfillment_status: new | preparing | ready | served
 *   - ห้ามมี 'voided' ใน enum นี้ เพราะจะเกิด dual truth กับ voided boolean ที่เป็น canonical อยู่แล้ว
 * Freeze + as const เพื่อไม่ให้ใคร mutate ค่า enum ได้
 */
export const FULFILLMENT_STATUSES = Object.freeze(["new", "preparing", "ready", "served"] as const);
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

/**
 * Order prep status ระดับ order (target enum ของ orders.prep_status)
 * แผน: U1 task — target enum ที่ "เพิ่ม ready" จาก CHECK เดิม (new | preparing | served | done)
 *   - U2/U5 จะ extend CHECK เพิ่ม 'ready' และห้ามลบ 'done' ออกใน migration เดียวกัน
 */
export const ORDER_PREP_STATUSES = Object.freeze(["new", "preparing", "ready", "served", "done"] as const);
export type OrderPrepStatus = (typeof ORDER_PREP_STATUSES)[number];

/** สถานะ order ที่ถือว่า order ปิดแล้ว (แผน: Order prep derive — "cancelled/closed") + paid */
const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = Object.freeze([
  "paid",
  "refunded",
  "voided",
  "cancelled",
] as const);

/** สถานะ effective ของ item: ถ้า voided ให้เห็นเป็น 'voided' เสมอ ไม่งั้นตาม fulfillment status */
export type EffectiveItemState = "voided" | FulfillmentStatus;

/**
 * Shape ของ item input ที่ใช้ร่วมกันทั้ง effective state / prep derive / cancel rule
 * (นิยามครั้งเดียว — U2/U5 เพิ่ม field ใหม่ เช่น fulfillment_version แก้ที่จุดเดียว)
 */
export interface ItemFulfillmentInput {
  voided: boolean;
  fulfillmentStatus: FulfillmentStatus;
}

/**
 * แผน: "Contracts ที่ห้ามเปลี่ยนความหมาย → Canonical void"
 *   effective_item_state = item.voided ? "voided" : item.fulfillment_status
 * กฎ canonical: voided=true ชนะ fulfillment status เสมอ (ไม่ว่า fulfillment จะเป็นอะไร)
 */
export function effectiveItemState(item: ItemFulfillmentInput): EffectiveItemState {
  return item.voided ? "voided" : item.fulfillmentStatus;
}

/**
 * แผน: "Contracts ที่ห้ามเปลี่ยนความหมาย → Order prep derive" (map จาก active items → สถานะ order)
 *   1. order ปิดแล้ว (status ∈ terminal: cancelled/voided/refunded/paid หรือ paidAt ไม่ null) → 'done'
 *   2. ไม่มี active item (ทุก item voided หรือ items ว่าง) → 'done'
 *   3. active items ทั้งหมด 'new' → 'new'
 *   4. active items ผสมหลายสถานะ → 'preparing'
 *   5. active เป็น ready/served ล้วน และมีอย่างน้อย 1 ready → 'ready'
 *   6. active เป็น served ล้วน → 'served'
 * หมายเหตุ: active item = item ที่ voided=false เท่านั้น (canonical void)
 */
export function deriveOrderPrepStatus(input: {
  orderStatus: OrderStatus;
  paidAt?: string | null;
  items: ReadonlyArray<ItemFulfillmentInput>;
}): OrderPrepStatus {
  // (1) order ปิดแล้ว → done
  const isClosed = TERMINAL_ORDER_STATUSES.includes(input.orderStatus) || (input.paidAt ?? null) !== null;
  if (isClosed) return "done";

  const activeStates = input.items
    .filter((item) => !item.voided)
    .map((item) => item.fulfillmentStatus);

  // (2) ไม่มี active item → done
  if (activeStates.length === 0) return "done";

  const uniqueStates = new Set(activeStates);

  // (3) ล้วนสถานะเดียว: all new → new, all preparing → preparing, all ready → ready, all served → served
  if (uniqueStates.size === 1) return activeStates[0];

  // (4) ผสมหลายสถานะ → preparing
  // (5)(6) ยกเว้น ready/served ล้วน: มี ready ≥1 → ready, served ล้วน → served
  const hasEarlyState = activeStates.some((s) => s === "new" || s === "preparing");
  if (hasEarlyState) return "preparing";
  return uniqueStates.has("ready") ? "ready" : "served";
}

/**
 * Transition ที่อนุญาตของ item fulfillment: เดินหน้าได้เฉพาะขั้นถัดไป
 * new → preparing → ready → served (served คือปลายทาง — ถอย/ข้าม/ซ้ำไม่ได้)
 */
const NEXT_FULFILLMENT_STATUS: Readonly<Record<FulfillmentStatus, FulfillmentStatus | null>> = Object.freeze({
  new: "preparing",
  preparing: "ready",
  ready: "served",
  served: null,
});

/**
 * ตรวจว่าเปลี่ยนสถานะ fulfillment ของ item ได้หรือไม่
 * แผน: U5 (Item fulfillment) — เดินหน้าได้เฉพาะขั้นถัดไป ห้ามถอย ห้ามข้าม
 * และ transition จากสถานะเดียวกันถือว่าไม่ valid (return false)
 */
export function canTransitionItemFulfillment(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
  const next = NEXT_FULFILLMENT_STATUS[from];
  return next !== null && next !== undefined && next === to;
}

/**
 * แผน: "Order prep derive" — "customer cancel ยังอนุญาตเฉพาะ order-level new"
 * กฎเดิมจริงอยู่ที่ migration `supabase/migrations/20260701000001_cancel_qr_order.sql`
 * (ฟังก์ชัน cancel_qr_order_by_customer: status='open' + prep_status='new' + ยังไม่จ่าย)
 *
 * ⚠ กฎเดิมมี guard อีกชั้นที่ predicate นี้ไม่รวมตามแผน: อนุญาตเฉพาะ order ที่มาจาก QR
 *   (qr_order_source = true) — call site (U4/U5) ต้อง enforce เงื่อนไขนี้เอง
 *   มิฉะนั้นจะยกเลิกออเดอร์หน้าร้าน/พนักงานได้ (behavior change จากกฎเดิม)
 *
 * Predicate ที่ฟังก์ชันนี้ตรวจ:
 *   - order status ต้องเป็น 'open' เท่านั้น
 *   - ยังไม่จ่าย (paidAt เป็น null/undefined)
 *   - ต้องมี active item (voided=false) อย่างน้อย 1 ชิ้น
 *   - active items ทั้งหมดยัง 'new' (ครัวยังไม่รับงาน)
 */
export function canCustomerCancelOrder(input: {
  status: OrderStatus;
  paidAt?: string | null;
  items: ReadonlyArray<ItemFulfillmentInput>;
}): boolean {
  if (input.status !== "open") return false;
  if ((input.paidAt ?? null) !== null) return false;

  const activeItems = input.items.filter((item) => !item.voided);
  if (activeItems.length === 0) return false;

  return activeItems.every((item) => item.fulfillmentStatus === "new");
}

/**
 * แผน: "Contracts ที่ห้ามเปลี่ยนความหมาย → Idempotency retention" + Task U4-U7
 * Envelope ของ operation ที่ต้อง idempotent (QR submit, add-items, fulfillment, settlement, payment)
 *   - operationKey: key ที่ client สร้างและส่งซ้ำได้เมื่อ retry
 *   - requestHash: hash ของ payload เพื่อพิสูจน์ว่า retry คือคำขอเดิมจริง
 * กฎ (contract-level — storage จะทำใน U4-U7):
 *   - key ใหม่ (ไม่เคยเห็น)          → outcome 'executed'
 *   - operationKey เดิม + hash เดิม  → outcome 'replayed' (คืน result เดิม ไม่ execute ซ้ำ)
 *   - operationKey เดิม + hash ใหม่  → outcome 'hash_conflict' (ห้าม execute)
 */
export interface UnifiedPosOperationRequest {
  operationKey: string;
  requestHash: string;
}

export type UnifiedPosOperationOutcome<T> =
  | { status: "executed"; result: T }
  | { status: "replayed"; result: T }
  | { status: "hash_conflict" };

/**
 * Stable error codes ของ unified POS (แผน: U1 task — "stable error codes")
 * ค่าทุกตัวมี prefix 'up_' เพื่อแยกจาก error codes เดิมของระบบ และ RPC U5-U7 ต้องคืนค่าจากชุดนี้เท่านั้น
 * Freeze + as const เพื่อไม่ให้ใคร mutate/เพิ่ม key ได้
 */
export const UNIFIED_POS_ERROR_CODES = Object.freeze({
  /** เขียนทับด้วย version เก่า (optimistic concurrency — แผน: Optimistic concurrency) */
  stale_version: "up_stale_version",
  /** transition สถานะ fulfillment/prep ที่ไม่ใช่ขั้นถัดไปที่อนุญาต */
  invalid_state_transition: "up_invalid_state_transition",
  /** operationKey เดิมแต่ requestHash ไม่ตรง (แผน: Idempotency retention) */
  hash_conflict: "up_hash_conflict",
  /** อ้างถึง order_item ที่ไม่ valid / ไม่อยู่ใน order */
  invalid_item: "up_invalid_item",
  /** ไม่พบ entity ที่อ้างถึง */
  not_found: "up_not_found",
  /** ผู้เรียกไม่มีสิทธิ์ทำ operation นี้ */
  forbidden: "up_forbidden",
  /** ลูกค้าขอ cancel ไม่ได้ตามกฎ (แผน: Order prep derive — cancel เฉพาะ order-level new) */
  cancel_not_allowed: "up_cancel_not_allowed",
  /** สต๊อกไม่พอสำหรับ operation */
  stock_insufficient: "up_stock_insufficient",
  /** store flag ที่เกี่ยวข้องถูกปิด (แผน: U2 store flags) */
  store_flag_disabled: "up_store_flag_disabled",
  /**
   * payload การชำระเงินไม่ถูกต้อง (เพิ่มใน U7 ตามหลัก U4 — เลือก code ใหม่เมื่อ
   * ไม่มีตัวไหนตรง): วิธีชำระ/ยอดชำระ/เงินสดที่รับ-เงินทอน ไม่ผ่าน validation
   * เช่น ยอดชำระไม่ตรงกับยอดรวม server (never client totals)
   */
  invalid_payment: "up_invalid_payment",
  /**
   * โต๊ะไม่มี session ที่ใช้สั่งได้ (หมดอายุ/ยังไม่เปิด) และกฎของร้านไม่อนุญาตให้เปิดเอง
   * (แผน U4 RED: auto-open failure — ร้านที่ไม่ใช่ table_bound+customer_self ต้องแจ้งพนักงาน)
   * เพิ่มใน U4 (v0.35.4) ตาม brief ให้เลือก/เพิ่ม code เมื่อไม่มีตัวไหนตรง
   */
  session_not_active: "up_session_not_active",
} as const);

/** Union ของ error code ทั้งหมด (ดึงจากค่าใน UNIFIED_POS_ERROR_CODES) */
export type UnionErrorCode = (typeof UNIFIED_POS_ERROR_CODES)[keyof typeof UNIFIED_POS_ERROR_CODES];
