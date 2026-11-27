"use server";

import { revalidatePath } from "next/cache";
import { performOnlineOrderTransition, type TransitionActor } from "@/modules/online-orders/transition-service";
import { settleCodBeamIfPaid, startCodBeamQr } from "@/modules/online-orders/cod-beam";
import type { BeamQrForPos } from "@/modules/payments/types";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isOpsManagerRole } from "@/modules/operations/access";
import { addPaymentAndClose } from "@/modules/pos/order-repository";
import {
  claimBeamPaymentForOrder,
  finalizeBeamPaymentForOrder,
  isBeamReadyForStore,
  releaseBeamPaymentClaim,
} from "@/modules/payments/beam-service";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getStoreWebsite } from "@/modules/store-website/repository";
import { logSystemEvent } from "@/modules/system/event-log";
import {
  STATUS_LABEL,
  onlineOrderSettingsSchema,
  type CodCollectMethod,
  type OnlineOrderSettings,
  type OnlineOrderStatus,
} from "@/modules/online-orders/core";
import {
  expireStaleOnlineOrders,
  getAttendanceOrigin,
  getOnlineOrderSettings,
  listAwaitingOnlineOrders,
  listRiderCandidates,
  type RiderCandidate,
  getOnlineOrderForStore,
  listOnlineOrdersForStore,
  saveOnlineOrderSettings,
  transitionOnlineOrder,
  type OnlineOrder,
} from "@/modules/online-orders/repository";

type ActionResult = { ok: boolean; error: string | null };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** คิวออนไลน์: พนักงานที่จัดการออเดอร์ QR/เดลิเวอรีได้ + องค์กรยัง Enterprise ที่มี Payment Gateway */
async function queueGuard() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("orders.manage_qr")) return { error: "ไม่มีสิทธิ์จัดการออเดอร์ออนไลน์" as const };
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing) || !getPlanFeatures(billing).byoPaymentGateway) {
    return { error: "สั่งออนไลน์ใช้ได้เฉพาะแพ็กเกจ Enterprise" as const };
  }
  return { user, ctx, resolved, error: null };
}

function log(
  level: "info" | "warn" | "error",
  action: string,
  message: string,
  g: { user: { id: string }; ctx: { organizationId: string; storeId: string } },
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

export async function saveOnlineOrderSettingsAction(settings: OnlineOrderSettings): Promise<ActionResult> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!isOpsManagerRole(resolved.role)) return { ok: false, error: "เฉพาะเจ้าของหรือแอดมินที่ตั้งค่าสั่งออนไลน์ได้" };
    const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
    if (!canUseMemberPrivileges(billing) || !getPlanFeatures(billing).byoPaymentGateway) {
      return { ok: false, error: "สั่งออนไลน์ใช้ได้เฉพาะแพ็กเกจ Enterprise" };
    }
    // พิกัดร้าน = พิกัดลงเวลาเข้างาน (ถ้าตั้งไว้) — ค่าจากฟอร์มใช้เฉพาะร้านที่ยังไม่ตั้งจุดลงเวลา
    const attendanceOrigin = await getAttendanceOrigin(ctx.storeId);
    const parsed = onlineOrderSettingsSchema.safeParse(
      attendanceOrigin ? { ...settings, originLat: attendanceOrigin.lat, originLng: attendanceOrigin.lng } : settings,
    );
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "ตั้งค่าไม่ถูกต้อง" };
    const site = await getStoreWebsite(ctx.storeId);
    if (parsed.data.enabled) {
      if (!site) return { ok: false, error: "สร้างเว็บไซต์ร้านก่อนเปิดสั่งออนไลน์" };
      const service = await createSupabaseServiceClient();
      if (!(await isBeamReadyForStore(ctx.storeId, service))) {
        return { ok: false, error: "เปิด Beam ก่อน (ตั้งค่า → การชำระเงิน) — ระบบสั่งออนไลน์ต้องเปิด Beam (QR พร้อมเพย์) แม้จะเปิดเก็บเงินปลายทางด้วย" };
      }
    }
    const error = await saveOnlineOrderSettings({ storeId: ctx.storeId, organizationId: ctx.organizationId, settings: parsed.data, userId: user.id });
    const g = { user, ctx };
    log(error ? "error" : "info", "saveOnlineOrderSettings", error ? `บันทึกตั้งค่าสั่งออนไลน์ไม่สำเร็จ: ${error}` : `ตั้งค่าสั่งออนไลน์ (${parsed.data.enabled ? "เปิด" : "ปิด"})`, g, {
      enabled: parsed.data.enabled,
      pickup: parsed.data.pickupEnabled,
      delivery: parsed.data.deliveryEnabled,
    });
    if (error) return { ok: false, error: "บันทึกไม่สำเร็จ" };
    if (site?.slug) revalidatePath(`/s/${site.slug}`);
    revalidatePath("/website/orders");
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

