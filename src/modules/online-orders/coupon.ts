import { evaluateCouponForCart, normalizeCouponCode } from "@/modules/promotions/coupon-policy";
import type { CouponPolicy, CouponRejectionReason } from "@/modules/promotions/types";

/**
 * คูปองในหน้าสั่งออนไลน์ (ส่วนที่ไม่แตะฐานข้อมูล) — ใช้กติกาคูปองเดิมของ POS (evaluateCouponForCart)
 * · ลดเฉพาะค่าอาหาร ไม่ลดค่าส่ง · ยอดชำระหลังลดต้องเหลืออย่างน้อย 1 บาท (QR พร้อมเพย์จ่าย 0 ไม่ได้)
 */

export const MIN_ONLINE_TOTAL = 1;
export const COUPON_CODE_MAX = 40;

/** รหัสคูปองจากลูกค้า → ตัวพิมพ์ใหญ่ไม่มีช่องว่าง · ยาว/อักขระแปลก = ว่าง (ไม่ไปค้นฐานข้อมูล) */
export function cleanOnlineCouponCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const code = normalizeCouponCode(raw);
  if (!code || code.length > COUPON_CODE_MAX) return "";
  // ตัดอักขระควบคุม (ค้นฐานข้อมูลแบบ parameter อยู่แล้ว แค่กันข้อมูลขยะ)
  return /[\p{Cc}\p{Cf}]/u.test(code) ? "" : code;
}

export const COUPON_REASON_MESSAGE: Record<CouponRejectionReason, string> = {
  coupon_code_mismatch: "ไม่พบคูปองนี้",
  coupon_inactive: "คูปองนี้ใช้ไม่ได้แล้ว",
  coupon_wrong_store: "ไม่พบคูปองนี้",
  coupon_not_started: "คูปองนี้ยังไม่เริ่มใช้",
  coupon_expired: "คูปองนี้หมดอายุแล้ว",
  coupon_min_subtotal: "ยอดค่าอาหารยังไม่ถึงขั้นต่ำของคูปอง",
  coupon_usage_limit: "คูปองนี้ถูกใช้ครบจำนวนแล้ว",
  coupon_customer_usage_limit: "คุณใช้คูปองนี้ครบจำนวนแล้ว",
  coupon_customer_required: "คูปองนี้ใช้ได้เฉพาะสมาชิก — สั่งผ่านหน้าสมาชิกของร้าน",
  coupon_manual_discount_conflict: "คูปองนี้ใช้ร่วมกับส่วนลดอื่นไม่ได้",
  coupon_invalid_discount: "คูปองนี้ใช้กับรายการนี้ไม่ได้",
};

export type OnlineCouponResult =
  | { ok: true; couponId: string; code: string; name: string; discount: number }
  | { ok: false; code: string; error: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

function baht(n: number): string {
  return n.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

/**
 * คิดส่วนลดคูปองของคำสั่งซื้อออนไลน์
 * @param coupon null = ไม่พบรหัสในร้านนี้
 * @param customerId ลูกค้าที่ยืนยันตัวแล้ว (สมาชิกที่ล็อกอิน) — ไม่ใช้เบอร์ที่พิมพ์เอง
 */
export function evaluateOnlineCoupon(input: {
  coupon: (CouponPolicy & { allowOnline: boolean }) | null;
  code: string;
  storeId: string;
  subtotal: number;
  deliveryFee: number;
  customerId: string | null;
  now?: Date;
}): OnlineCouponResult {
  const code = cleanOnlineCouponCode(input.code);
  if (!code || !input.coupon) return { ok: false, code, error: "ไม่พบคูปองนี้" };
  if (!input.coupon.allowOnline) return { ok: false, code, error: "คูปองนี้ใช้ได้ที่หน้าร้านเท่านั้น" };

  const result = evaluateCouponForCart({
    coupon: input.coupon,
    cart: { storeId: input.storeId, subtotal: input.subtotal, discount: 0 },
    code,
    customerId: input.customerId,
    now: input.now,
  });
  if (!result.ok) {
    const message =
      result.reason === "coupon_min_subtotal"
        ? `${COUPON_REASON_MESSAGE.coupon_min_subtotal} (฿${baht(input.coupon.minSubtotal)})`
        : COUPON_REASON_MESSAGE[result.reason];
    return { ok: false, code, error: message };
  }

  // ยอดชำระ = ค่าอาหาร − ส่วนลด + ค่าส่ง ต้อง ≥ 1 บาท → ตัดส่วนลดส่วนเกิน
  const maxDiscount = round2(Math.max(0, input.subtotal + input.deliveryFee - MIN_ONLINE_TOTAL));
  const discount = round2(Math.min(result.discount, maxDiscount));
  if (discount <= 0) return { ok: false, code, error: COUPON_REASON_MESSAGE.coupon_invalid_discount };
  return { ok: true, couponId: input.coupon.id, code, name: input.coupon.name, discount };
}

/** ยอดชำระหลังหักคูปอง */
export function onlineOrderTotal(subtotal: number, discount: number, deliveryFee: number): number {
  return round2(subtotal - discount + deliveryFee);
}

// ---------- ด่านเดาโค้ด (หน้าเว็บสาธารณะ) ----------

export const ONLINE_COUPON_WINDOW_MS = 10 * 60 * 1000;
/** ผิดเกินจำนวนนี้ต่อ IP ใน 10 นาที = พัก */
export const ONLINE_COUPON_MAX_FAILED_PER_IP = 8;
/** ผิดรวมทั้งร้าน (ช่องทางออนไลน์) — กันยิงจากหลาย IP */
export const ONLINE_COUPON_MAX_FAILED_PER_STORE = 60;
export const COUPON_BLOCKED_MESSAGE = "ใส่รหัสคูปองผิดหลายครั้ง — ลองใหม่อีกครั้งในอีกสักครู่";
