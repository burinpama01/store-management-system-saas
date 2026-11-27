// R3b: เก็บเงินปลายทางด้วย Beam QR บนมือถือคนส่ง/หน้าร้าน
//
// ห้ามผูก online_order_id ใน gateway_payments — trigger promote_online_order_on_gateway_paid
// จะพยายามเลื่อนออเดอร์เป็น "paid" (ออเดอร์ COD กำลังไปส่งอยู่ → ตกเป็น LATE_PAID)
// ใช้ทางเดียวกับ QR ใน POS: สร้าง QR → รอ PAID → ผูกกับบิล → ปิดบิล → ยืนยัน แล้วเปลี่ยนเป็นสำเร็จ
// รายการชำระของออเดอร์ = storeos_reference "beam:cod-<onlineOrderId>-<รอบ>" (รอบใหม่เมื่อ QR หมดอายุ)
// ผู้เรียกต้องตรวจสิทธิ์ + ว่าเป็นงานของคนนี้ก่อน — ที่นี่ใช้ service client

import { addPaymentAndClose } from "@/modules/pos/order-repository";
import {
  claimBeamPaymentForOrder,
  createBeamQrPayment,
  finalizeBeamPaymentForOrder,
  refreshBeamPayment,
  releaseBeamPaymentClaim,
} from "@/modules/payments/beam-service";
import type { BeamQrForPos } from "@/modules/payments/types";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { logSystemEvent } from "@/modules/system/event-log";
import type { OnlineOrder } from "./repository";
import { performOnlineOrderTransition, type TransitionActor } from "./transition-service";

// ตรงกับ OPEN_STATUSES ใน beam-service (รายการที่ยังรอลูกค้าจ่าย)
const OPEN = ["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING"];
/** เงินเข้าแล้วแต่ต้องให้ร้านตรวจ (ยอดไม่ตรง/จ่ายหลังยกเลิก) — ห้ามสร้าง QR ใหม่ให้ลูกค้าจ่ายซ้ำ */
const NEEDS_REVIEW = ["REVIEW_REQUIRED", "LATE_PAID"];
export const COD_BEAM_REVIEW_ERROR = "ลูกค้าจ่ายแล้วแต่ยอด/สถานะต้องตรวจ — แจ้งร้านตรวจที่ ตั้งค่า → การชำระเงิน ห้ามสร้าง QR ใหม่";

export function codBeamReferencePrefix(onlineOrderId: string): string {
  return `beam:cod-${onlineOrderId}-`;
}

function check(order: OnlineOrder): string | null {
  if (order.paymentMethod !== "cod") return "ออเดอร์นี้จ่ายแล้ว ไม่ต้องเก็บเงิน";
  if (order.status !== "out_for_delivery") return "เก็บเงินได้เมื่อออเดอร์กำลังไปส่ง";
  if (!order.orderId) return "ยังไม่มีบิลของออเดอร์นี้";
  return null;
}

