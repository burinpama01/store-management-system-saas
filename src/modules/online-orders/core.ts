import { z } from "zod";

/**
 * สั่งออนไลน์จากเว็บร้าน (S2) — ส่วนที่ไม่แตะฐานข้อมูล (ทดสอบได้ตรง ๆ)
 * ราคา/ค่าส่งคิดฝั่ง server เสมอ ค่าจากเบราว์เซอร์ใช้แค่ "เลือกอะไร" ไม่ใช่ "ราคาเท่าไร"
 */

export const ONLINE_ORDER_STATUSES = [
  "awaiting_payment",
  "paid",
  "accepted",
  "preparing",
  "ready",
  "out_for_delivery",
  "completed",
  "expired",
  "refund_pending",
  "refunded",
] as const;
export type OnlineOrderStatus = (typeof ONLINE_ORDER_STATUSES)[number];
export type Fulfillment = "pickup" | "delivery";

export const STATUS_LABEL: Record<OnlineOrderStatus, string> = {
  awaiting_payment: "รอชำระเงิน",
  paid: "จ่ายแล้ว รอร้านรับ",
  accepted: "ร้านรับออเดอร์แล้ว",
  preparing: "กำลังทำ",
  ready: "พร้อมรับที่ร้าน",
  out_for_delivery: "กำลังไปส่ง",
  completed: "สำเร็จ",
  expired: "หมดเวลาชำระ",
  refund_pending: "ยกเลิก รอร้านคืนเงิน",
  refunded: "ยกเลิก คืนเงินแล้ว",
};

/** สถานะถัดไปที่ร้านกดได้ (รับออเดอร์ = accept ทำในเส้นทางพิเศษเพราะต้องสร้างบิล) */
export function nextStatuses(status: OnlineOrderStatus, fulfillment: Fulfillment): OnlineOrderStatus[] {
  switch (status) {
    case "paid":
      return ["accepted", "refund_pending"];
    // รับแล้ว = บิล POS ปิดด้วยเงิน Beam แล้ว — ยกเลิก/คืนเงินหลังจากนี้ใช้ขั้นตอนบิลที่จ่ายแล้วของร้าน
    // (ยกเลิกในหน้านี้ได้เฉพาะก่อนรับ เพื่อไม่ให้ยอดขายกับเงินที่คืนไม่ตรงกัน)
    case "accepted":
      return ["preparing", fulfillment === "pickup" ? "ready" : "out_for_delivery"];
    case "preparing":
      return [fulfillment === "pickup" ? "ready" : "out_for_delivery"];
    case "ready":
    case "out_for_delivery":
      return ["completed"];
    case "refund_pending":
      return ["refunded"];
    default:
      return [];
  }
}

export function canTransition(from: OnlineOrderStatus, to: OnlineOrderStatus, fulfillment: Fulfillment): boolean {
  return nextStatuses(from, fulfillment).includes(to);
}

/** สถานะที่ร้านยังต้องจัดการ (แสดงในคิว + นับแจ้งเตือน) */
export const ACTIVE_STATUSES: OnlineOrderStatus[] = ["paid", "accepted", "preparing", "ready", "out_for_delivery", "refund_pending"];

// ---------- ตั้งค่า ----------

export const onlineOrderSettingsSchema = z
  .object({
    enabled: z.boolean(),
    pickupEnabled: z.boolean(),
    deliveryEnabled: z.boolean(),
    originLat: z.number().min(-90).max(90).nullable(),
    originLng: z.number().min(-180).max(180).nullable(),
    deliveryRadiusKm: z.number().gt(0).max(50),
    deliveryBaseFee: z.number().min(0).max(10000),
    deliveryFeePerKm: z.number().min(0).max(1000),
    deliveryFreeOver: z.number().min(0).max(1000000).nullable(),
    /** ส่งฟรีในระยะกี่ กม. แรก (0 = ไม่มี) — เกินระยะนี้คิดเฉพาะส่วนที่เกิน */
    deliveryFreeKm: z.number().min(0).max(50),
    minOrder: z.number().min(0).max(1000000),
    prepMinutes: z.number().int().min(0).max(240),
  })
  .strict()
  .refine((s) => (s.originLat === null) === (s.originLng === null), "พิกัดร้านต้องมีทั้งละติจูดและลองจิจูด")
  .refine((s) => !s.deliveryEnabled || s.originLat !== null, "เปิดส่งถึงบ้านต้องตั้งพิกัดร้านก่อน")
  .refine((s) => s.deliveryFreeKm <= s.deliveryRadiusKm, "ระยะส่งฟรีต้องไม่เกินรัศมีส่ง")
  .refine((s) => !s.enabled || s.pickupEnabled || s.deliveryEnabled, "เลือกอย่างน้อย 1 ช่องทาง (รับที่ร้าน/ส่งถึงบ้าน)");
export type OnlineOrderSettings = z.infer<typeof onlineOrderSettingsSchema>;

export const DEFAULT_ONLINE_ORDER_SETTINGS: OnlineOrderSettings = {
  enabled: false,
  pickupEnabled: true,
  deliveryEnabled: false,
  originLat: null,
  originLng: null,
  deliveryRadiusKm: 5,
  deliveryBaseFee: 20,
  deliveryFeePerKm: 10,
  deliveryFreeOver: null,
  deliveryFreeKm: 0,
  minOrder: 0,
  prepMinutes: 20,
};

