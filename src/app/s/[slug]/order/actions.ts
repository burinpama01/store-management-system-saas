"use server";

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { hashClientIp } from "@/modules/auth/device-login";
import { getMemberSessionByStoreId } from "@/modules/customers/member-repository";
import { deliverMemberOtp, verifyProviderOtp } from "@/modules/notifications/smskub";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { cancelBeamQrPayment, createBeamQrPayment, refreshBeamPayment } from "@/modules/payments/beam-service";
import type { BeamQrForPos } from "@/modules/payments/types";
import { notifyOnlineOrderPaidOnce } from "@/modules/online-orders/notify";
import { logSystemEvent } from "@/modules/system/event-log";
import {
  COD_FAILED_BLOCK_COUNT,
  COD_FAILED_LOOKBACK_DAYS,
  COD_MAX_ACTIVE_PER_PHONE,
  COD_OTP_COOLDOWN_MS,
  COD_OTP_MAX_ATTEMPTS,
  COD_OTP_MAX_PER_IP_10MIN,
  COD_OTP_MAX_PER_PHONE_DAY,
  COD_OTP_TTL_MS,
  QR_LIFETIME_MS,
  STATUS_LABEL,
  codCapFor,
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
import { resolveOrderingStore, type OrderingStore } from "@/modules/online-orders/public";
import { describeAvailability } from "@/modules/online-orders/hours";
import {
  COUPON_BLOCKED_MESSAGE,
  ONLINE_COUPON_MAX_FAILED_PER_IP,
  ONLINE_COUPON_MAX_FAILED_PER_STORE,
  ONLINE_COUPON_WINDOW_MS,
  cleanOnlineCouponCode,
  evaluateOnlineCoupon,
  onlineOrderTotal,
  type OnlineCouponResult,
} from "@/modules/online-orders/coupon";
import {
  bumpCodOtpAttempts,
  consumeCodOtp,
  countCodOtpRequests,
  countActiveCodOrders,
  countFailedCodOrders,
  findMemberTierRankByPhone,
  getLatestCodOtp,
  insertCodOtp,
  countPendingOnlineOrders,
  countOnlineCouponFailures,
  deleteFreshOnlineOrder,
  findOnlineCouponPolicy,
  recordOnlineCouponAttempt,
  reserveOnlineOrderCoupon,
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
  /** ส่วนลดคูปอง (0 = ไม่มี) */
  discount: number;
  /** คูปองที่ใช้ได้ (null = ไม่ได้ใช้/ใช้ไม่ได้) */
  coupon: { code: string; name: string } | null;
  /** ใส่รหัสมาแต่ใช้ไม่ได้ — ยอดอื่นยังคิดให้ตามปกติ */
  couponError: string | null;
}

/** ข้อความตอนร้านปิดรับ (นอกเวลา/ปิดด่วน) */
function closedMessage(store: OrderingStore): string {
  const d = describeAvailability(store.availability, new Date(), store.timeZone);
  return d.detail ? `${d.title} — ${d.detail}` : d.title;
}

/**
 * ตรวจคูปองของคำสั่งซื้อ (ฝั่ง server เสมอ) — ไม่ใส่รหัส = null
 * ลูกค้า = สมาชิกที่ล็อกอิน (cookie หน้าสมาชิก) เท่านั้น ไม่ใช้เบอร์ที่พิมพ์เอง · รหัสที่ไม่มีในร้านนับเป็นการเดา (ด่านต่อ IP)
 */
async function resolveOnlineCoupon(
  store: OrderingStore,
  rawCode: string | undefined,
  subtotal: number,
  deliveryFee: number,
  options: { recordAttempt: boolean },
): Promise<{ result: OnlineCouponResult; customerId: string | null } | null> {
  if (!rawCode?.trim()) return null;
  const code = cleanOnlineCouponCode(rawCode);
  if (!store.couponsAvailable) return { result: { ok: false, code, error: "ร้านนี้ยังไม่รับคูปองในหน้าสั่งออนไลน์" }, customerId: null };
  if (!code) return { result: { ok: false, code, error: "ไม่พบคูปองนี้" }, customerId: null };
  const ipHash = await clientIpHash();
  const failures = await countOnlineCouponFailures(store.storeId, ipHash, ONLINE_COUPON_WINDOW_MS);
  if (failures.ip >= ONLINE_COUPON_MAX_FAILED_PER_IP || failures.store >= ONLINE_COUPON_MAX_FAILED_PER_STORE) {
    void logSystemEvent({
      level: "warn",
      source: "online-orders",
      action: "onlineCouponBlocked",
      message: "พักการใส่คูปองหน้าสั่งออนไลน์ชั่วคราว (ใส่รหัสผิดหลายครั้ง)",
      organizationId: store.organizationId,
      storeId: store.storeId,
      context: { failuresByIp: failures.ip, failuresByStore: failures.store },
    });
    return { result: { ok: false, code, error: COUPON_BLOCKED_MESSAGE }, customerId: null };
  }
  const member = await getMemberSessionByStoreId(store.storeId).catch(() => null);
  const customerId = member?.customerId ?? null;
  const coupon = await findOnlineCouponPolicy(store.storeId, code, customerId);
  const result = evaluateOnlineCoupon({ coupon, code, storeId: store.storeId, subtotal, deliveryFee, customerId });
  // บันทึกเฉพาะตอนลูกค้ากด "ใช้" (quote) — ตอนสั่งจริงตรวจซ้ำแต่ไม่นับซ้ำ
  // ใช้ไม่ได้ทุกกรณี (รวมรหัสเก่า/ปิดแล้ว) นับเป็นผิด กันใช้รหัสเก่าเป็นทางเดาต่อ
  if (options.recordAttempt) {
    await recordOnlineCouponAttempt({ organizationId: store.organizationId, storeId: store.storeId, code, ipHash, succeeded: result.ok });
  }
  return { result, customerId };
}

export async function quoteOnlineOrderAction(slug: string, raw: unknown): Promise<QuoteResult> {
  const empty = { subtotal: 0, deliveryFee: 0, distanceKm: null, total: 0, discount: 0, coupon: null, couponError: null };
  const parsed = checkoutSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "ข้อมูลไม่ครบ", ...empty };
  const resolved = await resolveOrderingStore(slug);
  if (!resolved.ok) return { ok: false, error: resolved.reason, ...empty };
  const priced = await priceCart(resolved.store.storeId, parsed.data.items);
  if (!priced.ok) return { ok: false, error: priced.error, ...empty };
  const fee = feeFor(resolved.store.settings, parsed.data, priced.subtotal);
  if (!fee.ok) return { ok: false, error: fee.error, ...empty, subtotal: priced.subtotal, total: priced.subtotal };
  const coupon = await resolveOnlineCoupon(resolved.store, parsed.data.couponCode, priced.subtotal, fee.fee, { recordAttempt: true });
  const applied = coupon?.result.ok ? coupon.result : null;
  const discount = applied?.discount ?? 0;
  return {
    ok: true,
    error: null,
    subtotal: priced.subtotal,
    deliveryFee: fee.fee,
    distanceKm: fee.distanceKm,
    total: onlineOrderTotal(priced.subtotal, discount, fee.fee),
    discount,
    coupon: applied ? { code: applied.code, name: applied.name } : null,
    couponError: coupon && !coupon.result.ok ? coupon.result.error : null,
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

// ---------- เก็บเงินปลายทาง (R3): OTP ยืนยันเบอร์ ----------

function otpHash(storeId: string, phone: string, code: string): string {
  return createHash("sha256").update(`online-cod:${storeId}:${phone}:${code}`).digest("hex");
}

async function clientIpHash(): Promise<string | null> {
  const h = await headers();
  return hashClientIp(h.get("x-forwarded-for"), h.get("x-real-ip"));
}

/** ขอ OTP ก่อนสั่งเก็บเงินปลายทาง — จำกัดความถี่ต่อเบอร์/ต่อ IP (กันค่า SMS โดนยิง) */
export async function requestCodOtpAction(slug: string, rawPhone: string): Promise<{ ok: boolean; error: string | null; cooldownSec: number }> {
  const fail = (error: string, cooldownSec = 0) => ({ ok: false, error, cooldownSec });
  const phone = normalizeThaiPhone(String(rawPhone ?? ""));
  if (!/^0[0-9]{8,9}$/.test(phone)) return fail("กรอกเบอร์โทรให้ถูกต้อง");
  const resolved = await resolveOrderingStore(slug);
  if (!resolved.ok) return fail(resolved.reason);
  const store = resolved.store;
  if (!store.availability.open) return fail(closedMessage(store));
  if (!store.settings.codEnabled || !store.settings.deliveryEnabled) return fail("ร้านยังไม่เปิดเก็บเงินปลายทาง");
  if (!store.settings.codRequireOtp) return { ok: true, error: null, cooldownSec: 0 };
  if ((await countFailedCodOrders(store.storeId, phone, COD_FAILED_LOOKBACK_DAYS)) >= COD_FAILED_BLOCK_COUNT) {
    return fail("เบอร์นี้ใช้เก็บเงินปลายทางไม่ได้ — กรุณาจ่ายด้วย QR");
  }
  const ipHash = await clientIpHash();
  const recent = await countCodOtpRequests({ storeId: store.storeId, phone, ipHash });
  if (recent.lastAt) {
    const wait = COD_OTP_COOLDOWN_MS - (Date.now() - new Date(recent.lastAt).getTime());
    if (wait > 0) return fail("ส่งรหัสไปแล้ว รอสักครู่ก่อนขอใหม่", Math.ceil(wait / 1000));
  }
  if (recent.phoneToday >= COD_OTP_MAX_PER_PHONE_DAY) return fail("ขอรหัสครบจำนวนต่อวันแล้ว — กรุณาจ่ายด้วย QR");
  if (recent.ip10min >= COD_OTP_MAX_PER_IP_10MIN) return fail("ขอรหัสถี่เกินไป ลองใหม่อีกสักครู่");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  let channel: "campaigns" | "otp_v2";
  try {
    channel = (await deliverMemberOtp(phone, code)).channel;
  } catch (e) {
    void logSystemEvent({
      level: "error",
      source: "online-orders",
      action: "requestCodOtp",
      message: `ส่ง OTP เก็บเงินปลายทางไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`,
      organizationId: store.organizationId,
      storeId: store.storeId,
    });
    return fail("ส่งรหัสไม่สำเร็จ — กรุณาจ่ายด้วย QR หรือลองใหม่ภายหลัง");
  }
  const saved = await insertCodOtp({
    storeId: store.storeId,
    phone,
    // otp_v2 = ผู้ให้บริการสร้างรหัสเอง เราไม่มีรหัส → ตรวจกับผู้ให้บริการตอนยืนยัน
    codeHash: channel === "campaigns" ? otpHash(store.storeId, phone, code) : null,
    channel,
    ipHash,
    expiresAt: new Date(Date.now() + COD_OTP_TTL_MS).toISOString(),
  });
  void logSystemEvent({
    level: saved ? "info" : "error",
    source: "online-orders",
    action: "requestCodOtp",
    message: saved ? `ส่ง OTP เก็บเงินปลายทาง (${channel})` : "บันทึก OTP เก็บเงินปลายทางไม่สำเร็จ",
    organizationId: store.organizationId,
    storeId: store.storeId,
    context: { channel },
  });
  if (!saved) return fail("ส่งรหัสไม่สำเร็จ ลองใหม่อีกครั้ง");
  return { ok: true, error: null, cooldownSec: Math.ceil(COD_OTP_COOLDOWN_MS / 1000) };
}

/** ตรวจ OTP + ใช้ครั้งเดียว — คืน null = ผ่าน, ข้อความ = ไม่ผ่าน */
async function verifyCodOtp(storeId: string, phone: string, code: string | undefined): Promise<string | null> {
  if (!code) return "กรอกรหัส OTP ที่ได้รับทาง SMS";
  const otp = await getLatestCodOtp(storeId, phone);
  if (!otp) return "ขอรหัส OTP ก่อน";
  if (new Date(otp.expiresAt).getTime() < Date.now()) return "รหัสหมดอายุ — ขอรหัสใหม่";
  if (otp.attempts >= COD_OTP_MAX_ATTEMPTS) return "ใส่รหัสผิดหลายครั้ง — ขอรหัสใหม่";
  let valid = false;
  if (otp.channel === "campaigns") {
    const expected = Buffer.from(otp.codeHash ?? "", "hex");
    const actual = Buffer.from(otpHash(storeId, phone, code), "hex");
    valid = expected.length === actual.length && expected.length > 0 && timingSafeEqual(expected, actual);
  } else {
    try {
      valid = await verifyProviderOtp(phone, code);
    } catch {
      return "ตรวจรหัสไม่สำเร็จชั่วคราว ลองใหม่อีกครั้ง";
    }
  }
  if (!valid) {
    await bumpCodOtpAttempts(otp.id, otp.attempts + 1);
    return "รหัส OTP ไม่ถูกต้อง";
  }
  if (!(await consumeCodOtp(otp.id))) return "รหัสนี้ถูกใช้แล้ว — ขอรหัสใหม่";
  return null;
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
  // นอกเวลารับออเดอร์/ปิดด่วน — ตรวจฝั่ง server (หน้าเว็บอาจเปิดค้างไว้ก่อนร้านปิด)
  if (!store.availability.open) return fail(closedMessage(store));

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
  // คูปอง: ใส่มาแต่ใช้ไม่ได้ = ไม่สร้างคำสั่งซื้อ (ไม่ให้ลูกค้าจ่ายเต็มราคาโดยไม่รู้ตัว)
  const coupon = await resolveOnlineCoupon(store, input.couponCode, priced.subtotal, fee.fee, { recordAttempt: false });
  if (coupon && !coupon.result.ok) return fail(coupon.result.error);
  const applied = coupon?.result.ok ? coupon.result : null;
  const discount = applied?.discount ?? 0;
  const total = onlineOrderTotal(priced.subtotal, discount, fee.fee);
  if (total < 1) return fail("ยอดชำระต้องอย่างน้อย 1 บาท");

  // R3: เก็บเงินปลายทาง — ส่งถึงบ้านเท่านั้น + เพดาน (ระดับสมาชิก/ต่อบิล) + ประวัติไม่รับของ + OTP
  const isCod = input.paymentMethod === "cod";
  if (isCod) {
    if (!store.settings.codEnabled) return fail("ร้านยังไม่เปิดเก็บเงินปลายทาง");
    if (input.fulfillment !== "delivery") return fail("เก็บเงินปลายทางใช้ได้กับส่งถึงบ้านเท่านั้น");
    if ((await countFailedCodOrders(store.storeId, input.customerPhone, COD_FAILED_LOOKBACK_DAYS)) >= COD_FAILED_BLOCK_COUNT) {
      return fail("เบอร์นี้ใช้เก็บเงินปลายทางไม่ได้ — กรุณาจ่ายด้วย QR");
    }
    if ((await countActiveCodOrders(store.storeId, input.customerPhone)) >= COD_MAX_ACTIVE_PER_PHONE) {
      return fail("มีออเดอร์เก็บเงินปลายทางที่ยังไม่ส่งอยู่แล้ว — รอรับของก่อน หรือจ่ายด้วย QR");
    }
    const tierRank = await findMemberTierRankByPhone(store.storeId, input.customerPhone);
    const cap = codCapFor(store.settings, tierRank);
    if (total > cap) return fail(`เก็บเงินปลายทางได้ไม่เกิน ฿${cap.toLocaleString("th-TH")} — กรุณาจ่ายด้วย QR`);
    if (store.settings.codRequireOtp) {
      // สมาชิกที่ล็อกอินอยู่ (ยืนยัน OTP ตอนเข้าสมาชิกแล้ว) + ใช้เบอร์สมาชิก → ไม่ต้องขอ OTP ซ้ำ
      // ตรวจจาก cookie สมาชิกฝั่ง server เท่านั้น (ส่งมาเฉพาะคำขอจากหน้า /member/<slug>/order)
      const member = await getMemberSessionByStoreId(store.storeId).catch(() => null);
      const memberVerified = Boolean(member?.phone && normalizeThaiPhone(member.phone) === input.customerPhone);
      if (!memberVerified) {
        const otpError = await verifyCodOtp(store.storeId, input.customerPhone, input.otpCode);
        if (otpError) return fail(otpError);
      }
    }
  }

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
    status: isCod ? "cod_pending" : "awaiting_payment",
    payment_method: isCod ? "cod" : "beam",
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
    ...(applied ? { coupon_id: applied.couponId, coupon_code: applied.code, discount } : {}),
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
    return fail(isCod ? "สร้างคำสั่งซื้อไม่สำเร็จ — ขอรหัส OTP ใหม่แล้วลองอีกครั้ง" : "สร้างคำสั่งซื้อไม่สำเร็จ ลองใหม่อีกครั้ง");
  }

  // จองสิทธิ์คูปอง (ล็อกแถวคูปองใน DB กันใช้เกินจำนวน) — ไม่ได้ = ลบคำสั่งซื้อที่เพิ่งสร้าง (ยังไม่มี QR/เงิน)
  if (applied) {
    const reserveError = await reserveOnlineOrderCoupon({
      onlineOrderId: id,
      couponId: applied.couponId,
      customerId: coupon?.customerId ?? null,
      discount,
    });
    if (reserveError) {
      await deleteFreshOnlineOrder(store.storeId, id);
      void logSystemEvent({
        level: "warn",
        source: "online-orders",
        action: "reserveOnlineCoupon",
        message: `จองคูปอง ${applied.code} ไม่สำเร็จ: ${reserveError}`,
        organizationId: store.organizationId,
        storeId: store.storeId,
        context: { onlineOrderId: id, couponId: applied.couponId, discount },
      });
      return fail(reserveError);
    }
  }
  const couponLog = applied ? { couponCode: applied.code, couponId: applied.couponId, discount } : {};
  const couponNote = applied ? ` (คูปอง ${applied.code} −${discount.toFixed(2)})` : "";

  if (isCod) {
    void logSystemEvent({
      level: "info",
      source: "online-orders",
      action: "createOnlineOrder",
      message: `คำสั่งซื้อออนไลน์ ${inserted.order.orderCode} เก็บเงินปลายทาง ${total.toFixed(2)}${couponNote}`,
      organizationId: store.organizationId,
      storeId: store.storeId,
      context: { onlineOrderId: id, fulfillment: input.fulfillment, total, lines: priced.lines.length, paymentMethod: "cod", ...couponLog },
    });
    // ไม่มีขั้นจ่าย — แจ้งร้านทันที (เหมือนออเดอร์ที่จ่าย Beam แล้ว)
    await notifyOnlineOrderPaidOnce(inserted.order);
    return { ok: true, error: null, token };
  }

  const qr = await ensureQr(inserted.order);
  void logSystemEvent({
    level: qr.ok ? "info" : "error",
    source: "online-orders",
    action: "createOnlineOrder",
    message: qr.ok
      ? `คำสั่งซื้อออนไลน์ ${inserted.order.orderCode} รอชำระ ${total.toFixed(2)}${couponNote}`
      : `สร้าง QR คำสั่งซื้อออนไลน์ไม่สำเร็จ: ${qr.error}`,
    organizationId: store.organizationId,
    storeId: store.storeId,
    context: { onlineOrderId: id, fulfillment: input.fulfillment, total, lines: priced.lines.length, ...couponLog },
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
  /** ส่วนลดคูปอง */
  discount: number;
  couponCode: string | null;
  total: number;
  expiresAt: string;
  createdAt: string;
  qr: { payload: string | null; image: string | null } | null;
  notice: string | null;
  /** R3: cod = จ่ายเงินปลายทาง */
  paymentMethod: "beam" | "cod";
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
    discount: order.discount,
    couponCode: order.couponCode,
    total: order.total,
    expiresAt: order.expiresAt,
    createdAt: order.createdAt,
    qr: qr ? { payload: qr.qrPayload, image: qr.qrImageBase64 } : null,
    notice,
    paymentMethod: order.paymentMethod,
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

  // ทางสำรอง — ปกติ webhook Beam แจ้งไปแล้ว (claim notified_at กันซ้ำ)
  if (order.status === "paid" && !order.notifiedAt) await notifyOnlineOrderPaidOnce(order);
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
