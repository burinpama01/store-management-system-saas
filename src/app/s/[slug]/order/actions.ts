"use server";

import { randomBytes } from "node:crypto";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { cancelBeamQrPayment, createBeamQrPayment, refreshBeamPayment } from "@/modules/payments/beam-service";
import type { BeamQrForPos } from "@/modules/payments/types";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { logSystemEvent } from "@/modules/system/event-log";
import {
  QR_LIFETIME_MS,
  STATUS_LABEL,
  checkoutSchema,
  isPaymentWindowOver,
  maskPhone,
  normalizeThaiPhone,
  onlineOrderCode,
  quoteDelivery,
  type CheckoutInput,
  type OnlineOrderStatus,
} from "@/modules/online-orders/core";
import { priceCart } from "@/modules/online-orders/menu";
import { resolveOrderingStore } from "@/modules/online-orders/public";
import {
  claimOnlineOrderNotification,
  countPendingOnlineOrders,
  expireStaleOnlineOrders,
  findOnlineOrderByRequest,
  getOnlineOrderByToken,
  insertOnlineOrder,
  setOnlineOrderGateway,
  transitionOnlineOrder,
  type OnlineOrder,
} from "@/modules/online-orders/repository";

/**
 * หน้าสั่งออนไลน์ของเว็บร้าน (สาธารณะ ไม่ต้องล็อกอิน) — ทุกอย่างตรวจใหม่ฝั่ง server
 * กุญแจเข้าถึงคำสั่งซื้อ = public_token สุ่ม 32 ไบต์ (อยู่ในลิงก์ติดตาม)
 */

export interface QuoteResult {
  ok: boolean;
  error: string | null;
  subtotal: number;
  deliveryFee: number;
  distanceKm: number | null;
  total: number;
}

export async function quoteOnlineOrderAction(slug: string, raw: unknown): Promise<QuoteResult> {
  const empty = { subtotal: 0, deliveryFee: 0, distanceKm: null, total: 0 };
  const parsed = checkoutSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "ข้อมูลไม่ครบ", ...empty };
  const resolved = await resolveOrderingStore(slug);
  if (!resolved.ok) return { ok: false, error: resolved.reason, ...empty };
  const priced = await priceCart(resolved.store.storeId, parsed.data.items);
  if (!priced.ok) return { ok: false, error: priced.error, ...empty };
  const fee = feeFor(resolved.store.settings, parsed.data, priced.subtotal);
  if (!fee.ok) return { ok: false, error: fee.error, ...empty, subtotal: priced.subtotal, total: priced.subtotal };
  return {
    ok: true,
    error: null,
    subtotal: priced.subtotal,
    deliveryFee: fee.fee,
    distanceKm: fee.distanceKm,
    total: Math.round((priced.subtotal + fee.fee) * 100) / 100,
  };
}

function feeFor(
  settings: Parameters<typeof quoteDelivery>[0],
  input: CheckoutInput,
  subtotal: number,
): { ok: true; fee: number; distanceKm: number | null } | { ok: false; error: string } {
  if (input.fulfillment === "pickup") {
    if (!settings.pickupEnabled) return { ok: false, error: "ร้านไม่เปิดรับที่ร้าน" };
    return { ok: true, fee: 0, distanceKm: null };
  }
  const point = typeof input.lat === "number" && typeof input.lng === "number" ? { lat: input.lat, lng: input.lng } : null;
  const quote = quoteDelivery(settings, subtotal, point);
  return quote.ok ? { ok: true, fee: quote.fee, distanceKm: quote.distanceKm } : quote;
}

export interface StartResult {
  ok: boolean;
  error: string | null;
  token: string | null;
}

