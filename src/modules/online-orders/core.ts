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
  "cod_pending",
  "delivery_failed",
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
  cod_pending: "เก็บเงินปลายทาง รอร้านรับ",
  delivery_failed: "ส่งไม่สำเร็จ/ยกเลิก",
};

export type OnlinePaymentMethod = "beam" | "cod";
/** วิธีรับเงินปลายทางตอนส่งสำเร็จ (R3a: เงินสด/โอน · Beam QR = R3b) */
export type CodCollectMethod = "cash" | "bank_transfer";

/** สถานะถัดไปที่ร้านกดได้ (รับออเดอร์ = accept ทำในเส้นทางพิเศษเพราะต้องสร้างบิล) */
export function nextStatuses(
  status: OnlineOrderStatus,
  fulfillment: Fulfillment,
  paymentMethod: OnlinePaymentMethod = "beam",
): OnlineOrderStatus[] {
  switch (status) {
    case "paid":
      return ["accepted", "refund_pending"];
    // เก็บปลายทาง: ยังไม่มีเงิน — ปฏิเสธได้เลยไม่ต้องคืนเงิน
    case "cod_pending":
      return ["accepted", "delivery_failed"];
    // รับแล้ว = บิล POS ปิดด้วยเงิน Beam แล้ว — ยกเลิก/คืนเงินหลังจากนี้ใช้ขั้นตอนบิลที่จ่ายแล้วของร้าน
    // (ยกเลิกในหน้านี้ได้เฉพาะก่อนรับ เพื่อไม่ให้ยอดขายกับเงินที่คืนไม่ตรงกัน)
    case "accepted":
      return ["preparing", fulfillment === "pickup" ? "ready" : "out_for_delivery"];
    case "preparing":
      return [fulfillment === "pickup" ? "ready" : "out_for_delivery"];
    case "ready":
      return ["completed"];
    // เก็บปลายทาง: ลูกค้าไม่รับ/ติดต่อไม่ได้ = ส่งไม่สำเร็จ (ยกเลิกบิลที่เปิดค้าง ไม่มีเงินเข้า)
    case "out_for_delivery":
      return paymentMethod === "cod" ? ["completed", "delivery_failed"] : ["completed"];
    case "refund_pending":
      return ["refunded"];
    default:
      return [];
  }
}

export function canTransition(
  from: OnlineOrderStatus,
  to: OnlineOrderStatus,
  fulfillment: Fulfillment,
  paymentMethod: OnlinePaymentMethod = "beam",
): boolean {
  return nextStatuses(from, fulfillment, paymentMethod).includes(to);
}

/** สถานะที่ร้านยังต้องจัดการ (แสดงในคิว + นับแจ้งเตือน) */
export const ACTIVE_STATUSES: OnlineOrderStatus[] = ["paid", "cod_pending", "accepted", "preparing", "ready", "out_for_delivery", "refund_pending"];

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
    /** R2: รายได้พิเศษคนส่ง (ออนไลน์ส่งถึงบ้าน) — เข้าเงินเดือนอัตโนมัติเมื่อส่งสำเร็จ */
    riderPayEnabled: z.boolean(),
    /** % ของยอดอาหาร */
    riderPayRate: z.number().min(0).max(100),
    /** บวกค่าส่งที่ลูกค้าจ่ายให้คนส่งเต็มจำนวน */
    riderPayIncludeFee: z.boolean(),
    /** R3: เก็บเงินปลายทาง (ส่งถึงบ้านเท่านั้น) */
    codEnabled: z.boolean(),
    /** เพดานยอดต่อบิล (ลูกค้าทั่วไป/ระดับที่ไม่ได้ตั้ง) */
    codMaxPerBill: z.number().min(0).max(100000),
    /** เพดานตามระดับสมาชิก { "<rank>": ยอด } */
    codTierCaps: z.record(z.string().regex(/^[0-9]{1,2}$/), z.number().min(0).max(100000)),
    /** ยืนยันเบอร์ด้วย OTP ก่อนสั่ง */
    codRequireOtp: z.boolean(),
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
  riderPayEnabled: false,
  riderPayRate: 10,
  riderPayIncludeFee: true,
  codEnabled: false,
  codMaxPerBill: 500,
  codTierCaps: {},
  codRequireOtp: true,
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
    /** R3: beam = จ่าย QR ก่อน (เดิม) · cod = เก็บเงินปลายทาง */
    paymentMethod: z.enum(["beam", "cod"]).optional(),
    /** OTP ยืนยันเบอร์ (cod) */
    otpCode: z.string().regex(/^[0-9]{4,8}$/).optional(),
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

// ---------- เก็บเงินปลายทาง (R3) ----------

/** เพดาน COD ของลูกค้า: ระดับสมาชิกที่ตั้งเพดานไว้ใช้ของระดับนั้น · นอกนั้นใช้เพดานต่อบิล */
export function codCapFor(settings: Pick<OnlineOrderSettings, "codMaxPerBill" | "codTierCaps">, tierRank: number | null): number {
  if (tierRank !== null) {
    const tierCap = settings.codTierCaps[String(tierRank)];
    if (typeof tierCap === "number" && Number.isFinite(tierCap)) return tierCap;
  }
  return settings.codMaxPerBill;
}

/** ส่งไม่สำเร็จแบบเก็บปลายทางกี่ครั้ง (90 วัน) จึงปิด COD ของเบอร์นั้น */
export const COD_FAILED_BLOCK_COUNT = 2;
export const COD_FAILED_LOOKBACK_DAYS = 90;
/** ออเดอร์เก็บปลายทางที่ยังไม่จบได้พร้อมกันต่อเบอร์ */
export const COD_MAX_ACTIVE_PER_PHONE = 2;
/**
 * OTP: อายุ 10 นาที (ต้องตรงข้อความ SMS กลาง "หมดอายุใน 10 นาที" ใน smskub.buildOtpMessage)
 * · ส่งซ้ำได้ทุก 60 วิ · ≤5 ครั้ง/เบอร์/วัน · ≤20 ครั้ง/IP/10 นาที · ใส่ผิดได้ 5 ครั้ง
 */
export const COD_OTP_TTL_MIN = 10;
export const COD_OTP_TTL_MS = COD_OTP_TTL_MIN * 60_000;
export const COD_OTP_COOLDOWN_MS = 60_000;
export const COD_OTP_MAX_PER_PHONE_DAY = 5;
export const COD_OTP_MAX_PER_IP_10MIN = 20;
export const COD_OTP_MAX_ATTEMPTS = 5;

// ---------- คนส่ง (R2) ----------

/** รายได้พิเศษคนส่ง = rate% × ยอดอาหาร (+ ค่าส่งทั้งหมดถ้าเปิด) — ยอดอาหาร = subtotal (ไม่รวมค่าส่ง) */
export function computeRiderPay(input: { subtotal: number; deliveryFee: number; rate: number; includeFee: boolean }): number {
  const food = Math.max(0, input.subtotal);
  const rate = Math.min(100, Math.max(0, input.rate));
  const fee = input.includeFee ? Math.max(0, input.deliveryFee) : 0;
  return round2(round2((food * rate) / 100) + fee);
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