/** รายการชำระ Beam ล่าสุดของออเดอร์นี้ (รอบล่าสุด) */
async function latestAttempt(storeId: string, onlineOrderId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่าน gateway_payments ด้วย service client
  const db: any = await createSupabaseServiceClient();
  const { data } = await db
    .from("gateway_payments")
    .select("id, status, storeos_reference, created_at")
    .eq("store_id", storeId)
    .eq("provider_key", "beam")
    .like("storeos_reference", `${codBeamReferencePrefix(onlineOrderId)}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = (data as { id: string; status: string; storeos_reference: string }[] | null)?.[0];
  if (!row) return null;
  const round = Number(row.storeos_reference.slice(codBeamReferencePrefix(onlineOrderId).length)) || 1;
  return { id: row.id, status: row.status, round };
}

/** เริ่ม/ใช้ QR เดิมของออเดอร์ (QR เดิมยังเปิดอยู่ = ใช้ต่อ · จ่ายแล้ว = คืน PAID · หมดอายุ = รอบใหม่) */
export async function startCodBeamQr(g: TransitionActor, order: OnlineOrder): Promise<{ qr: BeamQrForPos | null; error: string | null }> {
  const bad = check(order);
  if (bad) return { qr: null, error: bad };
  const service = await createSupabaseServiceClient();
  const last = await latestAttempt(g.ctx.storeId, order.id);
  if (last && NEEDS_REVIEW.includes(last.status)) return { qr: null, error: COD_BEAM_REVIEW_ERROR };
  const round = !last ? 1 : OPEN.includes(last.status) || last.status === "PAID" ? last.round : last.round + 1;
  const created = await createBeamQrPayment({
    organizationId: g.ctx.organizationId,
    storeId: g.ctx.storeId,
    amountMajor: order.total,
    // clientRequestId → storeos_reference "beam:cod-<id>-<รอบ>"
    clientRequestId: `cod-${order.id}-${round}`,
    actorUserId: g.user.id,
    client: service,
  });
  void logSystemEvent({
    level: created.ok ? "info" : "error",
    source: "online-orders",
    action: "codBeamQr",
    message: created.ok ? `QR Beam เก็บปลายทาง ${order.orderCode} ฿${order.total} (รอบ ${round})` : `สร้าง QR Beam เก็บปลายทางไม่สำเร็จ ${order.orderCode}: ${created.error}`,
    organizationId: g.ctx.organizationId,
    storeId: g.ctx.storeId,
    actorUserId: g.user.id,
    context: { onlineOrderId: order.id, round },
  });
  return created.ok ? { qr: created.qr, error: null } : { qr: null, error: created.error };
}

/**
 * ถามสถานะ QR — จ่ายแล้วปิดบิลด้วยเงิน Beam + เปลี่ยนออเดอร์เป็นสำเร็จ (รายได้คนส่งเข้าเงินเดือนตามปกติ)
 * กดซ้ำ/ถามซ้ำได้: บิลปิดแล้วข้ามขั้นปิด · ออเดอร์สำเร็จแล้วคืน done
 */
export async function settleCodBeamIfPaid(
  g: TransitionActor,
  order: OnlineOrder,
  gatewayPaymentId: string,
): Promise<{ status: string; done: boolean; error: string | null }> {
  if (order.status === "completed" && order.codCollectedMethod === "beam") {
    // รอบก่อนอาจค้างก่อนผูก pos_payment_id — ผูกให้ครบ (ประวัติ Beam ไม่ขึ้น "ยังไม่ผูก")
    if (order.orderId) await ensureFinalized(g, order.orderId, gatewayPaymentId);
    return { status: "PAID", done: true, error: null };
  }
  const bad = check(order);
  if (bad) return { status: "UNKNOWN", done: false, error: bad };
  const service = await createSupabaseServiceClient();
  // QR ต้องเป็นของออเดอร์นี้จริง (กันเอาเงินของรายการอื่นมาปิด)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่าน gateway_payments ด้วย service client
  const { data: gw } = await (service as any)
    .from("gateway_payments")
    .select("storeos_reference")
    .eq("id", gatewayPaymentId)
    .eq("store_id", g.ctx.storeId)
    .maybeSingle();
  if (!gw || !String(gw.storeos_reference ?? "").startsWith(codBeamReferencePrefix(order.id))) {
    return { status: "UNKNOWN", done: false, error: "QR นี้ไม่ใช่ของออเดอร์นี้" };
  }
  const refreshed = await refreshBeamPayment({ storeId: g.ctx.storeId, gatewayPaymentId, client: service, minLookupIntervalMs: 5_000 });
  if (!refreshed.ok) return { status: "UNKNOWN", done: false, error: refreshed.error };
  if (NEEDS_REVIEW.includes(refreshed.status)) {
    return { status: refreshed.status, done: false, error: COD_BEAM_REVIEW_ERROR };
  }
  if (refreshed.status !== "PAID") {
    return { status: refreshed.status, done: false, error: OPEN.includes(refreshed.status) ? null : "QR หมดอายุ/ยกเลิก — สร้าง QR ใหม่" };
  }
  const billId = order.orderId as string;
  const { data: bill } = await service.from("orders").select("status").eq("id", billId).maybeSingle();
  if (bill?.status !== "paid") {
    const claimed = await claimBeamPaymentForOrder({ storeId: g.ctx.storeId, gatewayPaymentId, orderId: billId, expectedAmount: order.total, client: service });
    if (!claimed.ok) return { status: "PAID", done: false, error: claimed.error };
    const closed = await addPaymentAndClose(billId, g.ctx.storeId, g.user.id, { method: "other", amount: claimed.amount, reference: `BEAM:${gatewayPaymentId}` });
    if (closed.error) {
      await releaseBeamPaymentClaim({ storeId: g.ctx.storeId, gatewayPaymentId, orderId: billId, client: service });
      void logSystemEvent({
        level: "error",
        source: "online-orders",
        action: "codBeamSettle",
        message: `ได้รับเงิน Beam แล้วแต่ปิดบิลไม่สำเร็จ ${order.orderCode}: ${closed.error.userMessage}`,
        organizationId: g.ctx.organizationId,
        storeId: g.ctx.storeId,
        actorUserId: g.user.id,
        context: { onlineOrderId: order.id, gatewayPaymentId },
      });
      return { status: "PAID", done: false, error: `ได้รับเงินแล้วแต่ปิดบิลไม่สำเร็จ: ${closed.error.userMessage} — กดตรวจอีกครั้ง` };
    }
    await finalizeBeamPaymentForOrder({
      organizationId: g.ctx.organizationId,
      storeId: g.ctx.storeId,
      gatewayPaymentId,
      orderId: billId,
      posPaymentId: closed.data.id,
      actorUserId: g.user.id,
      client: service,
    });
  } else {
    // บิลปิดแล้ว (รอบก่อนค้างกลางทาง) — ต้องปิดด้วยรายการนี้จริง ไม่งั้นเงินก้อนนี้เป็นเงินเกิน
    const ok = await ensureFinalized(g, billId, gatewayPaymentId);
    if (!ok) return { status: "PAID", done: false, error: "บิลนี้ปิดด้วยรายการอื่นแล้ว — แจ้งร้านตรวจเงิน Beam ก้อนนี้ (อาจต้องคืนเงิน)" };
  }
  const moved = await performOnlineOrderTransition(g, order.id, "completed", { codMethod: "beam", via: "rider" });
  if (!moved.ok) return { status: "PAID", done: false, error: moved.error };
  return { status: "PAID", done: true, error: moved.error };
}

/**
 * บิลปิดด้วยเงิน Beam รายการนี้แล้วหรือยัง + ผูก pos_payment_id ถ้ายังค้าง (กดตรวจซ้ำหลังรอบก่อนล้มกลางทาง)
 * คืน false = บิลไม่ได้ปิดด้วยรายการนี้
 */
async function ensureFinalized(g: TransitionActor, billId: string, gatewayPaymentId: string): Promise<boolean> {
  const service = await createSupabaseServiceClient();
  const { data: pay } = await service
    .from("payments")
    .select("id")
    .eq("order_id", billId)
    .eq("reference", `BEAM:${gatewayPaymentId}`)
    .limit(1)
    .maybeSingle();
  if (!pay) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่าน gateway_payments ด้วย service client
  const { data: gw } = await (service as any)
    .from("gateway_payments")
    .select("pos_payment_id")
    .eq("id", gatewayPaymentId)
    .eq("store_id", g.ctx.storeId)
    .maybeSingle();
  if (gw && !gw.pos_payment_id) {
    await finalizeBeamPaymentForOrder({
      organizationId: g.ctx.organizationId,
      storeId: g.ctx.storeId,
      gatewayPaymentId,
      orderId: billId,
      posPaymentId: pay.id,
      actorUserId: g.user.id,
      client: service,
    });
  }
  return true;
}
