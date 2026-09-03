/**
 * ตัดสินว่าจะแสดงสถานะแพ็กเกจของร้านว่าอย่างไร
 *
 * แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพราะบั๊กที่เจอบน prod 2026-09-03 เกิดจากตรรกะนี้
 * ฝังอยู่ใน JSX แล้วเดาเอาจาก `status === "trialing"` อย่างเดียว ผลคือสลับกัน:
 *   • Each Other (สัญญาไม่มีวันหมดอายุ) ขึ้นว่า "ทดลองใช้ · เหลือ 0 วัน"
 *   • proud.cafe (หมดจริง 2 ต.ค.) ขึ้นว่า "ใช้งานอยู่ · ไม่มีกำหนดหมดอายุ" และซ่อนวันหมดอายุ
 *
 * ตัวชี้ที่ถูกต้องมีสองตัวและมาจากเซิร์ฟเวอร์เท่านั้น:
 *   promoTrial → มาจากโปรทดลองฟรีจริงไหม (subscriptions.promo_trial_code)
 *   expires    → ผลของ isExpiringState() ตัวเดียวกับที่ด่านสิทธิ์ใช้บังคับใช้จริง
 */

export type SubscriptionDisplayKind =
  | "enterprise_contract" // สัญญาไม่มีวันหมดอายุ ใช้งานอยู่
  | "enterprise_inactive" // สัญญาไม่มีวันหมดอายุ แต่ยังไม่เปิดสิทธิ์
  | "trial" // โปรทดลองฟรี ยังไม่หมด
  | "active" // แพ็กเกจมีกำหนด ยังไม่หมด
  | "expired"; // หมดอายุ/ยังไม่ชำระ

export interface SubscriptionDisplayInput {
  readonly plan: string;
  readonly isActive: boolean;
  /** มาจากโปรทดลองฟรี (promo_trial_code) — ห้ามใช้ status='trialing' แทน */
  readonly promoTrial: boolean;
  /** false = สัญญาไม่มีวันหมดอายุ */
  readonly expires: boolean;
  readonly currentPeriodEnd: string;
}

export interface SubscriptionDisplay {
  readonly kind: SubscriptionDisplayKind;
  /** จำนวนวันที่เหลือ — null เมื่อไม่มีกำหนดหมดอายุ */
  readonly daysLeft: number | null;
  /** ควรแสดงแถว "ใช้งานได้ถึง" หรือไม่ */
  readonly showExpiryDate: boolean;
  /** ควรเปิดให้เลือกซื้อ/ต่ออายุหรือไม่ (สัญญาไม่ต้องซื้อเอง) */
  readonly canPurchase: boolean;
}

export function daysUntil(iso: string, now: Date = new Date()): number {
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000));
}

export function describeSubscriptionDisplay(
  input: SubscriptionDisplayInput,
  now: Date = new Date(),
): SubscriptionDisplay {
  const isEnterprise = input.plan === "enterprise";

  // สัญญาไม่มีวันหมดอายุ: ไม่มีวันเหลือ ไม่ต้องโชว์วันหมด และซื้อเองไม่ได้
  if (isEnterprise && !input.expires) {
    return {
      kind: input.isActive ? "enterprise_contract" : "enterprise_inactive",
      daysLeft: null,
      showExpiryDate: false,
      canPurchase: false,
    };
  }

  if (!input.isActive) {
    return { kind: "expired", daysLeft: 0, showExpiryDate: true, canPurchase: true };
  }

  return {
    kind: input.promoTrial ? "trial" : "active",
    daysLeft: daysUntil(input.currentPeriodEnd, now),
    showExpiryDate: true,
    canPurchase: true,
  };
}

/** ข้อความสั้นสำหรับป้ายสถานะ (ภาษาไทย) */
export function subscriptionStatusLabel(display: SubscriptionDisplay): string {
  switch (display.kind) {
    case "enterprise_contract":
      return "ใช้งานอยู่ · ไม่มีกำหนดหมดอายุ";
    case "enterprise_inactive":
      return "ต้องติดต่อผู้ดูแลแพลตฟอร์ม";
    case "trial":
      return `ทดลองใช้ · เหลือ ${display.daysLeft} วัน`;
    case "active":
      return `ใช้งานอยู่ · เหลือ ${display.daysLeft} วัน`;
    case "expired":
      return "หมดอายุ/ยังไม่ชำระ";
  }
}
