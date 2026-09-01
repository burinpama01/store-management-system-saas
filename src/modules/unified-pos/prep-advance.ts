/**
 * Unified POS — Order-level prep advance facade (Task U5, v0.35.5)
 *
 * ปุ่มเปลี่ยนสถานะระดับ "ออร์เดอร์" ของ kitchen board (updatePrepStatusAction) ต้อง
 * route ผ่าน governed backend ระดับ "item" (unified_pos_update_item_fulfillment)
 * เมื่อร้านเปิด flag unified_pos_enabled — โมดูลนี้แปลง target ระดับ order ให้เป็น
 * รายการ move ระดับ item แบบ deterministic:
 *   - ทุก active item เลื่อน "ทีละขั้น" ไปทาง target เท่านั้น (ห้าม skip ข้ามขั้น
 *     ตาม canTransitionItemFulfillment — ออเดอร์ผสมจะถึง target เมื่อกดซ้ำ)
 *   - item ที่ voided หรืออยู่ที่/หลัง target แล้ว ไม่ถูกแตะ
 *   - target 'new' (ย้อนกลับ) และ 'done' (ระบบ derive จากการชำระ/ยกเลิก) ถูกปฏิเสธ
 *
 * หมายเหตุ: ค่าระดับ order ที่เกิดจริงเป็นผล derive (deriveOrderPrepStatus) จาก
 * items หลัง move เสมอ ไม่ใช่ค่า target ที่สั่งมา
 */
import {
  canTransitionItemFulfillment,
  FULFILLMENT_STATUSES,
  UNIFIED_POS_ERROR_CODES,
  type FulfillmentStatus,
  type UnionErrorCode,
} from "./contracts";

/** ลำดับ canonical ของ fulfillment status (index มาก = ไปไกลกว่า) */
const FULFILLMENT_ORDER: Readonly<Record<FulfillmentStatus, number>> = Object.freeze({
  new: 0,
  preparing: 1,
  ready: 2,
  served: 3,
});

/** item input ของ facade (จาก order_items ที่อ่านมาฝั่ง server) */
export interface PrepAdvanceItemInput {
  id: string;
  voided: boolean;
  fulfillmentStatus: FulfillmentStatus;
}

export interface PrepAdvanceMove {
  itemId: string;
  from: FulfillmentStatus;
  to: FulfillmentStatus;
}

export type PrepAdvancePlan =
  | { kind: "advance"; moves: PrepAdvanceMove[] }
  | { kind: "noop" }
  | { kind: "rejected"; code: UnionErrorCode; message: string };

/** target ระดับ order ที่ facade รับจาก legacy action (PrepStatus) */
export type OrderPrepTarget = "new" | "preparing" | "ready" | "served" | "done";

/**
 * แผน move ระดับ item จาก target ระดับ order — pure function (ไม่แตะ DB)
 * ทุก move ต้องผ่าน canTransitionItemFulfillment ก่อนคืนผล (fail-closed)
 */
export function planOrderPrepAdvance(
  items: ReadonlyArray<PrepAdvanceItemInput>,
  target: OrderPrepTarget,
): PrepAdvancePlan {
  // order-level reverse — derive ไม่ยอมรับการถอย
  if (target === "new") {
    return {
      kind: "rejected",
      code: UNIFIED_POS_ERROR_CODES.invalid_state_transition,
      message: "ไม่สามารถย้อนสถานะออร์เดอร์กลับเป็นใหม่ได้",
    };
  }
  // 'done' เกิดจากการชำระเงิน/ยกเลิกเท่านั้น (derive contract) — ไม่มี move ที่ทำให้ถึง
  if (target === "done") {
    return {
      kind: "rejected",
      code: UNIFIED_POS_ERROR_CODES.invalid_state_transition,
      message: "สถานะเสร็จสิ้นระบบคำนวณให้อัตโนมัติเมื่อออร์เดอร์ถูกชำระเงินหรือยกเลิกแล้ว",
    };
  }

  const targetIndex = FULFILLMENT_ORDER[target];
  const moves: PrepAdvanceMove[] = [];
  for (const item of items) {
    if (item.voided) continue; // canonical void — item ที่ยกเลิกไม่ถูกแตะ
    const currentIndex = FULFILLMENT_ORDER[item.fulfillmentStatus];
    if (currentIndex >= targetIndex) continue; // อยู่ที่/หลัง target แล้ว
    const to = FULFILLMENT_STATUSES[currentIndex + 1];
    if (!to || !canTransitionItemFulfillment(item.fulfillmentStatus, to)) {
      // fail-closed — ไม่ควรเกิด (one-step จากลำดับ canonical) แต่ห้ามส่ง move ที่ผิดกฎ
      return {
        kind: "rejected",
        code: UNIFIED_POS_ERROR_CODES.invalid_state_transition,
        message: "เปลี่ยนสถานะไม่ถูกลำดับ (ได้เฉพาะขั้นถัดไป: new → preparing → ready → served)",
      };
    }
    moves.push({ itemId: item.id, from: item.fulfillmentStatus, to });
  }

  return moves.length === 0 ? { kind: "noop" } : { kind: "advance", moves };
}
