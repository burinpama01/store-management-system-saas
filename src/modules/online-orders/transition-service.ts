// เส้นทางเปลี่ยนสถานะออเดอร์ออนไลน์ (เงิน/คนส่ง/COD) — ใช้ร่วมกันระหว่างหน้า สั่งออนไลน์/POS และหน้าคนส่ง (R4)
// ผู้เรียกต้องตรวจสิทธิ์ + ร้านของผู้ใช้มาแล้ว (guard ต่างกันได้ แต่กติกาเงินอยู่ที่เดียว)

import { addPaymentAndClose, voidOrder } from "@/modules/pos/order-repository";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { logSystemEvent } from "@/modules/system/event-log";
import { isOpsManagerRole } from "@/modules/operations/access";
import { STATUS_LABEL, canTransition, computeRiderPay, type CodCollectMethod, type OnlineOrderStatus } from "./core";
import {
  getOnlineOrderForStore,
  getOnlineOrderSettings,
  listRiderCandidates,
  recordRiderPayAdjustment,
  transitionOnlineOrder,
} from "./repository";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TransitionActor {
  user: { id: string };
  ctx: { organizationId: string; storeId: string };
  resolved: { can: (permission: never) => boolean; role: string };
}

export interface TransitionOptions {
  reason?: string;
  /** ออกไปส่ง (ส่งถึงบ้าน) ต้องระบุคนส่ง */
  riderUserId?: string;
  /** ส่งสำเร็จแบบเก็บปลายทาง ต้องระบุวิธีรับเงิน */
  codMethod?: CodCollectMethod;
  /** แหล่งที่เรียก (log) */
  via?: "queue" | "rider";
}

function log(
  level: "info" | "warn" | "error",
  action: string,
  message: string,
  g: TransitionActor,
  context?: Record<string, unknown>,
) {
  void logSystemEvent({
    level,
    source: "online-orders",
    action,
    message,
    organizationId: g.ctx.organizationId,
    storeId: g.ctx.storeId,
    actorUserId: g.user.id,
    context,
  });
}

