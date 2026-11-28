/**
 * ลงโฆษณาผ่าน QR (แผน v1 เฟส A2–A3) — กติกาคำสั่งลงโฆษณา แบบ pure ทดสอบได้
 * ใช้ทั้งหน้าสาธารณะ /ads/<slug>, หน้าหลังร้าน และจอลูกค้า
 */
import {
  CUSTOMER_DISPLAY_IMAGE_MAX_BYTES,
  CUSTOMER_DISPLAY_VIDEO_MAX_BYTES,
  type CustomerDisplayAdSlide,
  type CustomerDisplaySettings,
} from "@/modules/settings/customer-display";
import type { StoreAdOffer, StoreAdPackage, StoreAdSlot } from "./rules";

export type StoreAdOrderStatus =
  | "pending_payment"
  | "pending_review"
  | "active"
  | "rejected"
  | "removed"
  | "expired"
  | "cancelled";

export type StoreAdMediaType = "image" | "video";

export interface StoreAdOrder {
  id: string;
  organizationId: string;
  storeId: string;
  publicToken: string | null;
  clientRequestId: string | null;
  packageId: string;
  packageName: string;
  days: number;
  amount: number;
  advertiserName: string;
  advertiserPhone: string;
  mediaType: StoreAdMediaType | null;
  mediaPath: string | null;
  mediaUrl: string | null;
  mediaDurationSeconds: number | null;
  mediaSizeBytes: number | null;
  slot: StoreAdSlot;
  status: StoreAdOrderStatus;
  paymentMethod: "beam" | "slip" | null;
  paymentRef: string | null;
  gatewayPaymentId: string | null;
  paidAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  expiresAt: string | null;
  statusReason: string | null;
  notifiedAt: string | null;
  createdAt: string;
}

/** ไม่จ่ายภายในเวลานี้ = ยกเลิก (cron ทุก 10 นาที + ตรวจตอนเปิดหน้า) */
export const STORE_AD_PAYMENT_WINDOW_MS = 30 * 60 * 1000;
/** กันสแปม: คำสั่งต่อ IP ต่อชั่วโมง / คำสั่งรอจ่ายต่อเบอร์ / ต่อร้าน */
export const STORE_AD_MAX_ORDERS_PER_IP_HOUR = 5;
export const STORE_AD_MAX_PENDING_PER_PHONE = 2;
export const STORE_AD_MAX_PENDING_PER_STORE = 20;
export const STORE_AD_NAME_MAX = 80;

export const STORE_AD_STATUS_LABEL: Record<StoreAdOrderStatus, string> = {
  pending_payment: "รอชำระเงิน",
  pending_review: "จ่ายแล้ว · รอร้านอนุมัติ",
  active: "กำลังแสดงบนจอ",
  rejected: "ร้านไม่อนุมัติ",
  removed: "ร้านถอดออกแล้ว",
  expired: "หมดอายุแล้ว",
  cancelled: "ยกเลิก / หมดเวลาชำระ",
};

const VIDEO_TYPES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** นามสกุล + ชนิดที่รับ — คืน content-type ที่จะใช้ตอนอัปโหลด */
export function storeAdMediaContentType(mediaType: StoreAdMediaType, extension: string): string | null {
  const ext = extension.trim().toLowerCase().replace(/^\./, "");
  return (mediaType === "video" ? VIDEO_TYPES : IMAGE_TYPES)[ext] ?? null;
}

export function storeAdMediaMaxBytes(mediaType: StoreAdMediaType): number {
  return mediaType === "video" ? CUSTOMER_DISPLAY_VIDEO_MAX_BYTES : CUSTOMER_DISPLAY_IMAGE_MAX_BYTES;
}

export interface StoreAdMediaCheckInput {
  mediaType: unknown;
  extension: unknown;
  sizeBytes: unknown;
  durationSeconds: unknown;
}

