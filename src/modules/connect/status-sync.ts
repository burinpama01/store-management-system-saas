// บริการ sync สถานะออเดอร์ สองทาง (Flow 3) + กัน loop ด้วย origin tagging
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { pushOrderStatus } from "./jdc-client";
import {
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

/** ยกเลิก/ปิดออเดอร์ภายในให้สอดคล้องกับ fulfillment (เฉพาะกรณีที่กระทบ orders) */
async function syncInternalOrderStatus(
  internalOrderId: string | null,
  fulfillment: FulfillmentStatus,
): Promise<void> {
  if (!internalOrderId) return;
  if (fulfillment !== "cancelled") return; // completed: ออเดอร์ยังเป็น paid; อื่น ๆ ไม่แตะ
  const supabase = await createSupabaseServiceClient();
  await supabase
    .from("orders")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", internalOrderId);
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
