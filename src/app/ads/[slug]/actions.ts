"use server";

import { randomBytes, randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { hashClientIp } from "@/modules/auth/device-login";
import { isSlip2goConfigured, verifySlipByImageBase64 } from "@/modules/billing/slip2go";
import { validateDonationSlip } from "@/modules/music-requests/donation-check";
import { normalizeThaiPhone } from "@/modules/online-orders/core";
import { cancelBeamQrPayment, createBeamQrPayment, refreshBeamPayment } from "@/modules/payments/beam-service";
import type { BeamQrForPos } from "@/modules/payments/types";
import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import { logSystemEvent } from "@/modules/system/event-log";
import { notifyAdOrderPaidOnce } from "@/modules/ad-self-serve/notify";
import {
  STORE_AD_MAX_ORDERS_PER_IP_HOUR,
  STORE_AD_MAX_PENDING_PER_PHONE,
  STORE_AD_MAX_PENDING_PER_STORE,
  STORE_AD_NAME_MAX,
  STORE_AD_PAYMENT_WINDOW_MS,
  STORE_AD_STATUS_LABEL,
  checkStoreAdMedia,
  countStoreAdSlotsInUse,
  findStoreAdPackage,
  storeAdMediaMaxBytes,
  type StoreAdMediaType,
  type StoreAdOrder,
  type StoreAdOrderStatus,
} from "@/modules/ad-self-serve/orders";
import {
  STORE_AD_MEDIA_BUCKET,
  cancelStaleAdOrders,
  getAdOrderByToken,
  listSlotOrders,
  resolveAdStore,
  serviceDb,
  type AdStore,
} from "@/modules/ad-self-serve/server";
import { CUSTOMER_DISPLAY_MEDIA_CACHE_SECONDS } from "@/modules/settings/customer-display";

/**
 * หน้าลงโฆษณาสาธารณะ /ads/<slug> (ไม่ต้องล็อกอิน) — ตรวจใหม่ทุกอย่างฝั่ง server
 * กุญแจเข้าถึงคำสั่ง = public_token สุ่ม 32 ไบต์ (อยู่ในลิงก์สถานะ)
 * ลำดับ: สร้างคำสั่ง + ได้สิทธิ์อัปโหลด → อัปโหลดตรงเข้า storage → ยืนยันไฟล์ → จ่าย (Beam / สลิป)
 */

async function clientIpHash(): Promise<string | null> {
  const h = await headers();
  return hashClientIp(h.get("x-forwarded-for"), h.get("x-real-ip"));
}

function mediaFolder(order: { organizationId: string; storeId: string }) {
  return `${order.organizationId}/${order.storeId}/ad-orders`;
}

function full(store: AdStore): string {
  const when = store.nextFreeAt
    ? ` — ว่างอีกครั้งประมาณ ${new Date(store.nextFreeAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" })}`
    : "";
  return `ช่องโฆษณาของร้านเต็มแล้ว${when}`;
}

export interface CreateAdOrderResult {
  ok: boolean;
  error: string | null;
  token: string | null;
  /** null = ไฟล์ของคำสั่งนี้อัปโหลด/ยืนยันแล้ว ไม่ต้องอัปซ้ำ */
  upload: { path: string; token: string; contentType: string; cacheControl: string } | null;
}

export async function createAdOrderAction(slug: string, raw: Record<string, unknown>): Promise<CreateAdOrderResult> {
  const fail = (error: string): CreateAdOrderResult => ({ ok: false, error, token: null, upload: null });
  const clientRequestId = typeof raw.clientRequestId === "string" ? raw.clientRequestId.trim() : "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clientRequestId)) return fail("คำขอไม่ถูกต้อง ลองโหลดหน้าใหม่");

  const resolved = await resolveAdStore(slug);
  if (!resolved.ok) return fail(resolved.reason);
  const store = resolved.store;
  const { offer } = store;

  if (raw.acceptTerms !== true) return fail("กรุณายอมรับเงื่อนไขของร้าน");
  const advertiserName = typeof raw.advertiserName === "string" ? raw.advertiserName.trim().slice(0, STORE_AD_NAME_MAX) : "";
  if (!advertiserName) return fail("กรอกชื่อร้าน/ผู้ลงโฆษณา");
  const advertiserPhone = normalizeThaiPhone(String(raw.advertiserPhone ?? ""));
  if (!/^0[0-9]{8,9}$/.test(advertiserPhone)) return fail("กรอกเบอร์โทรให้ถูกต้อง");
  const pkg = findStoreAdPackage(offer.packages, raw.packageId);
  if (!pkg) return fail("แพ็กนี้ไม่มีแล้ว ลองโหลดหน้าใหม่");
  const media = checkStoreAdMedia(offer, {
    mediaType: raw.mediaType,
    extension: raw.extension,
    sizeBytes: raw.sizeBytes,
    durationSeconds: raw.durationSeconds,
  });
  if (!media.ok) return fail(media.error);

  const db = await serviceDb();
  const { data: existingRow } = await db
    .from("store_ad_orders")
    .select("*")
    .eq("store_id", store.storeId)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();

  // กดซ้ำ/อัปโหลดล้มแล้วกดใหม่ → คำสั่งเดิม (เปลี่ยนไฟล์ได้จนกว่าจะยืนยันไฟล์)
  if (existingRow) {
    if (existingRow.status !== "pending_payment") return fail("คำสั่งนี้ปิดไปแล้ว ลองโหลดหน้าใหม่");
    if (existingRow.media_url) return { ok: true, error: null, token: existingRow.public_token, upload: null };
    const path = `${existingRow.organization_id}/${existingRow.store_id}/ad-orders/${existingRow.id}.${media.extension}`;
    if (existingRow.media_path && existingRow.media_path !== path) {
      await db.storage.from(STORE_AD_MEDIA_BUCKET).remove([existingRow.media_path]);
    }
    await db
      .from("store_ad_orders")
      .update({
        media_type: media.mediaType,
        media_path: path,
        media_duration_seconds: media.durationSeconds,
        media_size_bytes: media.sizeBytes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingRow.id)
      .eq("status", "pending_payment");
    const signed = await db.storage.from(STORE_AD_MEDIA_BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (signed.error || !signed.data?.token) return fail("เตรียมอัปโหลดไม่สำเร็จ ลองใหม่อีกครั้ง");
    return {
      ok: true,
      error: null,
      token: existingRow.public_token,
      upload: { path, token: signed.data.token, contentType: media.contentType, cacheControl: String(CUSTOMER_DISPLAY_MEDIA_CACHE_SECONDS) },
    };
  }

  await cancelStaleAdOrders(store.storeId, db);
  if (store.slotsInUse >= offer.maxConcurrent) return fail(full(store));

  const ipHash = await clientIpHash();
  if (!ipHash) {
    // ไม่มี IP (ไม่ควรเกิดบน Vercel) → ลิมิตต่อ IP ใช้ไม่ได้ เหลือลิมิตต่อเบอร์/ต่อร้าน — เก็บ log ไว้ดูรูปแบบ
    void logSystemEvent({
      level: "warn",
      source: "ad-self-serve",
      action: "createAdOrder",
      message: "สร้างคำสั่งลงโฆษณาโดยไม่มี IP — ข้ามลิมิตต่อ IP",
      organizationId: store.organizationId,
      storeId: store.storeId,
    });
  }
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const [byIp, byPhone, byStore] = await Promise.all([
    ipHash
      ? db.from("store_ad_orders").select("id", { count: "exact", head: true }).eq("client_ip_hash", ipHash).gte("created_at", hourAgo)
      : Promise.resolve({ count: 0 }),
    db
      .from("store_ad_orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", store.storeId)
      .eq("advertiser_phone", advertiserPhone)
      .eq("status", "pending_payment"),
    db.from("store_ad_orders").select("id", { count: "exact", head: true }).eq("store_id", store.storeId).eq("status", "pending_payment"),
  ]);
  if ((byIp.count ?? 0) >= STORE_AD_MAX_ORDERS_PER_IP_HOUR) return fail("สร้างคำสั่งถี่เกินไป ลองใหม่ภายหลัง");
  if ((byPhone.count ?? 0) >= STORE_AD_MAX_PENDING_PER_PHONE) return fail("เบอร์นี้มีคำสั่งรอชำระอยู่แล้ว — ชำระหรือยกเลิกก่อน");
  if ((byStore.count ?? 0) >= STORE_AD_MAX_PENDING_PER_STORE) return fail("ร้านมีคำสั่งรอชำระจำนวนมาก ลองใหม่อีกสักครู่");

  const id = randomUUID();
  const publicToken = randomBytes(32).toString("base64url");
  const path = `${store.organizationId}/${store.storeId}/ad-orders/${id}.${media.extension}`;
  const { error: insertError } = await db.from("store_ad_orders").insert({
    id,
    organization_id: store.organizationId,
    store_id: store.storeId,
    public_token: publicToken,
    client_request_id: clientRequestId,
    package_id: pkg.id,
    package_name: pkg.name,
    days: pkg.days,
    amount: pkg.price,
    advertiser_name: advertiserName,
    advertiser_phone: advertiserPhone,
    media_type: media.mediaType,
    media_path: path,
    media_duration_seconds: media.durationSeconds,
    media_size_bytes: media.sizeBytes,
    slot: offer.slot,
    status: "pending_payment",
    expires_at: new Date(Date.now() + STORE_AD_PAYMENT_WINDOW_MS).toISOString(),
    client_ip_hash: ipHash,
  });
  if (insertError) {
    // สองแท็บพร้อมกัน (ชน unique client_request_id) → คืนคำสั่งที่ชนะ
    const { data: raced } = await db
      .from("store_ad_orders")
      .select("public_token")
      .eq("store_id", store.storeId)
      .eq("client_request_id", clientRequestId)
      .maybeSingle();
    if (raced?.public_token) return fail("กำลังสร้างคำสั่งอยู่ กดอีกครั้ง");
    void logSystemEvent({
      level: "error",
      source: "ad-self-serve",
      action: "createAdOrder",
      message: `สร้างคำสั่งลงโฆษณาไม่สำเร็จ: ${insertError.message}`,
      organizationId: store.organizationId,
      storeId: store.storeId,
    });
    return fail("สร้างคำสั่งไม่สำเร็จ ลองใหม่อีกครั้ง");
  }

  const signed = await db.storage.from(STORE_AD_MEDIA_BUCKET).createSignedUploadUrl(path, { upsert: true });
  void logSystemEvent({
    level: signed.error ? "error" : "info",
    source: "ad-self-serve",
    action: "createAdOrder",
    message: signed.error
      ? `ออกสิทธิ์อัปโหลดสื่อโฆษณาไม่สำเร็จ: ${signed.error.message}`
      : `คำสั่งลงโฆษณา ${pkg.name} ${pkg.price.toFixed(2)} บาท (${media.mediaType}) รออัปโหลด/ชำระ`,
    organizationId: store.organizationId,
    storeId: store.storeId,
    context: { adOrderId: id, packageId: pkg.id, amount: pkg.price, mediaType: media.mediaType, sizeBytes: media.sizeBytes, durationSeconds: media.durationSeconds },
  });
  if (signed.error || !signed.data?.token) return fail("เตรียมอัปโหลดไม่สำเร็จ ลองใหม่อีกครั้ง");
  return {
    ok: true,
    error: null,
    token: publicToken,
    upload: { path, token: signed.data.token, contentType: media.contentType, cacheControl: String(CUSTOMER_DISPLAY_MEDIA_CACHE_SECONDS) },
  };
}

/** หลังอัปโหลด: ตรวจว่าไฟล์อยู่จริง ขนาด/ชนิดตรง แล้วผูก URL กับคำสั่ง (ไฟล์ที่ไม่ผ่านถูกลบ) */
export async function confirmAdMediaAction(token: string): Promise<{ ok: boolean; error: string | null }> {
  const order = await getAdOrderByToken(token);
  if (!order) return { ok: false, error: "ไม่พบคำสั่ง" };
  if (order.status !== "pending_payment") return { ok: false, error: "คำสั่งนี้ปิดไปแล้ว" };
  if (order.mediaUrl) return { ok: true, error: null };
  if (!order.mediaPath || !order.mediaType) return { ok: false, error: "ยังไม่ได้เลือกไฟล์" };

  const db = await serviceDb();
  const folder = mediaFolder(order);
  const name = order.mediaPath.slice(folder.length + 1);
  const { data: listed, error } = await db.storage.from(STORE_AD_MEDIA_BUCKET).list(folder, { search: order.id, limit: 10 });
  const object = Array.isArray(listed) ? listed.find((item: { name: string }) => item.name === name) : null;
  if (error || !object) return { ok: false, error: "ยังไม่พบไฟล์ที่อัปโหลด ลองอัปโหลดใหม่" };
  const size = Number(object.metadata?.size ?? 0);
  const mime = String(object.metadata?.mimetype ?? "");
  const mediaType: StoreAdMediaType = order.mediaType;
  const typeOk = mime.startsWith(mediaType === "video" ? "video/" : "image/");
  if (!(size > 0) || size > storeAdMediaMaxBytes(mediaType) || !typeOk) {
    await db.storage.from(STORE_AD_MEDIA_BUCKET).remove([order.mediaPath]);
    void logSystemEvent({
      level: "warn",
      source: "ad-self-serve",
      action: "confirmAdMedia",
      message: `ไฟล์โฆษณาไม่ผ่านการตรวจ (ขนาด ${size} ชนิด ${mime || "-"}) — ลบทิ้ง`,
      organizationId: order.organizationId,
      storeId: order.storeId,
      context: { adOrderId: order.id, size, mime },
    });
    return { ok: false, error: "ไฟล์ไม่ถูกต้องหรือใหญ่เกินกำหนด เลือกไฟล์ใหม่" };
  }
  const { data: pub } = db.storage.from(STORE_AD_MEDIA_BUCKET).getPublicUrl(order.mediaPath);
  await db
    .from("store_ad_orders")
    .update({ media_url: pub.publicUrl, media_size_bytes: size, updated_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("status", "pending_payment");
  void logSystemEvent({
    level: "info",
    source: "ad-self-serve",
    action: "confirmAdMedia",
    message: `อัปโหลดสื่อโฆษณาแล้ว (${mediaType}, ${(size / (1024 * 1024)).toFixed(1)} MB) — รอชำระ`,
    organizationId: order.organizationId,
    storeId: order.storeId,
    context: { adOrderId: order.id, size, mime },
  });
  return { ok: true, error: null };
}

export interface AdOrderView {
  storeName: string;
  packageName: string;
  days: number;
  amount: number;
  status: StoreAdOrderStatus;
  statusLabel: string;
  statusReason: string | null;
  advertiserName: string;
  mediaType: StoreAdMediaType | null;
  mediaUrl: string | null;
  paymentMethod: "beam" | "slip" | null;
  paymentRef: string | null;
  paidAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** วิธีจ่ายที่ร้านพร้อม (เฉพาะตอนรอชำระ) */
  payMode: "beam" | "slip" | null;
  qr: { payload: string | null; image: string | null } | null;
  notice: string | null;
}

async function storeNameOf(storeId: string): Promise<string> {
  const db = await serviceDb();
  const { data } = await db.from("stores").select("name").eq("id", storeId).maybeSingle();
  return typeof data?.name === "string" ? data.name : "ร้าน";
}

/** สร้าง/ดึง QR Beam ของคำสั่ง (idempotent ด้วย id คำสั่ง) */
async function ensureBeamQr(order: StoreAdOrder): Promise<{ ok: true; qr: BeamQrForPos } | { ok: false; error: string }> {
  const db = await serviceDb();
  const created = await createBeamQrPayment({
    organizationId: order.organizationId,
    storeId: order.storeId,
    amountMajor: order.amount,
    clientRequestId: `ad-${order.id}`,
    actorUserId: null,
    adOrderId: order.id,
    client: db,
  });
  if (!created.ok) return created;
  if (order.gatewayPaymentId !== created.qr.gatewayPaymentId) {
    await db.from("store_ad_orders").update({ gateway_payment_id: created.qr.gatewayPaymentId }).eq("id", order.id);
  }
  return created;
}

/** ช่องเต็มโดยไม่นับคำสั่งนี้ → ไม่ให้จ่าย (ไม่รับเงินเมื่อเต็ม) */
async function slotsFullFor(order: StoreAdOrder, maxConcurrent: number): Promise<boolean> {
  const others = (await listSlotOrders(order.storeId)).filter((o) => o.id !== order.id);
  return countStoreAdSlotsInUse(others, Date.now()) >= maxConcurrent;
}

async function cancelOrder(order: StoreAdOrder, reason: string): Promise<boolean> {
  const db = await serviceDb();
  const { data } = await db
    .from("store_ad_orders")
    .update({ status: "cancelled", status_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("status", "pending_payment")
    .select("id");
  if (order.gatewayPaymentId) {
    await cancelBeamQrPayment({ storeId: order.storeId, gatewayPaymentId: order.gatewayPaymentId, actorUserId: null, client: db, reason });
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * หน้าสถานะ: รอจ่าย = คืน QR (Beam) หรือ QR พร้อมเพย์ (สลิป) + ถามสถานะ Beam ไม่ถี่กว่า 10 วิ
 * จ่ายแล้วครั้งแรก = แจ้งร้าน (ทางสำรองของ webhook)
 */
export async function getAdOrderStatusAction(slug: string, token: string, withQr: boolean): Promise<{ view: AdOrderView | null; error: string | null }> {
  let order = await getAdOrderByToken(token);
  if (!order) return { view: null, error: "ไม่พบคำสั่ง" };

  let notice: string | null = null;
  let qr: AdOrderView["qr"] = null;
  let payMode: AdOrderView["payMode"] = null;

  if (order.status === "pending_payment") {
    if (order.gatewayPaymentId) {
      const db = await serviceDb();
      const refreshed = await refreshBeamPayment({
        storeId: order.storeId,
        gatewayPaymentId: order.gatewayPaymentId,
        client: db,
        minLookupIntervalMs: 10_000,
      });
      if (refreshed.ok && (refreshed.status === "LATE_PAID" || refreshed.status === "REVIEW_REQUIRED")) {
        notice = "ได้รับเงินแล้ว แต่ร้านต้องตรวจสอบก่อน — ติดต่อร้าน";
      }
      order = (await getAdOrderByToken(token)) ?? order;
    }
    if (order.status === "pending_payment" && order.expiresAt && Date.parse(order.expiresAt) <= Date.now()) {
      await cancelOrder(order, "ไม่ชำระภายในเวลา");
      order = (await getAdOrderByToken(token)) ?? order;
    }
  }

  if (order.status === "pending_payment") {
    const resolved = await resolveAdStore(slug);
    if (!resolved.ok || resolved.store.storeId !== order.storeId) {
      notice = resolved.ok ? "ลิงก์ไม่ตรงกับร้าน" : resolved.reason;
    } else if (!order.mediaUrl) {
      notice = "ยังไม่ได้อัปโหลดไฟล์โฆษณา — กลับไปเลือกไฟล์ใหม่";
    } else if (await slotsFullFor(order, resolved.store.offer.maxConcurrent)) {
      notice = "ช่องโฆษณาเพิ่งเต็ม — ยังไม่ต้องจ่าย ลองใหม่ภายหลัง";
    } else {
      payMode = resolved.store.beam ? "beam" : "slip";
      if (withQr && payMode === "beam") {
        const ensured = await ensureBeamQr(order);
        if (ensured.ok) qr = { payload: ensured.qr.qrPayload, image: ensured.qr.qrImageBase64 };
        else notice = ensured.error;
      } else if (withQr && payMode === "slip" && resolved.store.promptpayId) {
        try {
          qr = { payload: buildPromptPayPayload({ recipientId: resolved.store.promptpayId, amount: order.amount }), image: null };
        } catch {
          notice = "พร้อมเพย์ของร้านไม่ถูกต้อง — ติดต่อร้าน";
          payMode = null;
        }
      }
    }
  }

  // ทางสำรอง — ปกติ webhook Beam แจ้งไปแล้ว (claim notified_at กันซ้ำ)
  if ((order.status === "active" || order.status === "pending_review") && !order.notifiedAt) {
    await notifyAdOrderPaidOnce(order.id);
  }

  return {
    view: {
      storeName: await storeNameOf(order.storeId),
      packageName: order.packageName,
      days: order.days,
      amount: order.amount,
      status: order.status,
      statusLabel: STORE_AD_STATUS_LABEL[order.status],
      statusReason: order.statusReason,
      advertiserName: order.advertiserName,
      mediaType: order.mediaType,
      mediaUrl: order.mediaUrl,
      paymentMethod: order.paymentMethod,
      paymentRef: order.paymentRef,
      paidAt: order.paidAt,
      startsAt: order.startsAt,
      endsAt: order.endsAt,
      expiresAt: order.expiresAt,
      createdAt: order.createdAt,
      payMode,
      qr,
      notice,
    },
    error: null,
  };
}

const SLIP_RESULT_ERROR: Record<string, string> = {
  duplicate_ref: "สลิปนี้ถูกใช้ไปแล้ว",
  late: "คำสั่งนี้หมดเวลาแล้ว — ติดต่อร้านเรื่องเงินที่โอน",
  amount_mismatch: "ยอดในสลิปไม่ตรงกับยอดแพ็ก",
  not_found: "ไม่พบคำสั่ง",
};

/** ร้านไม่มี Beam: ผู้ลงโอนพร้อมเพย์ของร้านแล้วแนบสลิป — ตรวจด้วย slip2go + ยอด/ผู้รับ/เวลา */
export async function submitAdSlipAction(
  slug: string,
  token: string,
  slipBase64: string,
  contentType: string,
): Promise<{ ok: boolean; error: string | null }> {
  const order = await getAdOrderByToken(token);
  if (!order) return { ok: false, error: "ไม่พบคำสั่ง" };
  if (order.status !== "pending_payment") return { ok: false, error: "คำสั่งนี้ชำระหรือปิดไปแล้ว" };
  if (!order.mediaUrl) return { ok: false, error: "ยังไม่ได้อัปโหลดไฟล์โฆษณา" };
  if (order.expiresAt && Date.parse(order.expiresAt) <= Date.now()) return { ok: false, error: "หมดเวลาชำระ — สร้างคำสั่งใหม่" };
  if (!isSlip2goConfigured()) return { ok: false, error: "ระบบตรวจสลิปยังไม่พร้อมใช้งาน" };
  if (!slipBase64 || slipBase64.length > 3_000_000) return { ok: false, error: "แนบรูปสลิป (ไม่เกิน 2 MB)" };
  const type = /^image\/(jpeg|png|webp)$/.test(contentType) ? contentType : "image/jpeg";

  const resolved = await resolveAdStore(slug);
  if (!resolved.ok || resolved.store.storeId !== order.storeId) return { ok: false, error: resolved.ok ? "ลิงก์ไม่ตรงกับร้าน" : resolved.reason };
  if (!resolved.store.slip || !resolved.store.promptpayId) return { ok: false, error: "ร้านนี้รับชำระผ่าน QR อัตโนมัติ — ไม่ต้องแนบสลิป" };
  if (await slotsFullFor(order, resolved.store.offer.maxConcurrent)) return { ok: false, error: "ช่องโฆษณาเพิ่งเต็ม — ยังไม่ต้องโอน ลองใหม่ภายหลัง" };

  const slip = await verifySlipByImageBase64(slipBase64, type);
  if (!slip.ok) return { ok: false, error: slip.error ?? "ตรวจสลิปไม่สำเร็จ" };
  const check = validateDonationSlip({
    slipAmount: slip.amount,
    slipTransRef: slip.transRef,
    slipTransDate: slip.transDate ?? null,
    slipReceiverAccount: slip.receiverAccount,
    expectedAmount: order.amount,
    requestCreatedAt: order.createdAt,
    storePromptpayId: resolved.store.promptpayId,
    nowMs: Date.now(),
  });
  if (!check.ok) {
    const messages: Record<string, string> = {
      no_ref: "สลิปไม่มีเลขอ้างอิง",
      amount_mismatch: "ยอดในสลิปไม่ตรงกับยอดแพ็ก",
      too_old: "สลิปนี้เก่าเกินไป กรุณาโอนใหม่",
      before_request: "สลิปนี้เกิดก่อนสร้างคำสั่ง",
      wrong_recipient: "สลิปไม่ได้โอนเข้าพร้อมเพย์ของร้าน",
    };
    void logSystemEvent({
      level: "warn",
      source: "ad-self-serve",
      action: "submitAdSlip",
      message: `สลิปค่าโฆษณาไม่ผ่าน: ${check.error}`,
      organizationId: order.organizationId,
      storeId: order.storeId,
      context: { adOrderId: order.id, reason: check.error },
    });
    return { ok: false, error: messages[check.error] ?? "สลิปไม่ถูกต้อง" };
  }

  const db = await serviceDb();
  const { data: result, error } = await db.rpc("apply_store_ad_order_payment", {
    p_order_id: order.id,
    p_amount: slip.amount ?? order.amount,
    p_method: "slip",
    p_ref: `SLIP:${slip.transRef}`,
  });
  const outcome = typeof result === "string" ? result : null;
  void logSystemEvent({
    level: error || !outcome || SLIP_RESULT_ERROR[outcome] ? "warn" : "info",
    source: "ad-self-serve",
    action: "submitAdSlip",
    message: error ? `บันทึกการจ่ายค่าโฆษณาไม่สำเร็จ: ${error.message}` : `ชำระค่าโฆษณาด้วยสลิป → ${outcome}`,
    organizationId: order.organizationId,
    storeId: order.storeId,
    context: { adOrderId: order.id, outcome, amount: slip.amount },
  });
  if (error || !outcome) return { ok: false, error: "บันทึกการชำระไม่สำเร็จ ลองใหม่อีกครั้ง" };
  if (outcome === "already_paid") return { ok: true, error: null };
  if (SLIP_RESULT_ERROR[outcome]) return { ok: false, error: SLIP_RESULT_ERROR[outcome] };
  await notifyAdOrderPaidOnce(order.id);
  return { ok: true, error: null };
}

/** ผู้ลงยกเลิกก่อนจ่าย — เงินที่เข้าหลังจากนี้ trigger ทำเป็น LATE_PAID (ร้านคืนเงิน) */
export async function cancelAdOrderAction(token: string): Promise<{ error: string | null }> {
  const order = await getAdOrderByToken(token);
  if (!order) return { error: "ไม่พบคำสั่ง" };
  if (order.status !== "pending_payment") return { error: "คำสั่งนี้ยกเลิกเองไม่ได้แล้ว — ติดต่อร้าน" };
  const moved = await cancelOrder(order, "ผู้ลงโฆษณายกเลิกก่อนชำระ");
  void logSystemEvent({
    level: "info",
    source: "ad-self-serve",
    action: "cancelAdOrder",
    message: moved ? "ผู้ลงโฆษณายกเลิกคำสั่งก่อนชำระ" : "ยกเลิกคำสั่งลงโฆษณาไม่สำเร็จ (สถานะเปลี่ยนแล้ว)",
    organizationId: order.organizationId,
    storeId: order.storeId,
    context: { adOrderId: order.id },
  });
  return moved ? { error: null } : { error: "สถานะเปลี่ยนไปแล้ว ลองโหลดใหม่" };
}