/** ตรวจสื่อก่อนออกสิทธิ์อัปโหลด (ฝั่งเครื่องตรวจก่อนแล้ว ฝั่ง server ตรวจซ้ำ) */
export function checkStoreAdMedia(
  offer: Pick<StoreAdOffer, "allowVideo" | "allowImage" | "maxVideoSeconds">,
  input: StoreAdMediaCheckInput,
): { ok: true; mediaType: StoreAdMediaType; extension: string; contentType: string; sizeBytes: number; durationSeconds: number | null } | { ok: false; error: string } {
  const mediaType = input.mediaType === "video" ? "video" : input.mediaType === "image" ? "image" : null;
  if (!mediaType) return { ok: false, error: "เลือกไฟล์วิดีโอหรือรูปภาพ" };
  if (mediaType === "video" && !offer.allowVideo) return { ok: false, error: "ร้านนี้ไม่รับโฆษณาแบบวิดีโอ" };
  if (mediaType === "image" && !offer.allowImage) return { ok: false, error: "ร้านนี้ไม่รับโฆษณาแบบรูปภาพ" };
  const extension = typeof input.extension === "string" ? input.extension.trim().toLowerCase().replace(/^\./, "") : "";
  const contentType = storeAdMediaContentType(mediaType, extension);
  if (!contentType) {
    return { ok: false, error: mediaType === "video" ? "รองรับวิดีโอ MP4, WEBM, MOV" : "รองรับรูป JPG, PNG, WEBP, GIF" };
  }
  const sizeBytes = typeof input.sizeBytes === "number" ? input.sizeBytes : NaN;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { ok: false, error: "อ่านขนาดไฟล์ไม่ได้" };
  const maxBytes = storeAdMediaMaxBytes(mediaType);
  if (sizeBytes > maxBytes) return { ok: false, error: `ไฟล์ใหญ่เกิน ${Math.round(maxBytes / (1024 * 1024))} MB` };
  let durationSeconds: number | null = null;
  if (mediaType === "video") {
    const d = typeof input.durationSeconds === "number" ? input.durationSeconds : NaN;
    if (!Number.isFinite(d) || d <= 0) return { ok: false, error: "อ่านความยาววิดีโอไม่ได้ ลองไฟล์ MP4" };
    // เผื่อปัดเศษ 1 วินาที
    if (d > offer.maxVideoSeconds + 1) return { ok: false, error: `วิดีโอยาวเกิน ${offer.maxVideoSeconds} วินาที` };
    durationSeconds = Math.round(d * 100) / 100;
  }
  return { ok: true, mediaType, extension, contentType, sizeBytes, durationSeconds };
}

export function findStoreAdPackage(packages: readonly StoreAdPackage[], packageId: unknown): StoreAdPackage | null {
  return typeof packageId === "string" ? packages.find((pkg) => pkg.id === packageId) ?? null : null;
}

/** โฆษณาที่ "จองช่อง" อยู่ = กำลังแสดง (ยังไม่หมดอายุ) + จ่ายแล้วรออนุมัติ */
export function countStoreAdSlotsInUse(
  orders: readonly Pick<StoreAdOrder, "status" | "endsAt">[],
  nowMs: number,
): number {
  return orders.filter(
    (o) => o.status === "pending_review" || (o.status === "active" && o.endsAt !== null && Date.parse(o.endsAt) > nowMs),
  ).length;
}

/** ช่องเต็ม → วันที่ว่างถัดไป = โฆษณาที่หมดเร็วที่สุด (null = ไม่รู้ เช่นมีแต่รออนุมัติ) */
export function nextStoreAdFreeAt(
  orders: readonly Pick<StoreAdOrder, "status" | "endsAt">[],
  nowMs: number,
): string | null {
  const ends = orders
    .filter((o) => o.status === "active" && o.endsAt && Date.parse(o.endsAt) > nowMs)
    .map((o) => Date.parse(o.endsAt as string))
    .sort((a, b) => a - b);
  return ends.length > 0 ? new Date(ends[0]).toISOString() : null;
}

/** โฆษณาที่ควรขึ้นจอตอนนี้ (กรองวันหมดอายุตอนอ่าน — ไม่ต้องรอ cron) */
export function isStoreAdLive(order: Pick<StoreAdOrder, "status" | "mediaUrl" | "startsAt" | "endsAt">, nowMs: number): boolean {
  if (order.status !== "active" || !order.mediaUrl || !order.startsAt || !order.endsAt) return false;
  return Date.parse(order.startsAt) <= nowMs && Date.parse(order.endsAt) > nowMs;
}

export function storeAdSlide(order: Pick<StoreAdOrder, "id" | "mediaType" | "mediaUrl">, slot: "top" | "bottom"): CustomerDisplayAdSlide | null {
  if (!order.mediaUrl) return null;
  return {
    id: `customer-ad-${order.id}`,
    slot,
    mediaType: order.mediaType === "video" ? "video" : "image",
    url: order.mediaUrl,
    // สื่อของลูกค้ามีหลายสัดส่วน → แสดงครบทั้งภาพ ไม่ตัดขอบ
    fit: "contain",
  };
}

/** ร้าน 1 : ลูกค้า 1 — สลับกันจนหมดฝั่งใดฝั่งหนึ่ง แล้วต่อด้วยที่เหลือ */
export function interleaveStoreAds<T>(storeSlides: readonly T[], customerSlides: readonly T[]): T[] {
  const out: T[] = [];
  const n = Math.max(storeSlides.length, customerSlides.length);
  for (let i = 0; i < n; i += 1) {
    if (i < storeSlides.length) out.push(storeSlides[i]);
    if (i < customerSlides.length) out.push(customerSlides[i]);
  }
  return out;
}