// ---------- ตะกร้า (สิ่งที่ลูกค้าส่งมา) ----------

const uuid = z.string().uuid();
export const MAX_CART_LINES = 30;
export const MAX_LINE_QTY = 50;

export const cartLineSchema = z
  .object({
    productId: uuid,
    variantId: uuid.nullable(),
    modifierOptionIds: z.array(uuid).max(20),
    quantity: z.number().int().min(1).max(MAX_LINE_QTY),
    note: z.string().trim().max(120).optional(),
  })
  .strict();
export type CartLine = z.infer<typeof cartLineSchema>;

export const checkoutSchema = z
  .object({
    clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
    fulfillment: z.enum(["pickup", "delivery"]),
    items: z.array(cartLineSchema).min(1).max(MAX_CART_LINES),
    customerName: z.string().trim().min(1).max(80),
    customerPhone: z.string().trim().regex(/^0[0-9]{8,9}$/, "เบอร์โทรไม่ถูกต้อง"),
    address: z.string().trim().max(300).optional(),
    addressNote: z.string().trim().max(200).optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    /** นาทีจากตอนนี้ (รับที่ร้าน) — null = เร็วที่สุด */
    pickupInMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** เบอร์ไทย: ตัดขีด/ช่องว่าง, +66 → 0 */
export function normalizeThaiPhone(raw: string): string {
  const digits = raw.replace(/[\s-]/g, "");
  if (digits.startsWith("+66")) return `0${digits.slice(3)}`;
  if (digits.startsWith("66") && digits.length === 11) return `0${digits.slice(2)}`;
  return digits;
}

// ---------- ค่าส่ง ----------

/** ระยะเส้นตรง (กม.) ระหว่างสองพิกัด */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export type DeliveryQuote =
  | { ok: true; distanceKm: number; fee: number }
  | { ok: false; error: string };

/**
 * ค่าส่ง = ค่าเริ่มต้น + ค่าต่อ กม. × ระยะที่คิดเงิน (ปัดขึ้นทีละ 0.5 กม.)
 * · ส่งฟรีในระยะ X กม. แรก: ไม่เกิน X = ฟรี · เกิน X = คิดเฉพาะส่วนที่เกิน (ระยะที่คิดเงิน = ระยะ − X)
 * · ส่งฟรีเมื่อยอดถึง · เกินรัศมี = ส่งไม่ได้
 */
export function quoteDelivery(
  settings: OnlineOrderSettings,
  subtotal: number,
  point: { lat: number; lng: number } | null,
): DeliveryQuote {
  if (!settings.deliveryEnabled) return { ok: false, error: "ร้านยังไม่เปิดส่งถึงบ้าน" };
  if (settings.originLat === null || settings.originLng === null) return { ok: false, error: "ร้านยังไม่ได้ตั้งพิกัดร้าน" };
  if (!point) return { ok: false, error: "ปักหมุดจุดส่งบนแผนที่ (หรือกดใช้ตำแหน่งปัจจุบัน) เพื่อคำนวณค่าส่ง" };
  const distanceKm = round2(haversineKm({ lat: settings.originLat, lng: settings.originLng }, point));
  if (distanceKm > settings.deliveryRadiusKm) {
    return { ok: false, error: `อยู่นอกพื้นที่ส่ง (ห่าง ${distanceKm.toFixed(1)} กม. ร้านส่งไม่เกิน ${settings.deliveryRadiusKm} กม.)` };
  }
  if (settings.deliveryFreeOver !== null && subtotal >= settings.deliveryFreeOver) return { ok: true, distanceKm, fee: 0 };
  const freeKm = settings.deliveryFreeKm;
  if (freeKm > 0 && distanceKm <= freeKm) return { ok: true, distanceKm, fee: 0 };
  const billedKm = Math.ceil(Math.max(0, distanceKm - freeKm) * 2) / 2;
  return { ok: true, distanceKm, fee: round2(settings.deliveryBaseFee + settings.deliveryFeePerKm * billedKm) };
}

// ---------- อื่น ๆ ----------

/** รหัสออเดอร์ที่ลูกค้า/ร้านพูดกันได้ (ไม่ใช่กุญแจเข้าถึง) */
export function onlineOrderCode(id: string): string {
  return `W-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** ปิดบังเบอร์ในหน้าติดตาม (หน้าสาธารณะ) */
export function maskPhone(phone: string): string {
  return phone.length < 7 ? "***" : `${phone.slice(0, 3)}-xxx-${phone.slice(-4)}`;
}

/** หมดเวลาชำระหลัง QR หมดอายุ + เผื่อเวลา webhook มาช้า */
export const PAYMENT_GRACE_MS = 15 * 60 * 1000;
export const QR_LIFETIME_MS = 10 * 60 * 1000;

export function isPaymentWindowOver(expiresAtIso: string, nowMs: number): boolean {
  return Date.parse(expiresAtIso) + PAYMENT_GRACE_MS < nowMs;
}

/** รายการในตะกร้าหลังคิดราคาฝั่ง server (เก็บเป็น snapshot ใน online_orders.items) */
export interface PricedLine {
  productId: string;
  productName: string;
  variantId: string | null;
  variantName: string | null;
  modifiers: { modifierGroupId: string; modifierGroupName: string; option: { id: string; name: string; priceAdjustment: number } }[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  note: string | null;
  kitchenStationId: string | null;
  kitchenStationName: string | null;
}
