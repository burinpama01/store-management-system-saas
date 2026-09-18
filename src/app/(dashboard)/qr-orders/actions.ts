"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { updateOrderPrepStatus, resolveServiceRequest, voidQrOrderItem } from "@/modules/qr-ordering/repository";
import type { PrepStatus } from "@/modules/qr-ordering/types";
import { logSystemEvent } from "@/modules/system/event-log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// U5: เพิ่ม 'ready' — เส้นทาง governed จะแปลงเป็น item-level moves ให้เอง
const PREP_STATUSES: PrepStatus[] = ["new", "preparing", "ready", "served", "done"];

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function updatePrepStatusAction(
  orderId: string,
  prepStatus: PrepStatus,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { user, ctx } = await getStoreContext();
    if (!UUID_RE.test(orderId)) return { error: "ออร์เดอร์ไม่ถูกต้อง" };
    if (!PREP_STATUSES.includes(prepStatus)) return { error: "สถานะไม่ถูกต้อง" };
    if (ctx.role === "staff") {
      return { error: "พนักงานครัวไม่สามารถเปลี่ยนสถานะทั้งออร์เดอร์" };
    }

    const result = await updateOrderPrepStatus(orderId, ctx.storeId, prepStatus, user.id);
    if (result.error) {
      // รับออเดอร์ = ตัดสต๊อกที่จองไว้จริง (trigger qr_order_stock_lifecycle) — ของไม่พอต้องปฏิเสธรายการก่อน
      const stockShort = /เหลือไม่พอ|สต๊อกไม่เพียงพอ/.test(result.error.userMessage);
      await logSystemEvent({
        level: "warn",
        source: "qr.kitchen",
        action: "updatePrepStatus",
        message: `เปลี่ยนสถานะออเดอร์ไม่สำเร็จ: ${result.error.userMessage}`,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        actorUserId: user.id,
        context: { orderId, prepStatus },
      });
      return {
        error: stockShort
          ? `${result.error.userMessage} — กด "ปฏิเสธ" รายการที่หมดก่อน แล้วค่อยรับออเดอร์`
          : result.error.userMessage,
      };
    }
    await logSystemEvent({
      level: "info",
      source: "qr.kitchen",
      action: prepStatus === "preparing" ? "acceptOrder" : "updatePrepStatus",
      message: prepStatus === "preparing" ? "ครัวรับออเดอร์ (ตัดสต๊อกที่จองไว้)" : `เปลี่ยนสถานะออเดอร์เป็น ${prepStatus}`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { orderId, prepStatus },
    });
    revalidatePath("/qr-orders", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function voidQrOrderItemAction(
  orderId: string,
  itemId: string,
  reason?: string,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(orderId) || !UUID_RE.test(itemId)) return { error: "รายการไม่ถูกต้อง" };
    const trimmed = reason?.trim().slice(0, 100) || null;

    const result = await voidQrOrderItem(ctx.storeId, orderId, itemId, trimmed);
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/qr-orders", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/**
 * ครัวปฏิเสธทั้งออเดอร์ — ปฏิเสธทีละรายการผ่าน void_qr_order_item (คืนยอดจอง/สต๊อก +
 * ยกเลิกออเดอร์เมื่อไม่เหลือรายการ) แต่ละรายการเป็น transaction ของตัวเอง
 */
export async function rejectQrOrderAction(
  orderId: string,
  itemIds: string[],
  reason?: string,
): Promise<{ error: string | null; rejected: number }> {
  try {
    await requirePermission("orders.manage_qr");
    const { user, ctx } = await getStoreContext();
    if (!UUID_RE.test(orderId) || itemIds.length === 0 || !itemIds.every((id) => UUID_RE.test(id))) {
      return { error: "รายการไม่ถูกต้อง", rejected: 0 };
    }
    if (ctx.role === "staff") {
      return { error: "พนักงานครัวไม่สามารถปฏิเสธทั้งออร์เดอร์", rejected: 0 };
    }
    const trimmed = reason?.trim().slice(0, 100) || "ครัวปฏิเสธออเดอร์";
    let rejected = 0;
    for (const itemId of itemIds) {
      const result = await voidQrOrderItem(ctx.storeId, orderId, itemId, trimmed);
      if (result.error) {
        await logSystemEvent({
          level: "warn",
          source: "qr.kitchen",
          action: "rejectOrder",
          message: `ปฏิเสธออเดอร์ไม่ครบ: ${result.error.userMessage}`,
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          actorUserId: user.id,
          context: { orderId, rejected, total: itemIds.length },
        });
        revalidatePath("/qr-orders", "page");
        return { error: result.error.userMessage, rejected };
      }
      rejected += 1;
    }
    await logSystemEvent({
      level: "info",
      source: "qr.kitchen",
      action: "rejectOrder",
      message: `ครัวปฏิเสธออเดอร์ ${rejected} รายการ (คืนสต๊อก)`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { orderId, rejected, reason: trimmed },
    });
    revalidatePath("/qr-orders", "page");
    return { error: null, rejected };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", rejected: 0 };
  }
}

export async function resolveServiceRequestAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { user, ctx } = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "คำขอไม่ถูกต้อง" };

    const result = await resolveServiceRequest(id, ctx.storeId, user.id);
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/qr-orders", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
