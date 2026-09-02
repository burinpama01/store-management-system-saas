"use server";

// U10 — Server actions ของคิวครัวใน unified shell (v0.37.1)
// เส้นทาง transition เดียว: action → repository (service client) → governed RPC
// unified_pos_update_item_fulfillment (U5) — ห้ามเขียน order_items ตรงจาก client เด็ดขาด
// ความสัมพันธ์กับ U3 realtime: snapshot ที่คืนจาก action ใช้เป็น server truth ตอน
// conflict (stale/invalid transition) / reconnect / polling fallback — ห้าม client สร้างเอง
//
// U11 (v0.37.2) — แท็บบิล + print replay contract:
//   - บิลอ่านจาก server เสมอ (bill-repository: รายการ non-voided + payments + orders.total)
//   - ชำระผ่านเส้นทาง governed เดิม (settleOrdersGoverned → RPC U7) แล้ว map ผลเป็น
//     receipt reference + print job ids ด้วย print intent (post-commit — หลัง RPC สำเร็จเสมอ)
//   - replay ของคำขอเดิม (idempotencyKey เดิม) → job id ชุดเดิม (source_key unique)
//     — client ไม่เคย browser-auto-print; พิมพ์ซ้ำเป็น explicit action ที่ถูก audit

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  FULFILLMENT_STATUSES,
  UNIFIED_POS_ERROR_CODES,
  type FulfillmentStatus,
} from "@/modules/unified-pos/contracts";
import {
  listUnifiedPosKitchenQueue,
  updateKitchenItemFulfillment,
  type UpdateKitchenItemFulfillmentResult,
} from "@/modules/unified-pos/kitchen-repository";
import { fetchTableBillForTable } from "@/modules/unified-pos/bill-repository";
import {
  reprintUnifiedPosReceipt,
  resolveSettlementPrintIntent,
} from "@/modules/unified-pos/print-intent";
import {
  settleOrdersGoverned,
  type SettlementMode,
  type UnifiedPosSettlementResult,
} from "@/modules/unified-pos/settlement";
import { isValidOperationKey } from "@/modules/unified-pos/envelope";
import type { UnifiedPosTableBillView } from "./bill-types";
import type { UnifiedKitchenItem } from "./kitchen-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ผลลัพธ์ของการกดปุ่มบนการ์ด — code คงรูปจาก RPC เพื่อให้ client แยก conflict ได้ */
export type AdvanceKitchenItemActionResult = UpdateKitchenItemFulfillmentResult;

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

/**
 * Snapshot คิวครัวล่าสุดจาก server — ใช้ตอน conflict / reconnect / polling fallback
 * (client ห้ามเก็บหรือคำนวณ snapshot เอง — ต้องมาจาก DB เสมอ)
 */