export async function startOnlineOrderAction(slug: string, raw: unknown): Promise<StartResult> {
  const fail = (error: string): StartResult => ({ ok: false, error, token: null });
  const prepared = typeof raw === "object" && raw !== null && "customerPhone" in raw
    ? { ...(raw as Record<string, unknown>), customerPhone: normalizeThaiPhone(String((raw as Record<string, unknown>).customerPhone ?? "")) }
    : raw;
  const parsed = checkoutSchema.safeParse(prepared);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "ข้อมูลไม่ครบ");
  const input = parsed.data;
  if (input.fulfillment === "delivery" && !input.address) return fail("กรอกที่อยู่สำหรับจัดส่ง");

  const resolved = await resolveOrderingStore(slug);
  if (!resolved.ok) return fail(resolved.reason);
  const store = resolved.store;

  // กดซ้ำ/เน็ตหลุดแล้วส่งใหม่ด้วย clientRequestId เดิม → ใช้รายการเดิม
  const existing = await findOnlineOrderByRequest(store.storeId, input.clientRequestId);
  if (existing) return { ok: true, error: null, token: existing.publicToken };

  await expireStaleOnlineOrders(store.storeId);
  const pending = await countPendingOnlineOrders(store.storeId, input.customerPhone);
  if (pending.byPhone >= 3) return fail("มีรายการรอชำระอยู่แล้ว — ชำระหรือรอให้หมดเวลาก่อน");
  if (pending.byStore >= 30) return fail("ร้านมีรายการรอชำระจำนวนมาก ลองใหม่อีกสักครู่");

  const priced = await priceCart(store.storeId, input.items);
  if (!priced.ok) return fail(priced.error);
  if (priced.subtotal < store.settings.minOrder) return fail(`ยอดขั้นต่ำ ${store.settings.minOrder.toLocaleString("th-TH")} บาท`);
  const fee = feeFor(store.settings, input, priced.subtotal);
  if (!fee.ok) return fail(fee.error);
  const total = Math.round((priced.subtotal + fee.fee) * 100) / 100;
  if (total < 1) return fail("ยอดชำระต้องอย่างน้อย 1 บาท");

  const now = Date.now();
  const minPickup = store.settings.prepMinutes;
  const pickupAt =
    input.fulfillment === "pickup"
      ? new Date(now + Math.max(minPickup, input.pickupInMinutes ?? minPickup) * 60_000).toISOString()
      : null;
  const id = crypto.randomUUID();
  const token = randomBytes(32).toString("base64url");
  const inserted = await insertOnlineOrder({
    id,
    organization_id: store.organizationId,
    store_id: store.storeId,
    public_token: token,
    client_request_id: input.clientRequestId,
    order_code: onlineOrderCode(id),
    fulfillment: input.fulfillment,
    status: "awaiting_payment",
    customer_name: input.customerName,
    customer_phone: input.customerPhone,
    address: input.fulfillment === "delivery" ? input.address : null,
    address_note: input.fulfillment === "delivery" ? (input.addressNote || null) : null,
    lat: input.fulfillment === "delivery" ? (input.lat ?? null) : null,
    lng: input.fulfillment === "delivery" ? (input.lng ?? null) : null,
    distance_km: fee.distanceKm,
    pickup_at: pickupAt,
    note: input.note || null,
    items: priced.lines,
    subtotal: priced.subtotal,
    delivery_fee: fee.fee,
    total,
    expires_at: new Date(now + QR_LIFETIME_MS).toISOString(),
  });
  if (!inserted.order) {
    // ชน unique(client_request_id) จากสองแท็บพร้อมกัน → คืนรายการที่ชนะ
    const raced = await findOnlineOrderByRequest(store.storeId, input.clientRequestId);
    if (raced) return { ok: true, error: null, token: raced.publicToken };
    void logSystemEvent({
      level: "error",
      source: "online-orders",
      action: "createOnlineOrder",
      message: `สร้างคำสั่งซื้อออนไลน์ไม่สำเร็จ: ${inserted.error}`,
      organizationId: store.organizationId,
      storeId: store.storeId,
    });
    return fail("สร้างคำสั่งซื้อไม่สำเร็จ ลองใหม่อีกครั้ง");
  }

  const qr = await ensureQr(inserted.order);
  void logSystemEvent({
    level: qr.ok ? "info" : "error",
    source: "online-orders",
    action: "createOnlineOrder",
    message: qr.ok
      ? `คำสั่งซื้อออนไลน์ ${inserted.order.orderCode} รอชำระ ${total.toFixed(2)}`
      : `สร้าง QR คำสั่งซื้อออนไลน์ไม่สำเร็จ: ${qr.error}`,
    organizationId: store.organizationId,
    storeId: store.storeId,
    context: { onlineOrderId: id, fulfillment: input.fulfillment, total, lines: priced.lines.length },
  });
  if (!qr.ok) return fail(qr.error);
  return { ok: true, error: null, token };
}

/** สร้าง/ดึง QR Beam ของคำสั่งซื้อ (idempotent ด้วย clientRequestId ของรายการ) */
async function ensureQr(order: OnlineOrder): Promise<{ ok: true; qr: BeamQrForPos } | { ok: false; error: string }> {
  const service = await createSupabaseServiceClient();
  const created = await createBeamQrPayment({
    organizationId: order.organizationId,
    storeId: order.storeId,
    amountMajor: order.total,
    clientRequestId: `online-${order.clientRequestId}`,
    actorUserId: null,
    onlineOrderId: order.id,
    client: service,
  });
  if (!created.ok) return created;
  if (!order.gatewayPaymentId) await setOnlineOrderGateway(order.id, created.qr.gatewayPaymentId);
  return created;
}