export interface OnlineOrderVM {
  id: string;
  orderCode: string;
  status: OnlineOrderStatus;
  statusLabel: string;
  fulfillment: "pickup" | "delivery";
  customerName: string;
  customerPhone: string;
  address: string | null;
  addressNote: string | null;
  mapUrl: string | null;
  distanceKm: number | null;
  pickupAt: string | null;
  note: string | null;
  items: { name: string; detail: string; quantity: number; totalPrice: number }[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  orderId: string | null;
  /** บิล POS ปิดด้วยเงิน Beam แล้ว (false = รับแล้วแต่ขั้นปิดบิลค้าง กดซ้ำได้) */
  billClosed: boolean;
  paidAt: string | null;
  createdAt: string;
  /** R2: คนส่ง (ออนไลน์ส่งถึงบ้าน) */
  riderName: string | null;
  riderPayAmount: number | null;
  /** R3: เก็บเงินปลายทาง */
  paymentMethod: "beam" | "cod";
  codCollectedMethod: "cash" | "bank_transfer" | "beam" | null;
  /** เงินสดที่คนส่งเก็บมาแล้วยังไม่คืนร้าน (บิลยังไม่ปิด) */
  codCashPending: number | null;
  failureReason: string | null;
}

function toVM(o: OnlineOrder, closedBills: Set<string>): OnlineOrderVM {
  return {
    id: o.id,
    orderCode: o.orderCode,
    status: o.status,
    statusLabel: STATUS_LABEL[o.status],
    fulfillment: o.fulfillment,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    address: o.address,
    addressNote: o.addressNote,
    mapUrl: o.lat !== null && o.lng !== null ? `https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}` : null,
    distanceKm: o.distanceKm,
    pickupAt: o.pickupAt,
    note: o.note,
    items: o.items.map((line) => ({
      name: line.productName,
      detail: [line.variantName, ...line.modifiers.map((m) => m.option.name), line.note].filter(Boolean).join(" · "),
      quantity: line.quantity,
      totalPrice: line.totalPrice,
    })),
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    total: o.total,
    orderId: o.orderId,
    billClosed: o.orderId !== null && closedBills.has(o.orderId),
    paidAt: o.paidAt,
    createdAt: o.createdAt,
    riderName: o.riderName,
    riderPayAmount: o.riderPayAmount,
    paymentMethod: o.paymentMethod,
    codCollectedMethod: o.codCollectedMethod,
    codCashPending: o.paymentMethod === "cod" && o.codCollectedMethod === "cash" && !o.codSettledAt ? (o.codCashHeld ?? o.total) : null,
    failureReason: o.failureReason,
  };
}

/** R2: รายชื่อคนส่งที่เลือกได้ (คนลงเวลาอยู่ขึ้นก่อน) + ร้านเปิดรายได้คนส่งไหม */
export async function listRiderCandidatesAction(): Promise<{
  riders: RiderCandidate[];
  payEnabled: boolean;
  payRate: number;
  payIncludeFee: boolean;
  error: string | null;
}> {
  const g = await queueGuard();
  if (g.error !== null) return { riders: [], payEnabled: false, payRate: 0, payIncludeFee: false, error: g.error };
  const [riders, settings] = await Promise.all([listRiderCandidates(g.ctx.storeId), getOnlineOrderSettings(g.ctx.storeId)]);
  return { riders, payEnabled: settings.riderPayEnabled, payRate: settings.riderPayRate, payIncludeFee: settings.riderPayIncludeFee, error: null };
}

export async function listOnlineOrdersAction(): Promise<{ orders: OnlineOrderVM[]; error: string | null }> {
  const g = await queueGuard();
  if (g.error !== null) return { orders: [], error: g.error };
  await expireStaleOnlineOrders(g.ctx.storeId);
  const orders = await listOnlineOrdersForStore(g.ctx.storeId);
  const billIds = orders.map((o) => o.orderId).filter((id): id is string => Boolean(id));
  const closedBills = new Set<string>();
  if (billIds.length > 0) {
    const service = await createSupabaseServiceClient();
    const { data } = await service.from("orders").select("id, status").eq("store_id", g.ctx.storeId).in("id", billIds);
    for (const row of data ?? []) if (row.status === "paid") closedBills.add(row.id);
  }
  return { orders: orders.map((o) => toVM(o, closedBills)), error: null };
}

/**
 * รับออเดอร์: (1) จองสถานะ paid → accepted (กันสองเครื่องกดพร้อมกัน) (2) สร้างบิลจริงใน orders
 * (3) ปิดบิลด้วยเงิน Beam ผ่านเส้นทางปิดบิล POS เดิม (ตัดสต็อก/ยอดขาย/รายงานตามปกติ)
 * ขั้นไหนล้ม กดซ้ำได้ — สถานะ accepted + ยังไม่มีบิล/บิลยังไม่ปิด จะทำขั้นที่ค้างต่อ
 */
export async function acceptOnlineOrderAction(id: string): Promise<{ ok: boolean; error: string | null; orderId: string | null; orderNumber: string | null }> {
  const fail = (error: string) => ({ ok: false, error, orderId: null, orderNumber: null });
  try {
    if (!UUID_RE.test(id)) return fail("ไม่พบออเดอร์");
    const g = await queueGuard();
    if (g.error !== null) return fail(g.error);
    if (!g.resolved.can("pos.use")) return fail("ต้องมีสิทธิ์ใช้ POS เพื่อปิดบิล");
    let order = await getOnlineOrderForStore(g.ctx.storeId, id);
    if (!order) return fail("ไม่พบออเดอร์");
    const isCod = order.paymentMethod === "cod";
    if (order.status === "paid" || order.status === "cod_pending") {
      const moved = await transitionOnlineOrder({
        storeId: g.ctx.storeId,
        id,
        from: order.status,
        to: "accepted",
        userId: g.user.id,
        patch: { accepted_at: new Date().toISOString() },
      });
      if (!moved) return fail("มีคนรับออเดอร์นี้ไปแล้ว — โหลดใหม่");
      order = (await getOnlineOrderForStore(g.ctx.storeId, id)) ?? order;
    } else if (order.status !== "accepted") {
      return fail(`ออเดอร์อยู่ในสถานะ "${STATUS_LABEL[order.status]}" แล้ว`);
    }
    if (!isCod && !order.gatewayPaymentId) return fail("ไม่พบรายการชำระ Beam ของออเดอร์นี้");
    const gatewayPaymentId = order.gatewayPaymentId ?? "";

    const service = await createSupabaseServiceClient();
    let orderId = order.orderId;
    if (!orderId) {
      const label = order.fulfillment === "pickup" ? "รับที่ร้าน" : "ส่งถึงบ้าน";
      const note = [
        `ออนไลน์ ${order.orderCode} · ${label}`,
        `${order.customerName} ${order.customerPhone}`,
        order.deliveryFee > 0 ? `ค่าส่ง ${order.deliveryFee.toFixed(2)}` : null,
        order.note,
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 500);
      // บิลค้างจากรอบก่อนที่ล้มกลางทาง (order_number = รหัสออนไลน์ unique ต่อร้าน) → ใช้ต่อ ไม่สร้างซ้ำ
      const { data: orphan } = await service
        .from("orders")
        .select("id")
        .eq("store_id", order.storeId)
        .eq("order_number", order.orderCode)
        .eq("status", "open")
        .maybeSingle();
      const { data: created, error: orderErr } = orphan
        ? { data: orphan, error: null }
        : await service
        .from("orders")
        .insert({
          organization_id: order.organizationId,
          store_id: order.storeId,
          order_number: order.orderCode,
          status: "open",
          cashier_id: null,
          subtotal: order.subtotal,
          total: order.total,
          note,
          qr_order_source: false,
        })
        .select("id")
        .single();
      if (orderErr || !created) {
        log("error", "acceptOnlineOrder", `สร้างบิลออเดอร์ออนไลน์ไม่สำเร็จ: ${orderErr?.message ?? "unknown"}`, g, { onlineOrderId: id });
        return fail("สร้างบิลไม่สำเร็จ ลองกดรับอีกครั้ง");
      }
      // หมายเหตุ: ค่าส่งไม่ใช่รายการสินค้า → orders.total = ผลรวม order_items + ค่าส่ง (ระบุใน note)
      const { count: existingItems } = await service
        .from("order_items")
        .select("id", { count: "exact", head: true })
        .eq("order_id", created.id);
      const rows = order.items.map((line) => ({
        order_id: created.id,
        product_id: line.productId,
        product_name: line.productName,
        variant_id: line.variantId,
        variant_name: line.variantName,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        total_price: line.totalPrice,
        note: line.note,
        modifiers: line.modifiers as never,
        kitchen_station_id: line.kitchenStationId,
        kitchen_station_name: line.kitchenStationName,
      }));
      const { error: itemErr } = (existingItems ?? 0) > 0 ? { error: null } : await service.from("order_items").insert(rows);
      if (itemErr) {
        await service.from("orders").delete().eq("id", created.id).eq("status", "open");
        log("error", "acceptOnlineOrder", `สร้างรายการบิลออนไลน์ไม่สำเร็จ: ${itemErr.message}`, g, { onlineOrderId: id });
        return fail("สร้างรายการในบิลไม่สำเร็จ ลองกดรับอีกครั้ง");
      }
      // ผูกบิลแบบมีเงื่อนไข — ถ้าอีกเครื่องผูกไปก่อน ใช้ของเครื่องนั้นแล้วลบบิลที่เพิ่งสร้าง
      const { data: linked } = await (service as never as { from: (t: string) => any }) // eslint-disable-line @typescript-eslint/no-explicit-any -- ตารางใหม่
        .from("online_orders")
        .update({ order_id: created.id, updated_at: new Date().toISOString() })
        .eq("id", id)
        .is("order_id", null)
        .select("id")
        .maybeSingle();
      if (!linked) {
        await service.from("order_items").delete().eq("order_id", created.id);
        await service.from("orders").delete().eq("id", created.id).eq("status", "open");
        order = (await getOnlineOrderForStore(g.ctx.storeId, id)) ?? order;
        orderId = order.orderId;
        if (!orderId) return fail("ผูกบิลไม่สำเร็จ ลองอีกครั้ง");
      } else {
        orderId = created.id;
      }
    }

    // ปิดบิลด้วยเงิน Beam (ข้ามถ้าปิดไปแล้ว) · เก็บปลายทาง = บิลเปิดค้างจนรับเงิน (ส่งสำเร็จ/คืนเงินสด)
    const { data: billRow } = await service.from("orders").select("status, order_number").eq("id", orderId as string).maybeSingle();
    if (billRow && billRow.status !== "paid" && !isCod) {
      const claimed = await claimBeamPaymentForOrder({
        storeId: g.ctx.storeId,
        gatewayPaymentId: gatewayPaymentId,
        orderId: orderId as string,
        expectedAmount: order.total,
      });
      if (!claimed.ok) {
        log("error", "acceptOnlineOrder", `ผูกเงิน Beam กับบิลไม่สำเร็จ: ${claimed.error}`, g, { onlineOrderId: id, orderId });
        return fail(claimed.error);
      }
      const closed = await addPaymentAndClose(orderId as string, g.ctx.storeId, g.user.id, {
        method: "other",
        amount: claimed.amount,
        reference: `BEAM:${gatewayPaymentId}`,
      });
      if (closed.error) {
        await releaseBeamPaymentClaim({ storeId: g.ctx.storeId, gatewayPaymentId: gatewayPaymentId, orderId: orderId as string });
        log("error", "acceptOnlineOrder", `ปิดบิลออเดอร์ออนไลน์ไม่สำเร็จ: ${closed.error.userMessage}`, g, { onlineOrderId: id, orderId });
        return fail(`รับออเดอร์แล้วแต่ปิดบิลไม่สำเร็จ: ${closed.error.userMessage} — กดรับอีกครั้ง`);
      }
      await finalizeBeamPaymentForOrder({
        organizationId: g.ctx.organizationId,
        storeId: g.ctx.storeId,
        gatewayPaymentId: gatewayPaymentId,
        orderId: orderId as string,
        posPaymentId: closed.data.id,
        actorUserId: g.user.id,
      });
    }

    log("info", "acceptOnlineOrder", `รับออเดอร์ออนไลน์ ${order.orderCode}`, g, { onlineOrderId: id, orderId, total: order.total });
    revalidatePath("/website/orders");
    return { ok: true, error: null, orderId, orderNumber: billRow?.order_number ?? order.orderCode };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "รับออเดอร์ไม่สำเร็จ");
  }
}

