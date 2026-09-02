"use server";

// U10 — Server actions ของคิวครัวใน unified shell (v0.37.1)
// เส้นทาง transition เดียว: action → repository (service client) → governed RPC
// unified_pos_update_item_fulfillment (U5) — ห้ามเขียน order_items ตรงจาก client เด็ดขาด
// ความสัมพันธ์กับ U3 realtime: snapshot ที่คืนจาก action ใช้เป็น server truth ตอน
// conflict (stale/invalid transition) / reconnect / polling fallback — ห้าม client สร้างเอง

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