export interface TrackingView {
  orderCode: string;
  status: OnlineOrderStatus;
  statusLabel: string;
  fulfillment: "pickup" | "delivery";
  customerName: string;
  phoneMasked: string;
  address: string | null;
  pickupAt: string | null;
  items: { name: string; detail: string; quantity: number; totalPrice: number }[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  expiresAt: string;
  createdAt: string;
  qr: { payload: string | null; image: string | null } | null;
  notice: string | null;
}

function toView(order: OnlineOrder, qr: BeamQrForPos | null, notice: string | null): TrackingView {
  return {
    orderCode: order.orderCode,
    status: order.status,
    statusLabel: STATUS_LABEL[order.status],
    fulfillment: order.fulfillment,
    customerName: order.customerName,
    phoneMasked: maskPhone(order.customerPhone),
    address: order.address,
    pickupAt: order.pickupAt,
    items: order.items.map((line) => ({
      name: line.productName,
      detail: [line.variantName, ...line.modifiers.map((m) => m.option.name), line.note].filter(Boolean).join(" · "),
      quantity: line.quantity,
      totalPrice: line.totalPrice,
    })),
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    total: order.total,
    expiresAt: order.expiresAt,
    createdAt: order.createdAt,
    qr: qr ? { payload: qr.qrPayload, image: qr.qrImageBase64 } : null,
    notice,
  };
}

/**
 * หน้าติดตาม: รอจ่าย = คืน QR + ถามสถานะ Beam (ไม่ถี่กว่า 10 วิ ต่อรายการ webhook คือทางหลัก)
 * จ่ายแล้วครั้งแรก = แจ้งเตือนร้านครั้งเดียว (claim notified_at)
 */
export async function getTrackingAction(token: string, withQr: boolean): Promise<{ view: TrackingView | null; error: string | null }> {
  let order = await getOnlineOrderByToken(token);
  if (!order) return { view: null, error: "ไม่พบคำสั่งซื้อ" };

  let notice: string | null = null;
  let qr: BeamQrForPos | null = null;
  if (order.status === "awaiting_payment") {
    const nowMs = Date.now();
    // ถาม Beam ตรงไม่ถี่กว่า 10 วิ ต่อรายการ (throttle ใน DB ผ่าน metadata.lastLookupAt — ใช้ได้ข้าม instance)
    if (order.gatewayPaymentId) {
      const service = await createSupabaseServiceClient();
      const refreshed = await refreshBeamPayment({
        storeId: order.storeId,
        gatewayPaymentId: order.gatewayPaymentId,
        client: service,
        minLookupIntervalMs: 10_000,
      });
      if (refreshed.ok && (refreshed.status === "LATE_PAID" || refreshed.status === "REVIEW_REQUIRED")) {
        notice = "ได้รับเงินแล้ว แต่ร้านต้องตรวจสอบก่อน — ติดต่อร้าน";
      }
      order = (await getOnlineOrderByToken(token)) ?? order;
    }
    if (order.status === "awaiting_payment" && isPaymentWindowOver(order.expiresAt, nowMs)) {
      await transitionOnlineOrder({ storeId: order.storeId, id: order.id, from: "awaiting_payment", to: "expired", userId: null });
      order = (await getOnlineOrderByToken(token)) ?? order;
    }
    if (order.status === "awaiting_payment" && withQr && Date.parse(order.expiresAt) > nowMs) {
      const ensured = await ensureQr(order);
      if (ensured.ok) qr = ensured.qr;
      else notice = ensured.error;
    }
  }

  if (order.status === "paid" && !order.notifiedAt && (await claimOnlineOrderNotification(order.id))) {
    notifyOwnerSafely({
      type: "new_delivery_order",
      organizationId: order.organizationId,
      storeId: order.storeId,
      title: "มีออเดอร์ออนไลน์ใหม่ (จ่ายแล้ว)",
      message: `${order.fulfillment === "pickup" ? "รับที่ร้าน" : "ส่งถึงบ้าน"} ${order.orderCode} ยอด ${order.total.toFixed(2)}`,
      metadata: { onlineOrderId: order.id, orderNumber: order.orderCode, total: order.total, source: "online" },
    });
    void logSystemEvent({
      level: "info",
      source: "online-orders",
      action: "onlineOrderPaid",
      message: `คำสั่งซื้อออนไลน์ ${order.orderCode} จ่ายแล้ว`,
      organizationId: order.organizationId,
      storeId: order.storeId,
      context: { onlineOrderId: order.id, total: order.total },
    });
  }
  return { view: toView(order, qr, notice), error: null };
}

/** ลูกค้ายกเลิกก่อนจ่าย — เงินที่เข้าหลังจากนี้ trigger ทำเป็น LATE_PAID (ร้านคืนเงิน) */
export async function cancelUnpaidOnlineOrderAction(token: string): Promise<{ error: string | null }> {
  const order = await getOnlineOrderByToken(token);
  if (!order) return { error: "ไม่พบคำสั่งซื้อ" };
  if (order.status !== "awaiting_payment") return { error: "คำสั่งซื้อนี้ยกเลิกเองไม่ได้แล้ว — ติดต่อร้าน" };
  const moved = await transitionOnlineOrder({
    storeId: order.storeId,
    id: order.id,
    from: "awaiting_payment",
    to: "expired",
    userId: null,
    patch: { cancel_reason: "ลูกค้ายกเลิกก่อนชำระ" },
  });
  if (!moved) return { error: "สถานะเปลี่ยนไปแล้ว ลองโหลดใหม่" };
  if (order.gatewayPaymentId) {
    const service = await createSupabaseServiceClient();
    await cancelBeamQrPayment({ storeId: order.storeId, gatewayPaymentId: order.gatewayPaymentId, actorUserId: null, client: service, reason: "ลูกค้ายกเลิกคำสั่งซื้อออนไลน์" });
  }
  return { error: null };
}