/** เปลี่ยนสถานะอื่น ๆ (กำลังทำ/พร้อมรับ/กำลังส่ง/สำเร็จ/ยกเลิกรอคืนเงิน/คืนเงินแล้ว) */
export async function updateOnlineOrderStatusAction(
  id: string,
  to: OnlineOrderStatus,
  reason?: string,
  /** R2: ออกไปส่ง (ส่งถึงบ้าน) ต้องระบุคนส่ง */
  riderUserId?: string,
  /** R3: ส่งสำเร็จแบบเก็บปลายทาง ต้องระบุวิธีรับเงิน */
  codMethod?: CodCollectMethod,
): Promise<ActionResult> {
  try {
    if (!UUID_RE.test(id)) return { ok: false, error: "ไม่พบออเดอร์" };
    const g = await queueGuard();
    if (g.error !== null) return { ok: false, error: g.error };
    if (to === "accepted") return { ok: false, error: "ใช้ปุ่มรับออเดอร์" };
    // g จาก getResolvedCurrentPermissions มีรูปตรง TransitionActor
    const res = await performOnlineOrderTransition(g as unknown as TransitionActor, id, to, { reason, riderUserId, codMethod, via: "queue" });
    if (res.ok) revalidatePath("/website/orders");
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "เปลี่ยนสถานะไม่สำเร็จ" };
  }
}