/** เปลี่ยนสถานะ + ผลข้างเคียงทางเงิน (ล็อกรายได้คนส่ง, เก็บปลายทาง, void, รายได้เข้าเงินเดือน) */
export async function performOnlineOrderTransition(
  g: TransitionActor,
  id: string,
  to: OnlineOrderStatus,
  opts: TransitionOptions = {},
): Promise<{ ok: boolean; error: string | null }> {
  const { reason, riderUserId, codMethod } = opts;
  const can = (p: string) => g.resolved.can(p as never);
  const order = await getOnlineOrderForStore(g.ctx.storeId, id);
  if (!order) return { ok: false, error: "ไม่พบออเดอร์" };
  if (!canTransition(order.status, to, order.fulfillment, order.paymentMethod)) return { ok: false, error: "เปลี่ยนเป็นสถานะนี้ไม่ได้" };
  if (to === "refund_pending" && !isOpsManagerRole(g.resolved.role)) {
    return { ok: false, error: "ยกเลิกออเดอร์ที่จ่ายแล้วได้เฉพาะเจ้าของหรือแอดมิน" };
  }
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {};
  if (to === "completed") patch.completed_at = now;
  if (to === "refunded") patch.refunded_at = now;
  if (to === "refund_pending") patch.cancel_reason = (reason ?? "").trim().slice(0, 200) || "ร้านยกเลิก";
  // R2: ออกไปส่ง = เลือกคนส่ง + ล็อกอัตรา/ยอดรายได้คนส่ง ณ ตอนนี้ (ร้านเปลี่ยนตั้งค่าทีหลังไม่ย้อน)
  if (to === "out_for_delivery" && order.fulfillment === "delivery") {
    if (!riderUserId || !UUID_RE.test(riderUserId)) return { ok: false, error: "เลือกคนส่งก่อน" };
    const [riders, settings] = await Promise.all([listRiderCandidates(g.ctx.storeId), getOnlineOrderSettings(g.ctx.storeId)]);
    const rider = riders.find((r) => r.userId === riderUserId);
    if (!rider) return { ok: false, error: "คนส่งต้องเป็นพนักงานของสาขานี้ที่ยังไม่ลาออก" };
    patch.rider_user_id = rider.userId;
    patch.rider_name = rider.name.slice(0, 120);
    patch.rider_assigned_at = now;
    patch.rider_pay_rate = settings.riderPayEnabled ? settings.riderPayRate : null;
    patch.rider_pay_amount = settings.riderPayEnabled
      ? computeRiderPay({ subtotal: order.subtotal, deliveryFee: order.deliveryFee, rate: settings.riderPayRate, includeFee: settings.riderPayIncludeFee })
      : null;
  }
  // R3: ส่งสำเร็จแบบเก็บปลายทาง — โอน = ปิดบิลทันที · เงินสด = ค้างที่คนส่งจนคืนร้าน (ปิดบิลตอนนั้น)
  const isCod = order.paymentMethod === "cod";
  if (isCod && to === "completed") {
    if (codMethod !== "cash" && codMethod !== "bank_transfer" && codMethod !== "beam") {
      return { ok: false, error: "เลือกวิธีรับเงิน (เงินสด/โอน/Beam)" };
    }
    if (!can("pos.use")) return { ok: false, error: "ต้องมีสิทธิ์ใช้ POS เพื่อรับเงิน" };
    if (!order.orderId) return { ok: false, error: "ยังไม่มีบิลของออเดอร์นี้ — กดรับออเดอร์ก่อน" };
    patch.cod_collected_method = codMethod;
    if (codMethod === "beam") {
      // ปิดบิลด้วยเงิน Beam มาแล้วในทาง cod-beam (QR บนมือถือคนส่ง) — ที่นี่แค่ยืนยันว่าบิลปิดจริง
      const service = await createSupabaseServiceClient();
      const { data: bill } = await service.from("orders").select("status").eq("id", order.orderId).maybeSingle();
      if (bill?.status !== "paid") return { ok: false, error: "ยังไม่ได้รับเงินผ่าน Beam — ให้ลูกค้าสแกน QR ก่อน" };
      patch.cod_settled_at = now;
      patch.cod_settled_by = g.user.id;
    } else if (codMethod === "bank_transfer") {
      const closed = await addPaymentAndClose(order.orderId, g.ctx.storeId, g.user.id, {
        method: "bank_transfer",
        amount: order.total,
        reference: `COD:${order.orderCode}`,
      });
      if (closed.error) {
        log("error", "codCollect", `ปิดบิลเก็บปลายทาง (โอน) ไม่สำเร็จ ${order.orderCode}: ${closed.error.userMessage}`, g, { onlineOrderId: id });
        return { ok: false, error: `ปิดบิลไม่สำเร็จ: ${closed.error.userMessage}` };
      }
      patch.cod_settled_at = now;
      patch.cod_settled_by = g.user.id;
    } else {
      patch.cod_cash_held = order.total;
    }
  }
  // R3: ส่งไม่สำเร็จ/ร้านปฏิเสธ COD — ยกเลิกบิลที่เปิดค้าง (ไม่มีเงินเข้า)
  if (to === "delivery_failed") {
    patch.failure_reason = (reason ?? "").trim().slice(0, 200) || "ส่งไม่สำเร็จ";
    patch.failed_at = now;
    if (order.orderId) {
      const voided = await voidOrder(order.orderId, g.ctx.storeId, g.user.id, `ออนไลน์ ${order.orderCode}: ${String(patch.failure_reason)}`);
      if (!voided.ok) {
        // กดซ้ำหลังรอบก่อน void สำเร็จแต่เปลี่ยนสถานะไม่ทัน → บิล voided แล้ว ถือว่าผ่าน (ไม่งั้นค้างตลอด)
        const service = await createSupabaseServiceClient();
        const { data: bill } = await service.from("orders").select("status").eq("id", order.orderId).maybeSingle();
        if (bill?.status !== "voided") {
          log("error", "codDeliveryFailed", `ยกเลิกบิลเก็บปลายทางไม่สำเร็จ ${order.orderCode}`, g, { onlineOrderId: id });
          return { ok: false, error: "ยกเลิกบิลไม่สำเร็จ ลองอีกครั้ง" };
        }
      }
    }
  }
  const moved = await transitionOnlineOrder({ storeId: g.ctx.storeId, id, from: order.status, to, userId: g.user.id, patch });
  if (!moved) return { ok: false, error: "สถานะเปลี่ยนไปแล้ว — โหลดใหม่" };
  if (isCod && (to === "completed" || to === "delivery_failed")) {
    log(to === "delivery_failed" ? "warn" : "info", to === "completed" ? "codCollect" : "codDeliveryFailed",
      to === "completed"
        ? `เก็บปลายทาง ${order.orderCode} ฿${order.total} (${codMethod === "cash" ? "เงินสดค้างที่คนส่ง" : codMethod === "beam" ? "Beam QR ปิดบิลแล้ว" : "โอน ปิดบิลแล้ว"})`
        : `เก็บปลายทาง ${order.orderCode} ส่งไม่สำเร็จ: ${String(patch.failure_reason)}`,
      g, { onlineOrderId: id, codMethod: codMethod ?? null, riderUserId: order.riderUserId });
  }
  if (to === "out_for_delivery" && patch.rider_user_id) {
    log("info", "assignOnlineOrderRider", `ออเดอร์ออนไลน์ ${order.orderCode}: คนส่ง ${String(patch.rider_name)}`, g, {
      onlineOrderId: id,
      riderUserId: patch.rider_user_id,
      riderPayAmount: patch.rider_pay_amount,
    });
  }
  // R2: ส่งสำเร็จ → รายได้คนส่งเข้าเงินเดือน (1 ออเดอร์ 1 แถว — unique online_order_id)
  let riderPayError: string | null = null;
  if (to === "completed" && order.fulfillment === "delivery" && order.riderUserId && (order.riderPayAmount ?? 0) > 0) {
    const result = await recordRiderPayAdjustment({
      organizationId: g.ctx.organizationId,
      storeId: g.ctx.storeId,
      onlineOrderId: id,
      orderCode: order.orderCode,
      riderUserId: order.riderUserId,
      riderName: order.riderName ?? "พนักงาน",
      amount: order.riderPayAmount as number,
      createdByUserId: g.user.id,
    });
    if (result === "created" || result === "exists") {
      log("info", "recordRiderPay", `รายได้คนส่ง ${order.riderName ?? ""} ฿${order.riderPayAmount} (${order.orderCode}) ${result === "exists" ? "มีอยู่แล้ว" : "เข้าเงินเดือนแล้ว"}`, g, {
        onlineOrderId: id,
        riderUserId: order.riderUserId,
        amount: order.riderPayAmount,
        result,
      });
    } else {
      riderPayError = result;
      log("error", "recordRiderPay", `บันทึกรายได้คนส่งไม่สำเร็จ (${order.orderCode}): ${result}`, g, { onlineOrderId: id, riderUserId: order.riderUserId });
    }
  }
  log(to === "refund_pending" ? "warn" : "info", "updateOnlineOrderStatus", `ออเดอร์ออนไลน์ ${order.orderCode}: ${STATUS_LABEL[order.status]} → ${STATUS_LABEL[to]}`, g, {
    onlineOrderId: id,
    from: order.status,
    to,
    billOrderId: order.orderId,
  });
  if (riderPayError) {
    return {
      ok: true,
      error: `ส่งสำเร็จแล้ว แต่บันทึกค่าส่งของคนส่งไม่สำเร็จ — เพิ่มเองที่หน้าพนักงาน เป็น "โบนัส/เพิ่ม" ฿${order.riderPayAmount} หมายเหตุ "ส่งออนไลน์ ${order.orderCode}"`,
    };
  }
  return { ok: true, error: null };
}