/** จอโฆษณาร้านเปิดอยู่และมีช่องให้แสดง — หน้าลงโฆษณาไม่รับคำสั่งถ้าจอจะไม่แสดง */
export function canDisplayCustomerAds(settings: Pick<CustomerDisplaySettings, "adEnabled" | "topSlotEnabled" | "bottomSlotEnabled">): boolean {
  return settings.adEnabled && (settings.topSlotEnabled || settings.bottomSlotEnabled);
}

/**
 * รวมโฆษณาลูกค้าที่กำลังแสดงเข้ากับโฆษณาร้านสำหรับจอลูกค้า (ไม่บันทึกกลับ)
 * - แบ่งครึ่ง: top/bottom ลงช่องนั้น · any กระจายสลับบน/ล่าง · ช่องที่ปิดอยู่ย้ายไปช่องที่เปิด
 * - จอเดียว: รวมโฆษณาร้านทุกช่องที่เปิดแล้วสลับ 1:1
 */
export function mergeStoreAdsIntoDisplay(
  settings: CustomerDisplaySettings,
  orders: readonly Pick<StoreAdOrder, "id" | "mediaType" | "mediaUrl" | "slot">[],
): CustomerDisplaySettings {
  if (!canDisplayCustomerAds(settings) || orders.length === 0) return settings;
  const top = settings.topSlotEnabled ? settings.topSlides : [];
  const bottom = settings.bottomSlotEnabled ? settings.bottomSlides : [];

  if (settings.adLayout === "split") {
    const topAds: CustomerDisplayAdSlide[] = [];
    const bottomAds: CustomerDisplayAdSlide[] = [];
    let anyIndex = 0;
    for (const order of orders) {
      let target: "top" | "bottom" = order.slot === "top" ? "top" : order.slot === "bottom" ? "bottom" : anyIndex++ % 2 === 0 ? "top" : "bottom";
      if (target === "top" && !settings.topSlotEnabled) target = "bottom";
      if (target === "bottom" && !settings.bottomSlotEnabled) target = "top";
      const slide = storeAdSlide(order, target);
      if (!slide) continue;
      (target === "top" ? topAds : bottomAds).push(slide);
    }
    return {
      ...settings,
      topSlides: settings.topSlotEnabled ? interleaveStoreAds(top, topAds) : settings.topSlides,
      bottomSlides: settings.bottomSlotEnabled ? interleaveStoreAds(bottom, bottomAds) : settings.bottomSlides,
    };
  }

  const ads = orders.map((order) => storeAdSlide(order, "top")).filter((s): s is CustomerDisplayAdSlide => s !== null);
  return {
    ...settings,
    topSlotEnabled: true,
    bottomSlotEnabled: false,
    topSlides: interleaveStoreAds([...top, ...bottom], ads),
    bottomSlides: [],
  };
}

/** แปลงแถวจากฐานข้อมูล */
export function mapStoreAdOrderRow(row: Record<string, unknown>): StoreAdOrder {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const status = String(row.status ?? "pending_payment") as StoreAdOrderStatus;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    storeId: String(row.store_id),
    publicToken: str(row.public_token),
    clientRequestId: str(row.client_request_id),
    packageId: String(row.package_id ?? ""),
    packageName: String(row.package_name ?? ""),
    days: Number(row.days ?? 0),
    amount: Number(row.amount ?? 0),
    advertiserName: String(row.advertiser_name ?? ""),
    advertiserPhone: String(row.advertiser_phone ?? ""),
    mediaType: row.media_type === "video" ? "video" : row.media_type === "image" ? "image" : null,
    mediaPath: str(row.media_path),
    mediaUrl: str(row.media_url),
    mediaDurationSeconds: num(row.media_duration_seconds),
    mediaSizeBytes: num(row.media_size_bytes),
    slot: row.slot === "top" || row.slot === "bottom" ? row.slot : "any",
    status: status in STORE_AD_STATUS_LABEL ? status : "pending_payment",
    paymentMethod: row.payment_method === "beam" || row.payment_method === "slip" ? row.payment_method : null,
    paymentRef: str(row.payment_ref),
    gatewayPaymentId: str(row.gateway_payment_id),
    paidAt: str(row.paid_at),
    startsAt: str(row.starts_at),
    endsAt: str(row.ends_at),
    expiresAt: str(row.expires_at),
    statusReason: str(row.status_reason),
    notifiedAt: str(row.notified_at),
    createdAt: String(row.created_at ?? new Date(0).toISOString()),
  };
}

/** ร้านอนุมัติ/ไม่อนุมัติ/ถอด — สถานะต้นทางที่ยอมให้เปลี่ยน */
export const STORE_AD_REVIEW_TRANSITIONS = {
  approve: { from: ["pending_review"], to: "active" },
  reject: { from: ["pending_review"], to: "rejected" },
  remove: { from: ["active"], to: "removed" },
} as const satisfies Record<string, { from: readonly StoreAdOrderStatus[]; to: StoreAdOrderStatus }>;

export type StoreAdReviewAction = keyof typeof STORE_AD_REVIEW_TRANSITIONS;
