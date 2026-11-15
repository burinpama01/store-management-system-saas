import type { Cart, CartItem } from "@/modules/pos/types";

/**
 * เงื่อนไขเริ่มต้นของแพ็ก (ผู้ใช้ตัดสินใจ: ไม่คืนเงินทุกกรณี ต้องแจ้งละเอียด — ร้านแก้ได้)
 * แนะนำให้ร้านปรึกษาที่ปรึกษากฎหมายก่อนใช้จริง (กฎหมายคุ้มครองผู้บริโภค)
 */
export const DEFAULT_PREPAID_PASS_TERMS = [
  "1. แพ็กนี้ไม่สามารถขอคืนเงิน แลกเป็นเงินสด หรือเปลี่ยนเป็นสินค้าอื่นได้ทุกกรณี",
  "2. ใช้ได้เฉพาะเจ้าของเบอร์โทรที่ซื้อเท่านั้น โอนหรือแบ่งให้ผู้อื่นไม่ได้",
  "3. ทุกครั้งที่ใช้ต้องแสดงรหัสใช้สิทธิ์ 5 นาทีจากหน้าสมาชิกในมือถือ หากไม่มีมือถือจะใช้สิทธิ์ไม่ได้",
  "4. สิทธิ์ที่เหลือเมื่อแพ็กหมดอายุจะถูกยกเลิกทันทีโดยไม่คืนเงิน",
  "5. ใช้ได้เฉพาะเมนูและสาขาที่ระบุในแพ็กเท่านั้น",
  "6. หากร้านปรับราคาเมนูภายหลัง สิทธิ์ที่ซื้อไว้ยังใช้ได้ตามจำนวนเดิม",
].join("\n");

export type PassRedeemScope = "store" | "org";

export interface PassPlanInput {
  name: string;
  credits: number;
  price: number;
  validDays: number | null;
  redeemScope: PassRedeemScope;
  terms: string;
  productIds: string[];
  isActive: boolean;
}

export function validatePassPlanInput(input: PassPlanInput): string | null {
  const name = input.name.trim();
  if (!name) return "กรุณาตั้งชื่อแพ็ก";
  if (name.length > 120) return "ชื่อแพ็กยาวเกินไป";
  if (!Number.isInteger(input.credits) || input.credits < 1 || input.credits > 1000) return "จำนวนสิทธิ์ต้องเป็น 1–1,000";
  if (!Number.isFinite(input.price) || input.price <= 0) return "ราคาแพ็กต้องมากกว่า 0";
  if (Math.round(input.price * 100) !== input.price * 100) return "ราคาแพ็กทศนิยมได้ไม่เกิน 2 ตำแหน่ง";
  if (input.validDays !== null && (!Number.isInteger(input.validDays) || input.validDays < 1 || input.validDays > 3650)) {
    return "อายุแพ็กต้องเป็น 1–3,650 วัน หรือไม่หมดอายุ";
  }
  if (input.redeemScope !== "store" && input.redeemScope !== "org") return "ขอบเขตการใช้ไม่ถูกต้อง";
  const terms = input.terms.trim();
  if (terms.length < 20) return "กรุณาเขียนเงื่อนไขแพ็กให้ละเอียด (อย่างน้อย 20 ตัวอักษร)";
  if (terms.length > 5000) return "เงื่อนไขยาวเกินไป";
  if (input.productIds.length === 0) return "เลือกเมนูที่ใช้แพ็กได้อย่างน้อย 1 รายการ";
  return null;
}

/** มูลค่าต่อสิทธิ์ เช่น 350 / 10 = 35 — ใช้แสดงผลและรับรู้รายได้ */
export function passUnitValue(price: number, credits: number): number {
  if (credits <= 0) return 0;
  return Math.round((price / credits) * 100) / 100;
}

export function isPassCartItem(item: Pick<CartItem, "prepaidPassId">): boolean {
  return typeof item.prepaidPassId === "string" && item.prepaidPassId.length > 0;
}

export function cartHasPassItems(cart: Pick<Cart, "items">): boolean {
  return cart.items.some(isPassCartItem);
}

/** รวมบรรทัดใช้แพ็กเป็น (แพ็ก, เมนู) → จำนวน สำหรับจองสิทธิ์ครั้งเดียวต่อกลุ่ม */
export function groupPassRedemptions(items: CartItem[]): Array<{ passId: string; productId: string; quantity: number }> {
  const grouped = new Map<string, { passId: string; productId: string; quantity: number }>();
  for (const item of items) {
    if (!isPassCartItem(item)) continue;
    const key = `${item.prepaidPassId}|${item.productId}`;
    const current = grouped.get(key);
    const quantity = Math.max(1, Math.floor(item.quantity));
    if (current) current.quantity += quantity;
    else grouped.set(key, { passId: item.prepaidPassId!, productId: item.productId, quantity });
  }
  return [...grouped.values()];
}

export function formatPassExpiry(expiresAt: string | null, locale = "th-TH"): string {
  if (!expiresAt) return "ไม่หมดอายุ";
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "—";
  return `ใช้ได้ถึง ${date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}`;
}
