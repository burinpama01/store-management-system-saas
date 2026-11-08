import type { Cart } from "./types";
import type { CustomerProfile } from "@/modules/customers/types";
import { normalizeCustomerPhone } from "@/shared/utils/customer-phone";

/**
 * ตัวช่วยฝั่ง POS สำหรับสะสมแต้ม / คูปอง / ส่วนลด (ไม่มี side effect — เทสต์ได้ตรง ๆ)
 */

/**
 * ลายนิ้วมือของตะกร้าที่มีผลต่อยอดคูปอง — เปลี่ยนเมื่อไหร่ต้องคำนวณคูปองใหม่
 * (เดิมคำนวณครั้งเดียวตอนกด "ใช้คูปอง" แก้ตะกร้าทีหลังแล้วชำระไม่ผ่าน)
 */
export function couponCartKey(cart: Pick<Cart, "subtotal" | "discount" | "items">): string {
  const items = cart.items
    .map((item) => `${item.key}:${item.quantity}:${item.totalPrice}`)
    .sort()
    .join(",");
  return `${cart.subtotal}|${cart.discount}|${items}`;
}

/** เบอร์มือถือไทยครบหลัก (0 + 9 หลัก) — ใช้ตัดสินใจค้นหาทันทีโดยไม่ต้องรอ */
export function isCompleteThaiMobile(query: string): boolean {
  return /^0\d{9}$/.test(normalizeCustomerPhone(query));
}

/** เบอร์ที่ใช้สมัครสมาชิกได้ (เบอร์บ้าน 9 หลัก หรือมือถือ 10 หลัก ขึ้นต้น 0) */
export function isRegistrablePhone(query: string): boolean {
  return /^0\d{8,9}$/.test(normalizeCustomerPhone(query));
}

/** คำค้นที่ควรค้นเองขณะพิมพ์ (ชื่อ ≥ 2 ตัว หรือเบอร์ ≥ 4 หลัก) */
export function shouldAutoSearchCustomer(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (/^[\d\s()-]+$/.test(trimmed)) return normalizeCustomerPhone(trimmed).length >= 4;
  return trimmed.length >= 2;
}

/** พิมพ์เบอร์ครบแล้วเจอคนเดียวที่เบอร์ตรงเป๊ะ → เลือกให้เลย ไม่ต้องแตะอีก */
export function pickAutoSelectCustomer(query: string, results: CustomerProfile[]): CustomerProfile | null {
  if (!isCompleteThaiMobile(query)) return null;
  const phone = normalizeCustomerPhone(query);
  const exact = results.filter((customer) => normalizeCustomerPhone(customer.phone) === phone);
  return exact.length === 1 ? exact[0] : null;
}

/** ชื่อเริ่มต้นตอนสมัครจาก POS โดยไม่ได้กรอกชื่อ — โชว์แค่ 4 หลักท้าย */
export function fallbackMemberName(phone: string): string {
  const digits = normalizeCustomerPhone(phone);
  return `ลูกค้า ${digits.slice(-4)}`;
}

export interface DiscountPreset {
  label: string;
  type: "amount" | "percentage";
  value: number;
}

export const BILL_DISCOUNT_PRESETS: readonly DiscountPreset[] = [
  { label: "5%", type: "percentage", value: 5 },
  { label: "10%", type: "percentage", value: 10 },
  { label: "20%", type: "percentage", value: 20 },
  { label: "฿10", type: "amount", value: 10 },
  { label: "฿20", type: "amount", value: 20 },
  { label: "฿50", type: "amount", value: 50 },
];

export const DISCOUNT_REASON_PRESETS: readonly string[] = ["พนักงาน", "ลูกค้าประจำ", "วันเกิด", "โปรโมชัน"];

/** ส่วนลดลัดที่ใช้ได้กับยอดนี้ (ส่วนลดบาทต้องไม่เกินยอดรวม) */
export function availableDiscountPresets(subtotal: number): DiscountPreset[] {
  return BILL_DISCOUNT_PRESETS.filter((preset) => preset.type === "percentage" || preset.value < subtotal);
}

export interface PosRewardVoucher {
  redemptionId: string;
  code: string;
  rewardName: string;
  rewardType: "product" | "discount";
  expiresAt: string | null;
}

/** โค้ดที่ยังแตะใช้ได้ — ตัดตัวที่อยู่ในบิลแล้ว (ของรางวัล) หรือใช้เป็นคูปองอยู่ */
export function usableVouchers(
  vouchers: PosRewardVoucher[],
  cart: Pick<Cart, "items">,
  appliedCouponCode: string | null | undefined,
): PosRewardVoucher[] {
  const inCart = new Set(cart.items.map((item) => item.rewardVoucherCode).filter(Boolean));
  const applied = appliedCouponCode?.toUpperCase() ?? null;
  return vouchers.filter((voucher) => !inCart.has(voucher.code) && voucher.code.toUpperCase() !== applied);
}