export async function fetchKitchenQueueAction(): Promise<{
  items: UnifiedKitchenItem[];
  error: string | null;
}> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    const result = await listUnifiedPosKitchenQueue(ctx.storeId);
    if (result.error) return { items: [], error: result.error.userMessage };
    return { items: result.data, error: null };
  } catch (e) {
    return { items: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/**
 * เปลี่ยนสถานะรายการครัวหนึ่งรายการ — client ส่ง expected fulfillment_version ที่ตัวเองเห็น
 * มากับปุ่ม (optimistic concurrency):
 *   - ok → ปรับ version/สถานะจากผลลัพธ์ server (ไม่เดา)
 *   - up_stale_version / up_invalid_state_transition → conflict: client ต้อง refetch
 *     snapshot จาก server และแสดงตามความจริง ห้าม overwrite ด้วย state ท้องถิ่น
 *   - code อื่น → error ทั่วไป (แสดงข้อความ + revert optimistic)
 */
export async function advanceKitchenItemAction(
  orderId: string,
  itemId: string,
  expectedFulfillmentVersion: number,
  targetStatus: FulfillmentStatus,
): Promise<AdvanceKitchenItemActionResult> {
  try {
    await requirePermission("orders.manage_qr");
    const { user, ctx } = await getStoreContext();
    if (!UUID_RE.test(orderId) || !UUID_RE.test(itemId)) {
      return { ok: false, code: UNIFIED_POS_ERROR_CODES.invalid_item, message: "รายการไม่ถูกต้อง" };
    }
    if (!(FULFILLMENT_STATUSES as readonly string[]).includes(targetStatus)) {
      return {
        ok: false,
        code: UNIFIED_POS_ERROR_CODES.invalid_state_transition,
        message: "สถานะที่ต้องการไม่ถูกต้อง",
      };
    }
    return await updateKitchenItemFulfillment({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      orderId,
      itemId,
      expectedFulfillmentVersion,
      targetStatus,
      actorUserId: user.id,
    });
  } catch (e) {
    return {
      ok: false,
      code: UNIFIED_POS_ERROR_CODES.forbidden,
      message: e instanceof Error ? e.message : "เกิดข้อผิดพลาด",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// U11 — แท็บบิล: server-derived bill + settlement→print intent
// ─────────────────────────────────────────────────────────────────────────────

/** บิลของโต๊ะจาก server — null เมื่อโต๊ะไม่มีบิลที่ยังชำระ (โครงเดียวกับ bill-repository) */
export async function fetchUnifiedPosTableBillAction(
  tableId: string,
): Promise<{ bill: UnifiedPosTableBillView | null; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) return { bill: null, error: "โต๊ะไม่ถูกต้อง" };
    const bill = await fetchTableBillForTable(ctx.storeId, tableId);
    return { bill, error: null };
  } catch (e) {
    return { bill: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** input ของ settleUnifiedPosBillAction (client ส่งครั้งเดียวต่อคำขอ + reuse ตอน retry) */
export interface UnifiedPosSettleBillInput {
  /** whole_table: ต้องระบุ; partial: โต๊ะของบิล (derive ให้ RPC ล็อคขอบเขต) */
  tableId: string;
  mode: SettlementMode;
  /** partial: order ids ที่จะชำระ (ยอดต่อบิล RPC เทียบกับ server เอง); whole_table: ไม่ใช้ */
  orderIds?: readonly string[];
  method: "cash" | "qr_promptpay" | "credit_card" | "bank_transfer" | "other";
  /** partial เท่านั้น — ยอดที่ client อ้าง (จาก server props ของบิล ไม่ใช่คำนวณเอง) */
  amount?: number | null;
  receivedAmount?: number | null;
  changeAmount?: number | null;
  reference?: string | null;
  /** idempotency key ของคำขอ — retry ต้องส่งคีย์เดิม (replay → ผล + job เดิม) */
  idempotencyKey: string;
}

/** ผล print intent ที่ส่งกลับให้ client (reference + job ids + notice — client ไม่พิมพ์เอง) */
export interface UnifiedPosSettleReceiptView {
  readonly reference: string;
  readonly receiptJobId: string | null;
  readonly stationJobIds: readonly string[];
  readonly receiptNotice: string | null;
  readonly stationNotice: string | null;
}

export type UnifiedPosSettleBillResult =
  | {
      ok: true;
      replayed: boolean;
      result: UnifiedPosSettlementResult;
      receipt: UnifiedPosSettleReceiptView;
    }
  | { ok: false; code: string | null; error: string; stale: boolean };

/**
 * ชำระบิลจากแท็บบิล — เส้นทาง governed เดียวกับ surfaces เดิม (U7):
 *   settleOrdersGoverned (RPC unified_pos_settle_table_order) → สำเร็จแล้วค่อย
 *   resolve print intent "หลัง commit" (ห้ามสร้าง print job ใน transaction ของ RPC)
 * Idempotency: client สร้าง idempotencyKey ต่อคำขอและ reuse ตอน retry —
 *   replay คืนผลเดิม + job id เดิม (intent ใช้ source key จาก operation key เดิม)
 */
export async function settleUnifiedPosBillAction(
  input: UnifiedPosSettleBillInput,
): Promise<UnifiedPosSettleBillResult> {
  const fail = (error: string, code: string | null = null, stale = false): UnifiedPosSettleBillResult => ({
    ok: false,
    code,
    error,
    stale,
  });
  try {
    await requirePermission("pos.use");
    const { user, ctx } = await getStoreContext();
    if (!UUID_RE.test(input.tableId)) return fail("โต๊ะไม่ถูกต้อง");
    if (!isValidOperationKey(input.idempotencyKey)) return fail("คีย์ของคำขอไม่ถูกต้อง");
    if (input.mode !== "partial" && input.mode !== "whole_table") return fail("โหมดการชำระไม่ถูกต้อง");
    const orderIds = [...(input.orderIds ?? [])];
    if (input.mode === "partial" && orderIds.some((id) => !UUID_RE.test(id))) {
      return fail("รายการออเดอร์ไม่ถูกต้อง");
    }

    const settled = await settleOrdersGoverned({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      mode: input.mode,
      orderIds: input.mode === "partial" ? orderIds : undefined,
      tableId: input.tableId,
      method: input.method,
      amount: input.amount ?? null,
      receivedAmount: input.receivedAmount ?? null,
      changeAmount: input.changeAmount ?? null,
      reference: input.reference ?? null,
      actorUserId: user.id,
      idempotencyKey: input.idempotencyKey,
    });
    if (!settled.ok) {
      const code = settled.error.code;
      // stale = ผิดพลาดที่ "ข้อมูลบิลเปลี่ยนไป" — client ต้อง refetch จาก server truth:
      // version เก่า / transition ต้องห้าม / ยอดไม่ตรง (บิลมีรายการใหม่ระหว่างเปิดค้าง) /
      // key เดิม payload ต่าง (hash_conflict)
      const stale =
        code === UNIFIED_POS_ERROR_CODES.stale_version ||
        code === UNIFIED_POS_ERROR_CODES.invalid_state_transition ||
        code === UNIFIED_POS_ERROR_CODES.invalid_payment ||
        code === UNIFIED_POS_ERROR_CODES.hash_conflict;
      return fail(settled.error.userMessage, code, stale);
    }

    // Print intent — post-commit เท่านั้น (RPC สำเร็จ + commit แล้ว); replay ก็เรียก
    // ได้เสมอเพราะ intent dedupe ด้วย source key จาก operation key เดิม → job id เดิม
    const intent = await resolveSettlementPrintIntent({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      settlement: settled.result,
      operationKey: input.idempotencyKey,
      replayed: settled.replayed,
    });

    revalidatePath("/pos", "page");
    return {
      ok: true,
      replayed: settled.replayed,
      result: settled.result,
      receipt: {
        reference: intent.reference,
        receiptJobId: intent.receiptJobId,
        stationJobIds: intent.stationJobIds,
        receiptNotice: intent.receiptNotice,
        stationNotice: intent.stationNotice,
      },
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "เกิดข้อผิดพลาด");
  }
}

/**
 * พิมพ์ใบเสร็จซ้ำอย่างชัดเจน (explicit + audited) — action เดียวที่ client ใช้
 * สร้างงานพิมพ์เพิ่มหลังชำระ (client ไม่เคย browser-auto-print ผลของ replay)
 */
export async function reprintUnifiedPosReceiptAction(
  receiptReference: string,
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  try {
    await requirePermission("pos.use");
    const { user, ctx } = await getStoreContext();
    if (!receiptReference.startsWith("unified_pos_settlement:")) {
      return { ok: false, error: "อ้างอิงใบเสร็จไม่ถูกต้อง" };
    }
    const result = await reprintUnifiedPosReceipt({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      receiptReference,
    });
    if (!result.ok) return { ok: false, error: result.message };
    return { ok: true, jobId: result.jobId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