/**
 * R3: คนส่งกลับร้านพร้อมเงินสดเก็บปลายทาง → ปิดบิลเงินสดเข้ารอบเงินสดที่เปิดอยู่
 * กันกดซ้ำ: ปิดบิลก่อน (RPC ปิดซ้ำไม่ได้) แล้วจอง cod_settled_at แบบมีเงื่อนไข
 */
export async function settleCodCashAction(id: string): Promise<ActionResult> {
  try {
    if (!UUID_RE.test(id)) return { ok: false, error: "ไม่พบออเดอร์" };
    const g = await queueGuard();
    if (g.error !== null) return { ok: false, error: g.error };
    if (!g.resolved.can("pos.use")) return { ok: false, error: "ต้องมีสิทธิ์ใช้ POS เพื่อรับเงิน" };
    const order = await getOnlineOrderForStore(g.ctx.storeId, id);
    if (!order || order.paymentMethod !== "cod" || order.codCollectedMethod !== "cash") return { ok: false, error: "ไม่พบเงินค้างของออเดอร์นี้" };
    if (order.codSettledAt) return { ok: true, error: null };
    if (!order.orderId) return { ok: false, error: "ไม่พบบิลของออเดอร์นี้" };
    const service = await createSupabaseServiceClient();
    const { data: bill } = await service.from("orders").select("status").eq("id", order.orderId).maybeSingle();
    if (bill?.status !== "paid") {
      const closed = await addPaymentAndClose(order.orderId, g.ctx.storeId, g.user.id, {
        method: "cash",
        amount: order.codCashHeld ?? order.total,
        receivedAmount: order.codCashHeld ?? order.total,
        changeAmount: 0,
        reference: `COD:${order.orderCode}`,
      });
      if (closed.error) {
        log("error", "settleCodCash", `ปิดบิลเงินสดเก็บปลายทางไม่สำเร็จ ${order.orderCode}: ${closed.error.userMessage}`, g, { onlineOrderId: id });
        return { ok: false, error: `ปิดบิลไม่สำเร็จ: ${closed.error.userMessage}` };
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- คอลัมน์ใหม่
    await (service as never as { from: (t: string) => any })
      .from("online_orders")
      .update({ cod_settled_at: new Date().toISOString(), cod_settled_by: g.user.id, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("store_id", g.ctx.storeId)
      .is("cod_settled_at", null);
    log("info", "settleCodCash", `รับเงินสดเก็บปลายทางคืน ${order.orderCode} ฿${order.codCashHeld ?? order.total} จาก ${order.riderName ?? "คนส่ง"}`, g, {
      onlineOrderId: id,
      riderUserId: order.riderUserId,
      amount: order.codCashHeld ?? order.total,
    });
    revalidatePath("/website/orders");
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "รับเงินไม่สำเร็จ" };
  }
}

/** R3b: QR Beam เก็บปลายทาง (หน้าร้าน/POS) */
export async function startCodQrAction(id: string): Promise<{ qr: BeamQrForPos | null; error: string | null }> {
  if (!UUID_RE.test(id)) return { qr: null, error: "ไม่พบออเดอร์" };
  const g = await queueGuard();
  if (g.error !== null) return { qr: null, error: g.error };
  if (!g.resolved.can("pos.use")) return { qr: null, error: "ต้องมีสิทธิ์ใช้ POS เพื่อรับเงิน" };
  const order = await getOnlineOrderForStore(g.ctx.storeId, id);
  if (!order) return { qr: null, error: "ไม่พบออเดอร์" };
  return startCodBeamQr(g as unknown as TransitionActor, order);
}

export async function checkCodQrAction(id: string, gatewayPaymentId: string): Promise<{ status: string; done: boolean; error: string | null }> {
  if (!UUID_RE.test(id) || !UUID_RE.test(gatewayPaymentId)) return { status: "UNKNOWN", done: false, error: "ไม่พบรายการ" };
  const g = await queueGuard();
  if (g.error !== null) return { status: "UNKNOWN", done: false, error: g.error };
  if (!g.resolved.can("pos.use")) return { status: "UNKNOWN", done: false, error: "ต้องมีสิทธิ์ใช้ POS เพื่อรับเงิน" };
  const order = await getOnlineOrderForStore(g.ctx.storeId, id);
  if (!order) return { status: "UNKNOWN", done: false, error: "ไม่พบออเดอร์" };
  const res = await settleCodBeamIfPaid(g as unknown as TransitionActor, order, gatewayPaymentId);
  if (res.done) revalidatePath("/website/orders");
  return res;
}

/**
 * POS: ออเดอร์ออนไลน์ที่รอรับ (ถามทุก 15 วิ) — แคชเชียร์ไม่มีสิทธิ์อ่านตารางแจ้งเตือน (manager+)
 * จึงใช้ทางนี้แทน realtime · guard เบา (สิทธิ์จัดการออเดอร์) ไม่อ่าน billing ทุกรอบ
 */
export async function pendingOnlineOrdersAction(): Promise<{ orders: { id: string; orderCode: string }[]; error: string | null }> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("orders.manage_qr")) return { orders: [], error: "ไม่มีสิทธิ์จัดการออเดอร์ออนไลน์" };
    return { orders: await listAwaitingOnlineOrders(ctx.storeId), error: null };
  } catch (e) {
    return { orders: [], error: e instanceof Error ? e.message : "โหลดไม่สำเร็จ" };
  }
}
