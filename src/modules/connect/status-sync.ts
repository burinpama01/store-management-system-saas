// บริการ sync สถานะออเดอร์ สองทาง (Flow 3) + กัน loop ด้วย origin tagging
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { pushOrderStatus } from "./jdc-client";
import {
  applyDeliveryStockDelta,
  getConnectOrder,
  recordEvent,
  updateConnectOrderStatus,
  type ChannelLink,
  type ConnectOrder,
} from "./repository";
import {
  canPosTransition,
  fulfillmentToJdcStatus,
  jdcStatusToFulfillment,
  type FulfillmentStatus,
} from "./types";

/**
 * ปรับสถานะ order ภายในให้สอดคล้องกับ fulfillment:
 * - completed (คนขับรับอาหาร/นำส่ง) → ชำระแล้ว (เงินไหลร้านตอนคนขับรับของ)
 * - cancelled → ยกเลิก
 * - อื่น ๆ ไม่แตะ (order ยังเป็น open รออยู่)
 */
async function syncInternalOrderStatus(
  internalOrderId: string | null,
  fulfillment: FulfillmentStatus,
): Promise<void> {
  if (!internalOrderId) return;
  const now = new Date().toISOString();
  const supabase = await createSupabaseServiceClient();
  if (fulfillment === "completed") {
    await supabase
      .from("orders")
      .update({ status: "paid", paid_at: now, updated_at: now })
      .eq("id", internalOrderId)
      .neq("status", "cancelled");
    return;
  }
  if (fulfillment === "cancelled") {
    // คืนสต็อกก่อน (อ่านรายการก่อนเปลี่ยนสถานะ) แล้วค่อยยกเลิก
    const { data: its } = await supabase
      .from("order_items")
      .select("product_id, quantity")
      .eq("order_id", internalOrderId);
    try {
      await applyDeliveryStockDelta(
        (its ?? []).map((r) => ({ productId: r.product_id, qty: r.quantity })),
        1,
      );
    } catch {
      /* คืนสต็อกผิดพลาดไม่บล็อกการยกเลิก */
    }
    await supabase
      .from("orders")
      .update({ status: "cancelled", updated_at: now })
      .eq("id", internalOrderId)
      .neq("status", "cancelled");
  }
}

/**
 * 3B — พนักงานกดเปลี่ยนสถานะจาก StoreOS POS → push ไป JDC
 * ติด origin='storeos' (ฝั่ง JDC จะไม่ยิงกลับ) + เคารพกติกายกเลิก
 */
export async function applyPosStatus(
  link: ChannelLink,
  connectOrder: ConnectOrder,
  next: FulfillmentStatus,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (next === connectOrder.fulfillmentStatus) return { ok: true }; // idempotent

  const gate = canPosTransition(connectOrder.fulfillmentStatus, next);
  if (!gate.ok) return { ok: false, error: gate.reason };

  const upd = await updateConnectOrderStatus(connectOrder.id, next, "storeos");
  if (!upd.ok) return { ok: false, error: upd.error ?? "อัปเดตสถานะไม่สำเร็จ" };

  await syncInternalOrderStatus(connectOrder.internalOrderId, next);

  const jdcStatus = fulfillmentToJdcStatus(next);
  if (jdcStatus) {
    const res = await pushOrderStatus(link, connectOrder.externalOrderId, jdcStatus);
    await recordEvent({
      linkId: link.id,
      direction: "outbound",
      topic: "order.status",
      payload: { booking_id: connectOrder.externalOrderId, status: jdcStatus },
      status: res.ok ? "sent" : "failed",
      lastError: res.ok ? null : `HTTP ${res.status}: ${res.body.slice(0, 300)}`,
    });
    if (!res.ok) return { ok: false, error: `ส่งสถานะไป JDC ไม่สำเร็จ (HTTP ${res.status})` };
  }
  return { ok: true };
}

/**
 * 3A — รับสถานะจาก JDC (webhook order.status) → อัปเดต connect_orders เท่านั้น
 * ติด origin='jdc' และ "ไม่ push กลับ" (กัน loop)
 */
export async function applyInboundStatus(
  link: ChannelLink,
  externalOrderId: string,
  jdcStatus: string,
): Promise<{ ok: boolean; ignored?: boolean }> {
  const co = await getConnectOrder(link.id, externalOrderId);
  if (!co) return { ok: true, ignored: true };

  const next = jdcStatusToFulfillment(jdcStatus);
  if (next === co.fulfillmentStatus) return { ok: true, ignored: true }; // idempotent / no-op

  await updateConnectOrderStatus(co.id, next, "jdc");
  await syncInternalOrderStatus(co.internalOrderId, next);
  return { ok: true };
}
